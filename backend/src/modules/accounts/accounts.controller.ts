import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import { Auth, AuthContext, FinancialMutation, RequireTrustedDevice } from '../../common/auth';
import { AmountMinor, DateOnly, SIGNED_MINOR_RE, WithApproval } from '../../common/dto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { Paged } from '../../common/http';
import { IdempotencyService } from '../../common/idempotency.service';
import { parseMinor } from '../../common/money';
import { decodeCursor, encodeCursor, pageSize } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { StepUpService } from '../identity/step-up.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountsService } from './accounts.service';
import { BalancesService } from './balances.service';
import { WalletsService } from './wallets.service';

class CreateAccountDto {
  @IsString() @Length(1, 80) name: string;
  @IsIn(['EXTERNAL_TRACKED', 'CASH_MANUAL', 'CONTROLLED_PSP', 'BROKER_CASH']) type: any;
  @IsOptional() @IsString() @MaxLength(80) institution?: string;
  @IsOptional() @IsIn(['XOF']) currency?: string;
  @IsOptional() @Matches(SIGNED_MINOR_RE) openingBalanceMinor?: string;
  @IsOptional() @DateOnly() openingDate?: string;
  @IsOptional() @IsBoolean() includeInSpendable?: boolean;
  @IsOptional() @IsString() @MaxLength(20) colorHint?: string;
}
class UpdateAccountDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @MaxLength(80) institution?: string;
  @IsOptional() @IsBoolean() includeInSpendable?: boolean;
  @IsOptional() @IsString() @MaxLength(20) colorHint?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
class TransferDto {
  @IsString() fromAccountId: string;
  @IsString() toAccountId: string;
  @AmountMinor() amountMinor: string;
  @IsOptional() @AmountMinor() feeMinor?: string;
  @IsOptional() @DateOnly() date?: string;
  @IsOptional() @IsString() @MaxLength(200) memo?: string;
}
class CreateWalletDto { @IsString() @Length(1, 60) name: string; @IsIn(['RESERVE']) kind: 'RESERVE' }
class AllocationDto {
  @IsString() fromWalletId: string;
  @IsString() toWalletId: string;
  @AmountMinor() amountMinor: string;
  @IsOptional() @IsString() @MaxLength(200) memo?: string;
}
class CorrectionDto extends WithApproval {
  @IsString() originalTransactionId: string;
  @IsString() @Length(3, 300) reason: string;
}
class DeclareBalanceDto { @Matches(SIGNED_MINOR_RE) observedMinor: string; @IsOptional() @IsString() @MaxLength(300) note?: string }

@Controller()
export class AccountsController {
  constructor(
    private prisma: PrismaService, private accounts: AccountsService, private wallets: WalletsService, private balances: BalancesService,
    private ledger: LedgerService, private idem: IdempotencyService, private stepUp: StepUpService, private events: EventsService,
  ) {}

  @Get('accounts') list(@Auth() a: AuthContext, @Query('includeArchived') inc?: string) { return this.accounts.list(a, inc === 'true'); }

  @FinancialMutation() @Post('accounts')
  create(@Auth() a: AuthContext, @Body() dto: CreateAccountDto) {
    return this.prisma.tx((tx) => this.accounts.create(tx, a, { ...dto, openingBalanceMinor: dto.openingBalanceMinor ? parseMinor(dto.openingBalanceMinor) : undefined }));
  }

  @Get('accounts/:id') async get(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.present(this.prisma, await this.accounts.getOwned(this.prisma, a.ownerId, id));
  }
  @Get('accounts/:id/balance') async balance(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const p = await this.accounts.present(this.prisma, await this.accounts.getOwned(this.prisma, a.ownerId, id));
    return { accountId: id, balanceMinor: p.balanceMinor, currency: p.currency, verificationLevel: p.verificationLevel, asOf: p.balanceAsOf, lastVerifiedAt: p.lastVerifiedAt, blockedReason: p.blockedReason, dataLabel: p.dataLabel, transferable: p.type === 'CONTROLLED_PSP' && !p.blockedReason };
  }

  @Patch('accounts/:id')
  update(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAccountDto) {
    return this.prisma.tx((tx) => this.accounts.update(tx, a, id, dto));
  }

