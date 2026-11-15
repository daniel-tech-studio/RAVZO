import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth';
import { clock, economicToday, parseDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';
import { MarketService } from './market.service';

const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v as any);
const toMinor = (d: Prisma.Decimal) => BigInt(d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toFixed(0));

/**
 * SGI / BRVM (llm §11.2) : opérations DÉJÀ exécutées chez la SGI, saisies ou importées — aucun ordre transmis.
 * Titres au coût (frais inclus) ; coût de revient : méthode documentée SGI si fournie, sinon FIFO de repli INDICATIF.
 */
@Injectable()
export class InvestmentsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private market: MarketService, private events: EventsService) {}

  async brokers(auth: AuthContext) {
    const brokers = await this.prisma.broker.findMany({ where: { ownerId: auth.ownerId }, include: { accounts: true }, orderBy: { createdAt: 'asc' } });
    return Promise.all(brokers.map(async (b) => ({
      ...b,
      accounts: await Promise.all(b.accounts.map(async (a) => {
        const cash = await this.accounts.getOwned(this.prisma, auth.ownerId, a.cashFinancialAccountId);
        return { ...a, cashBalanceMinor: await this.ledger.balance(this.prisma, cash.ledgerAccountId), securitiesAtCostMinor: await this.ledger.balance(this.prisma, a.securitiesLedgerAccountId) };
      })),
    })));
  }

  async createBroker(tx: Tx, auth: AuthContext, dto: { name: string; notes?: string; officialId?: string; accountAlias: string; openingCashMinor?: bigint; costBasisMethod?: string }) {
    const broker = await tx.broker.create({ data: { ownerId: auth.ownerId, name: dto.name, notes: dto.notes, officialId: dto.officialId, costBasisMethod: dto.costBasisMethod ?? 'FALLBACK_FIFO' } });
    const baId = randomUUID();
    const cashLa = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:FA:SGI:${baId}`, name: `Espèces SGI ${dto.name}`, kind: 'ASSET' });
    const cash = await tx.financialAccount.create({ data: { ownerId: auth.ownerId, ledgerAccountId: cashLa.id, name: `Espèces ${dto.name}`, institution: dto.name, type: 'BROKER_CASH', includeInSpendable: false, verificationLevel: 'USER_DECLARED' } });
    const secLa = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:SEC:${baId}`, name: `Titres ${dto.name} (au coût)`, kind: 'ASSET' });
    const ba = await tx.brokerageAccount.create({ data: { id: baId, ownerId: auth.ownerId, brokerId: broker.id, cashFinancialAccountId: cash.id, securitiesLedgerAccountId: secLa.id, accountAlias: dto.accountAlias } });
    if (dto.openingCashMinor && dto.openingCashMinor > 0n) {
      const eq = await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING');
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ACCOUNT_OPENING', businessId: cash.id, memo: `Solde espèces SGI déclaré — ${dto.name}`, postings: [{ accountId: cashLa.id, amount: dto.openingCashMinor }, { accountId: eq.id, amount: -dto.openingCashMinor }] });
    }
    return { broker, brokerageAccount: ba, cashAccount: cash };
  }

  private async ba(db: Tx | PrismaService, ownerId: string, id: string) {
    const a = await db.brokerageAccount.findUnique({ where: { id }, include: { broker: true } });
    if (!a || a.ownerId !== ownerId) throw notFound('Compte SGI');
    return a;
  }

  /** Mouvement d'espèces SGI : virement depuis/vers un compte suivi (pas de revenu), ou frais de tenue. */
  async cashMovement(tx: Tx, auth: AuthContext, baId: string, dto: { type: 'DEPOSIT' | 'WITHDRAWAL' | 'FEE'; amountMinor: bigint; counterpartAccountId?: string; date?: string; memo?: string }) {
    const a = await this.ba(tx, auth.ownerId, baId);
    if (dto.type === 'FEE') {
      const cash = await this.accounts.getOwned(tx, auth.ownerId, a.cashFinancialAccountId);
      const fee = await this.books.core(tx, auth.ownerId, 'EXPENSE:FEES');
      return this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'SGI_FEE', businessId: randomUUID(), economicDate: dto.date ? parseDateOnly(dto.date) : economicToday(), memo: dto.memo ?? `Frais SGI ${a.broker.name}`, postings: [{ accountId: cash.ledgerAccountId, amount: -dto.amountMinor }, { accountId: fee.id, amount: dto.amountMinor }] });
    }
    if (!dto.counterpartAccountId) throw new DomainError('VALIDATION_FAILED', 'Compte de contrepartie requis');
    const [from, to] = dto.type === 'DEPOSIT' ? [dto.counterpartAccountId, a.cashFinancialAccountId] : [a.cashFinancialAccountId, dto.counterpartAccountId];
    return this.accounts.transfer(tx, auth, randomUUID(), { fromAccountId: from, toAccountId: to, amountMinor: dto.amountMinor, date: dto.date, memo: dto.memo ?? `${dto.type === 'DEPOSIT' ? 'Versement vers' : 'Retrait de'} SGI ${a.broker.name}` });
  }

  async recordTrade(tx: Tx, auth: AuthContext, dto: { brokerageAccountId: string; securityId: string; side: 'BUY' | 'SELL'; quantity: string; unitPrice: string; feesMinor?: bigint; taxesMinor?: bigint; executedAt: string; settledAt?: string; externalRef?: string; evidenceRef?: string; documentedCostMinor?: bigint; importRowId?: string }) {
    const a = await this.ba(tx, auth.ownerId, dto.brokerageAccountId);
    const sec = await tx.security.findUnique({ where: { id: dto.securityId } });
    if (!sec) throw notFound('Titre');
    if (dto.externalRef) {
      const dup = await tx.trade.findUnique({ where: { brokerageAccountId_externalRef: { brokerageAccountId: a.id, externalRef: dto.externalRef } } });
      if (dup) return { ...dup, duplicate: true }; // T14 : même avis d'opéré → un seul trade
    }
    const qty = D(dto.quantity), price = D(dto.unitPrice);
    if (qty.lte(0) || price.lt(0)) throw new DomainError('VALIDATION_FAILED', 'Quantité > 0 et prix ≥ 0');
    const executedAt = new Date(dto.executedAt);
    if (isNaN(executedAt.getTime()) || executedAt > clock.now()) throw new DomainError('VALIDATION_FAILED', 'Date d’exécution invalide ou future (opération déjà exécutée requise)');
    const gross = toMinor(qty.mul(price));
    const fees = dto.feesMinor ?? 0n, taxes = dto.taxesMinor ?? 0n;
    const cash = await this.accounts.getOwned(tx, auth.ownerId, a.cashFinancialAccountId);
    const id = randomUUID();
    await tx.$queryRaw`SELECT id FROM "BrokerageAccount" WHERE id = ${a.id}::uuid FOR UPDATE`;
    let realized: bigint | null = null;
    let method = a.broker.costBasisMethod === 'SGI_DOCUMENTED' ? 'SGI_DOCUMENTED' : 'FALLBACK_FIFO';
    let postings: { accountId: string; amount: bigint }[];
    if (dto.side === 'BUY') {
      const cost = gross + fees + taxes;
      postings = [{ accountId: cash.ledgerAccountId, amount: -cost }, { accountId: a.securitiesLedgerAccountId, amount: cost }];
    } else {
      const lots = await tx.costBasisLot.findMany({ where: { brokerageAccountId: a.id, securityId: sec.id, quantityRemaining: { gt: 0 } }, orderBy: { id: 'asc' } });
      const tradesOrder = await tx.trade.findMany({ where: { id: { in: lots.map((l) => l.tradeId) } }, select: { id: true, executedAt: true } });
      lots.sort((x, y) => tradesOrder.find((t) => t.id === x.tradeId)!.executedAt.getTime() - tradesOrder.find((t) => t.id === y.tradeId)!.executedAt.getTime());
      const held = lots.reduce((s, l) => s.add(l.quantityRemaining), D(0));
      if (qty.gt(held)) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Quantité vendue supérieure à la position', { heldQuantity: held.toString() });
      let remaining = qty, fifoCost = 0n;
      for (const l of lots) {
        if (remaining.lte(0)) break;
        const take = Prisma.Decimal.min(remaining, l.quantityRemaining);
        const unitCost = D(l.costMinor.toString()).div(l.quantityRemaining);
        const part = take.eq(l.quantityRemaining) ? l.costMinor : toMinor(unitCost.mul(take));
        fifoCost += part;
        await tx.costBasisLot.update({ where: { id: l.id }, data: { quantityRemaining: l.quantityRemaining.sub(take), costMinor: l.costMinor - part } });
        remaining = remaining.sub(take);
      }
      const cost = dto.documentedCostMinor ?? fifoCost;
      if (dto.documentedCostMinor !== undefined) method = 'SGI_DOCUMENTED';
      const proceeds = gross - fees - taxes;
      realized = proceeds - cost;
      const gainAcc = await this.books.core(tx, auth.ownerId, realized >= 0n ? 'INCOME:REALIZED_GAIN' : 'EXPENSE:REALIZED_LOSS');
      postings = [{ accountId: cash.ledgerAccountId, amount: proceeds }, { accountId: a.securitiesLedgerAccountId, amount: -cost }, { accountId: gainAcc.id, amount: -realized }];
    }
    const { transaction } = await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'TRADE', businessId: id, economicDate: parseDateOnly(dto.executedAt.slice(0, 10)), actorDeviceId: auth.deviceId, memo: `${dto.side === 'BUY' ? 'Achat' : 'Vente'} ${dto.quantity} ${sec.symbol} @ ${dto.unitPrice}`, externalCorrelationId: dto.externalRef, postings });
    const trade = await tx.trade.create({
      data: { id, ownerId: auth.ownerId, brokerageAccountId: a.id, securityId: sec.id, side: dto.side, quantity: qty, unitPrice: price, grossMinor: gross, feesMinor: fees, taxesMinor: taxes, executedAt, settledAt: dto.settledAt ? new Date(dto.settledAt) : null, externalRef: dto.externalRef, evidenceRef: dto.evidenceRef, importRowId: dto.importRowId, realizedPnlMinor: realized, costMethod: method, ledgerTransactionId: transaction.id },
    });
    if (dto.side === 'BUY') await tx.costBasisLot.create({ data: { ownerId: auth.ownerId, tradeId: trade.id, brokerageAccountId: a.id, securityId: sec.id, quantityRemaining: qty, costMinor: gross + fees + taxes, method, officialStatus: method === 'SGI_DOCUMENTED' ? 'SGI_VERIFIED' : 'INDICATIVE' } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'Trade', aggregateId: trade.id });
    return { ...trade, duplicate: false, costMethodLabel: method === 'SGI_DOCUMENTED' ? 'Méthode documentée par la SGI' : 'FIFO de repli — indicatif, non fiscal' };
  }

  async trades(auth: AuthContext, securityId?: string) {
    return this.prisma.trade.findMany({ where: { ownerId: auth.ownerId, ...(securityId ? { securityId } : {}) }, orderBy: { executedAt: 'desc' }, take: 300 });
  }

  /** Positions et performance avec cotations horodatées ; sans cours : valorisation au coût signalée. */
  async holdings(db: Tx | PrismaService, ownerId: string) {
    const lots = await db.costBasisLot.findMany({ where: { ownerId, quantityRemaining: { gt: 0 } } });
    const groups = new Map<string, typeof lots>();
    for (const l of lots) groups.set(`${l.brokerageAccountId}:${l.securityId}`, [...(groups.get(`${l.brokerageAccountId}:${l.securityId}`) ?? []), l]);
    const out = [];
    for (const [key, ls] of groups) {
      const [baId, secId] = key.split(':');
      const sec = await db.security.findUniqueOrThrow({ where: { id: secId } });
      const qty = ls.reduce((s, l) => s.add(l.quantityRemaining), D(0));
      const cost = ls.reduce((s, l) => s + l.costMinor, 0n);
      const q = await this.market.latestQuote(db, secId);
      const mv = q ? toMinor(q.price.mul(qty)) : null;
      const realized = (await db.trade.aggregate({ where: { ownerId, brokerageAccountId: baId, securityId: secId, side: 'SELL' }, _sum: { realizedPnlMinor: true } }))._sum.realizedPnlMinor ?? 0n;
      out.push({
        brokerageAccountId: baId, security: { id: sec.id, symbol: sec.symbol, name: sec.name, sector: sec.sector }, quantity: qty.toString(), costMinor: cost,
        averageCost: qty.gt(0) ? D(cost.toString()).div(qty).toDecimalPlaces(2).toString() : '0',
        lastQuote: q && { price: q.price.toString(), sessionDate: q.sessionDate, asOf: q.asOf, quality: q.quality, sourceId: q.sourceId }, freshness: this.market.freshness(q),
        marketValueMinor: mv, valuationBasis: mv === null ? 'COST' : 'QUOTE', unrealizedPnlMinor: mv === null ? null : mv - cost, realizedPnlMinor: realized,
        costBasisStatus: ls.every((l) => l.officialStatus === 'SGI_VERIFIED') ? 'SGI_VERIFIED' : 'INDICATIVE',
      });
    }
    return out;
  }

  // ─── Dividendes : annonce ≠ encaissement (T15) ───
  async announceDividend(tx: Tx, auth: AuthContext, dto: { securityId: string; declaredPerShare: string; exDate?: string; recordDate?: string; paymentDate?: string; source: string }) {
    const sec = await tx.security.findUnique({ where: { id: dto.securityId } });
    if (!sec) throw notFound('Titre');
    const ann = await tx.dividendAnnouncement.create({ data: { securityId: sec.id, declaredPerShare: D(dto.declaredPerShare), exDate: dto.exDate ? parseDateOnly(dto.exDate) : null, recordDate: dto.recordDate ? parseDateOnly(dto.recordDate) : null, paymentDate: dto.paymentDate ? parseDateOnly(dto.paymentDate) : null, source: dto.source } });
    // Droits évalués sur la position détenue (attendu, NON disponible).
    const bas = await tx.brokerageAccount.findMany({ where: { ownerId: auth.ownerId } });
    for (const ba of bas) {
      const lots = await tx.costBasisLot.findMany({ where: { brokerageAccountId: ba.id, securityId: sec.id, quantityRemaining: { gt: 0 } } });
      const qty = lots.reduce((s, l) => s.add(l.quantityRemaining), D(0));
      if (qty.lte(0)) continue;
      await tx.dividendEntitlement.create({ data: { ownerId: auth.ownerId, announcementId: ann.id, brokerageAccountId: ba.id, quantityEligible: qty, expectedMinor: toMinor(qty.mul(ann.declaredPerShare)), status: 'ENTITLEMENT_EVALUATED' } });
    }
    await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `dividend-ann:${ann.id}`, type: 'market.dividend_announced', category: 'MARKET', priority: 'LOW', title: `Dividende annoncé — ${sec.symbol}`, body: 'Montant attendu, non encaissé. Il sera crédité uniquement après réception rapprochée.', link: '/wealth/dividends' });
    return ann;
  }

  async dividends(auth: AuthContext) {
    const ents = await this.prisma.dividendEntitlement.findMany({ where: { ownerId: auth.ownerId } });
    const anns = await this.prisma.dividendAnnouncement.findMany({ where: { id: { in: ents.map((e) => e.announcementId) } } });
    const secs = await this.prisma.security.findMany({ where: { id: { in: anns.map((a) => a.securityId) } } });
    const receipts = await this.prisma.dividendReceipt.findMany({ where: { ownerId: auth.ownerId } });
    return ents.map((e) => {
      const a = anns.find((x) => x.id === e.announcementId)!;
      return { ...e, announcement: a, security: secs.find((s) => s.id === a.securityId), receipt: receipts.find((r) => r.entitlementId === e.id) ?? null, cashCredited: e.status === 'RECONCILED' };
    });
  }

  async matchDividendReceipt(tx: Tx, auth: AuthContext, entitlementId: string, dto: { receivedMinor: bigint; receivedAt: string }) {
    const e = await tx.dividendEntitlement.findUnique({ where: { id: entitlementId } });
    if (!e || e.ownerId !== auth.ownerId) throw notFound('Droit au dividende');
    if (e.status === 'RECONCILED') throw new DomainError('STATE_CONFLICT', 'Dividende déjà encaissé et rapproché');
    const ba = await this.ba(tx, auth.ownerId, e.brokerageAccountId);
    const cash = await this.accounts.getOwned(tx, auth.ownerId, ba.cashFinancialAccountId);
    const inc = await this.books.core(tx, auth.ownerId, 'INCOME:DIVIDENDS');
    const { transaction } = await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'DIVIDEND_RECEIPT', businessId: e.id, economicDate: parseDateOnly(dto.receivedAt), actorDeviceId: auth.deviceId, memo: 'Dividende encaissé (rapproché)', postings: [{ accountId: cash.ledgerAccountId, amount: dto.receivedMinor }, { accountId: inc.id, amount: -dto.receivedMinor }] });
    const r = await tx.dividendReceipt.create({ data: { ownerId: auth.ownerId, entitlementId: e.id, cashLedgerTransactionId: transaction.id, receivedMinor: dto.receivedMinor, receivedAt: parseDateOnly(dto.receivedAt) } });
    await tx.dividendEntitlement.update({ where: { id: e.id }, data: { status: 'RECONCILED' } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'DividendReceipt', aggregateId: r.id });
    return { receipt: r, differenceMinor: e.expectedMinor !== null ? dto.receivedMinor - e.expectedMinor : null };
  }

  // ─── Projets d'achat : réservation VIRTUELLE uniquement ───
  async plans(auth: AuthContext) {
    const ps = await this.prisma.purchasePlan.findMany({ where: { ownerId: auth.ownerId }, orderBy: { createdAt: 'desc' } });
    return Promise.all(ps.map(async (p) => ({ ...p, security: await this.prisma.security.findUnique({ where: { id: p.securityId } }), isHolding: false, reservationKind: 'VIRTUAL' })));
  }
  async createPlan(tx: Tx, auth: AuthContext, dto: { securityId: string; quantityTarget?: string; budgetReservedMinor: bigint; targetDate?: string; note?: string }) {
    const sec = await tx.security.findUnique({ where: { id: dto.securityId } });
    if (!sec) throw notFound('Titre');
    const p = await tx.purchasePlan.create({ data: { ownerId: auth.ownerId, securityId: sec.id, quantityTarget: dto.quantityTarget ? D(dto.quantityTarget) : null, budgetReservedMinor: dto.budgetReservedMinor, targetDate: dto.targetDate ? parseDateOnly(dto.targetDate) : null, note: dto.note } });
    const r = await tx.allocationReservation.create({ data: { ownerId: auth.ownerId, purposeType: 'PURCHASE_PLAN', purposeId: p.id, amountMinor: dto.budgetReservedMinor } });
    return tx.purchasePlan.update({ where: { id: p.id }, data: { allocationReservationId: r.id } });
  }
  async closePlan(tx: Tx, auth: AuthContext, id: string, state: 'CANCELLED' | 'EXECUTED_EXTERNALLY') {
    const p = await tx.purchasePlan.findUnique({ where: { id } });
    if (!p || p.ownerId !== auth.ownerId) throw notFound('Projet');
    if (p.state !== 'ACTIVE') throw new DomainError('STATE_CONFLICT', 'Projet déjà clos');
    await tx.allocationReservation.updateMany({ where: { purposeType: 'PURCHASE_PLAN', purposeId: p.id, state: 'ACTIVE' }, data: { state: 'RELEASED', releasedAt: clock.now() } });
    return tx.purchasePlan.update({ where: { id }, data: { state } });
  }

  async alerts(auth: AuthContext) { return this.prisma.priceAlert.findMany({ where: { ownerId: auth.ownerId } }); }
  async createAlert(auth: AuthContext, dto: { securityId: string; triggerType: 'ABOVE' | 'BELOW'; threshold: string }) {
    return this.prisma.priceAlert.create({ data: { ownerId: auth.ownerId, securityId: dto.securityId, triggerType: dto.triggerType, threshold: D(dto.threshold) } });
  }
  async toggleAlert(auth: AuthContext, id: string, enabled: boolean) {
    const a = await this.prisma.priceAlert.findUnique({ where: { id } });
    if (!a || a.ownerId !== auth.ownerId) throw notFound('Alerte');
    return this.prisma.priceAlert.update({ where: { id }, data: { enabled } });
  }
}
