import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, ValidateNested } from 'class-validator';
import { Auth, AuthContext, FinancialMutation, Public, RequireTrustedDevice } from '../../common/auth';
import { AmountMinor, WithApproval } from '../../common/dto';
import { DomainError } from '../../common/errors';
import { Raw } from '../../common/http';
import { parseMinor, parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { StepUpService } from '../identity/step-up.service';
import { LimitsService } from './limits.service';
import { PaymentsService } from './payments.service';
import { FakeProvider } from './provider.port';
import { ReconciliationService } from './reconciliation.service';

class PayoutDto {
  @IsUUID() sourceWalletId: string; @IsUUID() beneficiaryId: string; @IsIn(['TOTAL_DEBIT', 'NET_RECEIVED']) amountMode: any;
  @AmountMinor() amountMinor: string; @IsIn(['XOF']) currency: string; @IsOptional() @IsUUID() purposeCategoryId?: string;
  @IsOptional() @IsString() @MaxLength(80) clientReference?: string; @IsOptional() @IsUUID() sourceAccountId?: string;
}
class AuthorizeDto extends WithApproval { @IsOptional() @IsBoolean() acknowledgeUnverifiedBeneficiary?: boolean }
class BeneficiaryDto { @IsString() @Length(1, 80) displayName: string; @IsString() @MaxLength(20) phoneE164: string; @IsIn(['MTN_BJ', 'MOOV_BJ', 'CELTIIS_BJ']) operator: string; @IsOptional() @IsBoolean() isOwnAccount?: boolean }
class LimitChangeDto extends WithApproval { @AmountMinor() perOperationMinor: string; @AmountMinor() rolling24hMinor: string }
class ExceptionDto extends WithApproval { @IsUUID() paymentIntentId: string; @AmountMinor() maxDebitMinor: string; @IsString() @Length(5, 300) reason: string }
class ConnectProviderDto { @IsOptional() @IsString() @Length(1, 60) name?: string }
class SandboxDto { @IsString() @Length(1, 60) name: string; @AmountMinor() openingMinor: string }
class StepDto { @IsUUID() destinationAccountId: string; @AmountMinor() amountMinor: string }
class FundingPlanDto { @IsUUID() sourceAccountId: string; @IsUUID() payerBeneficiaryId: string; @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => StepDto) steps: StepDto[] }
class ResumeDto { @IsOptional() @IsBoolean() resumeAfterFailure?: boolean }
class ResolveDto extends WithApproval { @IsIn(['ADJUST', 'DISMISS_WITH_EVIDENCE']) resolution: any; @IsString() @Length(5, 500) explanation: string }
class EvidenceDto { @IsIn(['NOTE', 'PROVIDER_STATEMENT', 'BANK_STATEMENT', 'RECEIPT', 'OTHER']) kind: string; @IsOptional() @IsString() @MaxLength(500) note?: string; @IsOptional() @IsString() @MaxLength(80) providerRef?: string; @IsOptional() @IsUUID() documentId?: string }
class WalletGroupDto { @IsOptional() @IsUUID() realBalanceGroupId?: string }
class FakeScenarioDto { @IsIn(['ACCEPT', 'ACCEPT_AND_SUCCEED', 'REJECT', 'TIMEOUT_EXECUTED', 'TIMEOUT_NOT_EXECUTED', 'UNAVAILABLE']) scenario: any }

@Controller()
export class PaymentsController {
  constructor(private prisma: PrismaService, private payments: PaymentsService, private limits: LimitsService, private recon: ReconciliationService, private stepUp: StepUpService) {}

  @Get('payments/capabilities') caps() { return this.payments.capabilities(); }
  @Get('payments/intents') list(@Auth() a: AuthContext, @Query('state') state?: string) { return this.payments.list(a, state); }
  @Get('payments/intents/:id') get(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.get(a, id); }

