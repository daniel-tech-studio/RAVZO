import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { AuthContext } from '../../common/auth';
import { clock } from '../../common/clock';
import { config } from '../../common/config';
import { DomainError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';

export interface PushPayload { id: string; type: string; priority: string; title: string; body: string; link: string | null }

/** Masque les montants : un push peut s'afficher sur écran verrouillé (llm §14.1). */
export function redactAmounts(s: string) {
  return s.replace(/\d[\d\s  .,]{2,}\d\s*(F\b|FCFA|XOF)?/g, '•••').replace(/\d+\s*(FCFA|XOF|F\b)/g, '•••');
}

/**
 * Firebase Cloud Messaging (API HTTP v1) — Android, iOS, macOS.
 * Le serveur signe lui-même son jeton OAuth (JWT RS256) à partir du compte de service : aucune dépendance Google,
 * la clé ne quitte jamais le serveur. Un jeton FCM n'est accepté que d'un appareil de confiance ; il est supprimé
 * quand l'appareil est révoqué, à la déconnexion, ou quand FCM le déclare invalide.
 */
@Injectable()
export class FcmPushService {
  private log = new Logger('FCM');
  private access: { token: string; exp: number } | null = null;
  constructor(private prisma: PrismaService) {}

  private account(): { client_email: string; private_key: string; project_id?: string } | null {
    const f = config.fcm.serviceAccountFile;
    if (!f || !existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
  }
  get configured() { return !!(config.fcm.projectId && this.account()); }

  private async accessToken() {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const sa = this.account();
    if (!sa) throw new Error('Compte de service Firebase absent');
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
    const j: any = await r.json();
    if (!r.ok || !j.access_token) throw new Error(`OAuth Google refusé (${r.status} ${j.error ?? ''})`);
    this.access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }

  // ─── Enregistrement des appareils ───
  async register(auth: AuthContext, token: string, platform: string) {
    if (!auth.deviceId || !auth.deviceTrusted) throw new DomainError('UNTRUSTED_DEVICE', 'Appareil de confiance requis');
    if (!/^[\w:.-]{20,4096}$/.test(token)) throw new DomainError('VALIDATION_FAILED', 'Jeton push invalide');
    await this.prisma.pushDeviceToken.deleteMany({ where: { deviceId: auth.deviceId, token: { not: token } } });
    await this.prisma.pushDeviceToken.upsert({ where: { token }, create: { ownerId: auth.ownerId, deviceId: auth.deviceId, token, platform }, update: { ownerId: auth.ownerId, deviceId: auth.deviceId, platform, lastSeenAt: clock.now() } });
    return { registered: true, configured: this.configured };
  }
  async unregister(auth: AuthContext) {
    const r = await this.prisma.pushDeviceToken.deleteMany({ where: { deviceId: auth.deviceId ?? '00000000-0000-0000-0000-000000000000' } });
    return { removed: r.count };
  }

  /** Envoi à tous les appareils de confiance actifs. SENT si au moins un appareil a accepté. */
  async send(ownerId: string, n: PushPayload): Promise<{ status: 'SENT' | 'FAILED' | 'NOT_CONFIGURED'; error?: string }> {
    if (!this.configured) return { status: 'NOT_CONFIGURED', error: 'Firebase non configuré (compte de service absent)' };
    const tokens = await this.prisma.pushDeviceToken.findMany({ where: { ownerId } });
    const devices = await this.prisma.trustedDevice.findMany({ where: { id: { in: tokens.map((t) => t.deviceId) }, status: 'ACTIVE' } });
    const active = tokens.filter((t) => devices.some((d) => d.id === t.deviceId));
    if (!active.length) return { status: 'NOT_CONFIGURED', error: 'Aucun appareil inscrit aux notifications' };
    let ok = 0; const errors: string[] = [];
    let bearer: string;
    try { bearer = await this.accessToken(); } catch (e: any) { return { status: 'FAILED', error: String(e?.message).slice(0, 160) }; }
    const urgent = n.priority === 'CRITICAL' || n.priority === 'HIGH';
    for (const t of active) {
      const message = {
        token: t.token,
        notification: { title: redactAmounts(n.title).slice(0, 200), body: redactAmounts(n.body).slice(0, 1000) },
        data: { notificationId: n.id, type: n.type, link: n.link ?? '' },
        android: { priority: urgent ? 'HIGH' : 'NORMAL', notification: { channel_id: 'ravzo_default', tag: n.id } },
        apns: { headers: { 'apns-priority': urgent ? '10' : '5', 'apns-collapse-id': n.id.slice(0, 64) }, payload: { aps: { sound: 'default' } } },
      };
      try {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${config.fcm.projectId}/messages:send`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
        if (r.ok) { ok++; continue; }
        const j: any = await r.json().catch(() => ({}));
        const code = j?.error?.details?.find((d: any) => d.errorCode)?.errorCode ?? j?.error?.status ?? r.status;
        if (code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' || r.status === 404) await this.prisma.pushDeviceToken.delete({ where: { id: t.id } }).catch(() => undefined);
        errors.push(String(code));
      } catch (e: any) { errors.push(String(e?.message).slice(0, 80)); }
    }
    if (errors.length) this.log.warn(JSON.stringify({ fcm: 'partial', ok, errors }));
    return ok > 0 ? { status: 'SENT' } : { status: 'FAILED', error: errors.join(',').slice(0, 200) };
  }
}
