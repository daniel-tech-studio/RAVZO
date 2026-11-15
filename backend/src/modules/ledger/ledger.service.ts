import { Injectable } from '@nestjs/common';
import { LedgerAccountKind, LedgerBook, Prisma } from '@prisma/client';
import { economicToday } from '../../common/clock';
import { DomainError } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';

export interface PostingInput { accountId: string; amount: bigint }
export interface PostInput {
  ownerId: string;
  book?: LedgerBook;
  businessType: string;
  businessId: string;
  purpose?: string;
  economicDate?: Date;
  memo?: string;
  source?: string;
  actorDeviceId?: string | null;
  externalCorrelationId?: string;
  reversalOfId?: string;
  postings: PostingInput[];
}

const CREDIT_NORMAL: LedgerAccountKind[] = ['LIABILITY', 'INCOME', 'EQUITY', 'ALLOCATION_POOL'];
/** Solde « naturel » affichable (positif = normal) à partir d'un solde signé débit-positif. */
export const naturalBalance = (kind: LedgerAccountKind, signed: bigint) => (CREDIT_NORMAL.includes(kind) ? -signed : signed);

/**
 * Seul point d'écriture du registre (backend.md §3, §7.2).
 * - postings équilibrés par devise (pré-contrôle applicatif + trigger SQL différé),
 * - verrous des projections dans un ordre déterministe,
 * - projection AccountBalance mise à jour dans la MÊME transaction,
 * - unicité (businessType, businessId, purpose) : un événement métier n'est jamais posté deux fois.
 */
