import { Injectable } from '@nestjs/common';
import { canonicalJson, sha256 } from './crypto';
import { toJsonSafe } from './http';
import { Tx } from './prisma.service';

export type Priority = 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

/**
 * Outbox + flux de synchronisation + audit + notifications, TOUJOURS dans la transaction métier
 * (commit atomique registre/projection/outbox : backend.md §7.2, B22–B24).
 */
@Injectable()
export class EventsService {
  async emit(tx: Tx, e: {
    ownerId: string; eventType: string; aggregateType: string; aggregateId: string;
    payload?: Record<string, unknown>; version?: number; outbox?: boolean;
  }) {
    const payload = toJsonSafe(e.payload ?? {});
    await tx.syncEvent.create({
      data: {
        ownerId: e.ownerId, resourceType: e.aggregateType, resourceId: e.aggregateId, eventType: e.eventType,
        version: e.version, payloadDigest: sha256(canonicalJson(payload)),
      },
    });
    if (e.outbox !== false) {
      await tx.outboxEvent.create({
        data: { ownerId: e.ownerId, eventType: e.eventType, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload },
      });
    }
  }

  async audit(tx: Tx, a: {
    ownerId: string | null; actorType?: string; actorId?: string | null; action: string; resource?: string;
    decision?: string; context?: Record<string, unknown>; correlationId?: string;
  }) {
    await tx.auditEvent.create({
      data: {
        ownerId: a.ownerId, actorType: a.actorType ?? 'OWNER', actorId: a.actorId ?? null, action: a.action,
        resource: a.resource, decision: a.decision ?? 'ALLOWED', contextRedacted: toJsonSafe(a.context ?? {}), correlationId: a.correlationId,
      },
    });
  }

  async security(tx: Tx, s: {
    ownerId: string | null; actorDeviceId?: string | null; type: string; resourceType?: string; resourceId?: string;
    decision: string; evidenceHash?: string;
  }) {
    await tx.securityEvent.create({ data: { ...s, actorDeviceId: s.actorDeviceId ?? null } });
  }

  /**
   * B31 : chaque événement notifiable → 1 Notification persistante + 2 livraisons (PUSH, EMAIL).
   * Le contenu ne contient pas de secret ; les montants sont exclus du push verrouillé (metadataSafe sans montant).
   */
  async notify(tx: Tx, n: {
    ownerId: string; sourceEventId: string; type: string; category: string; priority: Priority;
    title: string; body: string; link?: string; metadataSafe?: Record<string, unknown>;
  }) {
    const existing = await tx.notification.findUnique({ where: { ownerId_sourceEventId: { ownerId: n.ownerId, sourceEventId: n.sourceEventId } } });
    if (existing) return existing;
    const notif = await tx.notification.create({
      data: {
        ownerId: n.ownerId, sourceEventId: n.sourceEventId, type: n.type, category: n.category, priority: n.priority,
        titleKey: n.type, title: n.title, body: n.body, link: n.link, metadataSafe: toJsonSafe(n.metadataSafe ?? {}),
      },
    });
    for (const channel of ['PUSH', 'EMAIL']) {
      await tx.notificationDelivery.create({ data: { notificationId: notif.id, channel, deliveryIdempotencyKey: `${notif.id}:${channel}` } });
    }
    await this.emit(tx, { ownerId: n.ownerId, eventType: 'notification.created', aggregateType: 'Notification', aggregateId: notif.id, payload: { priority: n.priority } });
    return notif;
  }
}
