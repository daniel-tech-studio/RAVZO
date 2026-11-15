import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../common/auth';
import { clock, DAY, economicToday, parseDateOnly, toDateOnly } from '../../common/clock';
import { DomainError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { decodeCursor, encodeCursor, pageSize } from '../../common/pagination';

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const LABELS: Record<string, string> = {
  INCOME: 'Revenu', EXPENSE: 'Dépense', ACCOUNT_TRANSFER: 'Transfert entre comptes', ACCOUNT_OPENING: 'Solde d’ouverture', ALLOCATION_TRANSFER: 'Réaffectation',
  INCOME_ALLOCATION: 'Répartition de revenu', SAVINGS_CONTRIBUTION: 'Versement épargne', SAVINGS_WITHDRAWAL: 'Retrait épargne', LOAN_RECEIVED: 'Emprunt reçu',
  LOAN_GRANTED: 'Prêt accordé', REPAYMENT: 'Remboursement', TRADE: 'Opération SGI', DIVIDEND_RECEIPT: 'Dividende encaissé', ASSET_ACQUISITION: 'Acquisition de bien',
  ASSET_REVALUATION: 'Réévaluation (non encaissée)', ASSET_DISPOSAL: 'Cession de bien', PAYOUT: 'Paiement sortant', PAYIN: 'Dépôt', PAYOUT_REFUND: 'Remboursement de paiement',
  REVERSAL: 'Contrepassation', EXPENSE_RECLASS: 'Reclassement', RECONCILIATION_ADJUSTMENT: 'Correction de rapprochement', SGI_FEE: 'Frais SGI',
};

@Injectable()
export class InsightsService {
  constructor(private prisma: PrismaService) {}

  // ─── Notifications intelligentes : critiques jamais masquées ───
  async notifications(auth: AuthContext, q: { unreadOnly?: boolean; category?: string; limit?: string }) {
    const prefs = ((await this.prisma.user.findUnique({ where: { id: auth.ownerId } }))?.preferences as any)?.notifications ?? {};
    const muted: string[] = prefs.mutedCategories ?? [];
    const rows = await this.prisma.notification.findMany({ where: { ownerId: auth.ownerId, ...(q.unreadOnly ? { readAt: null } : {}), ...(q.category ? { category: q.category } : {}) }, include: { deliveries: true }, orderBy: { createdAt: 'desc' }, take: pageSize(q.limit, 200, 80) });
    const visible = rows.filter((n) => !muted.includes(n.category) || ['CRITICAL', 'HIGH'].includes(n.priority) || ['SECURITY', 'PAYMENT', 'RECONCILIATION'].includes(n.category));
    visible.sort((a, b) => (Number(!!a.readAt) - Number(!!b.readAt)) || (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (b.createdAt.getTime() - a.createdAt.getTime()));
    const unread = await this.prisma.notification.count({ where: { ownerId: auth.ownerId, readAt: null } });
    const criticalUnread = await this.prisma.notification.count({ where: { ownerId: auth.ownerId, readAt: null, priority: 'CRITICAL' } });
    return { items: visible.map((n) => ({ ...n, deliveries: n.deliveries.map((d) => ({ channel: d.channel, status: d.status })) })), unreadCount: unread, criticalUnreadCount: criticalUnread, mutedCategories: muted };
  }
  async markRead(auth: AuthContext, id: string) {
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n || n.ownerId !== auth.ownerId) throw new DomainError('NOT_FOUND', 'Notification introuvable');
    return this.prisma.notification.update({ where: { id }, data: { readAt: n.readAt ?? clock.now() } });
  }
  async markAllRead(auth: AuthContext) {
    const r = await this.prisma.notification.updateMany({ where: { ownerId: auth.ownerId, readAt: null, priority: { not: 'CRITICAL' } }, data: { readAt: clock.now() } });
    return { marked: r.count, note: 'Les notifications critiques doivent être lues individuellement.' };
  }

  // ─── Centre des opérations (UX21/UX24) ───
  async operations(auth: AuthContext) {
    const o = auth.ownerId;
    const today = economicToday();
    const [drafts, payments, cases, withdrawals, exceptions, limitChanges, imports, contributions, occurrences, installments, offCycleExp, enrollments] = await Promise.all([
      this.prisma.offlineDraftRecord.findMany({ where: { ownerId: o, state: { in: ['REVIEW_REQUIRED', 'CONFLICT'] } } }),
      this.prisma.paymentIntent.findMany({ where: { ownerId: o, state: { in: ['AWAITING_CONFIRMATION', 'RESERVED', 'SUBMITTING', 'PROCESSING', 'UNKNOWN'] } } }),
      this.prisma.reconciliationCase.findMany({ where: { ownerId: o, status: { in: ['OPEN', 'INVESTIGATING'] } } }),
      this.prisma.savingsWithdrawalRequest.findMany({ where: { ownerId: o, status: { in: ['WAITING', 'ELIGIBLE'] } }, include: { goal: { select: { name: true } } } }),
      this.prisma.exceptionAuthorization.findMany({ where: { ownerId: o, state: { in: ['WAITING', 'ACTIVE'] } } }),
      this.prisma.limitChangeRequest.findMany({ where: { ownerId: o, status: 'PENDING' } }),
      this.prisma.importBatch.findMany({ where: { ownerId: o, status: 'PREVIEW_READY' } }),
      this.prisma.plannedContribution.findMany({ where: { goal: { ownerId: o }, state: { in: ['DUE', 'MISSED'] } }, include: { goal: { select: { name: true } } } }),
      this.prisma.obligationOccurrence.findMany({ where: { obligation: { ownerId: o }, state: 'DUE' }, include: { obligation: { select: { label: true } } } }),
      this.prisma.liabilityInstallment.findMany({ where: { liability: { ownerId: o }, state: 'LATE' }, include: { liability: { select: { label: true } } } }),
      this.prisma.expense.count({ where: { ownerId: o, cycleId: null, status: 'POSTED' } }),
      this.prisma.deviceApproval.count({ where: { ownerId: o, status: 'PENDING', method: 'TRUSTED_DEVICE', expiresAt: { gt: clock.now() } } }),
    ]);
    const items: any[] = [
      ...payments.map((p) => ({ kind: 'PAYMENT', id: p.id, state: p.state, urgency: p.state === 'UNKNOWN' ? 'CRITICAL' : 'HIGH', title: p.state === 'UNKNOWN' ? 'Paiement au résultat incertain' : p.state === 'AWAITING_CONFIRMATION' ? 'Paiement à confirmer' : 'Paiement en cours', link: `/money/payments/${p.id}`, needsIntervention: ['UNKNOWN', 'AWAITING_CONFIRMATION'].includes(p.state), retryAllowed: false })),
      ...cases.map((c) => ({ kind: 'RECONCILIATION', id: c.id, state: c.status, urgency: 'CRITICAL', title: 'Écart de rapprochement à expliquer', link: `/activity/reconciliation/${c.id}`, needsIntervention: true })),
      ...drafts.map((d) => ({ kind: 'OFFLINE_DRAFT', id: d.id, state: d.state, urgency: d.state === 'CONFLICT' ? 'HIGH' : 'NORMAL', title: d.state === 'CONFLICT' ? 'Conflit de synchronisation' : 'Modification hors ligne à confirmer', link: `/sync/drafts/${d.id}`, needsIntervention: true })),
      ...withdrawals.map((w) => ({ kind: 'SAVINGS_WITHDRAWAL', id: w.id, state: w.status, urgency: w.status === 'ELIGIBLE' ? 'HIGH' : 'LOW', title: `Retrait ${w.goal.name}${w.status === 'ELIGIBLE' ? ' — à confirmer' : ' — délai en cours'}`, eligibleAt: w.eligibleAt, link: `/savings/${w.goalId}`, needsIntervention: w.status === 'ELIGIBLE' })),
      ...exceptions.map((e) => ({ kind: 'LIMIT_EXCEPTION', id: e.id, state: e.state, urgency: 'NORMAL', title: 'Dérogation de plafond', activeFrom: e.activeFrom, expiresAt: e.expiresAt, link: `/security/exceptions/${e.id}`, needsIntervention: false })),
      ...limitChanges.map((l) => ({ kind: 'LIMIT_CHANGE', id: l.id, state: l.status, urgency: 'NORMAL', title: 'Changement de plafond en attente', effectiveAt: l.effectiveAt, link: '/security/limits', needsIntervention: false })),
      ...imports.map((i) => ({ kind: 'IMPORT', id: i.id, state: i.status, urgency: 'NORMAL', title: 'Import à vérifier', link: `/activity/imports/${i.id}`, needsIntervention: true })),
      ...contributions.map((c) => ({ kind: 'SAVINGS_CONTRIBUTION', id: c.id, state: c.state, urgency: c.state === 'MISSED' ? 'NORMAL' : 'LOW', title: `Versement ${c.state === 'MISSED' ? 'manqué' : 'prévu'} — ${c.goal.name}`, link: `/savings/${c.goalId}`, needsIntervention: false })),
      ...occurrences.map((c) => ({ kind: 'OBLIGATION_DUE', id: c.id, state: c.state, urgency: c.dueDate < today ? 'HIGH' : 'NORMAL', title: `Charge à régler — ${c.obligation.label}`, dueDate: c.dueDate, link: '/money/obligations', needsIntervention: false })),
      ...installments.map((i) => ({ kind: 'INSTALLMENT_LATE', id: i.id, state: i.state, urgency: 'HIGH', title: `Échéance en retard — ${i.liability.label}`, link: `/money/liabilities/${i.liabilityId}`, needsIntervention: true })),
      ...(offCycleExp ? [{ kind: 'OFF_CYCLE', id: 'off-cycle', state: 'UNASSIGNED', urgency: 'LOW', title: `${offCycleExp} opération(s) hors cycle à rattacher`, link: '/money/budgets/off-cycle', needsIntervention: false }] : []),
      ...(enrollments ? [{ kind: 'DEVICE_ENROLLMENT', id: 'enrollment', state: 'PENDING', urgency: 'CRITICAL', title: 'Nouvel appareil en attente d’approbation', link: '/security/devices', needsIntervention: true }] : []),
    ];
    items.sort((a, b) => PRIORITY_RANK[a.urgency] - PRIORITY_RANK[b.urgency]);
    return { items, needsInterventionCount: items.filter((i) => i.needsIntervention).length, total: items.length, serverTime: clock.now() };
  }

  // ─── Activité / historique complet ───
  async activity(auth: AuthContext, q: { cursor?: string; limit?: string; from?: string; to?: string; types?: string; accountId?: string; q?: string; minAmount?: string; maxAmount?: string; book?: string }) {
    const take = pageSize(q.limit, 200, 40);
    const c = decodeCursor(q.cursor);
    const where: Prisma.LedgerTransactionWhereInput = {
      ownerId: auth.ownerId, book: (q.book as any) ?? 'REAL',
      ...(q.types ? { businessType: { in: q.types.split(',') } } : {}),
      ...(q.from || q.to ? { economicDate: { ...(q.from ? { gte: parseDateOnly(q.from) } : {}), ...(q.to ? { lte: parseDateOnly(q.to) } : {}) } } : {}),
      ...(q.q ? { memo: { contains: q.q, mode: 'insensitive' } } : {}),
      ...(q.accountId ? { postings: { some: { ledgerAccount: { id: (await this.prisma.financialAccount.findUnique({ where: { id: q.accountId } }))?.ledgerAccountId ?? '00000000-0000-0000-0000-000000000000' } } } } : {}),
      ...(c ? { sequence: { lt: BigInt(c.seq) } } : {}),
    };
    const rows = await this.prisma.reader.ledgerTransaction.findMany({ where, include: { postings: { include: { ledgerAccount: { select: { id: true, code: true, name: true, kind: true } } } } }, orderBy: { sequence: 'desc' }, take: take + 1 });
    const min = q.minAmount ? BigInt(q.minAmount) : null, max = q.maxAmount ? BigInt(q.maxAmount) : null;
    const items = rows.slice(0, take).map((t) => {
      const cashLegs = t.postings.filter((p) => p.ledgerAccount.code.startsWith('ASSET:FA:'));
      const cash = cashLegs.reduce((s, p) => s + p.signedAmountMinor, 0n);
      const magnitude = t.postings.filter((p) => p.signedAmountMinor > 0n).reduce((s, p) => s + p.signedAmountMinor, 0n);
      return { id: t.id, sequence: t.sequence, businessType: t.businessType, businessId: t.businessId, label: LABELS[t.businessType] ?? t.businessType, memo: t.memo, economicDate: toDateOnly(t.economicDate), postedAt: t.postedAt, cashImpactMinor: cash, magnitudeMinor: magnitude, source: t.source, reversalOfId: t.reversalOfId, book: t.book, accounts: [...new Set(t.postings.map((p) => p.ledgerAccount.name))], dataLabel: t.source === 'PSP' ? 'CONFIRMED' : t.source === 'SANDBOX' ? 'SIMULATED' : 'MANUAL' };
    }).filter((i) => (min === null || i.magnitudeMinor >= min) && (max === null || i.magnitudeMinor <= max));
    const more = rows.length > take;
    return { items, nextCursor: more ? encodeCursor({ seq: rows[take - 1].sequence.toString() }) : null, hasMore: more, readSource: this.prisma.readerIsReplica ? 'REPLICA' : 'PRIMARY', computedAt: clock.now() };
  }

  // ─── Recherche globale (UX19) ───
  async search(auth: AuthContext, term: string) {
    const t = term.trim();
    if (t.length < 2) return { query: t, results: [] };
    const o = auth.ownerId;
    const amount = /^\d[\d\s]*$/.test(t) ? BigInt(t.replace(/\s/g, '')) : null;
    const ci = { contains: t, mode: 'insensitive' as const };
    const [accounts, expenses, incomes, goals, liabilities, securities, beneficiaries, assets] = await Promise.all([
      this.prisma.financialAccount.findMany({ where: { ownerId: o, OR: [{ name: ci }, { institution: ci }] }, take: 5 }),
      this.prisma.expense.findMany({ where: { ownerId: o, OR: [{ label: ci }, { merchant: ci }, ...(amount !== null ? [{ amountMinor: amount }] : [])] }, orderBy: { economicDate: 'desc' }, take: 8 }),
      this.prisma.income.findMany({ where: { ownerId: o, OR: [{ source: ci }, ...(amount !== null ? [{ grossMinor: amount }] : [])] }, orderBy: { economicDate: 'desc' }, take: 5 }),
      this.prisma.savingsGoal.findMany({ where: { ownerId: o, name: ci }, take: 5 }),
      this.prisma.liability.findMany({ where: { ownerId: o, OR: [{ label: ci }, { counterpartyName: ci }] }, take: 5 }),
      this.prisma.security.findMany({ where: { OR: [{ symbol: { contains: t.toUpperCase() } }, { name: ci }] }, take: 5 }),
      this.prisma.beneficiary.findMany({ where: { ownerId: o, OR: [{ displayName: ci }, { phoneE164: { contains: t.replace(/\s/g, '') } }] }, take: 5 }),
      this.prisma.physicalAsset.findMany({ where: { ownerId: o, name: ci }, take: 5 }),
    ]);
    const results = [
      ...accounts.map((a) => ({ type: 'ACCOUNT', id: a.id, title: a.name, subtitle: a.institution ?? a.type, link: `/money/accounts/${a.id}` })),
      ...expenses.map((e) => ({ type: 'EXPENSE', id: e.id, title: e.label, subtitle: toDateOnly(e.economicDate), amountMinor: e.amountMinor, link: `/activity/expenses/${e.id}` })),
      ...incomes.map((i) => ({ type: 'INCOME', id: i.id, title: i.source, subtitle: toDateOnly(i.economicDate), amountMinor: i.grossMinor, link: `/money/incomes/${i.id}` })),
      ...goals.map((g) => ({ type: 'SAVINGS_GOAL', id: g.id, title: g.name, subtitle: 'Coffre', link: `/savings/${g.id}` })),
      ...liabilities.map((l) => ({ type: 'LIABILITY', id: l.id, title: l.label, subtitle: l.counterpartyName, link: `/money/liabilities/${l.id}` })),
      ...securities.map((s) => ({ type: 'SECURITY', id: s.id, title: s.symbol, subtitle: s.name, link: `/wealth/market/${s.id}` })),
      ...beneficiaries.map((b) => ({ type: 'BENEFICIARY', id: b.id, title: b.displayName, subtitle: b.operator, link: '/money/beneficiaries' })),
      ...assets.map((a) => ({ type: 'ASSET', id: a.id, title: a.name, subtitle: a.kind, link: `/wealth/assets/${a.id}` })),
    ];
    return { query: t, results };
  }

  // ─── Analyses avancées (UX20) ───
  async analytics(auth: AuthContext, q: { from?: string; to?: string }) {
    const to = q.to ? parseDateOnly(q.to) : economicToday();
    const from = q.from ? parseDateOnly(q.from) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
    const o = auth.ownerId;
    const monthly = await this.prisma.reader.$queryRaw<{ month: Date; kind: string; amount: bigint }[]>`
      SELECT date_trunc('month', t."economicDate")::date AS month, a.kind::text AS kind, SUM(p."signedAmountMinor")::bigint AS amount
      FROM "LedgerPosting" p JOIN "LedgerTransaction" t ON t.id = p."transactionId" JOIN "LedgerAccount" a ON a.id = p."ledgerAccountId"
      WHERE t."ownerId" = ${o}::uuid AND t.book = 'REAL' AND a.kind IN ('INCOME','EXPENSE') AND t."economicDate" BETWEEN ${from} AND ${to}
      GROUP BY 1, 2 ORDER BY 1`;
    const months = new Map<string, { incomeMinor: bigint; expenseMinor: bigint }>();
    for (const r of monthly) {
      const k = toDateOnly(r.month);
      const e = months.get(k) ?? { incomeMinor: 0n, expenseMinor: 0n };
      if (r.kind === 'INCOME') e.incomeMinor += -BigInt(r.amount); else e.expenseMinor += BigInt(r.amount);
      months.set(k, e);
    }
    const byCategory = await this.prisma.reader.expense.groupBy({ by: ['categoryId'], where: { ownerId: o, status: 'POSTED', economicDate: { gte: from, lte: to } }, _sum: { amountMinor: true }, _count: true });
    const cats = await this.prisma.category.findMany({ where: { ownerId: o } });
    const cycles = await this.prisma.budgetCycle.findMany({ where: { ownerId: o }, orderBy: { startsAt: 'desc' }, take: 6 });
    const cycleComparison = await Promise.all(cycles.map(async (c) => {
      const spent = (await this.prisma.expense.aggregate({ where: { ownerId: o, cycleId: c.id, status: 'POSTED' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
      const income = (await this.prisma.income.aggregate({ where: { ownerId: o, cycleId: c.id }, _sum: { grossMinor: true } }))._sum.grossMinor ?? 0n;
      const planned = (await this.prisma.budget.aggregate({ where: { cycleId: c.id }, _sum: { plannedMinor: true } }))._sum.plannedMinor ?? 0n;
      return { cycleId: c.id, label: c.label, startsAt: toDateOnly(c.startsAt), state: c.state, incomeMinor: income, spentMinor: spent, plannedMinor: planned };
    }));
    const series = [...months.entries()].map(([month, v]) => ({ month, ...v, netMinor: v.incomeMinor - v.expenseMinor, savingsRatePercent: v.incomeMinor > 0n ? Number(((v.incomeMinor - v.expenseMinor) * 1000n) / v.incomeMinor) / 10 : null, dataLabel: 'TRACKED' }));
    return {
      period: { from: toDateOnly(from), to: toDateOnly(to) }, monthly: series,
      byCategory: byCategory.map((b) => ({ categoryId: b.categoryId, name: cats.find((c) => c.id === b.categoryId)?.name, icon: cats.find((c) => c.id === b.categoryId)?.icon, totalMinor: b._sum.amountMinor ?? 0n, count: b._count })).sort((a, b) => (b.totalMinor > a.totalMinor ? 1 : -1)),
      cycleComparison, computedAt: clock.now(), readSource: this.prisma.readerIsReplica ? 'REPLICA' : 'PRIMARY',
    };
  }

  // ─── Exports CSV / PDF avec provenance (llm §14.2) ───
  async exportRows(auth: AuthContext, q: any) {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await this.activity(auth, { ...q, cursor, limit: '200' });
      all.push(...page.items);
      if (!page.hasMore) break;
      cursor = page.nextCursor ?? undefined;
    }
    return all;
  }
  toCsv(rows: any[], masked: boolean) {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['date_economique', 'horodatage_utc', 'type', 'libelle', 'impact_tresorerie_xof', 'montant_xof', 'comptes', 'provenance', 'reference_ecriture'];
    const lines = rows.map((r) => [r.economicDate, r.postedAt.toISOString(), r.label, r.memo, masked ? '•••' : r.cashImpactMinor.toString(), masked ? '•••' : r.magnitudeMinor.toString(), r.accounts.join(' | '), r.dataLabel, r.id].map(esc).join(','));
    return [`# RAVZO — export confidentiel généré le ${clock.now().toISOString()} (UTC). Données personnelles : ne pas partager.`, head.join(','), ...lines].join('\n');
  }
  /** PDF texte minimal (sans dépendance), pages A4 paysage. */
  toPdf(rows: any[], masked: boolean) {
    const fmt = (m: bigint) => (masked ? '•••' : `${m.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`);
    const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?').replace(/([()\\])/g, '\\$1');
    const lines = [`RAVZO - Historique (${rows.length} operations) - genere le ${clock.now().toISOString()} UTC - CONFIDENTIEL`, '', ...rows.map((r) => `${r.economicDate}  ${r.label.padEnd(28).slice(0, 28)}  ${(r.memo ?? '').padEnd(40).slice(0, 40)}  ${fmt(r.cashImpactMinor).padStart(16)}  [${r.dataLabel}]`)];
    const perPage = 40;
    const pages: string[][] = [];
    for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
    if (!pages.length) pages.push(['Aucune operation']);
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
    const pageIds: number[] = [];
    const pagesId = objs.length + 1 + pages.length * 2;
    for (const p of pages) {
      const content = `BT /F1 8 Tf 30 560 Td 11 TL ${p.map((l) => `(${ascii(l)}) '`).join(' ')} ET`;
      const c = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'binary');
  }
}
