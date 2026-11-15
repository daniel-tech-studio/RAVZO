import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountsService } from './accounts.service';

/**
 * Enveloppes virtuelles (livre ALLOCATION). Le portefeuille COURANT est le reliquat :
 * courant = liquidités éligibles − Σ affectations des autres enveloppes. Une réaffectation ne touche jamais le livre REAL (T01).
 */
@Injectable()
export class WalletsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private events: EventsService) {}

  async allocationAccount(tx: Tx, ownerId: string, wallet: { id: string; name: string; currency: string; allocationAccountId: string | null }) {
    if (wallet.allocationAccountId) return wallet.allocationAccountId;
    const acc = await this.ledger.ensureAccount(tx, { ownerId, code: `ALLOC:W:${wallet.id}`, name: `Enveloppe ${wallet.name}`, kind: 'ALLOCATION', currency: wallet.currency });
    await tx.wallet.update({ where: { id: wallet.id }, data: { allocationAccountId: acc.id } });
    return acc.id;
  }

  async currentWallet(db: Tx | PrismaService, ownerId: string) {
    const w = await db.wallet.findFirst({ where: { ownerId, kind: 'CURRENT', status: 'ACTIVE' } });
    if (!w) throw notFound('Portefeuille courant');
    return w;
  }

  async getOwned(db: Tx | PrismaService, ownerId: string, id: string) {
    const w = await db.wallet.findUnique({ where: { id } });
    if (!w || w.ownerId !== ownerId) throw notFound('Portefeuille');
    return w;
  }

  /** Montant affecté à une enveloppe (≥ 0) ; pour COURANT : reliquat calculé. */
  async allocated(db: Tx | PrismaService, ownerId: string, w: { kind: string; allocationAccountId: string | null; currency: string }) {
    if (w.kind === 'CURRENT') return this.currentAmount(db, ownerId, w.currency);
    return w.allocationAccountId ? this.ledger.balance(db, w.allocationAccountId) : 0n;
  }

  async totalAllocated(db: Tx | PrismaService, ownerId: string, currency = 'XOF') {
    const pool = await db.ledgerAccount.findUnique({ where: { ownerId_code: { ownerId, code: `ALLOC:POOL:${currency}` } } });
    return pool ? -(await this.ledger.balance(db, pool.id)) : 0n;
  }

  async currentAmount(db: Tx | PrismaService, ownerId: string, currency = 'XOF') {
    const { spendableBase } = await this.accounts.liquidTotals(db, ownerId, currency);
    return spendableBase - (await this.totalAllocated(db, ownerId, currency));
  }

  async list(auth: AuthContext) {
    const wallets = await this.prisma.wallet.findMany({ where: { ownerId: auth.ownerId, status: 'ACTIVE' }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
    const goals = await this.prisma.savingsGoal.findMany({ where: { ownerId: auth.ownerId } });
    return Promise.all(wallets.map(async (w) => {
      const g = goals.find((x) => x.walletId === w.id);
      return { ...w, allocatedMinor: await this.allocated(this.prisma, auth.ownerId, w), savingsGoalId: g?.id ?? null, protectionMode: g?.protectionMode ?? null, realityLevel: w.realBalanceGroupId ? 'BACKED_BY_REAL_BALANCE' : 'VIRTUAL_ENVELOPE' };
    }));
  }

  async create(tx: Tx, auth: AuthContext, dto: { name: string; kind: 'RESERVE' }) {
    const w = await tx.wallet.create({ data: { ownerId: auth.ownerId, name: dto.name, kind: dto.kind } });
    await this.allocationAccount(tx, auth.ownerId, w);
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'wallet.created', aggregateType: 'Wallet', aggregateId: w.id, version: 1 });
    return w;
  }

  /**
   * Mouvement d'affectation interne. Sortie d'un coffre d'épargne interdite ici (passer par une demande de retrait : D/llm §7.2).
   * `internal` = appel par le module épargne après application des règles de retrait.
   */
  async move(tx: Tx, auth: AuthContext | { ownerId: string; deviceId: string | null }, businessId: string, dto: { fromWalletId: string; toWalletId: string; amountMinor: bigint; memo?: string }, internal = false, businessType = 'ALLOCATION_TRANSFER') {
    if (dto.amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Montant strictement positif requis');
    if (dto.fromWalletId === dto.toWalletId) throw new DomainError('VALIDATION_FAILED', 'Enveloppes identiques');
    const ownerId = auth.ownerId;
    // Verrou du pool : sérialise les affectations concurrentes multi-appareils.
    const pool = await this.books.core(tx, ownerId, 'ALLOC:POOL');
    await tx.$queryRaw`SELECT 1 FROM "AccountBalance" WHERE "ledgerAccountId" = ${pool.id}::uuid FOR UPDATE`;
    const from = await this.getOwned(tx, ownerId, dto.fromWalletId);
    const to = await this.getOwned(tx, ownerId, dto.toWalletId);
    for (const w of [from]) {
      if (!w.realBalanceGroupId) continue;
      const g = await tx.realBalanceGroup.findUnique({ where: { id: w.realBalanceGroupId } });
      if (g?.status === 'BLOCKED_OUTBOUND') throw new DomainError('BALANCE_RECONCILIATION_BLOCK', 'Sorties de cette balance bloquées par un écart de rapprochement', { reason: g.blockReason });
    }
    if (!internal) {
      const goal = await tx.savingsGoal.findUnique({ where: { walletId: from.id } });
      if (goal) throw new DomainError('SAVINGS_WITHDRAWAL_DELAY', 'Sortie d’un coffre : utilisez une demande de retrait (délai de 72 h)', { goalId: goal.id });
    }
    const available = await this.allocated(tx, ownerId, from);
    if (available < dto.amountMinor) throw new DomainError('INSUFFICIENT_ALLOCATABLE_FUNDS', 'Montant supérieur au disponible de l’enveloppe source', { availableMinor: available });
    const postings = [] as { accountId: string; amount: bigint }[];
    if (from.kind === 'CURRENT') postings.push({ accountId: pool.id, amount: -dto.amountMinor });
    else postings.push({ accountId: await this.allocationAccount(tx, ownerId, from), amount: -dto.amountMinor });
    if (to.kind === 'CURRENT') postings.push({ accountId: pool.id, amount: dto.amountMinor });
    else postings.push({ accountId: await this.allocationAccount(tx, ownerId, to), amount: dto.amountMinor });
    const { transaction } = await this.ledger.post(tx, { ownerId, book: 'ALLOCATION', businessType, businessId, memo: dto.memo ?? `Affectation ${from.name} → ${to.name}`, actorDeviceId: auth.deviceId, postings });
    await this.events.emit(tx, { ownerId, eventType: 'balance.updated', aggregateType: 'Wallet', aggregateId: to.id });
    return { transactionId: transaction.id };
  }
}
