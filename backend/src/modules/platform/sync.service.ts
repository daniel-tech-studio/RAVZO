import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { addMs, clock, DAY } from '../../common/clock';
import { digestOf } from '../../common/crypto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { config } from '../../common/config';
import { ExpensesService } from '../money/expenses.service';
import { IncomeService } from '../money/income.service';
import { SavingsService } from '../savings/savings.service';
import { AssetsService } from '../wealth/assets.service';

const ALLOWED: Record<string, string[]> = { EXPENSE: ['CREATE'], INCOME: ['CREATE'], SAVINGS_GOAL_META: ['UPDATE'], ASSET: ['CREATE'], NOTE: ['CREATE'] };

/**
 * Synchronisation (llm §13, backend.md §20.6) : deltas par curseur monotone ; brouillons hors ligne
 * PREPARED → REVIEW_REQUIRED → (confirmation INDIVIDUELLE) → APPLIED | CONFLICT | REJECTED. Aucune opération PSP par cette voie.
 */
@Injectable()
export class SyncService {
  constructor(private prisma: PrismaService, private expenses: ExpensesService, private incomes: IncomeService, private savings: SavingsService, private assets: AssetsService, private events: EventsService) {}

  async changes(auth: AuthContext, cursor?: string, limit = 500) {
    const after = cursor && /^\d+$/.test(cursor) ? BigInt(cursor) : 0n;
    const oldest = await this.prisma.syncEvent.findFirst({ where: { ownerId: auth.ownerId }, orderBy: { sequence: 'asc' } });
    const latest = await this.prisma.syncEvent.findFirst({ where: { ownerId: auth.ownerId }, orderBy: { sequence: 'desc' } });
    // Curseur antérieur à la fenêtre conservée : resynchronisation complète par instantanés exigée.
    if (after > 0n && oldest && after < oldest.sequence - 1n && (await this.prisma.syncEvent.count({ where: { ownerId: auth.ownerId, sequence: { lte: after } } })) === 0) {
      return { resyncRequired: true, events: [], nextCursor: latest?.sequence.toString() ?? '0', hasMore: false };
    }
    const events = await this.prisma.syncEvent.findMany({ where: { ownerId: auth.ownerId, sequence: { gt: after } }, orderBy: { sequence: 'asc' }, take: Math.min(limit, 1000) });
    return { resyncRequired: false, events: events.map((e) => ({ sequence: e.sequence.toString(), resourceType: e.resourceType, resourceId: e.resourceId, eventType: e.eventType, version: e.version, occurredAt: e.occurredAt })), nextCursor: (events.at(-1)?.sequence ?? after).toString(), hasMore: events.length === Math.min(limit, 1000) };
  }

