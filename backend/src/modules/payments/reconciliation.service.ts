import { Inject, Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { clock } from '../../common/clock';
import { sha256 } from '../../common/crypto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';
import { PAYMENT_PROVIDER, PaymentProviderPort } from './provider.port';

/**
 * Rapprochement (llm §9, backend.md §11) : instantanés datés append-only ; écart inexpliqué → blocage des sorties de TOUTE
 * la balance réelle concernée (toutes enveloppes), balances indépendantes préservées ; correction uniquement compensatoire.
 */
@Injectable()
export class ReconciliationService {
  constructor(private prisma: PrismaService, @Inject(PAYMENT_PROVIDER) private provider: PaymentProviderPort, private ledger: LedgerService, private books: BooksService, private events: EventsService) {}

  async list(auth: AuthContext, status?: string) {
    return this.prisma.reconciliationCase.findMany({ where: { ownerId: auth.ownerId, ...(status ? { status: status as any } : {}) }, include: { evidence: true }, orderBy: { openedAt: 'desc' }, take: 100 });
  }
  async get(auth: AuthContext, id: string) {
    const c = await this.prisma.reconciliationCase.findUnique({ where: { id }, include: { evidence: { orderBy: { recordedAt: 'asc' } } } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cas de rapprochement');
    const group = c.realBalanceGroupId ? await this.prisma.realBalanceGroup.findUnique({ where: { id: c.realBalanceGroupId } }) : null;
    const account = c.financialAccountId ? await this.prisma.financialAccount.findUnique({ where: { id: c.financialAccountId } }) : null;
    const affectedWallets = group ? await this.prisma.wallet.findMany({ where: { realBalanceGroupId: group.id } }) : [];
    return { ...c, differenceMinor: c.observedMinor - c.expectedMinor, group, account: account && { id: account.id, name: account.name, type: account.type }, affectedWallets };
  }
  async groups(auth: AuthContext) {
    const gs = await this.prisma.realBalanceGroup.findMany({ where: { ownerId: auth.ownerId } });
    return Promise.all(gs.map(async (g) => ({ ...g, lastSnapshot: await this.prisma.providerBalanceSnapshot.findFirst({ where: { realBalanceGroupId: g.id }, orderBy: { receivedAt: 'desc' } }) })));
  }

  async addEvidence(auth: AuthContext, id: string, dto: { kind: string; note?: string; providerRef?: string; documentId?: string }) {
    const c = await this.prisma.reconciliationCase.findUnique({ where: { id } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cas');
    if (c.status === 'OPEN') await this.prisma.reconciliationCase.update({ where: { id }, data: { status: 'INVESTIGATING', version: { increment: 1 } } });
    return this.prisma.reconciliationEvidence.create({ data: { caseId: id, kind: dto.kind, note: dto.note, providerRef: dto.providerRef, documentId: dto.documentId, digest: sha256(`${dto.kind}|${dto.note ?? ''}|${dto.providerRef ?? ''}`) } });
  }

  /** Résolution probante (step-up vérifié par le contrôleur) : écriture compensatoire liée OU classement avec preuve. */
  async resolve(tx: Tx, auth: AuthContext, id: string, dto: { resolution: 'ADJUST' | 'DISMISS_WITH_EVIDENCE'; explanation: string }) {
    await tx.$queryRaw`SELECT id FROM "ReconciliationCase" WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.reconciliationCase.findUnique({ where: { id }, include: { evidence: true } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cas');
    if (!['OPEN', 'INVESTIGATING'].includes(c.status)) throw new DomainError('STATE_CONFLICT', 'Cas déjà résolu');
    if (dto.resolution === 'DISMISS_WITH_EVIDENCE' && c.evidence.length === 0) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Un classement exige au moins une pièce justificative');
    let postingId: string | null = null;
    if (dto.resolution === 'ADJUST') {
      const fa = c.financialAccountId ? await tx.financialAccount.findUnique({ where: { id: c.financialAccountId } }) : null;
      if (!fa) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Ajustement impossible sans compte identifié');
      const delta = c.observedMinor - c.expectedMinor;
      if (delta !== 0n) {
        const counter = await this.books.core(tx, auth.ownerId, delta > 0n ? 'INCOME:RECONCILIATION_DIFF' : 'EXPENSE:RECONCILIATION_DIFF');
        const r = await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'RECONCILIATION_ADJUSTMENT', businessId: c.id, actorDeviceId: auth.deviceId, memo: `Correction de rapprochement : ${dto.explanation}`, postings: [{ accountId: fa.ledgerAccountId, amount: delta }, { accountId: counter.id, amount: -delta }] });
        postingId = r.transaction.id;
      }
      // Paiement réellement exécuté malgré un état « échoué » : il compte dans la fenêtre de 24 h depuis sa réservation d'origine.
      if (c.reason.includes('CONTRADICTS_TERMINAL_FAILED') || c.reason.includes('CONTRADICTS_TERMINAL_CANCELLED')) {
        const intentId = c.evidence.map((e) => e.note?.match(/^intent:([0-9a-f-]{36})$/)?.[1]).find(Boolean);
        if (intentId) await tx.limitHold.updateMany({ where: { paymentIntentId: intentId, state: 'RELEASED' }, data: { state: 'SETTLED', settledAt: clock.now(), releasedAt: null } });
      }
    }
    await tx.reconciliationEvidence.create({ data: { caseId: c.id, kind: 'RESOLUTION', note: dto.explanation, digest: sha256(`${dto.resolution}|${dto.explanation}`) } });
    const r = await tx.reconciliationCase.update({ where: { id }, data: { status: dto.resolution === 'ADJUST' ? 'RESOLVED' : 'DISMISSED_WITH_EVIDENCE', resolvedAt: clock.now(), resolutionNote: dto.explanation, resolutionPostingId: postingId, version: { increment: 1 } } });
    if (c.realBalanceGroupId) {
      const others = await tx.reconciliationCase.count({ where: { realBalanceGroupId: c.realBalanceGroupId, status: { in: ['OPEN', 'INVESTIGATING'] } } });
      if (!others) await tx.realBalanceGroup.update({ where: { id: c.realBalanceGroupId }, data: { status: 'ACTIVE', blockReason: null, version: { increment: 1 } } });
    }
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'RECONCILIATION_RESOLVED', resource: `ReconciliationCase:${id}`, context: { resolution: dto.resolution, postingId } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'security.restriction_changed', aggregateType: 'ReconciliationCase', aggregateId: id });
    return r;
  }

  /** Instantané prestataire vs registre. Les mouvements en vol (PROCESSING/UNKNOWN) peuvent expliquer un écart transitoire. */
  async snapshotGroup(groupId: string, source = 'SCHEDULED') {
    const g = await this.prisma.realBalanceGroup.findUniqueOrThrow({ where: { id: groupId } });
    if (!g.providerBalanceRef || !this.provider.getBalanceSnapshot) return { skipped: 'NO_BALANCE_CAPABILITY' };
    if (g.providerId && g.providerId !== this.provider.id) return { skipped: 'OTHER_PROVIDER' };
    const snap = await this.provider.getBalanceSnapshot(g.providerBalanceRef);
    if (!snap) return { skipped: 'BALANCE_UNKNOWN_TO_PROVIDER' };
    return this.prisma.tx(async (tx) => {
      await tx.providerBalanceSnapshot.create({ data: { realBalanceGroupId: g.id, providerRef: g.providerBalanceRef!, balanceMinor: snap.balanceMinor, asOf: snap.asOf, source, rawDigest: sha256(`${snap.balanceMinor}|${snap.asOf.toISOString()}`) } });
      const accounts = await tx.financialAccount.findMany({ where: { realBalanceGroupId: g.id, type: 'CONTROLLED_PSP' } });
      let expected = 0n;
      for (const a of accounts) expected += await this.ledger.balance(tx, a.ledgerAccountId);
      const inflight = (await tx.paymentIntent.aggregate({ where: { sourceAccountId: { in: accounts.map((a) => a.id) }, direction: 'PAYOUT', state: { in: ['SUBMITTING', 'PROCESSING', 'UNKNOWN'] } }, _sum: { totalDebitMinor: true } }))._sum.totalDebitMinor ?? 0n;
      const explained = snap.balanceMinor === expected || snap.balanceMinor === expected - inflight;
      await tx.realBalanceGroup.update({ where: { id: g.id }, data: { verifiedBalanceMinor: snap.balanceMinor, verifiedAt: snap.asOf } });
      if (explained) return { matched: true, expectedMinor: expected, observedMinor: snap.balanceMinor };
      const existing = await tx.reconciliationCase.findFirst({ where: { realBalanceGroupId: g.id, status: { in: ['OPEN', 'INVESTIGATING'] } } });
      const c = existing ?? await tx.reconciliationCase.create({ data: { ownerId: g.ownerId, realBalanceGroupId: g.id, financialAccountId: accounts[0]?.id, expectedMinor: expected, observedMinor: snap.balanceMinor, reason: 'PROVIDER_BALANCE_MISMATCH' } });
      await tx.reconciliationEvidence.create({ data: { caseId: c.id, kind: 'PROVIDER_SNAPSHOT', providerRef: g.providerBalanceRef, digest: sha256(`${snap.balanceMinor}`) } });
      await tx.realBalanceGroup.update({ where: { id: g.id }, data: { status: 'BLOCKED_OUTBOUND', blockReason: 'Écart entre le registre et le solde prestataire', version: { increment: 1 } } });
      if (!existing) await this.events.notify(tx, { ownerId: g.ownerId, sourceEventId: `recon-block:${c.id}`, type: 'reconciliation.balance_blocked', category: 'RECONCILIATION', priority: 'CRITICAL', title: 'Sorties suspendues — écart de solde', body: 'Le solde du prestataire diffère du registre. Toutes les sorties de cette balance sont bloquées jusqu’à résolution ; les entrées continuent d’être enregistrées.', link: `/activity/reconciliation/${c.id}` });
      await this.events.emit(tx, { ownerId: g.ownerId, eventType: 'security.restriction_changed', aggregateType: 'RealBalanceGroup', aggregateId: g.id });
      return { matched: false, caseId: c.id, expectedMinor: expected, observedMinor: snap.balanceMinor };
    });
  }
  async runAll(ownerId?: string) {
    const gs = await this.prisma.realBalanceGroup.findMany({ where: ownerId ? { ownerId } : {} });
    const out = [];
    for (const g of gs) out.push({ groupId: g.id, ...(await this.snapshotGroup(g.id, ownerId ? 'OWNER_REQUESTED' : 'SCHEDULED')) });
    return out;
  }
}
