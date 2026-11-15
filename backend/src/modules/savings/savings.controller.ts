import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import { Auth, AuthContext, FinancialMutation, RequireTrustedDevice } from '../../common/auth';
import { AmountMinor, DateOnly, WithApproval } from '../../common/dto';
import { IdempotencyService } from '../../common/idempotency.service';
import { parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { StepUpService } from '../identity/step-up.service';
import { SavingsService } from './savings.service';

class PlanDto {
  @IsIn(['CALENDAR', 'INCOME_TRIGGER']) triggerType: 'CALENDAR' | 'INCOME_TRIGGER';
  @IsString() @MaxLength(40) amountRule: string;
  @IsOptional() @IsString() @MaxLength(40) scheduleRule?: string;
}
class CreateGoalDto {
  @IsString() @Length(1, 60) name: string;
  @IsOptional() @IsString() @MaxLength(30) icon?: string;
  @AmountMinor() targetMinor: string;
  @DateOnly() deadline: string;
  @ValidateNested() @Type(() => PlanDto) plan: PlanDto;
}
class UpdateGoalDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsString() @MaxLength(30) icon?: string;
  @IsOptional() @AmountMinor() targetMinor?: string;
  @IsOptional() @DateOnly() deadline?: string;
  @IsOptional() @ValidateNested() @Type(() => PlanDto) plan?: PlanDto;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
class ConfirmContributionDto { @AmountMinor() amountMinor: string }
class WithdrawalDto extends WithApproval {
  @IsIn(['ORDINARY', 'EXCEPTIONAL']) kind: 'ORDINARY' | 'EXCEPTIONAL';
  @AmountMinor() amountMinor: string;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Controller('savings')
export class SavingsController {
  constructor(private prisma: PrismaService, private savings: SavingsService, private stepUp: StepUpService, private idem: IdempotencyService) {}

  @Get('goals') list(@Auth() a: AuthContext) { return this.savings.list(a); }
  @Get('goals/:id') get(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.savings.get(a, id); }
  @FinancialMutation() @Post('goals') create(@Auth() a: AuthContext, @Body() dto: CreateGoalDto) {
    return this.prisma.tx((tx) => this.savings.create(tx, a, { ...dto, targetMinor: parsePositiveMinor(dto.targetMinor, 'targetMinor') }));
  }
  @FinancialMutation() @Patch('goals/:id') update(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGoalDto) {
    return this.prisma.tx((tx) => this.savings.update(tx, a, id, { ...dto, targetMinor: dto.targetMinor ? parsePositiveMinor(dto.targetMinor) : undefined }));
  }
  @Post('goals/:id/contributions/prepare') prepare(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.savings.prepareContribution(a, id); }
  @FinancialMutation() @Post('goals/:id/contributions/:cid/confirm')
  confirm(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('cid') cid: string, @Body() dto: ConfirmContributionDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, `savings.contribution:${id}:${cid}`, key, dto, (tx) => this.savings.confirmContribution(tx, a, id, cid, parsePositiveMinor(dto.amountMinor)));
  }
  @Get('goals/:id/withdrawal-capacity') capacity(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.savings.capacity(this.prisma, a.ownerId, id); }

  @RequireTrustedDevice() @FinancialMutation() @Post('goals/:id/withdrawal-requests')
  request(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawalDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'savings.withdrawal.request', { goalId: id, kind: dto.kind, amountMinor: dto.amountMinor });
      return this.savings.requestWithdrawal(tx, a, id, { kind: dto.kind, amountMinor: parsePositiveMinor(dto.amountMinor), reason: dto.reason });
    });
  }
  @Get('withdrawal-requests/:id') getRequest(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.savings.getWithdrawal(a, id); }
  @RequireTrustedDevice() @FinancialMutation() @Post('withdrawal-requests/:id/confirm')
  confirmWithdrawal(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithApproval) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'savings.withdrawal.confirm', { requestId: id });
      return this.savings.confirmWithdrawal(tx, a, id);
    });
  }
  @Post('withdrawal-requests/:id/cancel') cancel(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.prisma.tx((tx) => this.savings.cancelWithdrawal(tx, a, id)); }
}
