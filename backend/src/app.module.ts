import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard, SecurityStateService } from './common/auth';
import { EventsService } from './common/events.service';
import { AllExceptionsFilter, CorrelationMiddleware, EnvelopeInterceptor } from './common/http';
import { IdempotencyService } from './common/idempotency.service';
import { PrismaService } from './common/prisma.service';
import { AccountsController } from './modules/accounts/accounts.controller';
import { AccountsService } from './modules/accounts/accounts.service';
import { BalancesService } from './modules/accounts/balances.service';
import { WalletsService } from './modules/accounts/wallets.service';
import { BudgetsController } from './modules/budgets/budgets.controller';
import { BudgetsService } from './modules/budgets/budgets.service';
import { IdentityController } from './modules/identity/identity.controller';
import { IdentityService } from './modules/identity/identity.service';
import { StepUpService } from './modules/identity/step-up.service';
import { BooksService } from './modules/ledger/books.service';
import { LedgerService } from './modules/ledger/ledger.service';
import { ExpensesService } from './modules/money/expenses.service';
import { IncomeService } from './modules/money/income.service';
import { MoneyController } from './modules/money/money.controller';
import { SavingsController } from './modules/savings/savings.controller';
import { SavingsService } from './modules/savings/savings.service';
import { DOMAIN_CONTROLLERS, DOMAIN_PROVIDERS } from './modules/registry';

/** Monolithe modulaire (B01–B02) : API et worker partagent ces fournisseurs. */
export const CORE_PROVIDERS = [
  PrismaService, EventsService, IdempotencyService, SecurityStateService,
  LedgerService, BooksService, IdentityService, StepUpService,
  AccountsService, WalletsService, BalancesService, BudgetsService, IncomeService, ExpensesService, SavingsService,
  ...DOMAIN_PROVIDERS,
];

@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }], skipIf: () => process.env.APP_ENV === 'test' && process.env.TEST_THROTTLE !== 'true' })],
  controllers: [IdentityController, AccountsController, MoneyController, BudgetsController, SavingsController, ...DOMAIN_CONTROLLERS],
  providers: [
    ...CORE_PROVIDERS,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(CorrelationMiddleware).forRoutes('*'); }
}
