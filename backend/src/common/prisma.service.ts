import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { config } from './config';

export type Tx = Prisma.TransactionClient;

/**
 * Accès PRIMAIRE. Toute décision financière (soldes, plafonds, holds, sécurité) passe par ici (backend.md §2.2, T21).
 * Les lectures analytiques tolérantes au retard peuvent utiliser `reader` (réplica si DB_READ_URL, sinon primaire).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  readonly reader: PrismaClient;
  readonly readerIsReplica: boolean;

  constructor() {
    super({ datasources: { db: { url: config.dbPrimaryUrl } } });
    this.readerIsReplica = !!config.dbReadUrl;
    this.reader = config.dbReadUrl ? new PrismaClient({ datasources: { db: { url: config.dbReadUrl } } }) : this;
  }
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() {
    await this.$disconnect();
    if (this.reader !== this) await this.reader.$disconnect();
  }

  /** Transaction courte ; retry borné des seules erreurs de sérialisation/deadlock (jamais d'appel PSP dedans). */
  async tx<T>(fn: (tx: Tx) => Promise<T>, opts: { serializable?: boolean; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? (opts.serializable ? 8 : 3);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: opts.serializable ? Prisma.TransactionIsolationLevel.Serializable : Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
          maxWait: 10000,
        });
      } catch (e: any) {
        const code = e?.code ?? e?.meta?.code;
        const retryable = code === 'P2034' || /40001|40P01|could not serialize|deadlock/i.test(String(e?.message));
        if (!retryable || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
      }
    }
  }
}
