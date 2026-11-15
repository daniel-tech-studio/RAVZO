import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { addMs, clock } from '../../common/clock';
import { digestOf, randomToken, sha256, verifyEd25519 } from '../../common/crypto';
import { DomainError } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';

export interface ApprovalProof { challengeId: string; signature: string }

export const approvalMessage = (a: { id: string; action: string; operationDigest: string; nonce: string; expiresAt: Date }) =>
  `RAVZO-APPROVAL-V1|${a.id}|${a.action}|${a.operationDigest}|${a.nonce}|${a.expiresAt.toISOString()}`;

/**
 * Preuve forte par opération (B10–B12, backend.md §10.2 étape 8, §20.2) :
 * challenge serveur à usage unique, lié au digest canonique des paramètres EXACTS, signé Ed25519 par la clé de l'appareil.
 * Toute modification des paramètres après signature → SIGNED_APPROVAL_INVALID (T20). Rejeu → refus.
 */
@Injectable()
export class StepUpService {
  static TTL_MS = 5 * 60_000;
  constructor(private prisma: PrismaService, private events: EventsService) {}

  async createChallenge(auth: AuthContext, action: string, params: unknown, policySnapshot: Record<string, unknown> = {}) {
    if (!auth.deviceTrusted || !auth.deviceId) throw new DomainError('UNTRUSTED_DEVICE', 'Appareil de confiance requis pour une validation forte');
    const nonce = randomToken(24);
    const operationDigest = digestOf({ action, params });
    const expiresAt = addMs(clock.now(), StepUpService.TTL_MS);
    const rec = await this.prisma.signedApproval.create({
      data: { ownerId: auth.ownerId, deviceId: auth.deviceId, action, operationDigest, challengeNonceHash: sha256(nonce), expiresAt, policySnapshot: policySnapshot as any },
    });
    return { challengeId: rec.id, action, nonce, operationDigest, expiresAt, message: approvalMessage({ id: rec.id, action, operationDigest, nonce, expiresAt }) };
  }

  /** Vérifie et CONSOMME la preuve dans la transaction métier fournie. */
  async verifyAndConsume(tx: Tx, auth: AuthContext, proof: ApprovalProof | undefined, action: string, params: unknown): Promise<string> {
    if (!proof?.challengeId || !proof?.signature) throw new DomainError('STEP_UP_REQUIRED', 'Validation forte requise pour cette opération', { action });
    const rec = await tx.signedApproval.findUnique({ where: { id: proof.challengeId } });
    const fail = async (code: string, msg: string) => {
      await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'STEP_UP_REJECTED', resourceType: action, decision: code });
      return new DomainError(code, msg);
    };
    if (!rec || rec.ownerId !== auth.ownerId || rec.deviceId !== auth.deviceId || rec.action !== action) throw await fail('SIGNED_APPROVAL_INVALID', 'Preuve non valide pour cette opération');
    if (rec.consumedAt) throw await fail('SIGNED_APPROVAL_INVALID', 'Preuve déjà utilisée (rejeu refusé)');
    if (rec.expiresAt < clock.now()) throw await fail('SIGNED_APPROVAL_EXPIRED', 'Preuve expirée, nouvelle validation requise');
    if (rec.operationDigest !== digestOf({ action, params })) throw await fail('SIGNED_APPROVAL_INVALID', 'Les paramètres ont changé depuis la signature : nouvelle confirmation requise');
    const device = await tx.trustedDevice.findUnique({ where: { id: rec.deviceId } });
    if (!device || device.status !== 'ACTIVE') throw await fail('UNTRUSTED_DEVICE', 'Appareil non fiable');
    // Le nonce n'est pas stocké en clair : le client renvoie la signature du message complet ; on reconstruit avec le nonce hashé impossible,
    // donc le client transmet aussi le nonce dans la signature (format signature = base64sig.nonce).
    const [sig, nonce] = proof.signature.split('.');
    if (!nonce || sha256(nonce) !== rec.challengeNonceHash) throw await fail('SIGNED_APPROVAL_INVALID', 'Nonce invalide');
    const msg = approvalMessage({ id: rec.id, action, operationDigest: rec.operationDigest, nonce, expiresAt: rec.expiresAt });
    if (!verifyEd25519(device.publicKey, msg, sig)) throw await fail('SIGNED_APPROVAL_INVALID', 'Signature invalide');
    const consumed = await tx.signedApproval.updateMany({ where: { id: rec.id, consumedAt: null }, data: { consumedAt: clock.now(), signatureDigest: sha256(sig) } });
    if (consumed.count !== 1) throw await fail('SIGNED_APPROVAL_INVALID', 'Preuve déjà utilisée (rejeu refusé)');
    await this.events.security(tx, { ownerId: auth.ownerId, actorDeviceId: auth.deviceId, type: 'STEP_UP_ACCEPTED', resourceType: action, decision: 'ALLOWED', evidenceHash: sha256(sig) });
    return rec.id;
  }
}
