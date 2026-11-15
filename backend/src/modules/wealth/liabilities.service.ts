import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth';
import { DAY, economicToday, parseDateOnly, toDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { nextOccurrence } from '../budgets/schedule';
import { BooksService } from '../ledger/books.service';
import { LedgerService, naturalBalance } from '../ledger/ledger.service';
import { ExpensesService } from '../money/expenses.service';

type Kind = 'DEBT' | 'RECEIVABLE' | 'FUTURE_COMMITMENT';

/**
 * Dettes, créances, engagements (llm §10) :
 * emprunt reçu = trésorerie + passif (JAMAIS revenu, T16) ; remboursement du principal = trésorerie − passif ;
 * intérêts et frais = charges distinctes ; une échéance n'est pas un paiement exécuté.
 */
@Injectable()
export class LiabilitiesService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private expenses: ExpensesService, private events: EventsService) {}

  private async owned(db: Tx | PrismaService, ownerId: string, id: string) {
    const l = await db.liability.findUnique({ where: { id }, include: { installments: { orderBy: { dueDate: 'asc' } }, repayments: { orderBy: { at: 'desc' } } } });
    if (!l || l.ownerId !== ownerId) throw notFound('Obligation');
    return l;
  }

  async outstanding(db: Tx | PrismaService, l: { kind: string; ledgerAccountId: string | null; principalMinor: bigint; repayments?: { principalMinor: bigint }[] }) {
    if (l.ledgerAccountId) {
      const acc = await db.ledgerAccount.findUniqueOrThrow({ where: { id: l.ledgerAccountId } });
      return naturalBalance(acc.kind, await this.ledger.balance(db, l.ledgerAccountId));
    }
    return l.principalMinor - (l.repayments ?? []).reduce((s, r) => s + r.principalMinor, 0n);
  }

  async present(db: Tx | PrismaService, l: any) {
    const outstanding = await this.outstanding(db, l);
    const today = economicToday();
    const next = l.installments.find((i: any) => ['SCHEDULED', 'LATE', 'PARTIAL'].includes(i.state));
    return {
      ...l, outstandingMinor: outstanding, paidPrincipalMinor: l.principalMinor - outstanding,
      progressPercent: l.principalMinor > 0n ? Number(((l.principalMinor - outstanding) * 10000n) / l.principalMinor) / 100 : 0,
      nextInstallment: next ?? null, lateCount: l.installments.filter((i: any) => i.state === 'LATE' || (['SCHEDULED', 'PARTIAL'].includes(i.state) && i.dueDate < today)).length,
      interestPaidMinor: l.repayments.reduce((s: bigint, r: any) => s + r.interestMinor, 0n), feesPaidMinor: l.repayments.reduce((s: bigint, r: any) => s + r.feeMinor, 0n),
    };
  }

  async list(auth: AuthContext, kind?: string) {
    const ls = await this.prisma.liability.findMany({ where: { ownerId: auth.ownerId, ...(kind ? { kind } : {}) }, include: { installments: { orderBy: { dueDate: 'asc' } }, repayments: { orderBy: { at: 'desc' } } }, orderBy: { createdAt: 'desc' } });
    const items = await Promise.all(ls.map((l) => this.present(this.prisma, l)));
    const active = items.filter((i) => i.state === 'ACTIVE');
    const today = economicToday();
    const in30 = new Date(today.getTime() + 30 * DAY);
    const upcoming = active.flatMap((l) => l.installments.filter((i: any) => ['SCHEDULED', 'PARTIAL', 'LATE'].includes(i.state) && i.dueDate <= in30).map((i: any) => ({ ...i, liabilityId: l.id, kind: l.kind, label: l.label, counterpartyName: l.counterpartyName }))).sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
    return {
      items,
      summary: {
        debtsOutstandingMinor: active.filter((i) => i.kind === 'DEBT').reduce((s, i) => s + i.outstandingMinor, 0n),
        receivablesOutstandingMinor: active.filter((i) => i.kind === 'RECEIVABLE').reduce((s, i) => s + i.outstandingMinor, 0n),
        commitmentsOutstandingMinor: active.filter((i) => i.kind === 'FUTURE_COMMITMENT').reduce((s, i) => s + i.outstandingMinor, 0n),
        lateCount: active.reduce((s, i) => s + i.lateCount, 0), upcoming30d: upcoming,
      },
    };
  }
  async get(auth: AuthContext, id: string) { return this.present(this.prisma, await this.owned(this.prisma, auth.ownerId, id)); }

  async create(tx: Tx, auth: AuthContext, dto: {
    kind: Kind; counterpartyName: string; label: string; principalMinor: bigint; startDate: string; interestTerms?: string;
    cashAccountId?: string; schedule?: { count: number; rule: string; firstDueDate: string; interestPerInstallmentMinor?: bigint }; initialDueDate?: string;
  }) {
    const id = randomUUID();
    const start = parseDateOnly(dto.startDate);
    let ledgerAccountId: string | null = null;
    if (dto.kind !== 'FUTURE_COMMITMENT') {
      const la = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: dto.kind === 'DEBT' ? `LIABILITY:DEBT:${id}` : `ASSET:RECV:${id}`, name: `${dto.kind === 'DEBT' ? 'Dette' : 'Créance'} — ${dto.counterpartyName}`, kind: dto.kind === 'DEBT' ? 'LIABILITY' : 'ASSET' });
      ledgerAccountId = la.id;
      const counter = dto.cashAccountId ? (await this.accounts.getOwned(tx, auth.ownerId, dto.cashAccountId)).ledgerAccountId : (await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING')).id;
      const sign = dto.kind === 'DEBT' ? 1n : -1n; // DEBT : cash +P / passif −P ; RECEIVABLE : créance +P / cash −P
      await this.ledger.post(tx, {
        ownerId: auth.ownerId, businessType: dto.kind === 'DEBT' ? 'LOAN_RECEIVED' : 'LOAN_GRANTED', businessId: id, economicDate: start, actorDeviceId: auth.deviceId,
        memo: dto.cashAccountId ? `${dto.kind === 'DEBT' ? 'Emprunt reçu de' : 'Prêt accordé à'} ${dto.counterpartyName}` : `Encours existant — ${dto.counterpartyName}`,
        postings: [{ accountId: counter, amount: sign * dto.principalMinor }, { accountId: la.id, amount: -sign * dto.principalMinor }],
      });
    }
    const l = await tx.liability.create({ data: { id, ownerId: auth.ownerId, kind: dto.kind, counterpartyName: dto.counterpartyName, label: dto.label, principalMinor: dto.principalMinor, startDate: start, interestTerms: dto.interestTerms, initialDueDate: dto.initialDueDate ? parseDateOnly(dto.initialDueDate) : null, ledgerAccountId, cashAccountId: dto.cashAccountId } });
    if (dto.schedule) {
      const n = dto.schedule.count;
      if (n < 1 || n > 360) throw new DomainError('VALIDATION_FAILED', 'Nombre d’échéances entre 1 et 360');
      const per = dto.principalMinor / BigInt(n);
      let d = parseDateOnly(dto.schedule.firstDueDate);
      for (let i = 0; i < n; i++) {
        const principal = i === n - 1 ? dto.principalMinor - per * BigInt(n - 1) : per;
        await tx.liabilityInstallment.create({ data: { liabilityId: l.id, dueDate: d, principalDueMinor: principal, interestDueMinor: dto.schedule.interestPerInstallmentMinor ?? 0n } });
        d = nextOccurrence(dto.schedule.rule, d);
      }
    } else if (dto.initialDueDate) {
      await tx.liabilityInstallment.create({ data: { liabilityId: l.id, dueDate: parseDateOnly(dto.initialDueDate), principalDueMinor: dto.principalMinor } });
    }
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'liability.updated', aggregateType: 'Liability', aggregateId: l.id, version: 1 });
    return this.present(tx, await this.owned(tx, auth.ownerId, l.id));
  }

  async update(tx: Tx, auth: AuthContext, id: string, dto: { label?: string; counterpartyName?: string; interestTerms?: string; state?: 'CANCELLED'; expectedVersion?: number }) {
    const l = await this.owned(tx, auth.ownerId, id);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== l.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Modifiée ailleurs', { current: await this.present(tx, l) });
    if (dto.state === 'CANCELLED' && l.kind !== 'FUTURE_COMMITMENT') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Une dette ou créance se solde par remboursement ou remise traçable, pas par annulation');
    const { expectedVersion, ...data } = dto;
    await tx.liability.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    return this.present(tx, await this.owned(tx, auth.ownerId, id));
  }

  /** Report d'échéance historisé (l'ancienne ligne est conservée RESCHEDULED). Aucun accord tiers n'est présumé. */
  async reschedule(tx: Tx, auth: AuthContext, installmentId: string, dto: { newDueDate: string; note?: string }) {
    const inst = await tx.liabilityInstallment.findUnique({ where: { id: installmentId }, include: { liability: true } });
    if (!inst || inst.liability.ownerId !== auth.ownerId) throw notFound('Échéance');
    if (!['SCHEDULED', 'LATE', 'PARTIAL'].includes(inst.state)) throw new DomainError('STATE_CONFLICT', 'Échéance non reportable');
    await tx.liabilityInstallment.update({ where: { id: inst.id }, data: { state: 'RESCHEDULED', version: { increment: 1 } } });
    const n = await tx.liabilityInstallment.create({ data: { liabilityId: inst.liabilityId, dueDate: parseDateOnly(dto.newDueDate), principalDueMinor: inst.principalDueMinor, interestDueMinor: inst.interestDueMinor, rescheduledFrom: inst.id, note: dto.note ? `${dto.note} (report déclaré par le propriétaire)` : 'Report déclaré par le propriétaire' } });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'INSTALLMENT_RESCHEDULED', resource: `LiabilityInstallment:${inst.id}`, context: { from: toDateOnly(inst.dueDate), to: dto.newDueDate } });
    return n;
  }

  /** Remboursement confirmé par le propriétaire. linkExpenseId = rapprochement d'une dépense déjà saisie (reclassement, pas de double charge). */
  async repay(tx: Tx, auth: AuthContext, id: string, dto: { cashAccountId: string; principalMinor: bigint; interestMinor?: bigint; feeMinor?: bigint; date?: string; linkExpenseId?: string; categoryId?: string }) {
    await tx.$queryRaw`SELECT id FROM "Liability" WHERE id = ${id}::uuid FOR UPDATE`;
    const l = await this.owned(tx, auth.ownerId, id);
    if (l.state !== 'ACTIVE') throw new DomainError('STATE_CONFLICT', 'Obligation soldée ou annulée');
    const interest = dto.interestMinor ?? 0n, fee = dto.feeMinor ?? 0n;
    const date = dto.date ? parseDateOnly(dto.date) : economicToday();
    const outstanding = await this.outstanding(tx, l);
    if (dto.principalMinor > outstanding) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Principal supérieur à l’encours', { outstandingMinor: outstanding });
    const repId = randomUUID();
    let ref: string | undefined;
    if (l.kind === 'FUTURE_COMMITMENT') {
      if (!dto.categoryId) throw new DomainError('VALIDATION_FAILED', 'Catégorie requise pour régler un engagement');
      const e = await this.expenses.create(tx, auth, repId, { accountId: dto.cashAccountId, categoryId: dto.categoryId, amountMinor: dto.principalMinor + interest + fee, economicDate: dto.date, label: `Engagement — ${l.label}` });
      ref = e.id;
    } else {
      const cash = await this.accounts.getOwned(tx, auth.ownerId, dto.cashAccountId);
      const interestAcc = await this.books.core(tx, auth.ownerId, l.kind === 'DEBT' ? 'EXPENSE:INTEREST' : 'INCOME:INTEREST');
      const feeAcc = await this.books.core(tx, auth.ownerId, 'EXPENSE:FEES');
      let source = cash.ledgerAccountId;
      if (dto.linkExpenseId) {
        const e = await tx.expense.findUnique({ where: { id: dto.linkExpenseId } });
        if (!e || e.ownerId !== auth.ownerId || e.status !== 'POSTED') throw notFound('Dépense à rapprocher');
        if (l.kind !== 'DEBT' || e.amountMinor !== dto.principalMinor + interest + fee) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Le montant de la dépense doit égaler principal + intérêts + frais');
        const cat = await tx.category.findUniqueOrThrow({ where: { id: e.categoryId } });
        source = (await this.books.forCategory(tx, auth.ownerId, cat.id, 'EXPENSE', cat.name)).id; // on reclasse la charge
        await tx.expense.update({ where: { id: e.id }, data: { status: 'RECLASSIFIED_REPAYMENT', version: { increment: 1 } } });
        ref = e.id;
      }
      const postings = l.kind === 'DEBT'
        ? [{ accountId: source, amount: -(dto.principalMinor + interest + fee) }, { accountId: l.ledgerAccountId!, amount: dto.principalMinor }, { accountId: interestAcc.id, amount: interest }, { accountId: feeAcc.id, amount: fee }]
        : [{ accountId: source, amount: dto.principalMinor + interest - fee }, { accountId: l.ledgerAccountId!, amount: -dto.principalMinor }, { accountId: interestAcc.id, amount: -interest }, { accountId: feeAcc.id, amount: fee }];
      const { transaction } = await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'REPAYMENT', businessId: repId, economicDate: date, actorDeviceId: auth.deviceId, memo: `${l.kind === 'DEBT' ? 'Remboursement' : 'Encaissement'} — ${l.counterpartyName}`, postings });
      ref = ref ?? transaction.id;
    }
    const rep = await tx.repayment.create({ data: { id: repId, liabilityId: l.id, cashAccountId: dto.cashAccountId, principalMinor: dto.principalMinor, interestMinor: interest, feeMinor: fee, at: date, paymentOrLedgerRef: ref } });
    // Imputation du principal sur les échéances ouvertes, dans l'ordre.
    let left = dto.principalMinor;
    const repaidBefore = l.repayments.reduce((s, r) => s + r.principalMinor, 0n);
    let cum = 0n;
    for (const inst of l.installments.filter((i) => i.state !== 'RESCHEDULED')) {
      cum += inst.principalDueMinor;
      if (!['SCHEDULED', 'LATE', 'PARTIAL'].includes(inst.state)) continue;
      const covered = repaidBefore + dto.principalMinor;
      const state = covered >= cum ? 'PAID' : covered > cum - inst.principalDueMinor ? 'PARTIAL' : inst.state;
      if (state !== inst.state) await tx.liabilityInstallment.update({ where: { id: inst.id }, data: { state, version: { increment: 1 } } });
      if (covered < cum) break;
    }
    left = await this.outstanding(tx, { ...l, repayments: [...l.repayments, rep] });
    if (left === 0n) await tx.liability.update({ where: { id: l.id }, data: { state: 'SETTLED', version: { increment: 1 } } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'Liability', aggregateId: l.id });
    return { repayment: rep, liability: await this.present(tx, await this.owned(tx, auth.ownerId, l.id)) };
  }

  /** Suggestions de rapprochement : dépenses non liées dont le montant égale une échéance (confirmation explicite requise). */
  async matchSuggestions(auth: AuthContext, id: string) {
    const l = await this.owned(this.prisma, auth.ownerId, id);
    const open = l.installments.filter((i) => ['SCHEDULED', 'LATE', 'PARTIAL'].includes(i.state));
    const out: any[] = [];
    for (const inst of open.slice(0, 3)) {
      const total = inst.principalDueMinor + inst.interestDueMinor;
      const cands = await this.prisma.expense.findMany({ where: { ownerId: auth.ownerId, status: 'POSTED', amountMinor: total, economicDate: { gte: new Date(inst.dueDate.getTime() - 10 * DAY), lte: new Date(inst.dueDate.getTime() + 10 * DAY) } }, take: 5 });
      for (const c of cands) out.push({ installmentId: inst.id, expense: c, requiresConfirmation: true });
    }
    return out;
  }

  async flagLate() {
    const today = economicToday();
    const late = await this.prisma.liabilityInstallment.findMany({ where: { state: { in: ['SCHEDULED', 'PARTIAL'] }, dueDate: { lt: today }, liability: { state: 'ACTIVE' } }, include: { liability: true } });
    for (const i of late) {
      await this.prisma.tx(async (tx) => {
        await tx.liabilityInstallment.update({ where: { id: i.id }, data: { state: 'LATE', version: { increment: 1 } } });
        await this.events.notify(tx, { ownerId: i.liability.ownerId, sourceEventId: `installment-late:${i.id}`, type: 'liability.installment_late', category: 'LIABILITY', priority: 'HIGH', title: `Échéance en retard — ${i.liability.label}`, body: `${i.liability.kind === 'DEBT' ? 'Paiement' : 'Encaissement'} attendu le ${toDateOnly(i.dueDate)}.`, link: `/money/liabilities/${i.liabilityId}` });
      });
    }
    return late.length;
  }
}
