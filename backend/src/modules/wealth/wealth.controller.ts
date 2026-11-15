import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Auth, AuthContext, FinancialMutation } from '../../common/auth';
import { AmountMinor, DateOnly } from '../../common/dto';
import { parseMinor, parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { AssetsService } from './assets.service';
import { InvestmentsService } from './investments.service';
import { LiabilitiesService } from './liabilities.service';
import { MarketService } from './market.service';

const DECIMAL = /^\d{1,12}(\.\d{1,10})?$/;
class ScheduleDto { @IsInt() @Min(1) @Max(360) count: number; @IsString() rule: string; @DateOnly() firstDueDate: string; @IsOptional() @AmountMinor() interestPerInstallmentMinor?: string }
class LiabilityDto {
  @IsIn(['DEBT', 'RECEIVABLE', 'FUTURE_COMMITMENT']) kind: any;
  @IsString() @Length(1, 80) counterpartyName: string;
  @IsString() @Length(1, 120) label: string;
  @AmountMinor() principalMinor: string;
  @DateOnly() startDate: string;
  @IsOptional() @IsString() @MaxLength(200) interestTerms?: string;
  @IsOptional() @IsUUID() cashAccountId?: string;
  @IsOptional() @DateOnly() initialDueDate?: string;
  @IsOptional() @ValidateNested() @Type(() => ScheduleDto) schedule?: ScheduleDto;
}
class UpdateLiabilityDto { @IsOptional() @IsString() @Length(1, 120) label?: string; @IsOptional() @IsString() @Length(1, 80) counterpartyName?: string; @IsOptional() @IsString() @MaxLength(200) interestTerms?: string; @IsOptional() @IsIn(['CANCELLED']) state?: 'CANCELLED'; @IsOptional() @IsInt() expectedVersion?: number }
class RepaymentDto {
  @IsUUID() cashAccountId: string;
  @Matches(/^\d{1,15}$/) principalMinor: string;
  @IsOptional() @AmountMinor() interestMinor?: string;
  @IsOptional() @AmountMinor() feeMinor?: string;
  @IsOptional() @DateOnly() date?: string;
  @IsOptional() @IsUUID() linkExpenseId?: string;
  @IsOptional() @IsUUID() categoryId?: string;
}
class RescheduleDto { @DateOnly() newDueDate: string; @IsOptional() @IsString() @MaxLength(200) note?: string }
class AssetDto {
  @IsString() @Length(1, 80) name: string;
  @IsIn(['REAL_ESTATE', 'VEHICLE', 'EQUIPMENT', 'LAND', 'OTHER']) kind: string;
  @IsOptional() @DateOnly() acquiredAt?: string;
  @IsOptional() @AmountMinor() acquisitionCostMinor?: string;
  @IsOptional() @IsUUID() paidFromAccountId?: string;
  @IsOptional() @AmountMinor() currentValueMinor?: string;
  @IsOptional() @IsIn(['OWNER_ESTIMATE', 'PROFESSIONAL', 'MARKET_COMPARABLE']) valuationSource?: string;
}
class ValuationDto { @AmountMinor() valueMinor: string; @DateOnly() valuationDate: string; @IsIn(['OWNER_ESTIMATE', 'PROFESSIONAL', 'MARKET_COMPARABLE']) source: string; @IsOptional() @IsString() @MaxLength(300) note?: string; @IsOptional() @IsUUID() evidenceDocumentId?: string }
class DisposeDto { @AmountMinor() saleMinor: string; @IsOptional() @IsUUID() toAccountId?: string; @DateOnly() date: string }
class BrokerDto { @IsString() @Length(1, 80) name: string; @IsOptional() @IsString() @MaxLength(300) notes?: string; @IsOptional() @IsString() @MaxLength(60) officialId?: string; @IsString() @Length(1, 60) accountAlias: string; @IsOptional() @AmountMinor() openingCashMinor?: string; @IsOptional() @IsIn(['SGI_DOCUMENTED', 'FALLBACK_FIFO']) costBasisMethod?: string }
class CashMoveDto { @IsIn(['DEPOSIT', 'WITHDRAWAL', 'FEE']) type: any; @AmountMinor() amountMinor: string; @IsOptional() @IsUUID() counterpartAccountId?: string; @IsOptional() @DateOnly() date?: string; @IsOptional() @IsString() @MaxLength(200) memo?: string }
class TradeDto {
  @IsUUID() brokerageAccountId: string; @IsUUID() securityId: string; @IsIn(['BUY', 'SELL']) side: any;
  @Matches(DECIMAL) quantity: string; @Matches(DECIMAL) unitPrice: string;
  @IsOptional() @AmountMinor() feesMinor?: string; @IsOptional() @AmountMinor() taxesMinor?: string;
  @IsISO8601() executedAt: string; @IsOptional() @IsISO8601() settledAt?: string;
  @IsOptional() @IsString() @MaxLength(80) externalRef?: string; @IsOptional() @IsString() @MaxLength(200) evidenceRef?: string;
  @IsOptional() @AmountMinor() documentedCostMinor?: string;
}
class SecurityDto { @Matches(/^[A-Za-z0-9.]{2,12}$/) symbol: string; @IsString() @Length(1, 120) name: string; @IsOptional() @IsString() @MaxLength(12) isin?: string; @IsOptional() @IsString() @MaxLength(60) sector?: string }
class QuoteDto { @IsUUID() securityId: string; @Matches(DECIMAL) price: string; @DateOnly() sessionDate: string }
class DividendDto { @IsUUID() securityId: string; @Matches(DECIMAL) declaredPerShare: string; @IsOptional() @DateOnly() exDate?: string; @IsOptional() @DateOnly() recordDate?: string; @IsOptional() @DateOnly() paymentDate?: string; @IsString() @Length(1, 120) source: string }
class ReceiptDto { @AmountMinor() receivedMinor: string; @DateOnly() receivedAt: string }
class PlanDto { @IsUUID() securityId: string; @IsOptional() @Matches(DECIMAL) quantityTarget?: string; @AmountMinor() budgetReservedMinor: string; @IsOptional() @DateOnly() targetDate?: string; @IsOptional() @IsString() @MaxLength(200) note?: string }
class ClosePlanDto { @IsIn(['CANCELLED', 'EXECUTED_EXTERNALLY']) state: any }
class AlertDto { @IsUUID() securityId: string; @IsIn(['ABOVE', 'BELOW']) triggerType: any; @Matches(DECIMAL) threshold: string }
class ToggleDto { @IsBoolean() enabled: boolean }

@Controller()
export class WealthController {
  constructor(private prisma: PrismaService, private liab: LiabilitiesService, private assets: AssetsService, private inv: InvestmentsService, private market: MarketService) {}

  @Get('liabilities') liabilities(@Auth() a: AuthContext, @Query('kind') kind?: string) { return this.liab.list(a, kind); }
  @Get('liabilities/:id') liability(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.liab.get(a, id); }
  @Get('liabilities/:id/match-suggestions') match(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.liab.matchSuggestions(a, id); }
  @FinancialMutation() @Post('liabilities') createLiability(@Auth() a: AuthContext, @Body() dto: LiabilityDto) {
    return this.prisma.tx((tx) => this.liab.create(tx, a, { ...dto, principalMinor: parsePositiveMinor(dto.principalMinor), schedule: dto.schedule && { ...dto.schedule, interestPerInstallmentMinor: dto.schedule.interestPerInstallmentMinor ? parseMinor(dto.schedule.interestPerInstallmentMinor) : undefined } }));
  }
  @FinancialMutation() @Patch('liabilities/:id') updateLiability(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLiabilityDto) { return this.prisma.tx((tx) => this.liab.update(tx, a, id, dto)); }
  @FinancialMutation() @Post('liabilities/:id/repayments') repay(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RepaymentDto) {
    return this.prisma.tx((tx) => this.liab.repay(tx, a, id, { ...dto, principalMinor: parseMinor(dto.principalMinor), interestMinor: dto.interestMinor ? parseMinor(dto.interestMinor) : 0n, feeMinor: dto.feeMinor ? parseMinor(dto.feeMinor) : 0n }));
  }
  @FinancialMutation() @Post('liabilities/installments/:id/reschedule') reschedule(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) { return this.prisma.tx((tx) => this.liab.reschedule(tx, a, id, dto)); }

  @Get('assets') assetsList(@Auth() a: AuthContext) { return this.assets.list(a); }
  @Get('assets/:id') asset(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.assets.get(a, id); }
  @FinancialMutation() @Post('assets') createAsset(@Auth() a: AuthContext, @Body() dto: AssetDto) {
    return this.prisma.tx((tx) => this.assets.create(tx, a, { ...dto, acquisitionCostMinor: dto.acquisitionCostMinor ? parseMinor(dto.acquisitionCostMinor) : undefined, currentValueMinor: dto.currentValueMinor ? parseMinor(dto.currentValueMinor) : undefined }));
  }
  @FinancialMutation() @Post('assets/:id/valuations') revalue(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ValuationDto) { return this.prisma.tx((tx) => this.assets.revalue(tx, a, id, { ...dto, valueMinor: parseMinor(dto.valueMinor) })); }
  @FinancialMutation() @Post('assets/:id/dispose') dispose(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisposeDto) { return this.prisma.tx((tx) => this.assets.dispose(tx, a, id, { ...dto, saleMinor: parseMinor(dto.saleMinor) })); }
  @Get('wealth/overview') wealth(@Auth() a: AuthContext) { return this.assets.wealthOverview(a); }

  @Get('investments/brokers') brokers(@Auth() a: AuthContext) { return this.inv.brokers(a); }
  @FinancialMutation() @Post('investments/brokers') createBroker(@Auth() a: AuthContext, @Body() dto: BrokerDto) { return this.prisma.tx((tx) => this.inv.createBroker(tx, a, { ...dto, openingCashMinor: dto.openingCashMinor ? parseMinor(dto.openingCashMinor) : undefined })); }
  @FinancialMutation() @Post('investments/brokerage-accounts/:id/cash-movements') cash(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CashMoveDto) { return this.prisma.tx((tx) => this.inv.cashMovement(tx, a, id, { ...dto, amountMinor: parsePositiveMinor(dto.amountMinor) })); }
  @Get('investments/holdings') holdings(@Auth() a: AuthContext) { return this.inv.holdings(this.prisma, a.ownerId); }
  @Get('investments/trades') trades(@Auth() a: AuthContext, @Query('securityId') s?: string) { return this.inv.trades(a, s); }
  @FinancialMutation() @Post('investments/trades') trade(@Auth() a: AuthContext, @Body() dto: TradeDto) {
    return this.prisma.tx((tx) => this.inv.recordTrade(tx, a, { ...dto, feesMinor: dto.feesMinor ? parseMinor(dto.feesMinor) : 0n, taxesMinor: dto.taxesMinor ? parseMinor(dto.taxesMinor) : 0n, documentedCostMinor: dto.documentedCostMinor ? parseMinor(dto.documentedCostMinor) : undefined }));
  }
  @Get('investments/dividends') dividends(@Auth() a: AuthContext) { return this.inv.dividends(a); }
  @Post('investments/dividends/announcements') announce(@Auth() a: AuthContext, @Body() dto: DividendDto) { return this.prisma.tx((tx) => this.inv.announceDividend(tx, a, dto)); }
  @FinancialMutation() @Post('investments/dividends/:id/match-receipt') receipt(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiptDto) { return this.prisma.tx((tx) => this.inv.matchDividendReceipt(tx, a, id, { ...dto, receivedMinor: parsePositiveMinor(dto.receivedMinor) })); }
  @Get('investments/plans') plans(@Auth() a: AuthContext) { return this.inv.plans(a); }
  @Post('investments/plans') createPlan(@Auth() a: AuthContext, @Body() dto: PlanDto) { return this.prisma.tx((tx) => this.inv.createPlan(tx, a, { ...dto, budgetReservedMinor: parsePositiveMinor(dto.budgetReservedMinor) })); }
  @Post('investments/plans/:id/close') closePlan(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ClosePlanDto) { return this.prisma.tx((tx) => this.inv.closePlan(tx, a, id, dto.state)); }
  @Get('investments/alerts') alerts(@Auth() a: AuthContext) { return this.inv.alerts(a); }
  @Post('investments/alerts') createAlert(@Auth() a: AuthContext, @Body() dto: AlertDto) { return this.inv.createAlert(a, dto); }
  @Patch('investments/alerts/:id') toggleAlert(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ToggleDto) { return this.inv.toggleAlert(a, id, dto.enabled); }

  @Get('market/status') marketStatus() { return this.market.status(); }
  /** Rafraîchissement à la demande : au plus un toutes les 15 min (quota fournisseur). */
  @Post('market/refresh') marketRefresh() { return this.market.refresh({ minIntervalMs: 15 * 60_000, reason: 'OWNER' }); }
  @Get('market/securities') securities(@Auth() a: AuthContext, @Query('q') q?: string) { return this.market.securities(a, q); }
  @Post('market/securities') createSecurity(@Body() dto: SecurityDto) { return this.market.createSecurity(dto); }
  @Post('market/securities/:id/favorite') fav(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.market.toggleFavorite(a, id); }
  @Get('market/securities/:id/quotes') quotes(@Param('id', ParseUUIDPipe) id: string) { return this.market.quotes(id); }
  @Post('market/manual-quotes') manual(@Auth() a: AuthContext, @Body() dto: QuoteDto) { return this.market.manualQuote(a, dto); }
}
