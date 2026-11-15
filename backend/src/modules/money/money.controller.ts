import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min, ValidateNested } from 'class-validator';
import { randomUUID } from 'crypto';
import { Auth, AuthContext, FinancialMutation, RequireTrustedDevice } from '../../common/auth';
import { AmountMinor, DateOnly, WithApproval } from '../../common/dto';
import { IdempotencyService } from '../../common/idempotency.service';
import { parsePositiveMinor } from '../../common/money';
import { PrismaService } from '../../common/prisma.service';
import { BudgetsService } from '../budgets/budgets.service';
import { StepUpService } from '../identity/step-up.service';
import { ExpensesService } from './expenses.service';
import { IncomeService } from './income.service';

class CreateIncomeDto {
  @IsUUID() accountId: string;
  @IsString() @Length(1, 120) source: string;
  @IsOptional() @IsIn(['SALARY', 'BUSINESS', 'GIFT', 'RENTAL', 'OTHER']) nature?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @DateOnly() economicDate?: string;
  @AmountMinor() grossMinor: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
  @IsOptional() @IsString() @MaxLength(120) externalRef?: string;
}
class AllocLine { @IsUUID() walletId: string; @AmountMinor() amountMinor: string }
class ConfirmAllocDto {
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => AllocLine) allocations: AllocLine[];
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
class CreateExpenseDto {
  @IsUUID() accountId: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @AmountMinor() amountMinor: string;
  @IsOptional() @DateOnly() economicDate?: string;
  @IsString() @Length(1, 160) label: string;
  @IsOptional() @IsString() @MaxLength(120) merchant?: string;
  @IsOptional() @IsString() @MaxLength(120) externalRef?: string;
  @IsOptional() @IsUUID() obligationOccurrenceId?: string;
}
class UpdateExpenseDto {
  @IsOptional() @IsString() @Length(1, 160) label?: string;
  @IsOptional() @IsString() @MaxLength(120) merchant?: string;
  @IsOptional() @IsUUID() categoryId?: string;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
class ReverseDto extends WithApproval { @IsString() @Length(3, 300) reason: string }
class CategoryDto {
  @IsString() @Length(1, 60) name: string;
  @IsIn(['EXPENSE', 'INCOME']) type: 'EXPENSE' | 'INCOME';
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsString() @MaxLength(30) icon?: string;
  @IsOptional() @IsBoolean() essential?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
}
class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional() @IsString() @MaxLength(30) icon?: string;
  @IsOptional() @IsBoolean() essential?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) keywords?: string[];
  @IsOptional() @IsBoolean() active?: boolean;
}

@Controller()
export class MoneyController {
  constructor(private prisma: PrismaService, private incomes: IncomeService, private expenses: ExpensesService, private budgets: BudgetsService, private idem: IdempotencyService, private stepUp: StepUpService) {}

  @Get('incomes') listIncomes(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) { return this.incomes.list(a, { from, to }); }
  @Get('incomes/:id') getIncome(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.incomes.get(a, id); }

  @FinancialMutation() @Post('incomes')
  createIncome(@Auth() a: AuthContext, @Body() dto: CreateIncomeDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, 'incomes.create', key, dto, (tx) => this.incomes.create(tx, a, randomUUID(), { ...dto, grossMinor: parsePositiveMinor(dto.grossMinor, 'grossMinor') }));
  }
  @Post('incomes/:id/allocation-proposals') proposals(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.incomes.proposals(a, id); }

  @FinancialMutation() @Post('incomes/:id/confirm-allocations')
  confirm(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmAllocDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, `incomes.confirm:${id}`, key, dto, (tx) => this.incomes.confirmAllocations(tx, a, id, { allocations: dto.allocations.map((l) => ({ walletId: l.walletId, amountMinor: parsePositiveMinor(l.amountMinor) })), expectedVersion: dto.expectedVersion }));
  }

  @Get('expenses') listExpenses(@Auth() a: AuthContext, @Query() q: { from?: string; to?: string; categoryId?: string; accountId?: string; cycleId?: string }) { return this.expenses.list(a, q); }

  @FinancialMutation() @Post('expenses')
  createExpense(@Auth() a: AuthContext, @Body() dto: CreateExpenseDto, @Headers('idempotency-key') key: string) {
    return this.idem.run(a.ownerId, 'expenses.create', key, dto, (tx) => this.expenses.create(tx, a, randomUUID(), { ...dto, amountMinor: parsePositiveMinor(dto.amountMinor) }));
  }
  @FinancialMutation() @Patch('expenses/:id')
  updateExpense(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto) { return this.prisma.tx((tx) => this.expenses.update(tx, a, id, dto)); }

  @RequireTrustedDevice() @FinancialMutation() @Post('expenses/:id/reverse')
  reverseExpense(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReverseDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'ledger.correction', { expenseId: id, reason: dto.reason });
      return this.expenses.reverse(tx, a, id, dto.reason);
    });
  }

  @Get('categories') categories(@Auth() a: AuthContext, @Query('type') type?: string) { return this.budgets.categories(a, type); }
  @Get('categories/suggest') suggest(@Auth() a: AuthContext, @Query('label') label = '', @Query('merchant') merchant?: string) { return this.budgets.suggestCategory(this.prisma, a.ownerId, label, merchant); }
  @Post('categories') createCategory(@Auth() a: AuthContext, @Body() dto: CategoryDto) { return this.budgets.createCategory(a, dto); }
  @Patch('categories/:id') updateCategory(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) { return this.budgets.updateCategory(a, id, dto); }
}