@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async ensureAccount(tx: Tx, a: { ownerId: string; code: string; name: string; kind: LedgerAccountKind; book?: LedgerBook; currency?: string }) {
    const existing = await tx.ledgerAccount.findUnique({ where: { ownerId_code: { ownerId: a.ownerId, code: a.code } } });
    if (existing) return existing;
    const acc = await tx.ledgerAccount.create({
      data: { ownerId: a.ownerId, code: a.code, name: a.name, kind: a.kind, book: a.book ?? (a.kind === 'ALLOCATION' || a.kind === 'ALLOCATION_POOL' ? 'ALLOCATION' : 'REAL'), currency: a.currency ?? 'XOF' },
    });
    await tx.accountBalance.create({ data: { ledgerAccountId: acc.id } });
    return acc;
  }

  async findPosted(db: Tx | PrismaService, businessType: string, businessId: string, purpose = 'MAIN') {
    return db.ledgerTransaction.findUnique({ where: { businessType_businessId_postingPurpose: { businessType, businessId, postingPurpose: purpose } }, include: { postings: true } });
  }

  async post(tx: Tx, input: PostInput) {
    const purpose = input.purpose ?? 'MAIN';
    const already = await this.findPosted(tx, input.businessType, input.businessId, purpose);
    if (already) return { transaction: already, duplicate: true };

    const postings = input.postings.filter((p) => p.amount !== 0n);
    if (postings.length < 2) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Une écriture requiert au moins deux mouvements non nuls');
    const ids = [...new Set(postings.map((p) => p.accountId))].sort();
    const accounts = await tx.ledgerAccount.findMany({ where: { id: { in: ids } } });
    if (accounts.length !== ids.length) throw new DomainError('NOT_FOUND', 'Compte comptable introuvable');
    const book = input.book ?? 'REAL';
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const sums = new Map<string, bigint>();
    for (const p of postings) {
      const acc = byId.get(p.accountId)!;
      if (acc.ownerId !== input.ownerId) throw new DomainError('NOT_FOUND', 'Compte comptable introuvable');
      if (acc.book !== book) throw new DomainError('BUSINESS_RULE_VIOLATION', `Compte ${acc.code} hors du livre ${book}`);
      if (!acc.isPostingAllowed || acc.status !== 'ACTIVE') throw new DomainError('BUSINESS_RULE_VIOLATION', `Compte ${acc.code} fermé aux écritures`);
      sums.set(acc.currency, (sums.get(acc.currency) ?? 0n) + p.amount);
    }
    for (const [cur, s] of sums) if (s !== 0n) throw new DomainError('BUSINESS_RULE_VIOLATION', `Écriture déséquilibrée en ${cur} (${s})`);

    // Verrouillage ordonné des projections (évite interblocages et courses multi-appareils).
    await tx.$queryRaw`SELECT "ledgerAccountId" FROM "AccountBalance" WHERE "ledgerAccountId" IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))}) ORDER BY "ledgerAccountId" FOR UPDATE`;

    const t = await tx.ledgerTransaction.create({
      data: {
        ownerId: input.ownerId, book, businessType: input.businessType, businessId: input.businessId, postingPurpose: purpose,
        economicDate: input.economicDate ?? economicToday(), memo: input.memo, source: input.source ?? 'OWNER',
        actorDeviceId: input.actorDeviceId ?? null, externalCorrelationId: input.externalCorrelationId, reversalOfId: input.reversalOfId,
        postings: { create: postings.map((p, i) => ({ ledgerAccountId: p.accountId, signedAmountMinor: p.amount, currency: byId.get(p.accountId)!.currency, postingOrdinal: i + 1 })) },
      },
      include: { postings: true },
    });
    for (const p of postings) {
      await tx.accountBalance.update({
        where: { ledgerAccountId: p.accountId },
        data: { balanceMinor: { increment: p.amount }, ledgerSequence: t.sequence, version: { increment: 1 } },
      });
    }
    return { transaction: t, duplicate: false };
  }

  /** Contrepassation traçable : jamais d'écrasement (llm §5.2). Une seule contrepassation par écriture. */
  async reverse(tx: Tx, ownerId: string, transactionId: string, reason: string, actorDeviceId?: string | null) {
    const orig = await tx.ledgerTransaction.findUnique({ where: { id: transactionId }, include: { postings: true } });
    if (!orig || orig.ownerId !== ownerId) throw new DomainError('NOT_FOUND', 'Écriture introuvable');
    if (orig.businessType === 'REVERSAL') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Une contrepassation ne se contrepasse pas ; saisir une nouvelle écriture');
    return this.post(tx, {
      ownerId, book: orig.book, businessType: 'REVERSAL', businessId: orig.id, memo: `Contrepassation : ${reason}`, reversalOfId: orig.id,
      actorDeviceId, postings: orig.postings.map((p) => ({ accountId: p.ledgerAccountId, amount: -p.signedAmountMinor })),
    });
  }

  async balance(db: Tx | PrismaService, ledgerAccountId: string): Promise<bigint> {
    const b = await db.accountBalance.findUnique({ where: { ledgerAccountId } });
    return b?.balanceMinor ?? 0n;
  }

  /** Recomptage du journal vs projections (job périodique, backend.md §7.2). */
  async auditProjections(ownerId?: string) {
    const rows = await this.prisma.$queryRaw<{ id: string; code: string; projected: bigint; journal: bigint }[]>`
      SELECT a.id, a.code, b."balanceMinor" AS projected, COALESCE(SUM(p."signedAmountMinor"), 0)::bigint AS journal
      FROM "LedgerAccount" a JOIN "AccountBalance" b ON b."ledgerAccountId" = a.id
      LEFT JOIN "LedgerPosting" p ON p."ledgerAccountId" = a.id
      WHERE (${ownerId ?? null}::uuid IS NULL OR a."ownerId" = ${ownerId ?? null}::uuid)
      GROUP BY a.id, a.code, b."balanceMinor"
      HAVING b."balanceMinor" <> COALESCE(SUM(p."signedAmountMinor"), 0)`;
    const unbalanced = await this.prisma.$queryRaw<{ transactionId: string }[]>`
      SELECT "transactionId" FROM "LedgerPosting" GROUP BY "transactionId", currency HAVING SUM("signedAmountMinor") <> 0`;
    return { projectionMismatches: rows, unbalancedTransactions: unbalanced, healthy: rows.length === 0 && unbalanced.length === 0 };
  }
}
