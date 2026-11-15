import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { Auth, AuthContext, FinancialMutation } from '../../common/auth';
import { AmountMinor, DateOnly } from '../../common/dto';
import { DomainError } from '../../common/errors';
import { parseMinor, parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { BudgetsService } from './budgets.service';

class OpenCycleDto {
  @IsOptional() @IsString() @Length(1, 80) label?: string;
  @IsOptional() @DateOnly() startsAt?: string;
  @IsOptional() @DateOnly() plannedEndAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(92) durationDays?: number;
  @IsOptional() @IsUUID() anchorIncomeId?: string;
  @IsOptional() @IsBoolean() copyBudgetsFromPrevious?: boolean;
}
class AssignDto { @IsOptional() @IsArray() @IsUUID('all', { each: true }) expenseIds?: string[]; @IsOptional() @IsArray() @IsUUID('all', { each: true }) incomeIds?: string[] }
class BudgetDto {
  @IsUUID() cycleId: string;
  @IsUUID() categoryId: string;
  @AmountMinor() plannedMinor: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) alertThreshold?: number;
  @IsOptional() @IsBoolean() essential?: boolean;
}
class UpdateBudgetDto {
  @IsOptional() @AmountMinor() plannedMinor?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) alertThreshold?: number;
  @IsOptional() @IsBoolean() essential?: boolean;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
class ObligationDto {
  @IsString() @Length(1, 80) label: string;
  @IsIn(['RENT', 'UTILITY', 'SUBSCRIPTION', 'LOAN', 'SCHOOL', 'INSURANCE', 'OTHER']) kind: string;
  @AmountMinor() amountMinor: string;
  @IsString() scheduleRule: string;
  @DateOnly() nextDueDate: string;
  @IsUUID() categoryId: string;
  @IsOptional() @IsBoolean() essential?: boolean;
}
class UpdateObligationDto { @IsOptional() @IsString() @Length(1, 80) label?: string; @IsOptional() @AmountMinor() amountMinor?: string; @IsOptional() @IsBoolean() active?: boolean; @IsOptional() @IsBoolean() essential?: boolean }

@Controller()
export class BudgetsController {
  constructor(private prisma: PrismaService, private budgets: BudgetsService) {}

  @Get('budget-cycles') cycles(@Auth() a: AuthContext) { return this.budgets.listCycles(a); }
  @Get('budget-cycles/current') async current(@Auth() a: AuthContext) { return this.budgets.openCycle(this.prisma, a.ownerId); }
  @Get('budget-cycles/off-cycle') offCycle(@Auth() a: AuthContext) { return this.budgets.offCycleItems(a); }
  @Get('budget-cycles/:id') cycle(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.budgets.getCycle(a, id); }
  @FinancialMutation() @Post('budget-cycles') open(@Auth() a: AuthContext, @Body() dto: OpenCycleDto) { return this.prisma.tx((tx) => this.budgets.openNewCycle(tx, a, dto)); }
  @FinancialMutation() @Post('budget-cycles/:id/close') close(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.prisma.tx((tx) => this.budgets.closeCycle(tx, a.ownerId, id, 'MANUAL')); }
  @FinancialMutation() @Post('budget-cycles/:id/off-cycle-assignments') assign(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) { return this.prisma.tx((tx) => this.budgets.assignOffCycle(tx, a, id, dto)); }

  @Get('budgets') list(@Auth() a: AuthContext, @Query('cycleId') cycleId?: string) { return this.budgets.listBudgets(a, cycleId); }
  @Get('budgets/analytics') async analytics(@Auth() a: AuthContext, @Query('cycleId') cycleId?: string) {
    const id = cycleId ?? (await this.budgets.openCycle(this.prisma, a.ownerId))?.id;
    if (!id) return { cycle: null, categories: [], totals: null, daily: [], emptyReason: 'NO_OPEN_CYCLE' };
    return this.budgets.cycleAnalytics(this.prisma.reader as any, a.ownerId, id);
  }
  @Post('budgets') create(@Auth() a: AuthContext, @Body() dto: BudgetDto) { return this.prisma.tx((tx) => this.budgets.createBudget(tx, a, { ...dto, plannedMinor: parseMinor(dto.plannedMinor) })); }
  @Patch('budgets/:id') update(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBudgetDto) {
    return this.prisma.tx((tx) => this.budgets.updateBudget(tx, a, id, { ...dto, plannedMinor: dto.plannedMinor !== undefined ? parseMinor(dto.plannedMinor) : undefined }));
  }

  @Get('recurring-obligations') obligations(@Auth() a: AuthContext) { return this.budgets.listObligations(a); }
  @Post('recurring-obligations') createObligation(@Auth() a: AuthContext, @Body() dto: ObligationDto) { return this.prisma.tx((tx) => this.budgets.createObligation(tx, a, { ...dto, amountMinor: parsePositiveMinor(dto.amountMinor) })); }
  @Patch('recurring-obligations/:id') updateObligation(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateObligationDto) {
    return this.prisma.tx((tx) => this.budgets.updateObligation(tx, a, id, { ...dto, amountMinor: dto.amountMinor ? parsePositiveMinor(dto.amountMinor) : undefined }));
  }
  @Post('recurring-obligations/occurrences/:id/skip') skip(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.prisma.tx((tx) => this.budgets.skipOccurrence(tx, a, id)); }
}
