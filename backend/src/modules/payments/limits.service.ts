import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { addMs, clock, DAY, HOUR } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';

export const ROLLING_WINDOW_MS = DAY;
export const EXCEPTION_DELAY_MS = 72 * HOUR;
export const EXCEPTION_VALIDITY_MS = 24 * HOUR;

/**
 * Plafonds (llm §8.2, backend.md §10.3, ADR-002) : total débité frais inclus ; fenêtre glissante de 24 h ancrée sur
 * l'horodatage serveur de RÉSERVATION (création du LimitHold), jamais déplacé lors d'un rapprochement.
 * ACTIVE + SETTLED comptent ; RELEASED (annulation certaine avant exécution) ne compte pas.
 */
@Injectable()
export class LimitsService {
  constructor(private prisma: PrismaService, private events: EventsService) {}

  async activePolicy(db: Tx | PrismaService, ownerId: string) {
    const p = await db.limitPolicy.findFirst({ where: { ownerId, status: 'ACTIVE' } });
    if (!p) throw notFound('Politique de plafonds');
    return p;
  }
  /** Verrou sérialisant toute réservation de plafond du propriétaire (multi-appareils, T02). */
  async lockPolicy(tx: Tx, ownerId: string) {
    await tx.$queryRaw`SELECT id FROM "LimitPolicy" WHERE "ownerId" = ${ownerId}::uuid AND status = 'ACTIVE' FOR UPDATE`;
    return this.activePolicy(tx, ownerId);
  }
  async usedInWindow(db: Tx | PrismaService, ownerId: string) {
    const since = addMs(clock.now(), -ROLLING_WINDOW_MS);
    const holds = await db.limitHold.findMany({ where: { ownerId, state: { in: ['ACTIVE', 'SETTLED'] }, windowAnchoredAt: { gt: since } }, orderBy: { windowAnchoredAt: 'asc' } });
    return { usedMinor: holds.reduce((s, h) => s + h.amountDebitMinor, 0n), holds };
  }

  async summary(auth: AuthContext) {
    const p = await this.activePolicy(this.prisma, auth.ownerId);
    const { usedMinor, holds } = await this.usedInWindow(this.prisma, auth.ownerId);
    const pending = await this.prisma.limitChangeRequest.findMany({ where: { ownerId: auth.ownerId, status: 'PENDING' } });
    const nextRelease = holds[0] ? addMs(holds[0].windowAnchoredAt, ROLLING_WINDOW_MS) : null;
    return {
      currency: 'XOF', policyVersion: p.policyVersion, perOperationMinor: p.perOperationMinor, rolling24hMinor: p.rolling24hMinor,
      referencePerOperationMinor: p.referencePerOperationMinor, referenceRolling24hMinor: p.referenceRolling24hMinor,
      usedInWindowMinor: usedMinor, remainingInWindowMinor: p.rolling24hMinor - usedMinor > 0n ? p.rolling24hMinor - usedMinor : 0n,
      activeHoldsMinor: holds.filter((h) => h.state === 'ACTIVE').reduce((s, h) => s + h.amountDebitMinor, 0n),
      nextCapacityReleaseAt: nextRelease, pendingChanges: pending, scope: 'Tous transferts sortants vers des comptes externes, frais inclus', serverTime: clock.now(),
    };
  }

