import { Controller, Get, Headers, Query, Req, Res } from '@nestjs/common';
import { AllowPendingDevice, Auth, AuthContext } from '../../common/auth';
import { clock } from '../../common/clock';
import { PrismaService } from '../../common/prisma.service';

/**
 * SSE (backend.md §21.1) : authentifié par en-tête Authorization (jamais de jeton dans l'URL), diffusion APRÈS commit
 * depuis le journal SyncEvent (séquence monotone), reprise via Last-Event-ID/cursor, battements de cœur,
 * fermeture immédiate si la session est révoquée. Un SSE manqué n'est jamais une perte : /sync/changes fait foi.
 */
@Controller()
export class SseController {
  constructor(private prisma: PrismaService) {}

  @AllowPendingDevice() @Get('events/stream')
  async stream(@Auth() a: AuthContext, @Headers('last-event-id') lastEventId: string | undefined, @Query('cursor') cursor: string | undefined, @Req() req: any, @Res() res: any) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let last = BigInt(/^\d+$/.test(lastEventId ?? '') ? lastEventId! : /^\d+$/.test(cursor ?? '') ? cursor! : (await this.prisma.syncEvent.findFirst({ where: { ownerId: a.ownerId }, orderBy: { sequence: 'desc' } }))?.sequence.toString() ?? '0');
    res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ cursor: last.toString(), serverTime: clock.now().toISOString() })}\n\n`);
    let closed = false, ticks = 0;
    const tick = async () => {
      if (closed) return;
      ticks++;
      try {
        if (ticks % 15 === 0) {
          const s = await this.prisma.session.findUnique({ where: { id: a.sessionId } });
          if (!s || s.revokedAt || s.expiresAt < clock.now()) { res.write(`event: session.revoked\ndata: {}\n\n`); return close(); }
        }
        const evs = await this.prisma.syncEvent.findMany({ where: { ownerId: a.ownerId, sequence: { gt: last } }, orderBy: { sequence: 'asc' }, take: 200 });
        for (const e of evs) {
          res.write(`id: ${e.sequence}\nevent: ${e.eventType}\ndata: ${JSON.stringify({ sequence: e.sequence.toString(), resourceType: e.resourceType, resourceId: e.resourceId, version: e.version })}\n\n`);
          last = e.sequence;
        }
        if (ticks % 20 === 0) res.write(`: heartbeat ${clock.now().toISOString()}\n\n`);
      } catch { /* la prochaine itération réessaie ; le client se resynchronise par /sync/changes */ }
    };
    const timer = setInterval(tick, 1000);
    const close = () => { if (closed) return; closed = true; clearInterval(timer); res.end(); };
    req.on('close', close);
  }
}
