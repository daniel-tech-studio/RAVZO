import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { clock } from './clock';
import { config } from './config';
import { hmac, safeEqual } from './crypto';
import { DomainError } from './errors';
import { PrismaService } from './prisma.service';

export interface AuthContext {
  ownerId: string;
  sessionId: string;
  familyId: string;
  deviceId: string | null;
  deviceTrusted: boolean;
  financialReadOnlyUntil: Date | null;
}

export const IS_PUBLIC = 'ravzo:public';
export const ALLOW_PENDING_DEVICE = 'ravzo:allowPending';
export const FINANCIAL_MUTATION = 'ravzo:financialMutation';
export const REQUIRE_TRUSTED = 'ravzo:requireTrusted';

/** Route accessible sans session (login, refresh, recovery, webhooks signés). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Route accessible à une session d'appareil non encore approuvé (enrôlement). */
export const AllowPendingDevice = () => SetMetadata(ALLOW_PENDING_DEVICE, true);
/** Mutation à effet financier : refusée pendant la suspension de récupération 48 h (D/llm §12, T11). */
export const FinancialMutation = () => SetMetadata(FINANCIAL_MUTATION, true);
/** Exige un appareil de confiance actif (en plus de la preuve signée vérifiée par le service). */
export const RequireTrustedDevice = () => SetMetadata(REQUIRE_TRUSTED, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest().auth);

export function signAccessToken(p: { sid: string; oid: string; did: string | null; fam: string }): { token: string; expiresAt: Date } {
  const exp = Math.floor(clock.now().getTime() / 1000) + config.accessTokenTtlSec;
  const body = Buffer.from(JSON.stringify({ ...p, exp, v: 1 })).toString('base64url');
  return { token: `rv1.${body}.${hmac(config.tokenSecret, body)}`, expiresAt: new Date(exp * 1000) };
}
export function verifyAccessToken(token: string): { sid: string; oid: string; did: string | null; fam: string; exp: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'rv1') return null;
  if (!safeEqual(parts[2], hmac(config.tokenSecret, parts[1]))) return null;
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (p.exp * 1000 < clock.now().getTime()) return null;
  return p;
}

@Injectable()
export class SecurityStateService {
  constructor(private prisma: PrismaService) {}
  /** Fin de la suspension de 48 h (horloge serveur), ou null. */
  async financialReadOnlyUntil(ownerId: string, db: any = this.prisma): Promise<Date | null> {
    const rc = await db.recoveryCase.findFirst({
      where: { ownerId, status: 'VERIFIED', financialReadOnlyUntil: { gt: clock.now() } },
      orderBy: { financialReadOnlyUntil: 'desc' },
    });
    return rc?.financialReadOnlyUntil ?? null;
  }
  async assertFinancialWritable(ownerId: string, db: any = this.prisma) {
    const until = await this.financialReadOnlyUntil(ownerId, db);
    if (until) throw new DomainError('RECOVERY_READ_ONLY', 'Suspension de sécurité active : modifications financières en lecture seule', { until });
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService, private sec: SecurityStateService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const handlers = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, handlers)) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string | undefined = req.headers['authorization'];
    const tok = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!tok) throw new DomainError('AUTH_REQUIRED', 'Session requise');
    const p = verifyAccessToken(tok);
    if (!p) throw new DomainError('AUTH_REQUIRED', 'Jeton invalide ou expiré');

    // Vérification serveur à chaque requête : révocation immédiatement effective (llm §4.4).
    const session = await this.prisma.session.findUnique({ where: { id: p.sid }, include: { device: true } });
    if (!session || session.revokedAt || session.expiresAt < clock.now()) throw new DomainError('SESSION_REVOKED', 'Session révoquée ou expirée');
    const device = session.device;
    if (device && device.status === 'REVOKED') throw new DomainError('SESSION_REVOKED', 'Appareil révoqué');
    const trusted = !!device && device.status === 'ACTIVE';
    if (!trusted && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_DEVICE, handlers)) {
      throw new DomainError('UNTRUSTED_DEVICE', 'Appareil non approuvé : enrôlement requis');
    }
    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_TRUSTED, handlers) && !trusted) {
      throw new DomainError('UNTRUSTED_DEVICE', 'Appareil de confiance requis');
    }
    const until = await this.sec.financialReadOnlyUntil(session.ownerId);
    if (until && this.reflector.getAllAndOverride<boolean>(FINANCIAL_MUTATION, handlers)) {
      throw new DomainError('RECOVERY_READ_ONLY', 'Suspension de sécurité active : modifications financières en lecture seule', { until });
    }
    req.auth = {
      ownerId: session.ownerId, sessionId: session.id, familyId: session.familyId,
      deviceId: device?.id ?? null, deviceTrusted: trusted, financialReadOnlyUntil: until,
    } satisfies AuthContext;
    if (device && (!device.lastSeenAt || clock.now().getTime() - device.lastSeenAt.getTime() > 60_000)) {
      await this.prisma.trustedDevice.update({ where: { id: device.id }, data: { lastSeenAt: clock.now() } });
    }
    return true;
  }
}