  /** Enregistre des brouillons ; n'applique RIEN. Validation et risques renvoyés pour revue individuelle. */
  async prepare(auth: AuthContext, drafts: { clientDraftId: string; targetResource: string; operation: string; targetId?: string; baseVersion?: number; payload: Record<string, any> }[]) {
    const out = [];
    for (const d of drafts) {
      const validation: string[] = [];
      if (!ALLOWED[d.targetResource]?.includes(d.operation)) validation.push('OPERATION_NOT_ALLOWED_OFFLINE');
      if (['PAYOUT', 'PAYIN', 'PAYMENT'].some((k) => d.targetResource.includes(k))) validation.push('PAYMENTS_NEVER_SYNCED_FROM_OFFLINE');
      if (d.targetResource === 'EXPENSE' || d.targetResource === 'INCOME') {
        const amt = d.payload.amountMinor ?? d.payload.grossMinor;
        try { parsePositiveMinor(amt); } catch { validation.push('INVALID_AMOUNT'); }
        const acc = d.payload.accountId ? await this.prisma.financialAccount.findUnique({ where: { id: String(d.payload.accountId) } }).catch(() => null) : null;
        if (!acc || acc.ownerId !== auth.ownerId) validation.push('UNKNOWN_ACCOUNT');
      }
      if (d.operation === 'UPDATE' && d.baseVersion === undefined) validation.push('BASE_VERSION_REQUIRED');
      const rec = await this.prisma.offlineDraftRecord.upsert({
        where: { sessionFamilyId_clientDraftId: { sessionFamilyId: auth.familyId, clientDraftId: d.clientDraftId } },
        create: { ownerId: auth.ownerId, deviceId: auth.deviceId, sessionFamilyId: auth.familyId, clientDraftId: d.clientDraftId, targetResource: d.targetResource, operation: d.operation, targetId: d.targetId, baseVersion: d.baseVersion, payload: d.payload, canonicalPayloadHash: digestOf(d.payload), state: validation.length ? 'REJECTED' : 'REVIEW_REQUIRED', validation },
        update: {},
      });
      out.push(rec);
    }
    await this.prisma.tx((tx) => this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'operations.updated', aggregateType: 'OfflineDraft', aggregateId: auth.familyId, outbox: false }));
    return out;
  }

  async list(auth: AuthContext) {
    return this.prisma.offlineDraftRecord.findMany({ where: { ownerId: auth.ownerId, state: { in: ['REVIEW_REQUIRED', 'CONFLICT', 'REJECTED'] } }, orderBy: { createdAt: 'asc' } });
  }

  async diff(auth: AuthContext, id: string) {
    const d = await this.owned(auth, id);
    let server: any = null;
    if (d.targetResource === 'SAVINGS_GOAL_META' && d.targetId) server = await this.prisma.savingsGoal.findUnique({ where: { id: d.targetId } });
    return { draft: d, server, serverVersion: server?.version ?? null, stale: server && d.baseVersion !== null && server.version !== d.baseVersion };
  }

  private async owned(auth: AuthContext, id: string) {
    const d = await this.prisma.offlineDraftRecord.findUnique({ where: { id } });
    if (!d || d.ownerId !== auth.ownerId) throw notFound('Brouillon');
    return d;
  }

  /** Confirmation INDIVIDUELLE et explicite d'un brouillon (T17). Conflit de version → 409 avec les deux versions. */
  async confirm(auth: AuthContext, id: string, dto: { payloadHash: string; resolution?: 'APPLY_ON_LATEST' }) {
    const d = await this.owned(auth, id);
    if (d.state === 'APPLIED') return d;
    if (d.state === 'REJECTED' || d.state === 'DISCARDED') throw new DomainError('STATE_CONFLICT', 'Brouillon rejeté ou abandonné');
    if (dto.payloadHash !== d.canonicalPayloadHash) throw new DomainError('SYNC_CONFIRMATION_REQUIRED', 'Le contenu confirmé ne correspond pas au brouillon présenté');
    const p = d.payload as Record<string, any>;
    try {
      const result = await this.prisma.tx(async (tx) => {
        const claimed = await tx.offlineDraftRecord.updateMany({ where: { id, state: { in: ['REVIEW_REQUIRED', 'CONFLICT'] } }, data: { state: 'APPLIED', confirmedAt: clock.now() } });
        if (claimed.count !== 1) throw new DomainError('STATE_CONFLICT', 'Brouillon déjà traité');
        let resId: string;
        switch (d.targetResource) {
          case 'EXPENSE': resId = (await this.expenses.create(tx, auth, d.id, { accountId: p.accountId, categoryId: p.categoryId, amountMinor: parsePositiveMinor(p.amountMinor), economicDate: p.economicDate, label: String(p.label ?? 'Dépense hors ligne').slice(0, 160), merchant: p.merchant, source: 'OFFLINE_DRAFT' })).id; break;
          case 'INCOME': resId = (await this.incomes.create(tx, auth, d.id, { accountId: p.accountId, source: String(p.source ?? 'Revenu').slice(0, 120), grossMinor: parsePositiveMinor(p.grossMinor), economicDate: p.economicDate, categoryId: p.categoryId, note: p.note })).id; break;
          case 'SAVINGS_GOAL_META': {
            const g = await tx.savingsGoal.findUnique({ where: { id: d.targetId! } });
            if (!g || g.ownerId !== auth.ownerId) throw notFound('Coffre');
            const expectedVersion = dto.resolution === 'APPLY_ON_LATEST' ? g.version : d.baseVersion ?? undefined;
            resId = (await this.savings.update(tx, auth, g.id, { name: p.name, icon: p.icon, deadline: p.deadline, expectedVersion })).id; break;
          }
          case 'ASSET': resId = (await this.assets.create(tx, auth, { name: p.name, kind: p.kind ?? 'OTHER', currentValueMinor: p.currentValueMinor ? parsePositiveMinor(p.currentValueMinor) : undefined })).id; break;
          default: throw new DomainError('VALIDATION_FAILED', 'Type de brouillon non pris en charge');
        }
        await tx.offlineDraftRecord.update({ where: { id }, data: { resultResourceId: resId } });
        return resId;
      });
      return { ...(await this.prisma.offlineDraftRecord.findUniqueOrThrow({ where: { id } })), resultResourceId: result };
    } catch (e: any) {
      if (e instanceof DomainError && e.code === 'RESOURCE_VERSION_CONFLICT') {
        await this.prisma.offlineDraftRecord.update({ where: { id }, data: { state: 'CONFLICT' } });
        throw new DomainError('SYNC_CONFLICT', 'La ressource a changé sur le serveur : comparez et choisissez', { draft: d.payload, server: e.details.current });
      }
      throw e;
    }
  }

  async discard(auth: AuthContext, id: string) {
    await this.owned(auth, id);
    return this.prisma.offlineDraftRecord.update({ where: { id }, data: { state: 'DISCARDED' } });
  }

  async purgeOld() {
    const r = await this.prisma.syncEvent.deleteMany({ where: { occurredAt: { lt: addMs(clock.now(), -config.sseRetentionDays * DAY) } } });
    return r.count;
  }
}
