import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { clock, DAY, economicToday, parseDateOnly, toDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { maxBig } from '../../common/money';
import { PrismaService, Tx } from '../../common/prisma.service';
import { occurrencesBetween, validateRule } from './schedule';

@Injectable()
export class BudgetsService {
  constructor(private prisma: PrismaService, private events: EventsService) {}

  // ─── Catégories ───
  async categories(auth: AuthContext, type?: string) {
    return this.prisma.category.findMany({ where: { ownerId: auth.ownerId, ...(type ? { type } : {}) }, orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  }
  async createCategory(auth: AuthContext, dto: { name: string; type: 'EXPENSE' | 'INCOME'; parentId?: string; icon?: string; essential?: boolean; keywords?: string[] }) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.ownerId !== auth.ownerId || parent.type !== dto.type) throw notFound('Catégorie parente');
      if (parent.parentId) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Arborescence limitée à deux niveaux');
    }
    return this.prisma.category.create({ data: { ownerId: auth.ownerId, name: dto.name, type: dto.type, parentId: dto.parentId, icon: dto.icon, essential: dto.essential ?? false, keywords: dto.keywords ?? [] } });
  }
  async updateCategory(auth: AuthContext, id: string, dto: { name?: string; parentId?: string | null; icon?: string; essential?: boolean; keywords?: string[]; active?: boolean }) {
    const c = await this.prisma.category.findUnique({ where: { id } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Catégorie');
    if (dto.parentId) {
      if (dto.parentId === id) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Boucle de catégories interdite');
      const parent = await this.prisma.category.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.ownerId !== auth.ownerId || parent.type !== c.type || parent.parentId) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Parent invalide (deux niveaux max, pas de boucle)');
      const children = await this.prisma.category.count({ where: { parentId: id } });
      if (children) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Une catégorie ayant des sous-catégories ne peut pas devenir enfant');
    }
    return this.prisma.category.update({ where: { id }, data: dto });
  }
  /** Catégorisation suggérée (modifiable) : correspondance de mots-clés puis historique du libellé. */
  async suggestCategory(db: Tx | PrismaService, ownerId: string, label: string, merchant?: string) {
    const text = `${label} ${merchant ?? ''}`.toLowerCase();
    const cats = await db.category.findMany({ where: { ownerId, type: 'EXPENSE', active: true } });
    const hit = cats.find((c) => c.keywords.some((k) => k && text.includes(k.toLowerCase())));
    if (hit) return { categoryId: hit.id, confidence: 'KEYWORD' };
    const prev = await db.expense.findFirst({ where: { ownerId, OR: [{ label: { equals: label, mode: 'insensitive' } }, ...(merchant ? [{ merchant: { equals: merchant, mode: 'insensitive' as const } }] : [])] }, orderBy: { createdAt: 'desc' } });
    if (prev) return { categoryId: prev.categoryId, confidence: 'HISTORY' };
    const misc = cats.find((c) => c.name === 'Divers') ?? cats[0];
    return { categoryId: misc?.id ?? null, confidence: 'DEFAULT' };
  }

  // ─── Cycles ───
  async openCycle(db: Tx | PrismaService, ownerId: string) {
    return db.budgetCycle.findFirst({ where: { ownerId, state: 'OPEN' } });
  }
  /** Cycle ouvert couvrant la date économique, sinon null (opération hors cycle). */
  async cycleFor(db: Tx | PrismaService, ownerId: string, date: Date) {
    const c = await this.openCycle(db, ownerId);
    return c && date >= c.startsAt && date <= c.plannedEndAt ? c : null;
  }

  async listCycles(auth: AuthContext) {
    return this.prisma.budgetCycle.findMany({ where: { ownerId: auth.ownerId }, orderBy: { startsAt: 'desc' }, take: 24 });
  }
  async getCycle(auth: AuthContext, id: string) {
    const c = await this.prisma.budgetCycle.findUnique({ where: { id }, include: { budgets: true } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cycle');
    return c;
  }

  /** Ouverture MANUELLE (llm §6.3). Durée suggérée 30 j ; budgets éventuellement repris du cycle précédent. */
  async openNewCycle(tx: Tx, auth: AuthContext, dto: { label?: string; startsAt?: string; plannedEndAt?: string; durationDays?: number; anchorIncomeId?: string; copyBudgetsFromPrevious?: boolean }) {
    const existing = await this.openCycle(tx, auth.ownerId);
    if (existing) throw new DomainError('STATE_CONFLICT', 'Un cycle est déjà ouvert', { cycleId: existing.id });
    const startsAt = dto.startsAt ? parseDateOnly(dto.startsAt) : economicToday();
    const plannedEndAt = dto.plannedEndAt ? parseDateOnly(dto.plannedEndAt) : new Date(startsAt.getTime() + ((dto.durationDays ?? 30) - 1) * DAY);
    if (plannedEndAt < startsAt) throw new DomainError('VALIDATION_FAILED', 'La fin doit suivre le début');
    const last = await tx.budgetCycle.findFirst({ where: { ownerId: auth.ownerId, state: 'CLOSED' }, orderBy: { plannedEndAt: 'desc' } });
    if (last && startsAt <= last.plannedEndAt) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Le nouveau cycle ne peut pas chevaucher un cycle clôturé', { lastEnd: toDateOnly(last.plannedEndAt) });
    const c = await tx.budgetCycle.create({ data: { ownerId: auth.ownerId, label: dto.label ?? `Cycle du ${toDateOnly(startsAt)}`, startsAt, plannedEndAt, anchorIncomeId: dto.anchorIncomeId } });
    if (dto.copyBudgetsFromPrevious && last) {
      const prev = await tx.budget.findMany({ where: { cycleId: last.id } });
      for (const b of prev) await tx.budget.create({ data: { ownerId: auth.ownerId, cycleId: c.id, categoryId: b.categoryId, plannedMinor: b.plannedMinor, alertThreshold: b.alertThreshold, essential: b.essential } });
    }
    // Les revenus déjà saisis dans l'intervalle (hors cycle) sont rattachés au cycle en cours (llm §6.3 « revenus additionnels »).
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'budget.cycle_opened', aggregateType: 'BudgetCycle', aggregateId: c.id, version: 1 });
    return c;
  }

  /** Clôture : figée, instantané des chiffres ; jamais réécrite ensuite. Idempotente. */
  async closeCycle(tx: Tx, ownerId: string, cycleId: string, reason: 'SCHEDULED' | 'MANUAL') {
    const c = await tx.budgetCycle.findUnique({ where: { id: cycleId } });
    if (!c || c.ownerId !== ownerId) throw notFound('Cycle');
    if (c.state === 'CLOSED') return c;
    const snapshot = await this.cycleAnalytics(tx, ownerId, c.id);
    const closed = await tx.budgetCycle.update({ where: { id: c.id, version: c.version }, data: { state: 'CLOSED', closedAt: clock.now(), closingSnapshot: JSON.parse(JSON.stringify(snapshot, (_, v) => (typeof v === 'bigint' ? v.toString() : v))), version: { increment: 1 } } });
    await this.events.notify(tx, { ownerId, sourceEventId: `cycle-closed:${c.id}`, type: 'budget.cycle_closed', category: 'BUDGET', priority: 'NORMAL', title: 'Cycle budgétaire clôturé', body: `« ${c.label} » est clôturé (${reason === 'SCHEDULED' ? 'date prévue atteinte' : 'clôture manuelle'}). Ouvrez le prochain cycle quand vous recevez votre revenu.`, link: `/money/budgets/cycles/${c.id}` });
    return closed;
  }

  async closeDueCycles() {
    const today = economicToday();
    const due = await this.prisma.budgetCycle.findMany({ where: { state: 'OPEN', plannedEndAt: { lt: today } } });
    for (const c of due) await this.prisma.tx((tx) => this.closeCycle(tx, c.ownerId, c.id, 'SCHEDULED'));
    return due.length;
  }

  async offCycleItems(auth: AuthContext) {
    const [expenses, incomes] = await Promise.all([
      this.prisma.expense.findMany({ where: { ownerId: auth.ownerId, cycleId: null, status: 'POSTED' }, orderBy: { economicDate: 'desc' }, take: 200 }),
      this.prisma.income.findMany({ where: { ownerId: auth.ownerId, cycleId: null }, orderBy: { economicDate: 'desc' }, take: 200 }),
    ]);
    return { expenses, incomes };
  }

  /** Rattachement approuvé d'opérations hors cycle au cycle OUVERT uniquement (jamais à un cycle clôturé). */
  async assignOffCycle(tx: Tx, auth: AuthContext, cycleId: string, dto: { expenseIds?: string[]; incomeIds?: string[] }) {
    const c = await tx.budgetCycle.findUnique({ where: { id: cycleId } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cycle');
    if (c.state !== 'OPEN') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Un cycle clôturé ne peut pas être modifié');
    const e = await tx.expense.updateMany({ where: { id: { in: dto.expenseIds ?? [] }, ownerId: auth.ownerId, cycleId: null }, data: { cycleId: c.id } });
    const i = await tx.income.updateMany({ where: { id: { in: dto.incomeIds ?? [] }, ownerId: auth.ownerId, cycleId: null }, data: { cycleId: c.id } });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'OFF_CYCLE_ASSIGNED', resource: `BudgetCycle:${c.id}`, context: { expenses: e.count, incomes: i.count } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'budget.updated', aggregateType: 'BudgetCycle', aggregateId: c.id });
    return { assignedExpenses: e.count, assignedIncomes: i.count };
  }

  // ─── Budgets ───
  async listBudgets(auth: AuthContext, cycleId?: string) {
    const cycle = cycleId ? await this.getCycle(auth, cycleId) : await this.openCycle(this.prisma, auth.ownerId);
    if (!cycle) return [];
    return this.prisma.budget.findMany({ where: { cycleId: cycle.id } });
  }
  async createBudget(tx: Tx, auth: AuthContext, dto: { cycleId: string; categoryId: string; plannedMinor: bigint; alertThreshold?: number; essential?: boolean }) {
    const c = await tx.budgetCycle.findUnique({ where: { id: dto.cycleId } });
    if (!c || c.ownerId !== auth.ownerId) throw notFound('Cycle');
    if (c.state !== 'OPEN') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Cycle clôturé : budgets figés');
    const cat = await tx.category.findUnique({ where: { id: dto.categoryId } });
    if (!cat || cat.ownerId !== auth.ownerId || cat.type !== 'EXPENSE') throw notFound('Catégorie de dépense');
    const b = await tx.budget.create({ data: { ownerId: auth.ownerId, cycleId: c.id, categoryId: cat.id, plannedMinor: dto.plannedMinor, alertThreshold: dto.alertThreshold ?? 80, essential: dto.essential ?? cat.essential } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'budget.updated', aggregateType: 'Budget', aggregateId: b.id, version: 1 });
    return b;
  }
  async updateBudget(tx: Tx, auth: AuthContext, id: string, dto: { plannedMinor?: bigint; alertThreshold?: number; essential?: boolean; expectedVersion?: number }) {
    const b = await tx.budget.findUnique({ where: { id }, include: { cycle: true } });
    if (!b || b.ownerId !== auth.ownerId) throw notFound('Budget');
    if (b.cycle.state !== 'OPEN') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Cycle clôturé : budgets figés');
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== b.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Budget modifié ailleurs', { current: b });
    const { expectedVersion, ...data } = dto;
    const r = await tx.budget.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'budget.updated', aggregateType: 'Budget', aggregateId: id, version: r.version });
    return r;
  }

  /** Réel vs prévu, prévision linéaire, statut d'alerte (non bloquant), série cumulée. */
  async cycleAnalytics(db: Tx | PrismaService, ownerId: string, cycleId: string) {
    const c = await db.budgetCycle.findUnique({ where: { id: cycleId }, include: { budgets: true } });
    if (!c || c.ownerId !== ownerId) throw notFound('Cycle');
    const cats = await db.category.findMany({ where: { ownerId } });
    const expenses = await db.expense.findMany({ where: { ownerId, cycleId: c.id, status: 'POSTED' } });
    const incomes = await db.income.findMany({ where: { ownerId, cycleId: c.id } });
    const today = economicToday();
    const totalDays = Math.round((c.plannedEndAt.getTime() - c.startsAt.getTime()) / DAY) + 1;
    const elapsed = Math.min(totalDays, Math.max(1, Math.round((Math.min(today.getTime(), c.plannedEndAt.getTime()) - c.startsAt.getTime()) / DAY) + 1));
    const spentBy = new Map<string, bigint>();
    for (const e of expenses) spentBy.set(e.categoryId, (spentBy.get(e.categoryId) ?? 0n) + e.amountMinor);
    const categories = c.budgets.map((b) => {
      const spent = spentBy.get(b.categoryId) ?? 0n;
      const pct = b.plannedMinor > 0n ? Number((spent * 1000n) / b.plannedMinor) / 10 : spent > 0n ? 999 : 0;
      const forecast = c.state === 'OPEN' ? (spent * BigInt(totalDays)) / BigInt(elapsed) : spent;
      const cat = cats.find((x) => x.id === b.categoryId);
      return {
        budgetId: b.id, categoryId: b.categoryId, categoryName: cat?.name, icon: cat?.icon, essential: b.essential, version: b.version,
        plannedMinor: b.plannedMinor, spentMinor: spent, remainingMinor: b.plannedMinor - spent, percentUsed: pct, forecastMinor: forecast,
        status: pct >= 100 ? 'EXCEEDED' : pct >= b.alertThreshold ? 'WARNING' : 'OK', alertThreshold: b.alertThreshold,
      };
    });
    const unbudgeted = [...spentBy.entries()].filter(([cid]) => !c.budgets.some((b) => b.categoryId === cid)).map(([cid, s]) => ({ categoryId: cid, categoryName: cats.find((x) => x.id === cid)?.name, spentMinor: s }));
    // Série cumulée journalière (confirmé/suivi) + projection (prévision).
    const daily: { date: string; cumulativeSpentMinor: bigint; kind: 'TRACKED' | 'FORECAST' }[] = [];
    let cum = 0n;
    const totalPlanned = c.budgets.reduce((s, b) => s + b.plannedMinor, 0n);
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(c.startsAt.getTime() + i * DAY);
      if (d <= today || c.state === 'CLOSED') {
        cum += expenses.filter((e) => e.economicDate.getTime() === d.getTime()).reduce((s, e) => s + e.amountMinor, 0n);
        daily.push({ date: toDateOnly(d), cumulativeSpentMinor: cum, kind: 'TRACKED' });
      } else {
        daily.push({ date: toDateOnly(d), cumulativeSpentMinor: (cum * BigInt(i + 1)) / BigInt(elapsed), kind: 'FORECAST' });
      }
    }
    const spentTotal = expenses.reduce((s, e) => s + e.amountMinor, 0n);
    return {
      cycle: { id: c.id, label: c.label, startsAt: toDateOnly(c.startsAt), plannedEndAt: toDateOnly(c.plannedEndAt), state: c.state, closedAt: c.closedAt, totalDays, elapsedDays: elapsed },
      totals: { plannedMinor: totalPlanned, spentMinor: spentTotal, incomeMinor: incomes.reduce((s, i) => s + i.grossMinor, 0n), forecastSpentMinor: c.state === 'OPEN' ? (spentTotal * BigInt(totalDays)) / BigInt(elapsed) : spentTotal },
      categories, unbudgeted, daily, dataLabels: { actual: 'TRACKED', forecast: 'FORECAST' },
      frozen: c.state === 'CLOSED' ? c.closingSnapshot : null,
    };
  }

  /** Avertissement post-dépense (jamais bloquant : llm §6.3). */
  async budgetWarnings(tx: Tx, ownerId: string, cycleId: string | null, categoryId: string, sourceId: string) {
    if (!cycleId) return [];
    const b = await tx.budget.findUnique({ where: { cycleId_categoryId: { cycleId, categoryId } } });
    if (!b) return [];
    const spent = (await tx.expense.aggregate({ where: { ownerId, cycleId, categoryId, status: 'POSTED' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
    const pct = b.plannedMinor > 0n ? Number((spent * 100n) / b.plannedMinor) : 100;
    const cat = await tx.category.findUnique({ where: { id: categoryId } });
    if (pct >= 100) {
      await this.events.notify(tx, { ownerId, sourceEventId: `budget-exceeded:${b.id}`, type: 'budget.exceeded', category: 'BUDGET', priority: 'HIGH', title: `Budget ${cat?.name} dépassé`, body: 'Le budget prévu pour ce cycle est dépassé. Rien n’est bloqué.', link: '/money/budgets' });
      return [{ code: 'BUDGET_EXCEEDED', budgetId: b.id, percentUsed: pct }];
    }
    if (pct >= b.alertThreshold) {
      await this.events.notify(tx, { ownerId, sourceEventId: `budget-threshold:${b.id}`, type: 'budget.threshold', category: 'BUDGET', priority: 'NORMAL', title: `Budget ${cat?.name} à ${pct} %`, body: `Seuil d’alerte de ${b.alertThreshold} % atteint.`, link: '/money/budgets' });
      return [{ code: 'BUDGET_THRESHOLD', budgetId: b.id, percentUsed: pct }];
    }
    return [];
  }

  // ─── Charges récurrentes ───
  async listObligations(auth: AuthContext) {
    const obs = await this.prisma.recurringObligation.findMany({ where: { ownerId: auth.ownerId }, include: { occurrences: { where: { dueDate: { gte: new Date(economicToday().getTime() - 60 * DAY) } }, orderBy: { dueDate: 'asc' }, take: 6 } }, orderBy: { nextDueDate: 'asc' } });
    return obs;
  }
  async createObligation(tx: Tx, auth: AuthContext, dto: { label: string; kind: string; amountMinor: bigint; scheduleRule: string; nextDueDate: string; categoryId: string; essential?: boolean }) {
    if (!validateRule(dto.scheduleRule)) throw new DomainError('VALIDATION_FAILED', 'Règle de récurrence invalide (MONTHLY:j, WEEKLY:j, EVERY_N_DAYS:n)');
    const cat = await tx.category.findUnique({ where: { id: dto.categoryId } });
    if (!cat || cat.ownerId !== auth.ownerId) throw notFound('Catégorie');
    const o = await tx.recurringObligation.create({ data: { ownerId: auth.ownerId, label: dto.label, kind: dto.kind, amountMinor: dto.amountMinor, scheduleRule: dto.scheduleRule, nextDueDate: parseDateOnly(dto.nextDueDate), categoryId: cat.id, essential: dto.essential ?? true } });
    await this.rollOccurrences(tx, o.id);
    return o;
  }
  async updateObligation(tx: Tx, auth: AuthContext, id: string, dto: { label?: string; amountMinor?: bigint; active?: boolean; essential?: boolean }) {
    const o = await tx.recurringObligation.findUnique({ where: { id } });
    if (!o || o.ownerId !== auth.ownerId) throw notFound('Charge');
    const r = await tx.recurringObligation.update({ where: { id }, data: dto });
    if (dto.amountMinor !== undefined) await tx.obligationOccurrence.updateMany({ where: { obligationId: id, state: 'FORECAST' }, data: { expectedMinor: dto.amountMinor } });
    if (dto.active === false) await tx.obligationOccurrence.updateMany({ where: { obligationId: id, state: 'FORECAST' }, data: { state: 'SKIPPED' } });
    return r;
  }
  /** Prévisions jusqu'à +90 j. Jamais de paiement automatique. */
  async rollOccurrences(tx: Tx, obligationId: string) {
    const o = await tx.recurringObligation.findUniqueOrThrow({ where: { id: obligationId } });
    if (!o.active) return;
    const today = economicToday();
    const dates = occurrencesBetween(o.scheduleRule, o.nextDueDate, new Date(today.getTime() - 31 * DAY), new Date(today.getTime() + 90 * DAY));
    for (const d of dates) {
      await tx.obligationOccurrence.upsert({ where: { obligationId_dueDate: { obligationId, dueDate: d } }, create: { obligationId, dueDate: d, expectedMinor: o.amountMinor, state: d <= today ? 'DUE' : 'FORECAST' }, update: {} });
    }
    await tx.obligationOccurrence.updateMany({ where: { obligationId, state: 'FORECAST', dueDate: { lte: today } }, data: { state: 'DUE' } });
  }
  async skipOccurrence(tx: Tx, auth: AuthContext, occurrenceId: string) {
    const oc = await tx.obligationOccurrence.findUnique({ where: { id: occurrenceId }, include: { obligation: true } });
    if (!oc || oc.obligation.ownerId !== auth.ownerId) throw notFound('Échéance');
    if (oc.state === 'SETTLED') throw new DomainError('STATE_CONFLICT', 'Échéance déjà réglée');
    return tx.obligationOccurrence.update({ where: { id: oc.id }, data: { state: 'SKIPPED' } });
  }
  async rollAllObligations() {
    const obs = await this.prisma.recurringObligation.findMany({ where: { active: true } });
    for (const o of obs) await this.prisma.tx((tx) => this.rollOccurrences(tx, o.id));
    return obs.length;
  }

  /** Réservations virtuelles pour le disponible conseillé, sans double imputation (backend.md §8). */
  async spendableReservations(db: Tx | PrismaService, ownerId: string) {
    const cycle = await this.openCycle(db, ownerId);
    const today = economicToday();
    const horizon = cycle ? cycle.plannedEndAt : new Date(today.getTime() + 30 * DAY);
    let essentialBudgets = 0n;
    const budgetCats = new Set<string>();
    if (cycle) {
      const budgets = await db.budget.findMany({ where: { cycleId: cycle.id } });
      for (const b of budgets) {
        budgetCats.add(b.categoryId);
        if (!b.essential) continue;
        const spent = (await db.expense.aggregate({ where: { ownerId, cycleId: cycle.id, categoryId: b.categoryId, status: 'POSTED' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
        essentialBudgets += maxBig(0n, b.plannedMinor - spent);
      }
    }
    // Obligations non réglées d'ici l'horizon, hors catégories déjà couvertes par un budget (pas de double retrait).
    const occ = await db.obligationOccurrence.findMany({ where: { obligation: { ownerId, active: true }, state: { in: ['FORECAST', 'DUE'] }, dueDate: { lte: horizon } }, include: { obligation: true } });
    const obligations = occ.filter((o) => !budgetCats.has(o.obligation.categoryId)).reduce((s, o) => s + o.expectedMinor, 0n);
    const plans = (await db.allocationReservation.aggregate({ where: { ownerId, state: 'ACTIVE' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
    // Dettes : échéances dues d'ici l'horizon.
    const inst = await db.liabilityInstallment.findMany({ where: { liability: { ownerId, kind: { in: ['DEBT', 'FUTURE_COMMITMENT'] }, state: 'ACTIVE' }, state: { in: ['SCHEDULED', 'LATE', 'PARTIAL'] }, dueDate: { lte: horizon } } });
    const debts = inst.reduce((s, i) => s + i.principalDueMinor + i.interestDueMinor, 0n);
    return { essentialBudgetsMinor: essentialBudgets, obligationsMinor: obligations, purchasePlansMinor: plans, debtInstallmentsMinor: debts, totalMinor: essentialBudgets + obligations + plans + debts, horizon: toDateOnly(horizon), cycleId: cycle?.id ?? null };
  }
}
