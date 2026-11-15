import { Injectable, Logger, Optional } from '@nestjs/common';
import { FcmPushService } from '../modules/platform/fcm-push.service';
import { clock } from '../common/clock';
import { PrismaService } from '../common/prisma.service';
import { ChannelResult, EmailChannel, OutgoingNotification } from './channels';

/**
 * Consommateurs idempotents de l'outbox (ProcessedEvent unique par consommateur/événement, T22).
 * Livraisons PUSH/EMAIL : sans fournisseur configuré, statut NOT_CONFIGURED explicite (jamais un faux « envoyé »).
 */
@Injectable()
export class OutboxConsumers {
  private log = new Logger('Outbox');
  constructor(private prisma: PrismaService, @Optional() private push?: FcmPushService) {}

  async handle(event: { id: string; eventType: string; aggregateId: string; ownerId: string | null }) {
    if (event.eventType === 'notification.created') await this.once('notifications.delivery', event.id, () => this.deliver(event.aggregateId));
  }

  async once(consumer: string, eventId: string, fn: () => Promise<string | void>) {
    try {
      await this.prisma.processedEvent.create({ data: { consumerName: consumer, eventId } });
    } catch { return false; } // déjà traité par un autre worker
    try { const r = await fn(); await this.prisma.processedEvent.update({ where: { consumerName_eventId: { consumerName: consumer, eventId } }, data: { resultDigest: r ?? 'ok' } }); }
    catch (e) { await this.prisma.processedEvent.delete({ where: { consumerName_eventId: { consumerName: consumer, eventId } } }); throw e; }
    return true;
  }

  readonly email = new EmailChannel();

  /** Une tentative par canal ; échec → retry borné (5) puis DEAD_LETTER ; jamais d'effet sur une transaction financière. */
  async deliver(notificationId: string) {
    const ds = await this.prisma.notificationDelivery.findMany({ where: { notificationId, status: { in: ['PENDING', 'FAILED'] } }, include: { notification: true } });
    for (const d of ds) {
      const n = d.notification;
      const owner = await this.prisma.user.findUnique({ where: { id: n.ownerId } });
      const out = { id: n.id, type: n.type, priority: n.priority, title: n.title, body: n.body, link: n.link };
      let r: ChannelResult;
      if (d.channel === 'EMAIL') r = owner ? await this.email.send(owner.email, out, d.deliveryIdempotencyKey) : { status: 'FAILED', error: 'owner' };
      else r = this.push?.configured ? await this.push.send(n.ownerId, out) : { status: 'NOT_CONFIGURED', error: 'Push non configuré' };
      const attempts = d.attempts + 1;
      await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: r.status === 'FAILED' && attempts >= 5 ? 'DEAD_LETTER' : r.status, attempts: { increment: 1 }, lastAttemptAt: clock.now(), lastError: r.error ?? null } });
    }
    return `${ds.length}`;
  }

  /** Reprise des livraisons en échec (job planifié). */
  async retryFailed() {
    const failed = await this.prisma.notificationDelivery.findMany({ where: { status: 'FAILED' }, select: { notificationId: true }, distinct: ['notificationId'], take: 50 });
    for (const f of failed) await this.deliver(f.notificationId);
    return failed.length;
  }
}

/** Réclame les événements non publiés (SKIP LOCKED : plusieurs dispatchers sûrs) et les publie ; le consommateur reste idempotent. */
export async function claimOutbox(prisma: PrismaService, batch = 100) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND ("claimedAt" IS NULL OR "claimedAt" < now() - interval '1 minute') ORDER BY "createdAt" LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return [];
    await tx.outboxEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { claimedAt: new Date(), attemptCount: { increment: 1 } } });
    return tx.outboxEvent.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  });
}
