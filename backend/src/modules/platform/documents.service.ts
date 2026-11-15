import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { AuthContext } from '../../common/auth';
import { addMs, clock } from '../../common/clock';
import { config } from '../../common/config';
import { randomToken, sha256 } from '../../common/crypto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService } from '../../common/prisma.service';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'text/csv'];

/** Détection du type réel par signature (anti MIME spoofing). */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 2).toString('hex') === '504b') return 'application/zip';
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b !== 127) || b >= 128) && !sample.includes(0)) return 'text/csv';
  return null;
}

/** Stockage privé chiffré (AES-256-GCM, clé de fichier enveloppée par la clé maîtresse), jamais d'URL publique permanente. */
@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService, private events: EventsService) {}

  private masterKey() {
    const k = Buffer.from(config.documentMasterKey, 'base64');
    if (k.length !== 32) throw new DomainError('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Stockage documentaire non configuré (DOCUMENT_MASTER_KEY)');
    return k;
  }
  private wrap(dek: Buffer) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const enc = Buffer.concat([c.update(dek), c.final()]);
    return `v1.${iv.toString('base64')}.${enc.toString('base64')}.${c.getAuthTag().toString('base64')}`;
  }
  private unwrap(ref: string) {
    const [, iv, enc, tag] = ref.split('.');
    const d = createDecipheriv('aes-256-gcm', this.masterKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]);
  }
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DomainError('DOCUMENT_ACCESS_DENIED', 'Clé invalide');
    return join(resolve(config.storageDir), key.slice(0, 2), key);
  }

  async requestUpload(auth: AuthContext, dto: { originalName: string; mimeDeclared: string; sizeBytes: number; linkedResource?: string }) {
    this.masterKey();
    if (!ALLOWED_MIME.includes(dto.mimeDeclared)) throw new DomainError('VALIDATION_FAILED', 'Type de fichier non autorisé', { allowed: ALLOWED_MIME });
    if (dto.sizeBytes <= 0 || dto.sizeBytes > MAX_DOCUMENT_BYTES) throw new DomainError('VALIDATION_FAILED', 'Taille maximale 10 Mo');
    const uploadToken = randomToken(24);
    const doc = await this.prisma.documentAttachment.create({ data: { ownerId: auth.ownerId, storageKey: sha256(uploadToken + randomToken(8)), cipherKeyRef: this.wrap(randomBytes(32)), originalName: dto.originalName.replace(/[^\w.\- ]/g, '_').slice(0, 120), mimeDeclared: dto.mimeDeclared, sizeBytes: dto.sizeBytes, linkedResource: dto.linkedResource } });
    await this.prisma.documentAccessGrant.create({ data: { documentId: doc.id, tokenHash: sha256(`up:${uploadToken}`), expiresAt: addMs(clock.now(), 10 * 60_000) } });
    return { documentId: doc.id, uploadToken, uploadPath: `/api/v1/documents/${doc.id}/content`, expiresInSec: 600, maxBytes: dto.sizeBytes };
  }

  async upload(auth: AuthContext, id: string, uploadToken: string, body: Buffer) {
    const doc = await this.prisma.documentAttachment.findUnique({ where: { id } });
    if (!doc || doc.ownerId !== auth.ownerId) throw notFound('Document');
    if (doc.state !== 'PENDING_UPLOAD') throw new DomainError('STATE_CONFLICT', 'Contenu déjà reçu');
    const g = await this.prisma.documentAccessGrant.findUnique({ where: { tokenHash: sha256(`up:${uploadToken}`) } });
    if (!g || g.documentId !== id || g.usedAt || g.expiresAt < clock.now()) throw new DomainError('DOCUMENT_ACCESS_DENIED', 'Autorisation de dépôt invalide ou expirée');
    if (body.length !== doc.sizeBytes || body.length > MAX_DOCUMENT_BYTES) throw new DomainError('VALIDATION_FAILED', 'Taille différente de celle annoncée');
    const detected = sniffMime(body);
    const ok = detected === doc.mimeDeclared;
    await this.prisma.documentAccessGrant.update({ where: { id: g.id }, data: { usedAt: clock.now() } });
    if (!ok) {
      await this.prisma.documentAttachment.update({ where: { id }, data: { state: 'REJECTED', mimeDetected: detected } });
      throw new DomainError('VALIDATION_FAILED', 'Le contenu ne correspond pas au type déclaré (fichier refusé)', { detected });
    }
    const dek = this.unwrap(doc.cipherKeyRef);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', dek, iv);
    const enc = Buffer.concat([iv, c.update(body), c.final(), c.getAuthTag()]);
    const p = this.path(doc.storageKey);
    await fs.mkdir(join(p, '..'), { recursive: true, mode: 0o700 });
    await fs.writeFile(p, enc, { mode: 0o600 });
    return this.prisma.documentAttachment.update({ where: { id }, data: { mimeDetected: detected, sha256: sha256(body), state: 'UPLOADED_PENDING_COMPLETE' } });
  }

  async complete(auth: AuthContext, id: string, expectedSha256: string) {
    const doc = await this.prisma.documentAttachment.findUnique({ where: { id } });
    if (!doc || doc.ownerId !== auth.ownerId) throw notFound('Document');
    if (doc.state !== 'UPLOADED_PENDING_COMPLETE') throw new DomainError('STATE_CONFLICT', 'Document non prêt');
    if (doc.sha256 !== expectedSha256.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 'Empreinte SHA-256 différente');
    return this.prisma.documentAttachment.update({ where: { id }, data: { state: 'ACTIVE' } });
  }

  async readDecrypted(ownerId: string, id: string): Promise<{ doc: any; content: Buffer }> {
    const doc = await this.prisma.documentAttachment.findUnique({ where: { id } });
    if (!doc || doc.ownerId !== ownerId || doc.state !== 'ACTIVE') throw notFound('Document');
    const enc = await fs.readFile(this.path(doc.storageKey));
    const d = createDecipheriv('aes-256-gcm', this.unwrap(doc.cipherKeyRef), enc.subarray(0, 12));
    d.setAuthTag(enc.subarray(enc.length - 16));
    return { doc, content: Buffer.concat([d.update(enc.subarray(12, enc.length - 16)), d.final()]) };
  }

  /** Autorisation temporaire (5 min, usage unique), auditée. */
  async grantAccess(auth: AuthContext, id: string) {
    const doc = await this.prisma.documentAttachment.findUnique({ where: { id } });
    if (!doc || doc.ownerId !== auth.ownerId || doc.state !== 'ACTIVE') throw notFound('Document');
    const token = randomToken(24);
    await this.prisma.tx(async (tx) => {
      await tx.documentAccessGrant.create({ data: { documentId: id, tokenHash: sha256(`dl:${token}`), expiresAt: addMs(clock.now(), 5 * 60_000) } });
      await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'DOCUMENT_ACCESS_GRANTED', resource: `Document:${id}` });
    });
    return { accessPath: `/api/v1/documents/access/${token}`, expiresInSec: 300 };
  }
  async consumeAccess(token: string) {
    const g = await this.prisma.documentAccessGrant.findUnique({ where: { tokenHash: sha256(`dl:${token}`) } });
    if (!g || g.usedAt || g.expiresAt < clock.now()) throw new DomainError('DOCUMENT_ACCESS_DENIED', 'Lien expiré ou déjà utilisé');
    await this.prisma.documentAccessGrant.update({ where: { id: g.id }, data: { usedAt: clock.now() } });
    const doc = await this.prisma.documentAttachment.findUniqueOrThrow({ where: { id: g.documentId } });
    return this.readDecrypted(doc.ownerId, doc.id);
  }
  async remove(auth: AuthContext, id: string) {
    const doc = await this.prisma.documentAttachment.findUnique({ where: { id } });
    if (!doc || doc.ownerId !== auth.ownerId) throw notFound('Document');
    await fs.rm(this.path(doc.storageKey), { force: true });
    await this.prisma.tx(async (tx) => {
      await tx.documentAttachment.update({ where: { id }, data: { state: 'DELETED' } });
      await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'DOCUMENT_DELETED', resource: `Document:${id}`, context: { tombstone: doc.storageKey } });
    });
    return { id, state: 'DELETED' };
  }
}
