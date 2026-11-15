import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { digestOf } from './crypto';
import { DomainError } from './errors';
import { toJsonSafe } from './http';
import { PrismaService, Tx } from './prisma.service';

/**
 * Idempotency-Key pour commandes sensibles (backend.md §18) : même clé + même corps → même résultat logique ;
 * même clé + corps différent → 409 IDEMPOTENCY_PAYLOAD_MISMATCH.
 */
@Injectable()
export class IdempotencyService {
  constructor(private prisma: PrismaService) {}

  async run<T>(ownerId: string, operation: string, key: string | undefined, body: unknown, fn: (tx: Tx) => Promise<T>, opts: { serializable?: boolean } = {}): Promise<T> {
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'En-tête Idempotency-Key requis (8–128 caractères)');
    const requestDigest = digestOf(body);
    const prior = await this.prisma.idempotencyRecord.findUnique({ where: { ownerId_operation_key: { ownerId, operation, key } } });
    if (prior) return this.replay(prior, requestDigest);
    try {
      return await this.prisma.tx(async (tx) => {
        const rec = await tx.idempotencyRecord.create({ data: { ownerId, operation, key, requestDigest } });
        const result = await fn(tx);
        await tx.idempotencyRecord.update({ where: { id: rec.id }, data: { responseStatus: 200, responseBody: toJsonSafe(result) as any } });
        return result;
      }, opts);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.idempotencyRecord.findUnique({ where: { ownerId_operation_key: { ownerId, operation, key } } });
        if (again) return this.replay(again, requestDigest);
      }
      throw e;
    }
  }

  private replay(rec: { requestDigest: string; responseBody: any }, digest: string): any {
    if (rec.requestDigest !== digest) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Clé d’idempotence déjà utilisée avec un contenu différent');
    return rec.responseBody;
  }
}