  @FinancialMutation() @Post('payments/payouts/intents')
  payout(@Auth() a: AuthContext, @Body() dto: PayoutDto, @Headers('idempotency-key') key: string) { return this.payments.createPayout(a, key, { ...dto, amountMinor: parsePositiveMinor(dto.amountMinor) }); }
  @RequireTrustedDevice() @FinancialMutation() @Post('payments/intents/:id/challenge')
  challenge(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.authorizationChallenge(a, id); }
  @FinancialMutation() @Post('payments/intents/:id/requote') requote(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.requote(a, id); }
  @RequireTrustedDevice() @FinancialMutation() @Post('payments/intents/:id/authorize') @HttpCode(202)
  authorize(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AuthorizeDto) { return this.payments.authorize(a, id, dto); }
  @RequireTrustedDevice() @FinancialMutation() @Post('payments/intents/:id/submit') @HttpCode(202)
  submit(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.submit(a.ownerId, id, a.deviceId ?? 'OWNER'); }
  @RequireTrustedDevice() @Post('payments/intents/:id/cancel')
  cancel(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithApproval) {
    return this.prisma.tx(async (tx) => { await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'payment.cancel', { intentId: id }); return this.payments.cancel(tx, a, id); });
  }
  @Post('payments/intents/:id/recheck') @HttpCode(202) recheck(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.recheck(a.ownerId, id); }

  @Get('beneficiaries') beneficiaries(@Auth() a: AuthContext) { return this.payments.beneficiaries(a); }
  @Post('beneficiaries') createBeneficiary(@Auth() a: AuthContext, @Body() dto: BeneficiaryDto) { return this.payments.createBeneficiary(a, dto); }
  @Post('beneficiaries/:id/verify') verify(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.payments.verifyBeneficiary(a, id); }

  @Get('security/limits') limitSummary(@Auth() a: AuthContext) { return this.limits.summary(a); }
  @RequireTrustedDevice() @FinancialMutation() @Post('security/limit-changes')
  changeLimits(@Auth() a: AuthContext, @Body() dto: LimitChangeDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'limits.change', { perOperationMinor: dto.perOperationMinor, rolling24hMinor: dto.rolling24hMinor });
      return this.limits.requestChange(tx, a, { perOperationMinor: parseMinor(dto.perOperationMinor), rolling24hMinor: parseMinor(dto.rolling24hMinor) });
    }, { serializable: true });
  }
  @Post('security/limit-changes/:id/cancel') cancelLimit(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.prisma.tx((tx) => this.limits.cancelChange(tx, a, id)); }
  @Get('security/exceptions') exceptions(@Auth() a: AuthContext) { return this.limits.listExceptions(a); }
  @RequireTrustedDevice() @FinancialMutation() @Post('security/exceptions') @HttpCode(202)
  createException(@Auth() a: AuthContext, @Body() dto: ExceptionDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'exception.request', { paymentIntentId: dto.paymentIntentId, maxDebitMinor: dto.maxDebitMinor, reason: dto.reason });
      return this.limits.createException(tx, a, { paymentIntentId: dto.paymentIntentId, maxDebitMinor: parsePositiveMinor(dto.maxDebitMinor), reason: dto.reason });
    });
  }
  @Get('security/exceptions/:id') exception(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.limits.getException(a, id); }
  @RequireTrustedDevice() @Post('security/exceptions/:id/cancel')
  cancelException(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithApproval) {
    return this.prisma.tx(async (tx) => { await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'exception.cancel', { exceptionId: id }); return this.limits.cancelException(tx, a, id); });
  }

  @Public() @Post('integrations/psp/webhooks/:provider') @HttpCode(200)
  async webhook(@Param('provider') provider: string, @Req() req: any) {
    if (!Buffer.isBuffer(req.body)) throw new DomainError('VALIDATION_FAILED', 'Corps brut attendu');
    return new Raw(await this.payments.handleWebhook(provider, req.body, req.headers));
  }

  @Get('payments/provider/balance') providerBalance() { return this.payments.providerBalance(); }
  @RequireTrustedDevice() @FinancialMutation() @Post('payments/provider/connect')
  connectProvider(@Auth() a: AuthContext, @Body() dto: ConnectProviderDto) { return this.prisma.tx((tx) => this.payments.connectProvider(tx, a, { name: dto.name })); }

  @FinancialMutation() @Post('payments/sandbox/provision') sandbox(@Auth() a: AuthContext, @Body() dto: SandboxDto) { return this.prisma.tx((tx) => this.payments.provisionSandbox(tx, a, { name: dto.name, openingMinor: parseMinor(dto.openingMinor) })); }
  @Post('payments/sandbox/scenario') scenario(@Body() dto: FakeScenarioDto) {
    if (!(this.payments.provider instanceof FakeProvider)) throw new DomainError('PSP_NOT_AUTHORIZED', 'Disponible uniquement avec le prestataire simulé');
    this.payments.provider.scenario = dto.scenario;
    return { scenario: dto.scenario, simulated: true };
  }
  @Patch('wallets/:id/real-balance-group') async walletGroup(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WalletGroupDto) {
    const w = await this.prisma.wallet.findUnique({ where: { id } });
    if (!w || w.ownerId !== a.ownerId) throw new DomainError('NOT_FOUND', 'Portefeuille introuvable');
    if (dto.realBalanceGroupId) { const g = await this.prisma.realBalanceGroup.findUnique({ where: { id: dto.realBalanceGroupId } }); if (!g || g.ownerId !== a.ownerId) throw new DomainError('NOT_FOUND', 'Balance introuvable'); }
    return this.prisma.wallet.update({ where: { id }, data: { realBalanceGroupId: dto.realBalanceGroupId ?? null, version: { increment: 1 } } });
  }

  @FinancialMutation() @Post('incomes/:id/funding-plans') fundingPlan(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FundingPlanDto) {
    return this.prisma.tx((tx) => this.payments.createFundingPlan(tx, a, id, { ...dto, steps: dto.steps.map((s) => ({ destinationAccountId: s.destinationAccountId, amountMinor: parsePositiveMinor(s.amountMinor) })) }));
  }
  @Get('incomes/:id/funding-plans/:planId') getPlan(@Auth() a: AuthContext, @Param('planId', ParseUUIDPipe) planId: string) { return this.payments.fundingPlan(a, planId); }
  @RequireTrustedDevice() @FinancialMutation() @Post('incomes/:id/funding-plans/:planId/next') @HttpCode(202)
  next(@Auth() a: AuthContext, @Param('planId', ParseUUIDPipe) planId: string, @Body() dto: ResumeDto) { return this.payments.runNextFundingStep(a, planId, dto.resumeAfterFailure); }

  @Get('reconciliation/cases') cases(@Auth() a: AuthContext, @Query('status') s?: string) { return this.recon.list(a, s); }
  @Get('reconciliation/cases/:id') case_(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.recon.get(a, id); }
  @Get('reconciliation/balance-groups') groups(@Auth() a: AuthContext) { return this.recon.groups(a); }
  @Post('reconciliation/run') run(@Auth() a: AuthContext) { return this.recon.runAll(a.ownerId); }
  @Post('reconciliation/cases/:id/evidence') evidence(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EvidenceDto) { return this.recon.addEvidence(a, id, dto); }
  @RequireTrustedDevice() @FinancialMutation() @Post('reconciliation/cases/:id/resolve')
  resolve(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDto) {
    return this.prisma.tx(async (tx) => { await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'reconciliation.resolve', { caseId: id, resolution: dto.resolution, explanation: dto.explanation }); return this.recon.resolve(tx, a, id, dto); });
  }
}
