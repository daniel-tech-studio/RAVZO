import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth';
import { economicToday, parseDateOnly, toDateOnly } from '../../common/clock';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService, LIQUID_TYPES } from '../accounts/accounts.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';
import { InvestmentsService } from './investments.service';
import { LiabilitiesService } from './liabilities.service';

/** Biens physiques : réévaluation = ajustement patrimonial NON encaissé (contrepartie capitaux, jamais revenu). */
@Injectable()
export class AssetsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private investments: InvestmentsService, private liabilities: LiabilitiesService, private events: EventsService) {}

  private async owned(db: Tx | PrismaService, ownerId: string, id: string) {
    const a = await db.physicalAsset.findUnique({ where: { id }, include: { valuations: { orderBy: { valuationDate: 'desc' } } } });
    if (!a || a.ownerId !== ownerId) throw notFound('Bien');
    return a;
  }
  async present(db: Tx | PrismaService, a: any) {
    const value = a.ledgerAccountId ? await this.ledger.balance(db, a.ledgerAccountId) : 0n;
    const last = a.valuations[0];
    return { ...a, currentValueMinor: value, lastValuation: last ?? null, valuationAgeDays: last ? Math.floor((economicToday().getTime() - last.valuationDate.getTime()) / 86400000) : null, dataLabel: 'ESTIMATED', gainVsCostMinor: a.acquisitionCostMinor !== null ? value - a.acquisitionCostMinor : null };
  }
  async list(auth: AuthContext) {
    const as = await this.prisma.physicalAsset.findMany({ where: { ownerId: auth.ownerId }, include: { valuations: { orderBy: { valuationDate: 'desc' } } }, orderBy: { createdAt: 'asc' } });
    return Promise.all(as.map((a) => this.present(this.prisma, a)));
  }
  async get(auth: AuthContext, id: string) { return this.present(this.prisma, await this.owned(this.prisma, auth.ownerId, id)); }

  async create(tx: Tx, auth: AuthContext, dto: { name: string; kind: string; acquiredAt?: string; acquisitionCostMinor?: bigint; paidFromAccountId?: string; currentValueMinor?: bigint; valuationSource?: string }) {
    const id = randomUUID();
    const la = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:PA:${id}`, name: `Bien — ${dto.name}`, kind: 'ASSET' });
    const a = await tx.physicalAsset.create({ data: { id, ownerId: auth.ownerId, name: dto.name, kind: dto.kind, acquiredAt: dto.acquiredAt ? parseDateOnly(dto.acquiredAt) : null, acquisitionCostMinor: dto.acquisitionCostMinor, ledgerAccountId: la.id } });
    const initial = dto.acquisitionCostMinor ?? dto.currentValueMinor ?? 0n;
    if (initial > 0n) {
      // Achat payé depuis un compte : échange trésorerie → bien (pas une dépense). Sinon bien préexistant : capitaux d'ouverture.
      const counter = dto.paidFromAccountId ? (await this.accounts.getOwned(tx, auth.ownerId, dto.paidFromAccountId)).ledgerAccountId : (await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING')).id;
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ASSET_ACQUISITION', businessId: id, economicDate: dto.acquiredAt ? parseDateOnly(dto.acquiredAt) : economicToday(), actorDeviceId: auth.deviceId, memo: `${dto.paidFromAccountId ? 'Acquisition' : 'Bien déclaré'} — ${dto.name}`, postings: [{ accountId: la.id, amount: initial }, { accountId: counter, amount: -initial }] });
      await tx.assetValuation.create({ data: { assetId: id, valueMinor: initial, valuationDate: dto.acquiredAt ? parseDateOnly(dto.acquiredAt) : economicToday(), source: dto.acquisitionCostMinor ? 'PURCHASE_PRICE' : (dto.valuationSource ?? 'OWNER_ESTIMATE') } });
    }
    if (dto.acquisitionCostMinor && dto.currentValueMinor !== undefined && dto.currentValueMinor !== dto.acquisitionCostMinor) {
      await this.revalue(tx, auth, id, { valueMinor: dto.currentValueMinor, valuationDate: toDateOnly(economicToday()), source: dto.valuationSource ?? 'OWNER_ESTIMATE' });
    }
    return this.present(tx, await this.owned(tx, auth.ownerId, a.id));
  }

  async revalue(tx: Tx, auth: AuthContext, id: string, dto: { valueMinor: bigint; valuationDate: string; source: string; note?: string; evidenceDocumentId?: string }) {
    const a = await this.owned(tx, auth.ownerId, id);
    if (a.status !== 'HELD') throw new DomainError('STATE_CONFLICT', 'Bien cédé');
    const date = parseDateOnly(dto.valuationDate);
    if (date > economicToday()) throw new DomainError('VALIDATION_FAILED', 'Date de valorisation future');
    const v = await tx.assetValuation.create({ data: { assetId: id, valueMinor: dto.valueMinor, valuationDate: date, source: dto.source, note: dto.note, evidenceDocumentId: dto.evidenceDocumentId } });
    const current = await this.ledger.balance(tx, a.ledgerAccountId!);
    const delta = dto.valueMinor - current;
    if (delta !== 0n) {
      const reval = await this.books.core(tx, auth.ownerId, 'EQUITY:REVALUATION');
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ASSET_REVALUATION', businessId: v.id, economicDate: date, actorDeviceId: auth.deviceId, memo: `Réévaluation non encaissée — ${a.name}`, postings: [{ accountId: a.ledgerAccountId!, amount: delta }, { accountId: reval.id, amount: -delta }] });
    }
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'wealth.updated', aggregateType: 'PhysicalAsset', aggregateId: id });
    return this.present(tx, await this.owned(tx, auth.ownerId, id));
  }

  /** Cession : encaissement réel, sortie du bien, plus/moins-value réalisée. */
  async dispose(tx: Tx, auth: AuthContext, id: string, dto: { saleMinor: bigint; toAccountId?: string; date: string }) {
    const a = await this.owned(tx, auth.ownerId, id);
    if (a.status !== 'HELD') throw new DomainError('STATE_CONFLICT', 'Bien déjà cédé');
    const book = await this.ledger.balance(tx, a.ledgerAccountId!);
    const gain = dto.saleMinor - book;
    const postings = [{ accountId: a.ledgerAccountId!, amount: -book }];
    if (dto.saleMinor > 0n) {
      if (!dto.toAccountId) throw new DomainError('VALIDATION_FAILED', 'Compte d’encaissement requis');
      postings.push({ accountId: (await this.accounts.getOwned(tx, auth.ownerId, dto.toAccountId)).ledgerAccountId, amount: dto.saleMinor });
    }
    postings.push({ accountId: (await this.books.core(tx, auth.ownerId, gain >= 0n ? 'INCOME:REALIZED_GAIN' : 'EXPENSE:REALIZED_LOSS')).id, amount: -gain });
    await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ASSET_DISPOSAL', businessId: id, economicDate: parseDateOnly(dto.date), actorDeviceId: auth.deviceId, memo: `Cession — ${a.name}`, postings });
    await tx.physicalAsset.update({ where: { id }, data: { status: dto.saleMinor > 0n ? 'SOLD' : 'DISPOSED' } });
    return this.present(tx, await this.owned(tx, auth.ownerId, id));
  }

  /** Patrimoine net : chaque composant compté une seule fois, provenance explicite (UX11, invariant 9). */
  async wealthOverview(auth: AuthContext) {
    const db = this.prisma;
    const ownerId = auth.ownerId;
    const accounts = await db.financialAccount.findMany({ where: { ownerId, status: 'ACTIVE' } });
    let liquid = 0n, brokerCash = 0n;
    for (const a of accounts) {
      const b = await this.ledger.balance(db, a.ledgerAccountId);
      if (a.type === 'BROKER_CASH') brokerCash += b; else if (LIQUID_TYPES.includes(a.type)) liquid += b;
    }
    const holdings = await this.investments.holdings(db, ownerId);
    const securitiesMarket = holdings.reduce((s, h) => s + (h.marketValueMinor ?? h.costMinor), 0n);
    const securitiesCost = holdings.reduce((s, h) => s + h.costMinor, 0n);
    const assets = await this.list(auth);
    const physical = assets.filter((a) => a.status === 'HELD').reduce((s, a) => s + a.currentValueMinor, 0n);
    const liab = await this.liabilities.list(auth);
    const totalAssets = liquid + brokerCash + securitiesMarket + physical + liab.summary.receivablesOutstandingMinor;
    const totalLiabilities = liab.summary.debtsOutstandingMinor;
    const history = await this.netWorthHistory(ownerId);
    return {
      currency: 'XOF', netWorthMinor: totalAssets - totalLiabilities, totalAssetsMinor: totalAssets, totalLiabilitiesMinor: totalLiabilities,
      breakdown: [
        { key: 'LIQUID', label: 'Liquidités suivies', valueMinor: liquid, dataLabel: 'MANUAL' },
        { key: 'BROKER_CASH', label: 'Espèces SGI', valueMinor: brokerCash, dataLabel: 'MANUAL' },
        { key: 'SECURITIES', label: 'Titres BRVM', valueMinor: securitiesMarket, costMinor: securitiesCost, dataLabel: holdings.some((h) => h.valuationBasis === 'COST') ? 'MIXED_COST_AND_QUOTES' : 'DELAYED' },
        { key: 'PHYSICAL', label: 'Biens', valueMinor: physical, dataLabel: 'ESTIMATED' },
        { key: 'RECEIVABLES', label: 'Créances', valueMinor: liab.summary.receivablesOutstandingMinor, dataLabel: 'MANUAL' },
        { key: 'DEBTS', label: 'Dettes', valueMinor: -totalLiabilities, dataLabel: 'MANUAL' },
      ],
      futureCommitmentsMinor: liab.summary.commitmentsOutstandingMinor,
      unrealizedSecuritiesPnlMinor: securitiesMarket - securitiesCost,
      history, notes: ['Les enveloppes et coffres ne sont pas additionnés : ils répartissent les liquidités déjà comptées.', 'Les réévaluations de biens ne sont pas de l’argent encaissé.', 'Les engagements futurs sont présentés à part et non déduits.'],
    };
  }

  /** Historique mensuel (12 mois) depuis le registre (titres au coût, biens à la dernière valorisation enregistrée). */
  async netWorthHistory(ownerId: string) {
    const rows = await this.prisma.reader.$queryRaw<{ month: Date; kind: string; amount: bigint }[]>`
      WITH months AS (SELECT (date_trunc('month', now()) - (n || ' month')::interval + interval '1 month' - interval '1 day')::date AS month FROM generate_series(0, 11) n)
      SELECT m.month, a.kind::text AS kind, COALESCE(SUM(p."signedAmountMinor"), 0)::bigint AS amount
      FROM months m CROSS JOIN (SELECT DISTINCT kind FROM "LedgerAccount" WHERE kind IN ('ASSET','LIABILITY')) a
      LEFT JOIN "LedgerTransaction" t ON t."ownerId" = ${ownerId}::uuid AND t.book = 'REAL' AND t."economicDate" <= m.month
      LEFT JOIN "LedgerPosting" p ON p."transactionId" = t.id AND p."ledgerAccountId" IN (SELECT id FROM "LedgerAccount" WHERE kind = a.kind AND "ownerId" = ${ownerId}::uuid)
      GROUP BY m.month, a.kind ORDER BY m.month`;
    const byMonth = new Map<string, { assets: bigint; liabilities: bigint }>();
    for (const r of rows) {
      const k = toDateOnly(r.month);
      const e = byMonth.get(k) ?? { assets: 0n, liabilities: 0n };
      if (r.kind === 'ASSET') e.assets += BigInt(r.amount); else e.liabilities += -BigInt(r.amount);
      byMonth.set(k, e);
    }
    return [...byMonth.entries()].map(([month, v]) => ({ month, assetsMinor: v.assets, liabilitiesMinor: v.liabilities, netWorthMinor: v.assets - v.liabilities, dataLabel: 'LEDGER_AT_COST' }));
  }
}