  /** Baisse immédiate ; hausse dans la référence : 48 h ; hausse au-delà : 72 h. Une seule hausse en attente. */
  async requestChange(tx: Tx, auth: AuthContext, dto: { perOperationMinor: bigint; rolling24hMinor: bigint }) {
    if (dto.perOperationMinor <= 0n || dto.rolling24hMinor < dto.perOperationMinor) throw new DomainError('VALIDATION_FAILED', 'Plafonds invalides (24 h ≥ par opération > 0)');
    const p = await this.lockPolicy(tx, auth.ownerId);
    const now = clock.now();
    const isDecrease = dto.perOperationMinor <= p.perOperationMinor && dto.rolling24hMinor <= p.rolling24hMinor;
    if (isDecrease) {
      await tx.limitChangeRequest.updateMany({ where: { ownerId: auth.ownerId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      const r = await tx.limitChangeRequest.create({ data: { ownerId: auth.ownerId, oldPolicyId: p.id, proposedPerOperation: dto.perOperationMinor, proposedRolling24h: dto.rolling24hMinor, kind: 'DECREASE', requestedAt: now, effectiveAt: now } });
      await this.apply(tx, r.id);
      return tx.limitChangeRequest.findUniqueOrThrow({ where: { id: r.id } });
    }
    const pending = await tx.limitChangeRequest.count({ where: { ownerId: auth.ownerId, status: 'PENDING' } });
    if (pending) throw new DomainError('LIMIT_CHANGE_PENDING', 'Une hausse est déjà en attente');
    const beyond = dto.perOperationMinor > p.referencePerOperationMinor || dto.rolling24hMinor > p.referenceRolling24hMinor;
    const r = await tx.limitChangeRequest.create({ data: { ownerId: auth.ownerId, oldPolicyId: p.id, proposedPerOperation: dto.perOperationMinor, proposedRolling24h: dto.rolling24hMinor, kind: beyond ? 'INCREASE_BEYOND_REFERENCE' : 'INCREASE_WITHIN_REFERENCE', requestedAt: now, effectiveAt: addMs(now, beyond ? 72 * HOUR : 48 * HOUR) } });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `limit-change:${r.id}`, type: 'security.limit_change_requested', category: 'SECURITY', priority: 'CRITICAL', title: 'Hausse de plafond demandée', body: `Effective après ${beyond ? '72' : '48'} heures si vous ne l’annulez pas.`, link: '/security/limits' });
    return r;
  }

  async apply(tx: Tx, requestId: string) {
    const r = await tx.limitChangeRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (r.status !== 'PENDING' || r.effectiveAt > clock.now()) return null;
    const p = await this.lockPolicy(tx, r.ownerId);
    await tx.limitPolicy.update({ where: { id: p.id }, data: { status: 'SUPERSEDED' } });
    const beyond = r.kind === 'INCREASE_BEYOND_REFERENCE';
    const np = await tx.limitPolicy.create({
      data: {
        ownerId: r.ownerId, perOperationMinor: r.proposedPerOperation, rolling24hMinor: r.proposedRolling24h, effectiveFrom: clock.now(), policyVersion: p.policyVersion + 1,
        referencePerOperationMinor: beyond ? r.proposedPerOperation : p.referencePerOperationMinor, referenceRolling24hMinor: beyond ? r.proposedRolling24h : p.referenceRolling24hMinor,
      },
    });
    await tx.limitChangeRequest.update({ where: { id: r.id }, data: { status: 'APPLIED', appliedPolicyId: np.id } });
    await this.events.security(tx, { ownerId: r.ownerId, type: 'LIMIT_POLICY_APPLIED', resourceId: np.id, decision: r.kind });
    await this.events.emit(tx, { ownerId: r.ownerId, eventType: 'security.restriction_changed', aggregateType: 'LimitPolicy', aggregateId: np.id, version: np.policyVersion });
    return np;
  }
  async cancelChange(tx: Tx, auth: AuthContext, id: string) {
    const r = await tx.limitChangeRequest.findUnique({ where: { id } });
    if (!r || r.ownerId !== auth.ownerId) throw notFound('Demande');
    if (r.status !== 'PENDING') throw new DomainError('STATE_CONFLICT', 'Demande déjà traitée');
    return tx.limitChangeRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
  }
  async applyDue() {
    const due = await this.prisma.limitChangeRequest.findMany({ where: { status: 'PENDING', effectiveAt: { lte: clock.now() } } });
    for (const r of due) await this.prisma.tx((tx) => this.apply(tx, r.id));
    return due.length;
  }

  // ─── Dérogations « grosse dépense » (llm §8.3) ───
  exceptionView(e: any) {
    const now = clock.now();
    let state = e.state;
    if (state === 'WAITING' && e.activeFrom <= now) state = e.expiresAt > now ? 'ACTIVE' : 'EXPIRED';
    if (state === 'ACTIVE' && e.expiresAt <= now) state = 'EXPIRED';
    return { ...e, effectiveState: state, serverTime: now };
  }
  async createException(tx: Tx, auth: AuthContext, dto: { paymentIntentId: string; maxDebitMinor: bigint; reason: string }) {
    const intent = await tx.paymentIntent.findUnique({ where: { id: dto.paymentIntentId } });
    if (!intent || intent.ownerId !== auth.ownerId || intent.direction !== 'PAYOUT') throw notFound('Paiement');
    if (!['DRAFT', 'AWAITING_CONFIRMATION'].includes(intent.state)) throw new DomainError('PAYMENT_STATE_CONFLICT', 'Paiement déjà engagé');
    if (dto.maxDebitMinor < intent.totalDebitMinor) throw new DomainError('VALIDATION_FAILED', 'Le montant maximal doit couvrir le total débité estimé');
    const existing = await tx.exceptionAuthorization.findFirst({ where: { intentId: intent.id, state: { in: ['WAITING', 'ACTIVE'] } } });
    if (existing) throw new DomainError('STATE_CONFLICT', 'Une dérogation existe déjà pour ce paiement');
    const now = clock.now();
    const activeFrom = addMs(now, EXCEPTION_DELAY_MS);
    const e = await tx.exceptionAuthorization.create({ data: { ownerId: auth.ownerId, intentId: intent.id, maxDebitMinor: dto.maxDebitMinor, beneficiaryBinding: intent.beneficiaryId ?? '', reason: dto.reason, requestedAt: now, activeFrom, expiresAt: addMs(activeFrom, EXCEPTION_VALIDITY_MS) } });
    await tx.paymentIntent.update({ where: { id: intent.id }, data: { exceptionId: e.id, version: { increment: 1 } } });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `exception:${e.id}`, type: 'security.exception_requested', category: 'SECURITY', priority: 'CRITICAL', title: 'Dérogation de plafond demandée', body: 'Utilisable une seule fois, dans 72 h, pendant 24 h, pour ce paiement précis.', link: `/security/exceptions/${e.id}` });
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'EXCEPTION_REQUESTED', resourceId: e.id, decision: 'WAITING' });
    return this.exceptionView(e);
  }
  async getException(auth: AuthContext, id: string) {
    const e = await this.prisma.exceptionAuthorization.findUnique({ where: { id } });
    if (!e || e.ownerId !== auth.ownerId) throw notFound('Dérogation');
    return this.exceptionView(e);
  }
  async listExceptions(auth: AuthContext) {
    const es = await this.prisma.exceptionAuthorization.findMany({ where: { ownerId: auth.ownerId }, orderBy: { requestedAt: 'desc' }, take: 50 });
    return es.map((e) => this.exceptionView(e));
  }
  async cancelException(tx: Tx, auth: AuthContext, id: string) {
    const e = await tx.exceptionAuthorization.findUnique({ where: { id } });
    if (!e || e.ownerId !== auth.ownerId) throw notFound('Dérogation');
    if (!['WAITING', 'ACTIVE'].includes(e.state)) throw new DomainError('STATE_CONFLICT', 'Dérogation non révocable');
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'EXCEPTION_CANCELLED', resourceId: id, decision: 'CANCELLED' });
    return tx.exceptionAuthorization.update({ where: { id }, data: { state: 'CANCELLED', cancelledAt: clock.now(), version: { increment: 1 } } });
  }
  /** Consommation atomique et unique, dans la transaction d'autorisation (T09). */
  async consumeException(tx: Tx, ownerId: string, intent: { id: string; exceptionId: string | null; beneficiaryId: string | null; totalDebitMinor: bigint }) {
    if (!intent.exceptionId) return null;
    const e = await tx.exceptionAuthorization.findUnique({ where: { id: intent.exceptionId } });
    if (!e || e.ownerId !== ownerId || e.intentId !== intent.id) throw new DomainError('EXCEPTION_NOT_ACTIVE', 'Dérogation non liée à ce paiement');
    const now = clock.now();
    if (e.state === 'CONSUMED' || e.consumedAt) throw new DomainError('EXCEPTION_CONSUMED', 'Dérogation déjà utilisée');
    if (e.state === 'CANCELLED') throw new DomainError('EXCEPTION_NOT_ACTIVE', 'Dérogation révoquée');
    if (now < e.activeFrom) throw new DomainError('EXCEPTION_NOT_ACTIVE', 'Dérogation pas encore active (délai de 72 h)', { activeFrom: e.activeFrom });
    if (now >= e.expiresAt) throw new DomainError('EXCEPTION_EXPIRED', 'Dérogation expirée');
    if (e.beneficiaryBinding !== (intent.beneficiaryId ?? '')) throw new DomainError('EXCEPTION_NOT_ACTIVE', 'Bénéficiaire différent de celui autorisé');
    if (intent.totalDebitMinor > e.maxDebitMinor) throw new DomainError('EXCEPTION_NOT_ACTIVE', 'Montant supérieur au maximum autorisé par la dérogation');
    const r = await tx.exceptionAuthorization.updateMany({ where: { id: e.id, consumedAt: null, state: { in: ['WAITING', 'ACTIVE'] } }, data: { state: 'CONSUMED', consumedAt: now, version: { increment: 1 } } });
    if (r.count !== 1) throw new DomainError('EXCEPTION_CONSUMED', 'Dérogation déjà utilisée');
    await this.events.security(tx, { ownerId, type: 'EXCEPTION_CONSUMED', resourceId: e.id, decision: 'CONSUMED' });
    return e;
  }
  async expireExceptions() {
    const now = clock.now();
    await this.prisma.exceptionAuthorization.updateMany({ where: { state: 'WAITING', activeFrom: { lte: now }, expiresAt: { gt: now } }, data: { state: 'ACTIVE' } });
    const r = await this.prisma.exceptionAuthorization.updateMany({ where: { state: { in: ['WAITING', 'ACTIVE'] }, expiresAt: { lte: now } }, data: { state: 'EXPIRED' } });
    return r.count;
  }
}
