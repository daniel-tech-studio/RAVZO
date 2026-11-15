import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AuthContext, signAccessToken } from '../../common/auth';
import { addMs, clock, DAY, HOUR } from '../../common/clock';
import { config } from '../../common/config';
import { fingerprintOf, randomToken, sha256 } from '../../common/crypto';
import { DomainError } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';

const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const DEFAULT_EXPENSE_CATEGORIES: [string, boolean, string, string[]][] = [
  ['Alimentation', true, 'basket', ['marché', 'supermarché', 'restaurant', 'boulangerie']],
  ['Logement', true, 'home', ['loyer', 'sbee', 'soneb', 'électricité', 'eau']],
  ['Transport', true, 'car', ['zem', 'taxi', 'essence', 'carburant', 'gozem']],
  ['Santé', true, 'heart', ['pharmacie', 'clinique', 'médecin']],
  ['Communication', false, 'phone', ['crédit', 'forfait', 'internet', 'mtn', 'moov']],
  ['Éducation', true, 'book', ['école', 'scolarité', 'formation']],
  ['Famille & dons', false, 'gift', ['don', 'tontine', 'cadeau', 'famille']],
  ['Loisirs', false, 'sparkle', ['cinéma', 'sortie', 'abonnement']],
  ['Habillement', false, 'shirt', ['vêtement', 'chaussure']],
  ['Divers', false, 'dots', []],
];
const DEFAULT_INCOME_CATEGORIES = ['Salaire', 'Activité indépendante', 'Revenus locatifs', 'Cadeaux reçus', 'Autres revenus'];

export const RECOVERY_SUSPENSION_MS = 48 * HOUR;

@Injectable()
export class IdentityService {
  constructor(private prisma: PrismaService, private events: EventsService, private ledger: LedgerService, private books: BooksService) {}

  /** Création unique du propriétaire (CLI d'exploitation). Retourne codes de secours + code d'enrôlement du premier appareil, une seule fois. */
  async bootstrapOwner(email: string, password: string, displayName: string) {
    if (password.length < 12) throw new DomainError('VALIDATION_FAILED', 'Mot de passe : 12 caractères minimum');
    const existing = await this.prisma.user.count();
    if (existing > 0) throw new DomainError('ALREADY_EXISTS', 'Le propriétaire existe déjà (application mono-utilisateur)');
    const passwordHash = await argon2.hash(password, ARGON);
    const recoveryCodes = Array.from({ length: 10 }, () => randomToken(10).replace(/[-_]/g, 'x').slice(0, 12).toUpperCase());
    const bootstrapCode = randomToken(9).replace(/[-_]/g, 'z').slice(0, 10).toUpperCase();
    const user = await this.prisma.tx(async (tx) => {
      const u = await tx.user.create({ data: { email: email.trim().toLowerCase(), passwordHash, displayName } });
      await tx.limitPolicy.create({
        data: { ownerId: u.id, perOperationMinor: 30000n, rolling24hMinor: 60000n, referencePerOperationMinor: 30000n, referenceRolling24hMinor: 60000n, effectiveFrom: clock.now(), policyVersion: 1 },
      });
      for (const c of recoveryCodes) await tx.recoveryCode.create({ data: { ownerId: u.id, codeHash: sha256(`rc:${c}`) } });
      await tx.deviceApproval.create({
        data: { ownerId: u.id, candidateDeviceId: u.id, challengeHash: sha256(`boot:${bootstrapCode}`), method: 'BOOTSTRAP', expiresAt: addMs(clock.now(), 7 * DAY) },
      });
      for (const [name, essential, icon, keywords] of DEFAULT_EXPENSE_CATEGORIES) await tx.category.create({ data: { ownerId: u.id, name, type: 'EXPENSE', essential, icon, keywords } });
      for (const name of DEFAULT_INCOME_CATEGORIES) await tx.category.create({ data: { ownerId: u.id, name, type: 'INCOME' } });
      for (const code of ['EQUITY:OPENING', 'ALLOC:POOL', 'EXPENSE:FEES']) await this.books.core(tx, u.id, code);
      await tx.wallet.create({ data: { ownerId: u.id, name: 'Courant', kind: 'CURRENT' } });
      await this.events.audit(tx, { ownerId: u.id, actorType: 'OPS_SERVICE', action: 'OWNER_BOOTSTRAPPED' });
      return u;
    });
    return { ownerId: user.id, recoveryCodes, bootstrapCode };
  }

