import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FinancialAccountType } from '@prisma/client';
import { AuthContext } from '../../common/auth';
import { clock, economicToday, parseDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService, naturalBalance } from '../ledger/ledger.service';

export const LIQUID_TYPES: FinancialAccountType[] = ['CONTROLLED_PSP', 'EXTERNAL_TRACKED', 'CASH_MANUAL'];

@Injectable()
export class AccountsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private events: EventsService) {}

  async getOwned(db: Tx | PrismaService, ownerId: string, id: string) {
    const a = await db.financialAccount.findUnique({ where: { id } });
    if (!a || a.ownerId !== ownerId) throw notFound('Compte');
    return a;
  }

  async present(db: Tx | PrismaService, a: any) {
    const bal = await db.accountBalance.findUnique({ where: { ledgerAccountId: a.ledgerAccountId } });
    const group = a.realBalanceGroupId ? await db.realBalanceGroup.findUnique({ where: { id: a.realBalanceGroupId } }) : null;
    const openCase = await db.reconciliationCase.findFirst({ where: { financialAccountId: a.id, status: { in: ['OPEN', 'INVESTIGATING'] } } });
    return {
      ...a,
      balanceMinor: bal?.balanceMinor ?? 0n,
      balanceAsOf: bal?.updatedAt ?? a.createdAt,
      dataLabel: a.verificationLevel === 'PROVIDER_VERIFIED' ? 'CONFIRMED' : a.verificationLevel === 'STALE' ? 'STALE' : openCase ? 'TO_RECONCILE' : 'MANUAL',
      blockedReason: group?.status === 'BLOCKED_OUTBOUND' ? group.blockReason : null,
      openReconciliationCaseId: openCase?.id ?? null,
    };
  }

  async list(auth: AuthContext, includeArchived = false) {
    const accounts = await this.prisma.financialAccount.findMany({ where: { ownerId: auth.ownerId, ...(includeArchived ? {} : { status: 'ACTIVE' }) }, orderBy: { createdAt: 'asc' } });
    return Promise.all(accounts.map((a) => this.present(this.prisma, a)));
  }

  async create(tx: Tx, auth: AuthContext, dto: { name: string; type: FinancialAccountType; institution?: string; currency?: string; openingBalanceMinor?: bigint; openingDate?: string; includeInSpendable?: boolean; colorHint?: string }) {
    if (dto.type === 'CONTROLLED_PSP') throw new DomainError('PSP_NOT_AUTHORIZED', 'Les comptes contrôlés par un prestataire ne sont créés que par une intégration PSP activée');
    if (dto.type === 'BROKER_CASH') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Créez un compte espèces SGI depuis Patrimoine › SGI');
    const currency = dto.currency ?? 'XOF';
    const faId = randomUUID();
    const la = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:FA:${faId}`, name: dto.name, kind: 'ASSET', currency });
    const fa = await tx.financialAccount.create({
      data: { id: faId, ownerId: auth.ownerId, ledgerAccountId: la.id, name: dto.name, type: dto.type, institution: dto.institution, currency, includeInSpendable: dto.includeInSpendable ?? true, colorHint: dto.colorHint, verificationLevel: 'USER_DECLARED', lastVerifiedAt: clock.now() },
    });
    const updated = fa;
    const opening = dto.openingBalanceMinor ?? 0n;
    if (opening !== 0n) {
      const eq = await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING', currency);
      await this.ledger.post(tx, {
        ownerId: auth.ownerId, businessType: 'ACCOUNT_OPENING', businessId: fa.id, memo: `Solde d’ouverture déclaré — ${dto.name}`,
        economicDate: dto.openingDate ? parseDateOnly(dto.openingDate) : economicToday(), actorDeviceId: auth.deviceId,
        postings: [{ accountId: la.id, amount: opening }, { accountId: eq.id, amount: -opening }],
      });
    }
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'ACCOUNT_CREATED', resource: `FinancialAccount:${fa.id}` });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'FinancialAccount', aggregateId: fa.id, version: 1 });
    return this.present(tx, updated);
  }

  async update(tx: Tx, auth: AuthContext, id: string, dto: { name?: string; institution?: string; includeInSpendable?: boolean; colorHint?: string; status?: 'ACTIVE' | 'ARCHIVED'; expectedVersion?: number }) {
    const a = await this.getOwned(tx, auth.ownerId, id);
    if (dto.expectedVersion !== undefined && dto.expectedVersion !== a.version) throw new DomainError('RESOURCE_VERSION_CONFLICT', 'Compte modifié ailleurs', { current: await this.present(tx, a) });
    if (dto.status === 'ARCHIVED' && (await this.ledger.balance(tx, a.ledgerAccountId)) !== 0n) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Un compte avec un solde non nul ne peut pas être archivé');
    const { expectedVersion, ...data } = dto;
    const r = await tx.financialAccount.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'account.updated', aggregateType: 'FinancialAccount', aggregateId: id, version: r.version });
    return this.present(tx, r);
  }

  /** Transfert entre deux comptes suivis du propriétaire : pas de revenu ni de dépense, frais séparés (llm §5.1). */
  async transfer(tx: Tx, auth: AuthContext, businessId: string, dto: { fromAccountId: string; toAccountId: string; amountMinor: bigint; feeMinor?: bigint; date?: string; memo?: string }) {
    if (dto.fromAccountId === dto.toAccountId) throw new DomainError('VALIDATION_FAILED', 'Comptes source et destination identiques');
    const from = await this.getOwned(tx, auth.ownerId, dto.fromAccountId);
    const to = await this.getOwned(tx, auth.ownerId, dto.toAccountId);
    if (from.currency !== to.currency) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Conversion de devises non prise en charge en V1');
    if (from.type === 'CONTROLLED_PSP') throw new DomainError('PSP_NOT_AUTHORIZED', 'Une sortie d’un compte prestataire passe par un paiement autorisé');
    const fee = dto.feeMinor ?? 0n;
    const feeAcc = await this.books.core(tx, auth.ownerId, 'EXPENSE:FEES', from.currency);
    const { transaction } = await this.ledger.post(tx, {
      ownerId: auth.ownerId, businessType: 'ACCOUNT_TRANSFER', businessId, memo: dto.memo ?? `Transfert ${from.name} → ${to.name}`,
      economicDate: dto.date ? parseDateOnly(dto.date) : economicToday(), actorDeviceId: auth.deviceId,
      postings: [
        { accountId: from.ledgerAccountId, amount: -(dto.amountMinor + fee) },
        { accountId: to.ledgerAccountId, amount: dto.amountMinor },
        { accountId: feeAcc.id, amount: fee },
      ],
    });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'LedgerTransaction', aggregateId: transaction.id });
    return { transactionId: transaction.id };
  }

  /** Somme des liquidités suivies éligibles (hors espèces SGI, hors comptes exclus). */
  async liquidTotals(db: Tx | PrismaService, ownerId: string, currency = 'XOF') {
    const accts = await db.financialAccount.findMany({ where: { ownerId, status: 'ACTIVE', currency, type: { in: LIQUID_TYPES } } });
    let tracked = 0n, spendableBase = 0n, providerVerified = 0n;
    const byVerification: Record<string, bigint> = {};
    for (const a of accts) {
      const b = await this.ledger.balance(db, a.ledgerAccountId);
      tracked += b;
      if (a.includeInSpendable) spendableBase += b;
      if (a.verificationLevel === 'PROVIDER_VERIFIED') providerVerified += b;
      byVerification[a.verificationLevel] = (byVerification[a.verificationLevel] ?? 0n) + b;
    }
    return { tracked, spendableBase, providerVerified, byVerification, accounts: accts };
  }
}