  @FinancialMutation() @Post('accounts/transfers')
  transfer(@Auth() a: AuthContext, @Body() dto: TransferDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, 'accounts.transfer', key, dto, (tx) => this.accounts.transfer(tx, a, randomUUID(), { ...dto, amountMinor: parseMinor(dto.amountMinor), feeMinor: dto.feeMinor ? parseMinor(dto.feeMinor) : 0n }));
  }

  /** Déclaration du solde observé d'un compte suivi : un écart ouvre un cas de rapprochement, jamais d'alignement silencieux. */
  @FinancialMutation() @Post('accounts/:id/balance-declarations')
  async declare(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeclareBalanceDto) {
    return this.prisma.tx(async (tx) => {
      const acc = await this.accounts.getOwned(tx, a.ownerId, id);
      const observed = parseMinor(dto.observedMinor);
      const expected = await this.ledger.balance(tx, acc.ledgerAccountId);
      await tx.financialAccount.update({ where: { id }, data: { lastVerifiedAt: new Date(), verificationLevel: acc.verificationLevel === 'STALE' ? 'USER_DECLARED' : acc.verificationLevel } });
      if (observed === expected) return { matched: true, expectedMinor: expected, observedMinor: observed };
      const existing = await tx.reconciliationCase.findFirst({ where: { financialAccountId: id, status: { in: ['OPEN', 'INVESTIGATING'] } } });
      const c = existing ?? await tx.reconciliationCase.create({ data: { ownerId: a.ownerId, financialAccountId: id, expectedMinor: expected, observedMinor: observed, reason: 'DECLARED_BALANCE_MISMATCH' } });
      await tx.reconciliationEvidence.create({ data: { caseId: c.id, kind: 'OWNER_DECLARATION', note: dto.note, digest: `${expected}:${observed}` } });
      await this.events.notify(tx, { ownerId: a.ownerId, sourceEventId: `recon-open:${c.id}`, type: 'reconciliation.case_opened', category: 'RECONCILIATION', priority: 'HIGH', title: `Écart de solde — ${acc.name}`, body: 'Le solde déclaré diffère du registre. Expliquez l’écart pour le corriger de façon traçable.', link: `/activity/reconciliation/${c.id}` });
      await this.events.emit(tx, { ownerId: a.ownerId, eventType: 'operations.updated', aggregateType: 'ReconciliationCase', aggregateId: c.id });
      return { matched: false, expectedMinor: expected, observedMinor: observed, reconciliationCaseId: c.id };
    });
  }

  @Get('balances/overview') overview(@Auth() a: AuthContext) { return this.balances.overview(a); }

  @Get('wallets') wallets_(@Auth() a: AuthContext) { return this.wallets.list(a); }
  @Get('wallets/:id') async wallet(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const all = await this.wallets.list(a);
    const w = all.find((x) => x.id === id);
    if (!w) throw notFound('Portefeuille');
    return w;
  }
  @FinancialMutation() @Post('wallets') createWallet(@Auth() a: AuthContext, @Body() dto: CreateWalletDto) { return this.prisma.tx((tx) => this.wallets.create(tx, a, dto)); }
  @Patch('wallets/:id') async renameWallet(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateWalletDto) {
    const w = await this.wallets.getOwned(this.prisma, a.ownerId, id);
    return this.prisma.wallet.update({ where: { id: w.id }, data: { name: dto.name, version: { increment: 1 } } });
  }

  @FinancialMutation() @Post('allocations/transfers')
  allocate(@Auth() a: AuthContext, @Body() dto: AllocationDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, 'allocations.transfer', key, dto, (tx) => this.wallets.move(tx, a, randomUUID(), { ...dto, amountMinor: parseMinor(dto.amountMinor) }));
  }

  @Get('ledger/entries')
  async entries(@Auth() a: AuthContext, @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('book') book?: string, @Query('ledgerAccountId') accId?: string) {
    const take = pageSize(limit);
    const c = decodeCursor(cursor);
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: { ownerId: a.ownerId, ...(book ? { book: book as any } : {}), ...(accId ? { postings: { some: { ledgerAccountId: accId } } } : {}), ...(c ? { sequence: { lt: BigInt(c.seq) } } : {}) },
      include: { postings: { include: { ledgerAccount: { select: { code: true, name: true, kind: true } } } } }, orderBy: { sequence: 'desc' }, take: take + 1,
    });
    const more = rows.length > take;
    const page = rows.slice(0, take);
    return new Paged(page, more ? encodeCursor({ seq: page[page.length - 1].sequence.toString() }) : null, more);
  }
  @Get('ledger/entries/:id') async entry(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const t = await this.prisma.ledgerTransaction.findUnique({ where: { id }, include: { postings: { include: { ledgerAccount: true } } } });
    if (!t || t.ownerId !== a.ownerId) throw notFound('Écriture');
    const reversal = await this.prisma.ledgerTransaction.findFirst({ where: { reversalOfId: id } });
    return { ...t, reversedBy: reversal?.id ?? null };
  }
  @Get('ledger/integrity') integrity(@Auth() a: AuthContext) { return this.ledger.auditProjections(a.ownerId); }

  /** Correction comptable : contrepassation traçable avec preuve forte (backend.md §19.2). */
  @RequireTrustedDevice() @FinancialMutation() @Post('ledger/corrections')
  correct(@Auth() a: AuthContext, @Body() dto: CorrectionDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'ledger.correction', { originalTransactionId: dto.originalTransactionId, reason: dto.reason });
      const orig = await tx.ledgerTransaction.findUnique({ where: { id: dto.originalTransactionId } });
      if (!orig || orig.ownerId !== a.ownerId) throw notFound('Écriture');
      if (orig.book === 'ALLOCATION') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Les affectations (coffres, enveloppes) se corrigent par un nouveau mouvement soumis à leurs règles');
      if (['EXPENSE', 'INCOME'].includes(orig.businessType)) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Contrepassez la dépense/le revenu depuis sa fiche pour garder la cohérence métier');
      const r = await this.ledger.reverse(tx, a.ownerId, orig.id, dto.reason, a.deviceId);
      await this.events.audit(tx, { ownerId: a.ownerId, actorId: a.deviceId, action: 'LEDGER_CORRECTION', resource: `LedgerTransaction:${orig.id}`, context: { reason: dto.reason } });
      await this.events.emit(tx, { ownerId: a.ownerId, eventType: 'balance.updated', aggregateType: 'LedgerTransaction', aggregateId: r.transaction.id });
      return r.transaction;
    });
  }
}