  private async issueSession(tx: Tx, ownerId: string, deviceId: string | null, familyId: string = randomUUID(), userAgent?: string) {
    const refreshToken = randomToken(32);
    const s = await tx.session.create({
      data: { ownerId, deviceId, refreshTokenHash: sha256(refreshToken), familyId, expiresAt: addMs(clock.now(), config.refreshTokenTtlSec * 1000), userAgent: userAgent?.slice(0, 200) },
    });
    const access = signAccessToken({ sid: s.id, oid: ownerId, did: deviceId, fam: familyId });
    return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, refreshToken, sessionId: s.id };
  }

  async login(input: { email: string; password: string; device: { publicKey: string; name: string; platform: string } }, meta: { ip?: string; ua?: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Anti-bruteforce par compte : 8 échecs / 15 min.
    if (user) {
      const recentFails = await this.prisma.securityEvent.count({ where: { ownerId: user.id, type: 'LOGIN_FAILED', at: { gt: addMs(clock.now(), -15 * 60_000) } } });
      if (recentFails >= 8) throw new DomainError('RATE_LIMITED', 'Trop de tentatives, réessayez plus tard');
    }
    const ok = user ? await argon2.verify(user.passwordHash, input.password) : (await argon2.hash('dummy-timing', ARGON), false);
    if (!user || !ok || user.status !== 'ACTIVE') {
      if (user) await this.prisma.securityEvent.create({ data: { ownerId: user.id, type: 'LOGIN_FAILED', decision: 'DENIED', ipMetadata: meta.ip ? sha256(meta.ip).slice(0, 16) : null } });
      throw new DomainError('INVALID_CREDENTIALS', 'Identifiants invalides');
    }
    let fingerprint: string;
    try { fingerprint = fingerprintOf(input.device.publicKey); } catch { throw new DomainError('VALIDATION_FAILED', 'Clé publique d’appareil invalide (Ed25519 attendue)'); }
    return this.prisma.tx(async (tx) => {
      let device = await tx.trustedDevice.findUnique({ where: { fingerprint } });
      if (device && device.ownerId !== user.id) throw new DomainError('UNTRUSTED_DEVICE', 'Appareil inconnu');
      if (device?.status === 'REVOKED') throw new DomainError('UNTRUSTED_DEVICE', 'Cet appareil a été révoqué ; générez une nouvelle clé pour le réenrôler');
      if (!device) {
        device = await tx.trustedDevice.create({ data: { ownerId: user.id, name: input.device.name.slice(0, 80), platform: input.device.platform.slice(0, 20), publicKey: input.device.publicKey, fingerprint } });
        await this.events.security(tx, { ownerId: user.id, actorDeviceId: device.id, type: 'DEVICE_SEEN_NEW', resourceType: 'TrustedDevice', resourceId: device.id, decision: 'PENDING' });
      }
      const tokens = await this.issueSession(tx, user.id, device.id, undefined, meta.ua);
      await this.events.security(tx, { ownerId: user.id, actorDeviceId: device.id, type: 'LOGIN', decision: device.status === 'ACTIVE' ? 'ALLOWED' : 'PENDING_DEVICE' });
      const hasActive = await tx.trustedDevice.count({ where: { ownerId: user.id, status: 'ACTIVE' } });
      return { ...tokens, device: { id: device.id, status: device.status }, enrollmentRequired: device.status !== 'ACTIVE', bootstrapAvailable: hasActive === 0 };
    });
  }

  /** Rotation du refresh avec détection de réutilisation : un ancien jeton rejoué révoque toute la famille. */
  async refresh(refreshToken: string) {
    const s = await this.prisma.session.findUnique({ where: { refreshTokenHash: sha256(refreshToken) }, include: { device: true } });
    if (!s) throw new DomainError('SESSION_REVOKED', 'Session inconnue');
    if (s.rotatedAt || s.revokedAt) {
      if (s.rotatedAt) {
        await this.prisma.tx(async (tx) => {
          await tx.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: clock.now(), revokeReason: 'REFRESH_REUSE_DETECTED' } });
          await this.events.security(tx, { ownerId: s.ownerId, actorDeviceId: s.deviceId, type: 'REFRESH_REUSE_DETECTED', resourceType: 'Session', resourceId: s.familyId, decision: 'FAMILY_REVOKED' });
          await this.events.notify(tx, { ownerId: s.ownerId, sourceEventId: `refresh-reuse:${s.id}`, type: 'security.session_compromised', category: 'SECURITY', priority: 'CRITICAL', title: 'Session compromise détectée', body: 'Un jeton de session déjà utilisé a été rejoué. Les sessions concernées ont été révoquées.', link: '/security/sessions' });
        });
      }
      throw new DomainError('SESSION_REVOKED', 'Session révoquée');
    }
    if (s.expiresAt < clock.now()) throw new DomainError('SESSION_REVOKED', 'Session expirée');
    if (s.device?.status === 'REVOKED') throw new DomainError('SESSION_REVOKED', 'Appareil révoqué');
    return this.prisma.tx(async (tx) => {
      const upd = await tx.session.updateMany({ where: { id: s.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: clock.now(), revokedAt: clock.now(), revokeReason: 'ROTATED' } });
      if (upd.count !== 1) throw new DomainError('SESSION_REVOKED', 'Session déjà renouvelée');
      return this.issueSession(tx, s.ownerId, s.deviceId, s.familyId, s.userAgent ?? undefined);
    });
  }

  async logout(auth: AuthContext) {
    await this.prisma.session.update({ where: { id: auth.sessionId }, data: { revokedAt: clock.now(), revokeReason: 'LOGOUT' } });
  }

  async me(auth: AuthContext) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.ownerId } });
    const device = auth.deviceId ? await this.prisma.trustedDevice.findUnique({ where: { id: auth.deviceId } }) : null;
    return {
      id: u.id, email: u.email, displayName: u.displayName, locale: u.locale, timezone: u.timezone, preferences: u.preferences, version: u.version,
      device: device && { id: device.id, name: device.name, platform: device.platform, status: device.status },
      restrictions: { financialReadOnlyUntil: auth.financialReadOnlyUntil, paymentsLiveEnabled: config.paymentsLiveEnabled },
    };
  }

  async updatePreferences(auth: AuthContext, prefs: Record<string, unknown>, expectedVersion?: number) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: auth.ownerId } });
    if (expectedVersion !== undefined && expectedVersion !== u.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Préférences modifiées ailleurs', { current: u.preferences, version: u.version });
    const merged = { ...(u.preferences as object), ...prefs };
    const r = await this.prisma.user.update({ where: { id: u.id }, data: { preferences: merged as any, version: { increment: 1 } } });
    return { preferences: r.preferences, version: r.version };
  }

  // ─── Appareils ───
  async listDevices(auth: AuthContext) {
    const devices = await this.prisma.trustedDevice.findMany({ where: { ownerId: auth.ownerId }, orderBy: { createdAt: 'asc' } });
    return devices.map(({ publicKey, ...d }) => ({ ...d, isCurrent: d.id === auth.deviceId }));
  }

  /** Nouvel appareil : crée une demande avec un code court affiché sur l'appareil candidat, à saisir sur un appareil fiable. */
  async createEnrollmentRequest(auth: AuthContext) {
    if (!auth.deviceId) throw new DomainError('VALIDATION_FAILED', 'Session sans appareil');
    if (auth.deviceTrusted) throw new DomainError('STATE_CONFLICT', 'Appareil déjà approuvé');
    const code = String(100000 + Math.floor(Math.random() * 900000)) + String(Math.floor(Math.random() * 100)).padStart(2, '0');
    const req = await this.prisma.tx(async (tx) => {
      await tx.deviceApproval.updateMany({ where: { candidateDeviceId: auth.deviceId!, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      const r = await tx.deviceApproval.create({ data: { ownerId: auth.ownerId, candidateDeviceId: auth.deviceId!, challengeHash: sha256(`enr:${auth.deviceId}:${code}`), method: 'TRUSTED_DEVICE', expiresAt: addMs(clock.now(), 15 * 60_000) } });
      await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `enroll:${r.id}`, type: 'security.device_enrollment_requested', category: 'SECURITY', priority: 'CRITICAL', title: 'Nouvel appareil en attente', body: 'Un nouvel appareil demande l’accès. Approuvez-le uniquement si vous en êtes à l’origine.', link: `/security/devices?enrollment=${r.id}` });
      return r;
    });
    return { id: req.id, code, expiresAt: req.expiresAt };
  }

  async pendingEnrollments(auth: AuthContext) {
    const reqs = await this.prisma.deviceApproval.findMany({ where: { ownerId: auth.ownerId, status: 'PENDING', method: 'TRUSTED_DEVICE', expiresAt: { gt: clock.now() } } });
    const devices = await this.prisma.trustedDevice.findMany({ where: { id: { in: reqs.map((r) => r.candidateDeviceId) } } });
    return reqs.map((r) => ({ id: r.id, expiresAt: r.expiresAt, candidate: devices.find((d) => d.id === r.candidateDeviceId) && { name: devices.find((d) => d.id === r.candidateDeviceId)!.name, platform: devices.find((d) => d.id === r.candidateDeviceId)!.platform } }));
  }

  async approveEnrollment(tx: Tx, auth: AuthContext, requestId: string, code: string) {
    const r = await tx.deviceApproval.findUnique({ where: { id: requestId } });
    if (!r || r.ownerId !== auth.ownerId || r.method !== 'TRUSTED_DEVICE') throw new DomainError('NOT_FOUND', 'Demande introuvable');
    if (r.status !== 'PENDING' || r.expiresAt < clock.now()) throw new DomainError('STATE_CONFLICT', 'Demande expirée ou déjà traitée');
    if (r.challengeHash !== sha256(`enr:${r.candidateDeviceId}:${code}`)) {
      await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'DEVICE_APPROVAL_BAD_CODE', resourceId: r.id, decision: 'DENIED' });
      throw new DomainError('SIGNED_APPROVAL_INVALID', 'Code de vérification incorrect');
    }
    await tx.deviceApproval.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedAt: clock.now(), approverDeviceId: auth.deviceId } });
    await tx.trustedDevice.update({ where: { id: r.candidateDeviceId }, data: { status: 'ACTIVE', approvedAt: clock.now() } });
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'DEVICE_APPROVED', resourceType: 'TrustedDevice', resourceId: r.candidateDeviceId, decision: 'ALLOWED' });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `device-approved:${r.candidateDeviceId}`, type: 'security.device_approved', category: 'SECURITY', priority: 'HIGH', title: 'Nouvel appareil approuvé', body: 'Un appareil a été ajouté à vos appareils de confiance.', link: '/security/devices' });
    return { deviceId: r.candidateDeviceId, status: 'ACTIVE' };
  }

  /** Premier appareil uniquement : code de bootstrap émis à la création du propriétaire. */
  async bootstrapEnroll(auth: AuthContext, code: string) {
    return this.prisma.tx(async (tx) => {
      const active = await tx.trustedDevice.count({ where: { ownerId: auth.ownerId, status: 'ACTIVE' } });
      if (active > 0) throw new DomainError('FORBIDDEN', 'Un appareil de confiance existe déjà : faites approuver ce nouvel appareil');
      const r = await tx.deviceApproval.findUnique({ where: { challengeHash: sha256(`boot:${code.trim().toUpperCase()}`) } });
      if (!r || r.ownerId !== auth.ownerId || r.method !== 'BOOTSTRAP' || r.status !== 'PENDING' || r.expiresAt < clock.now()) {
        await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'BOOTSTRAP_ENROLL_FAILED', decision: 'DENIED' });
        throw new DomainError('SIGNED_APPROVAL_INVALID', 'Code d’initialisation invalide ou expiré');
      }
      await tx.deviceApproval.update({ where: { id: r.id }, data: { status: 'APPROVED', approvedAt: clock.now(), candidateDeviceId: auth.deviceId! } });
      await tx.trustedDevice.update({ where: { id: auth.deviceId! }, data: { status: 'ACTIVE', approvedAt: clock.now() } });
      await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'DEVICE_BOOTSTRAPPED', resourceId: auth.deviceId!, decision: 'ALLOWED' });
      return { deviceId: auth.deviceId, status: 'ACTIVE' };
    });
  }

  async revokeDevice(tx: Tx, auth: AuthContext, deviceId: string) {
    const d = await tx.trustedDevice.findUnique({ where: { id: deviceId } });
    if (!d || d.ownerId !== auth.ownerId) throw new DomainError('NOT_FOUND', 'Appareil introuvable');
    if (d.status === 'REVOKED') return { id: d.id, status: 'REVOKED' };
    await tx.trustedDevice.update({ where: { id: d.id }, data: { status: 'REVOKED', revokedAt: clock.now() } });
    await tx.session.updateMany({ where: { deviceId: d.id, revokedAt: null }, data: { revokedAt: clock.now(), revokeReason: 'DEVICE_REVOKED' } });
    await tx.pushDeviceToken.deleteMany({ where: { deviceId: d.id } });
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'DEVICE_REVOKED', resourceType: 'TrustedDevice', resourceId: d.id, decision: 'ALLOWED' });
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `device-revoked:${d.id}`, type: 'security.device_revoked', category: 'SECURITY', priority: 'HIGH', title: 'Appareil révoqué', body: `L’appareil « ${d.name} » n’a plus accès.`, link: '/security/devices' });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'security.restriction_changed', aggregateType: 'TrustedDevice', aggregateId: d.id });
    return { id: d.id, status: 'REVOKED' };
  }

  async listSessions(auth: AuthContext) {
    const s = await this.prisma.session.findMany({ where: { ownerId: auth.ownerId, revokedAt: null, expiresAt: { gt: clock.now() } }, include: { device: true }, orderBy: { issuedAt: 'desc' } });
    return s.map((x) => ({ id: x.id, issuedAt: x.issuedAt, expiresAt: x.expiresAt, device: x.device && { id: x.device.id, name: x.device.name, platform: x.device.platform, status: x.device.status }, isCurrent: x.id === auth.sessionId, userAgent: x.userAgent }));
  }

  async revokeSession(tx: Tx, auth: AuthContext, sessionId: string) {
    const s = await tx.session.findUnique({ where: { id: sessionId } });
    if (!s || s.ownerId !== auth.ownerId) throw new DomainError('NOT_FOUND', 'Session introuvable');
    await tx.session.updateMany({ where: { familyId: s.familyId, revokedAt: null }, data: { revokedAt: clock.now(), revokeReason: 'OWNER_REVOKED' } });
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'SESSION_REVOKED', resourceId: s.id, decision: 'ALLOWED' });
  }

  // ─── Récupération ───
  async startRecovery(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const challenge = randomToken(24);
    // Réponse identique que le compte existe ou non (pas d'énumération).
    if (!user) return { recoveryId: randomUUID(), challenge, expiresAt: addMs(clock.now(), 15 * 60_000) };
    const rc = await this.prisma.tx(async (tx) => {
      const r = await tx.recoveryCase.create({ data: { ownerId: user.id, method: 'RECOVERY_CODE', challengeHash: sha256(challenge), expiresAt: addMs(clock.now(), 15 * 60_000) } });
      await this.events.security(tx, { ownerId: user.id, type: 'RECOVERY_STARTED', resourceId: r.id, decision: 'PENDING' });
      await this.events.notify(tx, { ownerId: user.id, sourceEventId: `recovery-start:${r.id}`, type: 'security.recovery_started', category: 'SECURITY', priority: 'CRITICAL', title: 'Récupération de compte démarrée', body: 'Une procédure de récupération a été lancée. Si ce n’est pas vous, révoquez immédiatement les sessions inconnues.', link: '/security' });
      return r;
    });
    return { recoveryId: rc.id, challenge, expiresAt: rc.expiresAt };
  }

  /** Récupération intégrale : révoque toutes les sessions et appareils, active le nouvel appareil, suspension financière 48 h (T11). */
  async verifyRecovery(input: { recoveryId: string; challenge: string; recoveryCode: string; newPassword?: string; device: { publicKey: string; name: string; platform: string } }) {
    const rc = await this.prisma.recoveryCase.findUnique({ where: { id: input.recoveryId } });
    if (!rc || rc.challengeHash !== sha256(input.challenge) || rc.status !== 'STARTED' || rc.expiresAt < clock.now() || rc.attempts >= 5) {
      if (rc) await this.prisma.recoveryCase.update({ where: { id: rc.id }, data: { attempts: { increment: 1 } } });
      throw new DomainError('SIGNED_APPROVAL_INVALID', 'Récupération invalide ou expirée');
    }
    const code = await this.prisma.recoveryCode.findFirst({ where: { ownerId: rc.ownerId, codeHash: sha256(`rc:${input.recoveryCode.trim().toUpperCase()}`), usedAt: null, revokedAt: null } });
    if (!code) {
      await this.prisma.recoveryCase.update({ where: { id: rc.id }, data: { attempts: { increment: 1 } } });
      await this.prisma.securityEvent.create({ data: { ownerId: rc.ownerId, type: 'RECOVERY_CODE_REJECTED', resourceId: rc.id, decision: 'DENIED' } });
      throw new DomainError('SIGNED_APPROVAL_INVALID', 'Code de secours invalide');
    }
    if (input.newPassword !== undefined && input.newPassword.length < 12) throw new DomainError('VALIDATION_FAILED', 'Mot de passe : 12 caractères minimum');
    const fingerprint = fingerprintOf(input.device.publicKey);
    const newHash = input.newPassword ? await argon2.hash(input.newPassword, ARGON) : null;
    return this.prisma.tx(async (tx) => {
      const used = await tx.recoveryCode.updateMany({ where: { id: code.id, usedAt: null }, data: { usedAt: clock.now() } });
      if (used.count !== 1) throw new DomainError('SIGNED_APPROVAL_INVALID', 'Code de secours déjà utilisé');
      const until = addMs(clock.now(), RECOVERY_SUSPENSION_MS);
      await tx.session.updateMany({ where: { ownerId: rc.ownerId, revokedAt: null }, data: { revokedAt: clock.now(), revokeReason: 'RECOVERY' } });
      await tx.trustedDevice.updateMany({ where: { ownerId: rc.ownerId, status: { in: ['ACTIVE', 'PENDING'] }, fingerprint: { not: fingerprint } }, data: { status: 'REVOKED', revokedAt: clock.now() } });
      await tx.pushDeviceToken.deleteMany({ where: { ownerId: rc.ownerId } });
      let device = await tx.trustedDevice.findUnique({ where: { fingerprint } });
      if (device && device.ownerId !== rc.ownerId) throw new DomainError('UNTRUSTED_DEVICE', 'Appareil invalide');
      if (!device) device = await tx.trustedDevice.create({ data: { ownerId: rc.ownerId, name: input.device.name, platform: input.device.platform, publicKey: input.device.publicKey, fingerprint, status: 'ACTIVE', approvedAt: clock.now() } });
      else device = await tx.trustedDevice.update({ where: { id: device.id }, data: { status: 'ACTIVE', approvedAt: clock.now(), revokedAt: null } });
      if (newHash) await tx.user.update({ where: { id: rc.ownerId }, data: { passwordHash: newHash } });
      await tx.recoveryCase.update({ where: { id: rc.id }, data: { status: 'VERIFIED', verifiedAt: clock.now(), financialReadOnlyUntil: until, revokedSessionsAt: clock.now() } });
      await this.events.security(tx, { ownerId: rc.ownerId, actorDeviceId: device.id, type: 'RECOVERY_COMPLETED', resourceId: rc.id, decision: 'SUSPENDED_48H' });
      await this.events.notify(tx, { ownerId: rc.ownerId, sourceEventId: `recovery-done:${rc.id}`, type: 'security.recovery_completed', category: 'SECURITY', priority: 'CRITICAL', title: 'Compte récupéré — suspension 48 h', body: 'Toutes les sessions et appareils ont été révoqués. Les modifications financières sont suspendues 48 heures.', link: '/security' });
      await this.events.emit(tx, { ownerId: rc.ownerId, eventType: 'security.restriction_changed', aggregateType: 'RecoveryCase', aggregateId: rc.id });
      const tokens = await this.issueSession(tx, rc.ownerId, device.id);
      const remaining = await tx.recoveryCode.count({ where: { ownerId: rc.ownerId, usedAt: null, revokedAt: null } });
      return { ...tokens, device: { id: device.id, status: 'ACTIVE' }, financialReadOnlyUntil: until, remainingRecoveryCodes: remaining };
    });
  }

  async regenerateRecoveryCodes(tx: Tx, auth: AuthContext) {
    const codes = Array.from({ length: 10 }, () => randomToken(10).replace(/[-_]/g, 'x').slice(0, 12).toUpperCase());
    await tx.recoveryCode.updateMany({ where: { ownerId: auth.ownerId, usedAt: null, revokedAt: null }, data: { revokedAt: clock.now() } });
    for (const c of codes) await tx.recoveryCode.create({ data: { ownerId: auth.ownerId, codeHash: sha256(`rc:${c}`) } });
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'RECOVERY_CODES_REGENERATED', decision: 'ALLOWED' });
    return { recoveryCodes: codes };
  }

  async securityStatus(auth: AuthContext) {
    const remaining = await this.prisma.recoveryCode.count({ where: { ownerId: auth.ownerId, usedAt: null, revokedAt: null } });
    const devices = await this.prisma.trustedDevice.count({ where: { ownerId: auth.ownerId, status: 'ACTIVE' } });
    return {
      serverTime: clock.now(), financialReadOnlyUntil: auth.financialReadOnlyUntil, financialReadOnly: !!auth.financialReadOnlyUntil,
      readAllowed: true, revokeAllowed: true, deviceTrusted: auth.deviceTrusted, activeDevices: devices, remainingRecoveryCodes: remaining,
      paymentsLiveEnabled: config.paymentsLiveEnabled,
    };
  }
}
