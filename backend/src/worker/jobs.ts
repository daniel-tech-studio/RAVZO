import { Injectable, Logger } from '@nestjs/common';
import { addMs, clock, DAY } from '../common/clock';
import { PrismaService } from '../common/prisma.service';
import { BudgetsService } from '../modules/budgets/budgets.service';
import { LedgerService } from '../modules/ledger/ledger.service';
import { LimitsService } from '../modules/payments/limits.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { ReconciliationService } from '../modules/payments/reconciliation.service';
import { SyncService } from '../modules/platform/sync.service';
import { SavingsService } from '../modules/savings/savings.service';
import { LiabilitiesService } from '../modules/wealth/liabilities.service';
import { MarketService } from '../modules/wealth/market.service';

/** Jobs planifiés (backend.md §22) : préparation, surveillance, lectures de statut — jamais un nouveau paiement. */
@Injectable()
export class ScheduledJobs {
  private log = new Logger('Jobs');
  constructor(
    private prisma: PrismaService, private budgets: BudgetsService, private savings: SavingsService, private liabilities: LiabilitiesService,
    private limits: LimitsService, private payments: PaymentsService, private recon: ReconciliationService, private ledger: LedgerService, private sync: SyncService, private market: MarketService,
  ) {}

  readonly schedule: Record<string, { everyMs: number; run: () => Promise<unknown> }> = {
    'payments.check-pending': { everyMs: 30_000, run: () => this.payments.checkPending() },
    'limits.apply-due': { everyMs: 60_000, run: () => this.limits.applyDue() },
    'exceptions.expire': { everyMs: 60_000, run: () => this.limits.expireExceptions() },
    'budget.close-due-cycles': { everyMs: 15 * 60_000, run: () => this.budgets.closeDueCycles() },
    'savings.evaluate': { everyMs: 15 * 60_000, run: () => this.savings.evaluate() },
    'obligations.roll': { everyMs: 60 * 60_000, run: () => this.budgets.rollAllObligations() },
    'liabilities.flag-late': { everyMs: 60 * 60_000, run: () => this.liabilities.flagLate() },
    'reconciliation.snapshots': { everyMs: 60 * 60_000, run: () => this.recon.runAll() },
    'accounts.mark-stale': { everyMs: 24 * 3600_000, run: () => this.markStale() },
    'ledger.audit-projections': { everyMs: 24 * 3600_000, run: () => this.auditLedger() },
    // BRVM : séance ≈ 09:00–15:30 GMT en semaine ; 1 requête/heure en séance + 1 après clôture ≈ 9/jour (quota 100).
    'market.refresh': { everyMs: 60 * 60_000, run: () => this.brvmWindow() ? this.market.refresh({ minIntervalMs: 50 * 60_000, reason: 'SCHEDULED' }) : Promise.resolve({ skipped: 'MARKET_CLOSED' }) },
    'market.purge-provider-quotes': { everyMs: 60 * 60_000, run: () => this.market.purgeExpiredProviderQuotes() },
    'sync.purge-old-events': { everyMs: 24 * 3600_000, run: () => this.sync.purgeOld() },
  };

  /** Exécution unique par créneau (JobRun unique) même si plusieurs workers tournent. */
  async run(name: string) {
    const job = this.schedule[name];
    if (!job) return;
    const slot = Math.floor(clock.now().getTime() / job.everyMs);
    try { await this.prisma.jobRun.create({ data: { job: name, runKey: String(slot) } }); } catch { return; }
    const started = Date.now();
    try {
      const result = await job.run();
      await this.prisma.jobRun.update({ where: { job_runKey: { job: name, runKey: String(slot) } }, data: { result: JSON.stringify(result ?? null, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 500) } });
      this.log.log(JSON.stringify({ job: name, outcome: 'ok', ms: Date.now() - started }));
    } catch (e: any) {
      this.log.error(JSON.stringify({ job: name, outcome: 'error', error: String(e?.message).slice(0, 300) }));
    }
  }

  brvmWindow() {
    const n = clock.now();
    const d = n.getUTCDay(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    return d >= 1 && d <= 5 && m >= 9 * 60 && m <= 17 * 60;
  }
  async markStale() {
    const r = await this.prisma.financialAccount.updateMany({ where: { type: { in: ['EXTERNAL_TRACKED', 'CASH_MANUAL', 'BROKER_CASH'] }, verificationLevel: 'USER_DECLARED', lastVerifiedAt: { lt: addMs(clock.now(), -30 * DAY) } }, data: { verificationLevel: 'STALE' } });
    return r.count;
  }
  async auditLedger() {
    const r = await this.ledger.auditProjections();
    if (!r.healthy) this.log.error(JSON.stringify({ alert: 'LEDGER_INTEGRITY', mismatches: r.projectionMismatches.length, unbalanced: r.unbalancedTransactions.length }));
    return { healthy: r.healthy };
  }
}
