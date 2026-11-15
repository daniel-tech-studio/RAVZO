import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { clock, economicToday, parseDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { percentBpFloor } from '../../common/money';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { WalletsService } from '../accounts/wallets.service';
import { BudgetsService } from '../budgets/budgets.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class IncomeService {
  constructor(
    private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService,
    private wallets: WalletsService, private budgets: BudgetsService, private events: EventsService,
  ) {}

  async list(auth: AuthContext, q: { from?: string; to?: string; limit?: number }) {
    return this.prisma.income.findMany({
      where: { ownerId: auth.ownerId, ...(q.from || q.to ? { economicDate: { ...(q.from ? { gte: parseDateOnly(q.from) } : {}), ...(q.to ? { lte: parseDateOnly(q.to) } : {}) } } : {}) },
      include: { allocations: true }, orderBy: [{ economicDate: 'desc' }, { createdAt: 'desc' }], take: Math.min(q.limit ?? 100, 500),
    });
  }

  async get(auth: AuthContext, id: string) {
    const i = await this.prisma.income.findUnique({ where: { id }, include: { allocations: true } });
    if (!i || i.ownerId !== auth.ownerId) throw notFound('Revenu');
    const plan = await this.prisma.incomeFundingPlan.findFirst({ where: { incomeId: id }, include: { steps: { orderBy: { ordinal: 'asc' } } }, orderBy: { createdAt: 'desc' } });
    return { ...i, fundingPlan: plan };
  }

  /**
   * Revenu économique reconnu UNE seule fois (llm §5.1) : actif +, produit −.
   * Mode EXTERNAL_TRACKING : l'argent arrive sur un compte suivi. Un Payin ultérieur déplace de la trésorerie déjà reconnue.
   */
  async create(tx: Tx, auth: AuthContext, businessId: string, dto: { accountId: string; source: string; nature?: string; categoryId?: string; economicDate?: string; grossMinor: bigint; note?: string; externalRef?: string }) {
    const acc = await this.accounts.getOwned(tx, auth.ownerId, dto.accountId);
    if (acc.type === 'BROKER_CASH') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Les encaissements SGI se saisissent depuis Patrimoine › SGI');
    if (dto.externalRef) {
      const dup = await tx.income.findFirst({ where: { ownerId: auth.ownerId, accountId: acc.id, externalRef: dto.externalRef } });
      if (dup) throw new DomainError('IMPORT_DUPLICATE_SUSPECTED', 'Un revenu avec cette référence existe déjà sur ce compte', { incomeId: dup.id });
    }
    let category = dto.categoryId ? await tx.category.findUnique({ where: { id: dto.categoryId } }) : await tx.category.findFirst({ where: { ownerId: auth.ownerId, type: 'INCOME', name: 'Autres revenus' } });
    if (!category || category.ownerId !== auth.ownerId || category.type !== 'INCOME') throw notFound('Catégorie de revenu');
    const date = dto.economicDate ? parseDateOnly(dto.economicDate) : economicToday();
    const cycle = await this.budgets.cycleFor(tx, auth.ownerId, date);
    const income = await tx.income.create({
      data: { id: businessId, ownerId: auth.ownerId, accountId: acc.id, source: dto.source, nature: dto.nature ?? 'SALARY', categoryId: category.id, economicDate: date, grossMinor: dto.grossMinor, currency: acc.currency, note: dto.note, externalRef: dto.externalRef, cycleId: cycle?.id ?? null },
    });
    const incAcc = await this.books.forCategory(tx, auth.ownerId, category.id, 'INCOME', category.name, acc.currency);
    const { transaction } = await this.ledger.post(tx, {
      ownerId: auth.ownerId, businessType: 'INCOME', businessId: income.id, economicDate: date, memo: `Revenu — ${dto.source}`, actorDeviceId: auth.deviceId,
      postings: [{ accountId: acc.ledgerAccountId, amount: dto.grossMinor }, { accountId: incAcc.id, amount: -dto.grossMinor }],
    });
    const r = await tx.income.update({ where: { id: income.id }, data: { ledgerTransactionId: transaction.id } });
    // Programmes d'épargne liés au revenu : suggestions seulement (jamais de versement automatique).
    const plans = await tx.savingsContributionPlan.findMany({ where: { triggerType: 'INCOME_TRIGGER', active: true, goal: { ownerId: auth.ownerId, status: { in: ['ACTIVE', 'LATE'] } } }, include: { goal: true } });
    for (const p of plans) {
      const amount = this.ruleAmount(p.amountRule, dto.grossMinor);
      if (amount > 0n) await tx.plannedContribution.upsert({ where: { goalId_slotKey: { goalId: p.goalId, slotKey: `INCOME:${income.id}` } }, create: { goalId: p.goalId, slotKey: `INCOME:${income.id}`, dueAt: date, plannedMinor: amount, state: 'DUE', kind: 'INCOME', sourceIncomeId: income.id }, update: {} });
    }
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'Income', aggregateId: income.id, version: 1 });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'INCOME_RECORDED', resource: `Income:${income.id}` });
    return { ...r, offCycle: !cycle, suggestOpenCycle: !(await this.budgets.openCycle(tx, auth.ownerId)) };
  }

  ruleAmount(rule: string, gross: bigint): bigint {
    const [k, v] = rule.split(':');
    if (k === 'FIXED') return BigInt(v);
    if (k === 'PERCENT') return percentBpFloor(gross, BigInt(v));
    return 0n;
  }

  /** Suggestions modifiables, non exécutoires (UX05 étape 2). */
  async proposals(auth: AuthContext, incomeId: string) {
    const income = await this.get(auth, incomeId);
    const goals = await this.prisma.savingsGoal.findMany({ where: { ownerId: auth.ownerId, status: { in: ['ACTIVE', 'LATE'] } }, include: { plan: true } });
    const out: { walletId: string; walletName: string; amountMinor: bigint; reason: string; goalId?: string }[] = [];
    let remaining = income.grossMinor;
    for (const g of goals) {
      if (!g.plan?.active) continue;
      const w = await this.prisma.wallet.findUniqueOrThrow({ where: { id: g.walletId } });
      const saved = await this.wallets.allocated(this.prisma, auth.ownerId, w);
      const gap = g.targetMinor - saved;
      if (gap <= 0n) continue;
      let amt = g.plan.triggerType === 'INCOME_TRIGGER' ? this.ruleAmount(g.plan.amountRule, income.grossMinor) : 0n;
      if (g.plan.triggerType === 'CALENDAR') {
        const due = await this.prisma.plannedContribution.findFirst({ where: { goalId: g.id, state: { in: ['DUE', 'MISSED'] } }, orderBy: { dueAt: 'asc' } });
        amt = due?.plannedMinor ?? 0n;
      }
      amt = amt > gap ? gap : amt;
      amt = amt > remaining ? remaining : amt;
      if (amt > 0n) { out.push({ walletId: w.id, walletName: g.name, amountMinor: amt, reason: g.plan.triggerType === 'INCOME_TRIGGER' ? 'Programme lié au revenu' : 'Versement prévu du programme', goalId: g.id }); remaining -= amt; }
    }
    return { incomeId, grossMinor: income.grossMinor, proposals: out, remainingToCurrentMinor: remaining, binding: false };
  }

  /** Affectation manuelle confirmée (UX05 étape 3) : mouvements d'affectation uniquement, revenu jamais recrédité. */
  async confirmAllocations(tx: Tx, auth: AuthContext, incomeId: string, dto: { allocations: { walletId: string; amountMinor: bigint }[]; expectedVersion?: number }) {
    const income = await tx.income.findUnique({ where: { id: incomeId } });
    if (!income || income.ownerId !== auth.ownerId) throw notFound('Revenu');
    await tx.$queryRaw`SELECT id FROM "Income" WHERE id = ${income.id}::uuid FOR UPDATE`;
    const fresh = await tx.income.findUniqueOrThrow({ where: { id: incomeId } });
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== fresh.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Revenu modifié ailleurs', { current: fresh });
    if (fresh.recordingStatus === 'ALLOCATED') throw new DomainError('STATE_CONFLICT', 'Répartition déjà confirmée');
    const total = dto.allocations.reduce((s, a) => s + a.amountMinor, 0n);
    if (total > fresh.grossMinor) throw new DomainError('BUSINESS_RULE_VIOLATION', 'La répartition dépasse le montant du revenu', { grossMinor: fresh.grossMinor, totalMinor: total });
    if (new Set(dto.allocations.map((a) => a.walletId)).size !== dto.allocations.length) throw new DomainError('VALIDATION_FAILED', 'Enveloppe en double');
    const current = await this.wallets.currentWallet(tx, auth.ownerId);
    for (const a of dto.allocations) {
      if (a.amountMinor <= 0n) throw new DomainError('VALIDATION_FAILED', 'Montants positifs requis');
      if (a.walletId === current.id) continue; // reste dans le courant
      await this.wallets.move(tx, auth, `${income.id}:${a.walletId}`, { fromWalletId: current.id, toWalletId: a.walletId, amountMinor: a.amountMinor, memo: `Répartition du revenu ${income.source}` }, true, 'INCOME_ALLOCATION');
      await tx.incomeAllocation.create({ data: { incomeId: income.id, walletId: a.walletId, amountMinor: a.amountMinor, confirmedAt: clock.now() } });
      const goal = await tx.savingsGoal.findUnique({ where: { walletId: a.walletId } });
      if (goal) {
        await tx.plannedContribution.updateMany({ where: { goalId: goal.id, sourceIncomeId: income.id, state: 'DUE' }, data: { state: 'CONFIRMED', confirmedMinor: a.amountMinor, confirmedAt: clock.now() } });
        await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'savings.updated', aggregateType: 'SavingsGoal', aggregateId: goal.id });
      }
    }
    const r = await tx.income.update({ where: { id: income.id }, data: { recordingStatus: 'ALLOCATED', version: { increment: 1 } }, include: { allocations: true } });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'INCOME_ALLOCATION_CONFIRMED', resource: `Income:${income.id}`, context: { count: dto.allocations.length } });
    return r;
  }
}
