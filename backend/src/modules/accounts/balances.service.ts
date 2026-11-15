import { Injectable } from '@nestjs/common';
import { AuthContext } from '../../common/auth';
import { clock } from '../../common/clock';
import { config } from '../../common/config';
import { PrismaService } from '../../common/prisma.service';
import { BudgetsService } from '../budgets/budgets.service';
import { AccountsService } from './accounts.service';
import { WalletsService } from './wallets.service';

/**
 * Trois notions NON interchangeables (llm §5.1, Annexe B) :
 * confirmedBalance (attesté prestataire) ≠ trackedBalance (déclaré/suivi) ≠ recommendedSpendable (estimation budgétaire).
 */
@Injectable()
export class BalancesService {
  constructor(private prisma: PrismaService, private accounts: AccountsService, private wallets: WalletsService, private budgets: BudgetsService) {}

  async overview(auth: AuthContext) {
    const ownerId = auth.ownerId;
    const liquid = await this.accounts.liquidTotals(this.prisma, ownerId);
    const allocated = await this.wallets.totalAllocated(this.prisma, ownerId);
    const current = liquid.spendableBase - allocated;
    const reservations = await this.budgets.spendableReservations(this.prisma, ownerId);
    const holds = (await this.prisma.fundsHold.aggregate({ where: { ownerId, state: 'ACTIVE' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
    const blockedGroups = await this.prisma.realBalanceGroup.findMany({ where: { ownerId, status: 'BLOCKED_OUTBOUND' } });
    const openCases = await this.prisma.reconciliationCase.count({ where: { ownerId, status: { in: ['OPEN', 'INVESTIGATING'] } } });
    const lastTx = await this.prisma.ledgerTransaction.findFirst({ where: { ownerId }, orderBy: { sequence: 'desc' } });
    const staleAccounts = liquid.accounts.filter((a) => a.verificationLevel === 'STALE' || (a.lastVerifiedAt && clock.now().getTime() - a.lastVerifiedAt.getTime() > 30 * 86400_000));
    return {
      currency: 'XOF',
      confirmedBalanceMinor: liquid.providerVerified,
      confirmedTransferableMinor: blockedGroups.length ? 0n : liquid.providerVerified - holds,
      trackedBalanceMinor: liquid.tracked,
      spendableBaseMinor: liquid.spendableBase,
      allocatedToEnvelopesMinor: allocated,
      currentWalletMinor: current,
      reservations,
      recommendedSpendableMinor: current - reservations.totalMinor,
      byVerification: liquid.byVerification,
      transferRestrictions: {
        paymentsLiveEnabled: config.paymentsLiveEnabled,
        blockedReason: blockedGroups[0]?.blockReason ?? null,
        blockedGroups: blockedGroups.map((g) => ({ id: g.id, name: g.name, reason: g.blockReason })),
        financialReadOnlyUntil: auth.financialReadOnlyUntil,
        openReconciliationCases: openCases,
      },
      dataLabels: {
        confirmedBalance: liquid.providerVerified > 0n ? 'CONFIRMED' : 'NONE',
        trackedBalance: 'MANUAL',
        recommendedSpendable: 'ESTIMATED',
        staleAccountIds: staleAccounts.map((a) => a.id),
      },
      asOf: lastTx?.postedAt ?? clock.now(),
      ledgerSequence: lastTx?.sequence ?? 0n,
      computedAt: clock.now(),
    };
  }
}
