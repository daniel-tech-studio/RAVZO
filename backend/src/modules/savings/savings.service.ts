import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth';
import { addMs, clock, DAY, economicToday, HOUR, parseDateOnly, toDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { maxBig, percentBpFloor } from '../../common/money';
import { PrismaService, Tx } from '../../common/prisma.service';
import { WalletsService } from '../accounts/wallets.service';
import { nextOccurrence, occurrencesBetween, validateRule } from '../budgets/schedule';

export const WITHDRAWAL_DELAY_MS = 72 * HOUR;
export const EXCEPTIONAL_CAP_BP = 2000n; // 20 %
export const EXCEPTIONAL_WINDOW_MS = 30 * DAY;
/** Contributions confirmées depuis moins de 72 h exclues de la base (anti « dépôt-puis-retrait », ADR-003). */
export const BASE_COOLDOWN_MS = 72 * HOUR;
export const ADVISORY_NOTICE = 'Discipline indicative : fonds non immobilisés techniquement. RAVZO refuse ses propres sorties hors règles, mais ne peut pas empêcher un retrait direct chez votre banque ou opérateur.';

@Injectable()
export class SavingsService {
  constructor(private prisma: PrismaService, private wallets: WalletsService, private events: EventsService) {}

  private async goalOwned(db: Tx | PrismaService, ownerId: string, id: string) {
    const g = await db.savingsGoal.findUnique({ where: { id }, include: { plan: true } });
    if (!g || g.ownerId !== ownerId) throw notFound('Coffre');
    return g;
  }

  async saved(db: Tx | PrismaService, ownerId: string, walletId: string) {
    const w = await db.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return this.wallets.allocated(db, ownerId, w);
  }

  async present(db: Tx | PrismaService, ownerId: string, g: any) {
    const saved = await this.saved(db, ownerId, g.walletId);
    const contributions = await db.plannedContribution.findMany({ where: { goalId: g.id }, orderBy: { dueAt: 'asc' } });
    const withdrawals = await db.savingsWithdrawalRequest.findMany({ where: { goalId: g.id }, orderBy: { requestedAt: 'desc' } });
    const today = economicToday();
    const daysLeft = Math.round((g.deadline.getTime() - today.getTime()) / DAY);
    const progress = g.targetMinor > 0n ? Number((saved * 10000n) / g.targetMinor) / 100 : 0;
    const confirmed = contributions.filter((c: any) => c.state === 'CONFIRMED');
    const missed = contributions.filter((c: any) => c.state === 'MISSED');
    return {
      ...g, savedMinor: saved, remainingMinor: maxBig(0n, g.targetMinor - saved), progressPercent: Math.min(progress, 999), daysLeft,
      onTrack: saved >= g.targetMinor || this.expectedByNow(g, contributions) <= saved,
      protection: { mode: g.protectionMode, notice: g.protectionMode === 'ADVISORY' ? ADVISORY_NOTICE : 'Sorties contrôlées par l’infrastructure', evidence: g.protectionEvidenceRef },
      stats: { confirmedCount: confirmed.length, missedCount: missed.length, confirmedTotalMinor: confirmed.reduce((s: bigint, c: any) => s + (c.confirmedMinor ?? 0n), 0n) },
      contributions, withdrawals,
    };
  }

  private expectedByNow(g: any, contributions: any[]) {
    const today = economicToday();
    return contributions.filter((c) => c.kind === 'SCHEDULED' && c.dueAt <= today).reduce((s, c) => s + c.plannedMinor, 0n);
  }

  async list(auth: AuthContext) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { ownerId: auth.ownerId, status: { not: 'ARCHIVED' } }, include: { plan: true }, orderBy: { createdAt: 'asc' } });
    const items = await Promise.all(goals.map((g) => this.present(this.prisma, auth.ownerId, g)));
    const totalSaved = items.reduce((s, g) => s + g.savedMinor, 0n);
    const totalTarget = items.reduce((s, g) => s + g.targetMinor, 0n);
    return { goals: items, totals: { savedMinor: totalSaved, targetMinor: totalTarget, progressPercent: totalTarget > 0n ? Number((totalSaved * 10000n) / totalTarget) / 100 : 0, lateCount: items.filter((g) => g.status === 'LATE').length } };
  }
  async get(auth: AuthContext, id: string) { return this.present(this.prisma, auth.ownerId, await this.goalOwned(this.prisma, auth.ownerId, id)); }

  /** Cible + échéance + programme OBLIGATOIRES (llm §7.1). Protection ADVISORY tant qu'aucun PSP ne garantit le blocage (D48). */
  async create(tx: Tx, auth: AuthContext, dto: { name: string; icon?: string; targetMinor: bigint; deadline: string; plan: { triggerType: 'CALENDAR' | 'INCOME_TRIGGER'; amountRule: string; scheduleRule?: string } }) {
    const deadline = parseDateOnly(dto.deadline, 'deadline');
    if (deadline <= economicToday()) throw new DomainError('VALIDATION_FAILED', 'L’échéance doit être future');
    this.validatePlan(dto.plan);
    const wallet = await tx.wallet.create({ data: { ownerId: auth.ownerId, name: dto.name, kind: 'SAVINGS' } });
    await this.wallets.allocationAccount(tx, auth.ownerId, wallet);
    const g = await tx.savingsGoal.create({
      data: {
        ownerId: auth.ownerId, walletId: wallet.id, name: dto.name, icon: dto.icon, targetMinor: dto.targetMinor, deadline, protectionMode: 'ADVISORY',
        protectionEvidenceRef: 'Aucun prestataire ne garantit l’immobilisation des fonds (PAYMENTS_LIVE_ENABLED=false)',
        plan: { create: { triggerType: dto.plan.triggerType, amountRule: dto.plan.amountRule, scheduleRule: dto.plan.scheduleRule } },
      },
      include: { plan: true },
    });
    await this.generateSchedule(tx, g);
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'savings.updated', aggregateType: 'SavingsGoal', aggregateId: g.id, version: 1 });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'SAVINGS_GOAL_CREATED', resource: `SavingsGoal:${g.id}` });
    return this.present(tx, auth.ownerId, g);
  }

  private validatePlan(p: { triggerType: string; amountRule: string; scheduleRule?: string }) {
    const [k, v] = p.amountRule.split(':');
    if (!['FIXED', 'PERCENT'].includes(k) || !/^\d{1,15}$/.test(v ?? '') || BigInt(v) <= 0n) throw new DomainError('VALIDATION_FAILED', 'amountRule : FIXED:<montant> ou PERCENT:<points de base>');
    if (k === 'PERCENT' && BigInt(v) > 10000n) throw new DomainError('VALIDATION_FAILED', 'Pourcentage maximal 100 %');
    if (p.triggerType === 'CALENDAR') {
      if (k !== 'FIXED') throw new DomainError('VALIDATION_FAILED', 'Un programme calendaire utilise un montant fixe');
      if (!p.scheduleRule || !validateRule(p.scheduleRule)) throw new DomainError('VALIDATION_FAILED', 'scheduleRule requise (MONTHLY:j ou WEEKLY:j)');
    }
  }

  /** Versements PLANIFIÉS (suggestions), jamais exécutés automatiquement. */
  private async generateSchedule(tx: Tx, g: { id: string; deadline: Date; plan: { triggerType: string; amountRule: string; scheduleRule: string | null } | null }) {
    if (!g.plan || g.plan.triggerType !== 'CALENDAR' || !g.plan.scheduleRule) return;
    const today = economicToday();
    const first = nextOccurrence(g.plan.scheduleRule, new Date(today.getTime() - DAY));
    const amount = BigInt(g.plan.amountRule.split(':')[1]);
    for (const d of occurrencesBetween(g.plan.scheduleRule, first, today, g.deadline, 120)) {
      await tx.plannedContribution.upsert({ where: { goalId_slotKey: { goalId: g.id, slotKey: `SCHEDULED:${toDateOnly(d)}` } }, create: { goalId: g.id, slotKey: `SCHEDULED:${toDateOnly(d)}`, dueAt: d, plannedMinor: amount, state: d <= today ? 'DUE' : 'PLANNED' }, update: {} });
    }
  }

  /** Préparation : suggestions (dû, manqués, rattrapage) — aucun mouvement. */
  async prepareContribution(auth: AuthContext, goalId: string) {
    const g = await this.present(this.prisma, auth.ownerId, await this.goalOwned(this.prisma, auth.ownerId, goalId));
    const due = g.contributions.filter((c: any) => c.state === 'DUE' || c.state === 'MISSED');
    const futureCount = g.contributions.filter((c: any) => c.state === 'PLANNED').length;
    const missedTotal = g.contributions.filter((c: any) => c.state === 'MISSED').reduce((s: bigint, c: any) => s + c.plannedMinor, 0n);
    const catchUp = missedTotal > 0n && futureCount > 0 ? { perContributionExtraMinor: (missedTotal + BigInt(futureCount) - 1n) / BigInt(futureCount), over: futureCount, imposed: false } : null;
    const nextPlanned = g.contributions.find((c: any) => c.state === 'PLANNED');
    const suggestedMinor = due.length ? due[0].plannedMinor : nextPlanned ? nextPlanned.plannedMinor : g.remainingMinor;
    return { goalId, suggestedMinor: suggestedMinor > g.remainingMinor ? g.remainingMinor : suggestedMinor, due, catchUpSuggestion: catchUp, executesMovement: false };
  }

  /** Confirmation explicite : affectation courant → coffre (virtuelle en mode ADVISORY). */
  async confirmContribution(tx: Tx, auth: AuthContext, goalId: string, contributionId: string, amountMinor: bigint) {
    const g = await this.goalOwned(tx, auth.ownerId, goalId);
    if (['RELEASED', 'ARCHIVED'].includes(g.status)) throw new DomainError('STATE_CONFLICT', 'Coffre clos');
    let c;
    if (contributionId === 'manual') {
      c = await tx.plannedContribution.create({ data: { goalId, dueAt: economicToday(), plannedMinor: amountMinor, state: 'DUE', kind: 'MANUAL', slotKey: `MANUAL:${randomUUID()}` } });
    } else {
      c = await tx.plannedContribution.findUnique({ where: { id: contributionId } });
      if (!c || c.goalId !== goalId) throw notFound('Versement');
      if (!['PLANNED', 'DUE', 'MISSED'].includes(c.state)) throw new DomainError('STATE_CONFLICT', 'Versement déjà traité');
    }
    const current = await this.wallets.currentWallet(tx, auth.ownerId);
    const { transactionId } = await this.wallets.move(tx, auth, `contribution:${c.id}`, { fromWalletId: current.id, toWalletId: g.walletId, amountMinor, memo: `Versement coffre ${g.name}` }, true, 'SAVINGS_CONTRIBUTION');
    await tx.plannedContribution.update({ where: { id: c.id }, data: { state: 'CONFIRMED', confirmedMinor: amountMinor, confirmedAt: clock.now(), actualAllocationTxId: transactionId } });
    const saved = await this.saved(tx, auth.ownerId, g.walletId);
    if (saved >= g.targetMinor && g.status !== 'TARGET_REACHED') {
      await tx.savingsGoal.update({ where: { id: g.id }, data: { status: 'TARGET_REACHED', version: { increment: 1 } } });
      await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `goal-reached:${g.id}`, type: 'savings.target_reached', category: 'SAVINGS', priority: 'NORMAL', title: `Objectif « ${g.name} » atteint 🎉`, body: 'Le coffre reste protégé : un déblocage demande une décision explicite et un délai de 72 h.', link: `/savings/${g.id}` });
    }
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'savings.updated', aggregateType: 'SavingsGoal', aggregateId: g.id });
    return this.present(tx, auth.ownerId, await this.goalOwned(tx, auth.ownerId, goalId));
  }

  /** Replanification versionnée : n'altère ni l'historique, ni les retraits ; jamais de libération automatique. */
  async update(tx: Tx, auth: AuthContext, goalId: string, dto: { name?: string; icon?: string; targetMinor?: bigint; deadline?: string; plan?: { triggerType: 'CALENDAR' | 'INCOME_TRIGGER'; amountRule: string; scheduleRule?: string }; expectedVersion?: number }) {
    const g = await this.goalOwned(tx, auth.ownerId, goalId);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== g.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Coffre modifié ailleurs', { current: await this.present(tx, auth.ownerId, g) });
    const pending = await tx.savingsWithdrawalRequest.count({ where: { goalId, status: { in: ['WAITING', 'ELIGIBLE'] } } });
    if (dto.targetMinor !== undefined && dto.targetMinor < g.targetMinor && pending) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Baisse de cible impossible pendant une demande de retrait en cours');
    const data: any = { version: { increment: 1 } };
    if (dto.name) data.name = dto.name;
    if (dto.icon) data.icon = dto.icon;
    if (dto.targetMinor !== undefined) data.targetMinor = dto.targetMinor;
    if (dto.deadline) {
      const d = parseDateOnly(dto.deadline);
      if (d <= economicToday()) throw new DomainError('VALIDATION_FAILED', 'L’échéance doit être future');
      data.deadline = d;
      data.deadlineHistory = [...((g.deadlineHistory as any[]) ?? []), { from: toDateOnly(g.deadline), to: dto.deadline, at: clock.now().toISOString() }];
      if (g.status === 'LATE') data.status = 'ACTIVE';
    }
    const saved = await this.saved(tx, auth.ownerId, g.walletId);
    const newTarget = dto.targetMinor ?? g.targetMinor;
    if (saved < newTarget && g.status === 'TARGET_REACHED') data.status = 'ACTIVE';
    if (saved >= newTarget && ['ACTIVE', 'LATE'].includes(data.status ?? g.status)) data.status = 'TARGET_REACHED';
    const r = await tx.savingsGoal.update({ where: { id: g.id }, data, include: { plan: true } });
    if (dto.plan) {
      this.validatePlan(dto.plan);
      await tx.savingsContributionPlan.update({ where: { goalId: g.id }, data: dto.plan });
      await tx.plannedContribution.updateMany({ where: { goalId: g.id, state: 'PLANNED', kind: 'SCHEDULED' }, data: { state: 'CANCELLED' } });
    }
    if (dto.plan || dto.deadline) await this.generateSchedule(tx, await tx.savingsGoal.findUniqueOrThrow({ where: { id: g.id }, include: { plan: true } }));
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'SAVINGS_GOAL_REPLANNED', resource: `SavingsGoal:${g.id}`, context: { fields: Object.keys(dto) } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'savings.updated', aggregateType: 'SavingsGoal', aggregateId: g.id, version: r.version });
    return this.present(tx, auth.ownerId, r);
  }

  /**
   * Capacité de retrait exceptionnel (backend.md §9, ADR-003) :
   * base = (épargne confirmée − contributions < 72 h) + retraits exceptionnels exécutés sur 30 j
   *   (les demandes réservées NE sont PAS rajoutées : leurs fonds sont encore dans le coffre jusqu'à exécution — les ajouter
   *   compterait deux fois le même argent et laisserait passer une demande fractionnée ; écart documenté ADR-003)
   * capacité = max(0, floor(20 % × base) − exécutés 30 j − réservés).
   */
  async capacity(db: Tx | PrismaService, ownerId: string, goalId: string, excludeRequestId?: string) {
    const g = await this.goalOwned(db, ownerId, goalId);
    const now = clock.now();
    const saved = await this.saved(db, ownerId, g.walletId);
    const recent = (await db.plannedContribution.aggregate({ where: { goalId, state: 'CONFIRMED', confirmedAt: { gt: addMs(now, -BASE_COOLDOWN_MS) } }, _sum: { confirmedMinor: true } }))._sum.confirmedMinor ?? 0n;
    const windowStart = addMs(now, -EXCEPTIONAL_WINDOW_MS);
    const reqs = await db.savingsWithdrawalRequest.findMany({ where: { goalId, kind: 'EXCEPTIONAL', OR: [{ status: 'EXECUTED', executedAt: { gt: windowStart } }, { status: { in: ['WAITING', 'ELIGIBLE'] } }] } });
    const executed = reqs.filter((r) => r.status === 'EXECUTED').reduce((s, r) => s + r.requestedMinor, 0n);
    const reserved = reqs.filter((r) => r.status !== 'EXECUTED' && r.id !== excludeRequestId).reduce((s, r) => s + r.holdMinor, 0n);
    const eligibleSaved = maxBig(0n, saved - recent);
    const base = eligibleSaved + executed;
    const cap = maxBig(0n, percentBpFloor(base, EXCEPTIONAL_CAP_BP) - executed - reserved);
    return {
      goalId, savedMinor: saved, excludedRecentContributionsMinor: recent, baseMinor: base, executedInWindowMinor: executed, reservedMinor: reserved,
      capacityMinor: cap > saved ? saved : cap, windowDays: 30, capPercent: 20, delayHours: 72,
      ordinaryAvailable: saved >= g.targetMinor, ordinaryMaxMinor: saved >= g.targetMinor ? saved : 0n,
      protection: { mode: g.protectionMode, notice: g.protectionMode === 'ADVISORY' ? ADVISORY_NOTICE : null },
    };
  }

  /** Demande de retrait : 72 h serveur ; exceptionnel plafonné ; verrou par coffre contre demandes concurrentes/fractionnées (T24). */
  async requestWithdrawal(tx: Tx, auth: AuthContext, goalId: string, dto: { kind: 'ORDINARY' | 'EXCEPTIONAL'; amountMinor: bigint; reason?: string }) {
    await tx.$queryRaw`SELECT id FROM "SavingsGoal" WHERE id = ${goalId}::uuid FOR UPDATE`;
    const g = await this.goalOwned(tx, auth.ownerId, goalId);
    const cap = await this.capacity(tx, auth.ownerId, goalId);
    if (dto.amountMinor > cap.savedMinor) throw new DomainError('INSUFFICIENT_ALLOCATABLE_FUNDS', 'Montant supérieur à l’épargne du coffre', { savedMinor: cap.savedMinor });
    if (dto.kind === 'ORDINARY') {
      if (cap.savedMinor < g.targetMinor) throw new DomainError('SAVINGS_TARGET_NOT_REACHED', 'Objectif non atteint : seul un retrait exceptionnel est possible', { capacity: cap });
      const pendingOrdinary = await tx.savingsWithdrawalRequest.count({ where: { goalId, kind: 'ORDINARY', status: { in: ['WAITING', 'ELIGIBLE'] } } });
      if (pendingOrdinary) throw new DomainError('STATE_CONFLICT', 'Un déblocage est déjà en attente');
    } else if (dto.amountMinor > cap.capacityMinor) {
      throw new DomainError('SAVINGS_CAP_EXCEEDED', 'Retrait exceptionnel limité à 20 % sur 30 jours glissants', { capacity: cap });
    }
    const now = clock.now();
    const r = await tx.savingsWithdrawalRequest.create({
      data: { ownerId: auth.ownerId, goalId, kind: dto.kind, requestedMinor: dto.amountMinor, reason: dto.reason, requestedAt: now, eligibleAt: addMs(now, WITHDRAWAL_DELAY_MS), baseSnapshotMinor: cap.baseMinor, holdMinor: dto.kind === 'EXCEPTIONAL' ? dto.amountMinor : 0n },
    });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `withdrawal-requested:${r.id}`, type: 'savings.withdrawal_requested', category: 'SAVINGS', priority: 'HIGH', title: `Demande de retrait — ${g.name}`, body: 'Disponible pour confirmation dans 72 heures. Vous pouvez l’annuler à tout moment.', link: `/savings/${g.id}` });
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'SAVINGS_WITHDRAWAL_REQUESTED', resource: `SavingsWithdrawalRequest:${r.id}`, context: { kind: dto.kind } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'operations.updated', aggregateType: 'SavingsWithdrawalRequest', aggregateId: r.id, version: 1 });
    return { ...r, protection: cap.protection };
  }

  async getWithdrawal(auth: AuthContext, id: string) {
    const r = await this.prisma.savingsWithdrawalRequest.findUnique({ where: { id } });
    if (!r || r.ownerId !== auth.ownerId) throw notFound('Demande de retrait');
    return { ...r, serverTime: clock.now(), remainingMs: Math.max(0, r.eligibleAt.getTime() - clock.now().getTime()) };
  }

  /** Confirmation à échéance : réévaluation conservatrice, puis affectation coffre → courant. */
  async confirmWithdrawal(tx: Tx, auth: AuthContext, id: string) {
    const r0 = await tx.savingsWithdrawalRequest.findUnique({ where: { id } });
    if (!r0 || r0.ownerId !== auth.ownerId) throw notFound('Demande de retrait');
    await tx.$queryRaw`SELECT id FROM "SavingsGoal" WHERE id = ${r0.goalId}::uuid FOR UPDATE`;
    const r = await tx.savingsWithdrawalRequest.findUniqueOrThrow({ where: { id } });
    if (!['WAITING', 'ELIGIBLE'].includes(r.status)) throw new DomainError('STATE_CONFLICT', 'Demande déjà traitée');
    if (r.eligibleAt > clock.now()) throw new DomainError('SAVINGS_WITHDRAWAL_DELAY', 'Délai de 72 heures non écoulé', { eligibleAt: r.eligibleAt });
    const g = await this.goalOwned(tx, auth.ownerId, r.goalId);
    const cap = await this.capacity(tx, auth.ownerId, r.goalId, r.id);
    if (r.requestedMinor > cap.savedMinor) throw new DomainError('INSUFFICIENT_ALLOCATABLE_FUNDS', 'Épargne insuffisante à l’échéance', { capacity: cap });
    if (r.kind === 'EXCEPTIONAL' && r.requestedMinor > cap.capacityMinor) {
      await tx.savingsWithdrawalRequest.update({ where: { id }, data: { status: 'REJECTED', version: { increment: 1 } } });
      await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'SAVINGS_WITHDRAWAL_REJECTED_ON_REEVALUATION', resource: `SavingsWithdrawalRequest:${id}`, decision: 'DENIED', context: { capacity: cap } });
      throw new DomainError('SAVINGS_CAP_EXCEEDED', 'La base a diminué depuis la demande : plafond de 20 % dépassé', { capacity: cap });
    }
    if (r.kind === 'ORDINARY' && cap.savedMinor < g.targetMinor) throw new DomainError('SAVINGS_TARGET_NOT_REACHED', 'Objectif plus atteint à l’échéance');
    const current = await this.wallets.currentWallet(tx, auth.ownerId);
    const { transactionId } = await this.wallets.move(tx, auth, `withdrawal:${r.id}`, { fromWalletId: g.walletId, toWalletId: current.id, amountMinor: r.requestedMinor, memo: `Retrait ${r.kind === 'EXCEPTIONAL' ? 'exceptionnel' : 'ordinaire'} — ${g.name}` }, true, 'SAVINGS_WITHDRAWAL');
    const done = await tx.savingsWithdrawalRequest.update({ where: { id }, data: { status: 'EXECUTED', confirmedAt: clock.now(), executedAt: clock.now(), allocationTxId: transactionId, version: { increment: 1 } } });
    const remaining = await this.saved(tx, auth.ownerId, g.walletId);
    if (r.kind === 'ORDINARY' && remaining === 0n) await tx.savingsGoal.update({ where: { id: g.id }, data: { status: 'RELEASED', version: { increment: 1 } } });
    else if (remaining < g.targetMinor && g.status === 'TARGET_REACHED') await tx.savingsGoal.update({ where: { id: g.id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `withdrawal-executed:${r.id}`, type: 'savings.withdrawal_executed', category: 'SAVINGS', priority: 'HIGH', title: `Retrait effectué — ${g.name}`, body: 'Le montant a été réaffecté à votre portefeuille courant.', link: `/savings/${g.id}` });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'savings.updated', aggregateType: 'SavingsGoal', aggregateId: g.id });
    return done;
  }

  async cancelWithdrawal(tx: Tx, auth: AuthContext, id: string) {
    const r = await tx.savingsWithdrawalRequest.findUnique({ where: { id } });
    if (!r || r.ownerId !== auth.ownerId) throw notFound('Demande de retrait');
    if (!['WAITING', 'ELIGIBLE'].includes(r.status)) throw new DomainError('STATE_CONFLICT', 'Demande déjà traitée');
    const res = await tx.savingsWithdrawalRequest.update({ where: { id, version: r.version }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'operations.updated', aggregateType: 'SavingsWithdrawalRequest', aggregateId: id });
    return res;
  }

  /** Job : DUE/MISSED, retards d'échéance, demandes devenues éligibles. Préparation et signalement seulement. */
  async evaluate() {
    const today = economicToday();
    await this.prisma.plannedContribution.updateMany({ where: { state: 'PLANNED', dueAt: { lte: today } }, data: { state: 'DUE' } });
    const missedCut = new Date(today.getTime() - 7 * DAY);
    const missed = await this.prisma.plannedContribution.findMany({ where: { state: 'DUE', dueAt: { lt: missedCut }, kind: 'SCHEDULED' }, include: { goal: true } });
    for (const m of missed) {
      await this.prisma.tx(async (tx) => {
        await tx.plannedContribution.update({ where: { id: m.id }, data: { state: 'MISSED' } });
        await this.events.notify(tx, { ownerId: m.goal.ownerId, sourceEventId: `contribution-missed:${m.id}`, type: 'savings.contribution_missed', category: 'SAVINGS', priority: 'NORMAL', title: `Versement manqué — ${m.goal.name}`, body: 'Un plan de rattrapage vous est proposé ; rien n’est imposé.', link: `/savings/${m.goalId}` });
      });
    }
    const late = await this.prisma.savingsGoal.findMany({ where: { status: 'ACTIVE', deadline: { lt: today } } });
    for (const g of late) {
      await this.prisma.tx(async (tx) => {
        const saved = await this.saved(tx, g.ownerId, g.walletId);
        if (saved >= g.targetMinor) return;
        await tx.savingsGoal.update({ where: { id: g.id }, data: { status: 'LATE', version: { increment: 1 } } });
        await this.events.notify(tx, { ownerId: g.ownerId, sourceEventId: `goal-late:${g.id}:${toDateOnly(g.deadline)}`, type: 'savings.goal_late', category: 'SAVINGS', priority: 'HIGH', title: `Échéance dépassée — ${g.name}`, body: 'Le coffre et sa protection sont conservés. Proposez une nouvelle échéance quand vous le souhaitez.', link: `/savings/${g.id}` });
      });
    }
    const eligible = await this.prisma.savingsWithdrawalRequest.findMany({ where: { status: 'WAITING', eligibleAt: { lte: clock.now() } }, include: { goal: true } });
    for (const r of eligible) {
      await this.prisma.tx(async (tx) => {
        await tx.savingsWithdrawalRequest.update({ where: { id: r.id }, data: { status: 'ELIGIBLE' } });
        await this.events.notify(tx, { ownerId: r.ownerId, sourceEventId: `withdrawal-eligible:${r.id}`, type: 'savings.withdrawal_eligible', category: 'SAVINGS', priority: 'HIGH', title: `Retrait prêt à confirmer — ${r.goal.name}`, body: 'Le délai de 72 heures est écoulé. Une confirmation explicite reste nécessaire.', link: `/savings/${r.goalId}` });
      });
    }
    return { missed: missed.length, late: late.length, eligible: eligible.length };
  }
}
