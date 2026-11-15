import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../common/auth';
import { clock, DAY, economicToday, parseDateOnly } from '../../common/clock';
import { config } from '../../common/config';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { PrismaService, Tx } from '../../common/prisma.service';

export interface ProviderQuote { symbol: string; name: string; price: string; changePct: string | null; volume: bigint | null; asOf: Date }
export interface ProviderCaps { listSecurities: boolean; quotes: boolean; history: boolean; corporateActions: boolean; licensed: boolean; note: string; attribution: { text: string; url: string } | null; freshness: string; cacheMaxHours: number | null }

/** Port fournisseur BRVM remplaçable (backend.md §21.3). */
export interface MarketDataProviderPort {
  id: string;
  capabilities(): ProviderCaps;
  /** Tous les cours BRVM en UNE requête (quota). */
  fetchQuotes?(): Promise<{ quotes: ProviderQuote[]; updatedAt: Date | null }>;
}
export class NoLicensedMarketProvider implements MarketDataProviderPort {
  id = 'NONE';
  capabilities(): ProviderCaps { return { listSecurities: false, quotes: false, history: false, corporateActions: false, licensed: false, note: 'Aucune source BRVM configurée. Seules les saisies manuelles (non officielles) sont disponibles.', attribution: null, freshness: 'NONE', cacheMaxHours: null }; }
}

/**
 * MansaAPI (offre gratuite) — couverture BRVM vérifiée (code IVORYCOAST, XOF, 48 titres).
 * Licence : affichage dans sa propre application avec la mention « Data by MansaAPI » ; cache ≤ 24 h ; pas de redistribution.
 * Données agrégées, cible de fraîcheur 30 min en séance : jamais présentées comme cotation officielle ni « en direct ».
 */
export class MansaMarketProvider implements MarketDataProviderPort {
  id = 'MANSA';
  constructor(private base: string, private key: string) {}
  capabilities(): ProviderCaps {
    return { listSecurities: true, quotes: true, history: false, corporateActions: false, licensed: true, freshness: 'DELAYED_30_MIN',
      note: 'Cours BRVM agrégés par MansaAPI (différés d’environ 30 min en séance, non officiels). Vérifiez auprès de votre SGI avant toute décision.',
      attribution: { text: 'Data by MansaAPI', url: 'https://mansaapi.com' }, cacheMaxHours: 24 };
  }
  async fetchQuotes() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      const r = await fetch(`${this.base}/markets/exchanges/IVORYCOAST/stocks?limit=200`, { headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json' }, signal: ctl.signal });
      if (r.status === 429) throw new DomainError('RATE_LIMITED', 'Quota MansaAPI atteint');
      if (!r.ok) throw new DomainError('MARKET_DATA_STALE', `MansaAPI indisponible (${r.status})`);
      const body: any = await r.json();
      if (!body?.success || !Array.isArray(body.data)) throw new DomainError('MARKET_DATA_STALE', 'Réponse MansaAPI inattendue');
      if (body.meta?.currency && body.meta.currency !== 'XOF') throw new DomainError('MARKET_DATA_STALE', 'Devise inattendue');
      const num = /^-?\d+(\.\d+)?$/;
      const quotes: ProviderQuote[] = [];
      for (const s of body.data) {
        const price = String(s.price ?? '');
        if (!s.ticker || !num.test(price) || Number(price) <= 0) continue;
        const asOf = new Date(s.scraped_at ?? body.meta?.updated_at);
        if (isNaN(asOf.getTime())) continue;
        quotes.push({ symbol: String(s.ticker).toUpperCase().slice(0, 12), name: String(s.name ?? s.ticker).slice(0, 120), price, changePct: s.change_pct === undefined || s.change_pct === null ? null : String(s.change_pct), volume: Number.isSafeInteger(s.volume) ? BigInt(s.volume) : null, asOf });
      }
      return { quotes, updatedAt: body.meta?.updated_at ? new Date(body.meta.updated_at) : null };
    } finally { clearTimeout(t); }
  }
}
export function marketProviderFactory(): MarketDataProviderPort {
  return config.marketProvider === 'mansa' && config.mansa.key ? new MansaMarketProvider(config.mansa.base, config.mansa.key) : new NoLicensedMarketProvider();
}

export const STALE_AFTER_DAYS = 3;

@Injectable()
export class MarketService {
  provider: MarketDataProviderPort = marketProviderFactory();
  private log = new Logger('Market');
  constructor(private prisma: PrismaService, private events: EventsService) {}

  async requestsToday() {
    const start = new Date(Date.UTC(clock.now().getUTCFullYear(), clock.now().getUTCMonth(), clock.now().getUTCDate()));
    return this.prisma.jobRun.count({ where: { job: 'market.provider_request', startedAt: { gte: start } } });
  }
  async status() {
    const last = await this.prisma.jobRun.findFirst({ where: { job: 'market.provider_request' }, orderBy: { startedAt: 'desc' } });
    return { provider: this.provider.id, ...this.provider.capabilities(), liveDataAvailable: false, requestsToday: await this.requestsToday(), dailyQuota: config.mansa.dailyQuota, lastRefreshAt: last?.startedAt ?? null, lastRefreshResult: last?.result ?? null, serverTime: clock.now() };
  }

  /**
   * Rafraîchit TOUS les cours en une requête. Garde-fous : quota journalier (réserve de 10), intervalle minimal,
   * aucune donnée effacée en cas d'échec (le dernier cours daté reste affiché).
   */
  async refresh(opts: { minIntervalMs?: number; reason: string }) {
    if (!this.provider.fetchQuotes) return { skipped: 'NO_PROVIDER' };
    const used = await this.requestsToday();
    if (used >= Math.max(0, config.mansa.dailyQuota - 10)) return { skipped: 'QUOTA_RESERVE_REACHED', used };
    const last = await this.prisma.jobRun.findFirst({ where: { job: 'market.provider_request' }, orderBy: { startedAt: 'desc' } });
    if (last && opts.minIntervalMs && clock.now().getTime() - last.startedAt.getTime() < opts.minIntervalMs) return { skipped: 'TOO_SOON', lastRefreshAt: last.startedAt };
    const run = await this.prisma.jobRun.create({ data: { job: 'market.provider_request', runKey: `${clock.now().toISOString()}:${Math.random().toString(36).slice(2, 8)}` } });
    try {
      const { quotes } = await this.provider.fetchQuotes();
      let upserted = 0;
      const owners = await this.prisma.user.findMany({ select: { id: true } });
      for (const q of quotes) {
        const sec = await this.prisma.security.upsert({ where: { symbol: q.symbol }, create: { symbol: q.symbol, name: q.name, source: this.provider.id }, update: {} });
        const sessionDate = new Date(Date.UTC(q.asOf.getUTCFullYear(), q.asOf.getUTCMonth(), q.asOf.getUTCDate()));
        const data = { price: new Prisma.Decimal(q.price), asOf: q.asOf, changePct: q.changePct === null ? null : new Prisma.Decimal(q.changePct), volume: q.volume, quality: 'DELAYED', receivedAt: clock.now() };
        await this.prisma.tx(async (tx) => {
          const mq = await tx.marketQuote.upsert({ where: { securityId_sessionDate_sourceId: { securityId: sec.id, sessionDate, sourceId: this.provider.id } }, create: { securityId: sec.id, sessionDate, sourceId: this.provider.id, ...data }, update: data });
          for (const o of owners) await this.evaluateAlerts(tx, o.id, sec.id, mq.price, sec.symbol);
        });
        upserted++;
      }
      await this.prisma.jobRun.update({ where: { id: run.id }, data: { result: `OK ${upserted} (${opts.reason})` } });
      for (const o of owners) await this.prisma.tx((tx) => this.events.emit(tx, { ownerId: o.id, eventType: 'market.quote', aggregateType: 'Market', aggregateId: 'BRVM', outbox: false }));
      return { refreshed: upserted, used: used + 1 };
    } catch (e: any) {
      await this.prisma.jobRun.update({ where: { id: run.id }, data: { result: `ERROR ${String(e?.message).slice(0, 120)}` } });
      this.log.warn(JSON.stringify({ market: 'refresh_failed', error: String(e?.message).slice(0, 200) }));
      throw e instanceof DomainError ? e : new DomainError('MARKET_DATA_STALE', 'Source de cours indisponible : derniers cours datés conservés');
    }
  }

  /** Licence MansaAPI (offre gratuite) : conservation ≤ 24 h. Les saisies manuelles ne sont pas concernées. */
  async purgeExpiredProviderQuotes() {
    const max = this.provider.capabilities().cacheMaxHours;
    if (!max) return 0;
    const r = await this.prisma.marketQuote.deleteMany({ where: { sourceId: this.provider.id, receivedAt: { lt: new Date(clock.now().getTime() - max * 3600_000) } } });
    return r.count;
  }

  freshness(q: { sessionDate: Date; asOf: Date; quality: string } | null) {
    if (!q) return { state: 'NO_QUOTE', ageDays: null, label: 'Aucun cours' };
    const ageDays = Math.floor((economicToday().getTime() - q.sessionDate.getTime()) / DAY);
    const stale = ageDays > STALE_AFTER_DAYS;
    const ageMin = Math.floor((clock.now().getTime() - q.asOf.getTime()) / 60_000);
    const label = stale ? `Cours ancien (${ageDays} j)` : q.quality === 'MANUAL_UNVERIFIED' ? 'Saisie manuelle non officielle' : ageMin < 120 ? `Différé · il y a ${ageMin} min` : `Différé · ${ageDays === 0 ? 'aujourd’hui' : `il y a ${ageDays} j`}`;
    return { state: stale ? 'STALE' : q.quality === 'MANUAL_UNVERIFIED' ? 'MANUAL' : 'DELAYED', ageDays, ageMinutes: ageMin, label, isLive: false };
  }

  async latestQuote(db: Tx | PrismaService, securityId: string) {
    return db.marketQuote.findFirst({ where: { securityId }, orderBy: [{ sessionDate: 'desc' }, { receivedAt: 'desc' }] });
  }

  async securities(auth: AuthContext, q?: string) {
    const list = await this.prisma.security.findMany({ where: q ? { OR: [{ symbol: { contains: q.toUpperCase() } }, { name: { contains: q, mode: 'insensitive' } }] } : {}, orderBy: { symbol: 'asc' }, take: 200 });
    return Promise.all(list.map(async (s) => {
      const quotes = await this.prisma.marketQuote.findMany({ where: { securityId: s.id }, orderBy: { sessionDate: 'desc' }, take: 2 });
      const last = quotes[0] ?? null;
      const change = last?.changePct ? last.changePct.toNumber() : quotes.length === 2 ? Number(((last!.price.toNumber() - quotes[1].price.toNumber()) / quotes[1].price.toNumber()) * 100) : null;
      return { ...s, favoriteOwnerIds: undefined, isFavorite: s.favoriteOwnerIds.includes(auth.ownerId), lastQuote: last, changePercent: change, freshness: this.freshness(last) };
    }));
  }

  async createSecurity(dto: { symbol: string; name: string; isin?: string; sector?: string }) {
    return this.prisma.security.create({ data: { symbol: dto.symbol.toUpperCase(), name: dto.name, isin: dto.isin, sector: dto.sector, source: 'OWNER_ENTERED' } });
  }

  async toggleFavorite(auth: AuthContext, id: string) {
    const s = await this.prisma.security.findUnique({ where: { id } });
    if (!s) throw notFound('Titre');
    const fav = s.favoriteOwnerIds.includes(auth.ownerId);
    return this.prisma.security.update({ where: { id }, data: { favoriteOwnerIds: fav ? s.favoriteOwnerIds.filter((x) => x !== auth.ownerId) : [...s.favoriteOwnerIds, auth.ownerId] } });
  }

  async quotes(id: string, limit = 120) {
    const s = await this.prisma.security.findUnique({ where: { id } });
    if (!s) throw notFound('Titre');
    const quotes = await this.prisma.marketQuote.findMany({ where: { securityId: id }, orderBy: { sessionDate: 'desc' }, take: limit });
    return { security: s, quotes, freshness: this.freshness(quotes[0] ?? null), provider: this.provider.capabilities(), attribution: quotes.some((q) => q.sourceId === this.provider.id) ? this.provider.capabilities().attribution : null };
  }

  /** Cours de secours saisi manuellement : MANUAL_UNVERIFIED, jamais présenté comme officiel. */
  async manualQuote(auth: AuthContext, dto: { securityId: string; price: string; sessionDate: string }) {
    const s = await this.prisma.security.findUnique({ where: { id: dto.securityId } });
    if (!s) throw notFound('Titre');
    const sessionDate = parseDateOnly(dto.sessionDate);
    if (sessionDate > economicToday()) throw new DomainError('VALIDATION_FAILED', 'Date de séance future');
    return this.prisma.tx(async (tx) => {
      const q = await tx.marketQuote.upsert({
        where: { securityId_sessionDate_sourceId: { securityId: s.id, sessionDate, sourceId: 'MANUAL' } },
        create: { securityId: s.id, price: new Prisma.Decimal(dto.price), sessionDate, asOf: clock.now(), sourceId: 'MANUAL', quality: 'MANUAL_UNVERIFIED' },
        update: { price: new Prisma.Decimal(dto.price), asOf: clock.now() },
      });
      await this.evaluateAlerts(tx, auth.ownerId, s.id, q.price, s.symbol);
      await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'market.quote', aggregateType: 'Security', aggregateId: s.id, outbox: false });
      return { ...q, freshness: this.freshness(q) };
    });
  }

  async evaluateAlerts(tx: Tx, ownerId: string, securityId: string, price: Prisma.Decimal, symbol: string) {
    const alerts = await tx.priceAlert.findMany({ where: { ownerId, securityId, enabled: true } });
    for (const a of alerts) {
      const hit = a.triggerType === 'ABOVE' ? price.gte(a.threshold) : price.lte(a.threshold);
      if (!hit) continue;
      if (a.lastTriggeredAt && clock.now().getTime() - a.lastTriggeredAt.getTime() < DAY) continue;
      await tx.priceAlert.update({ where: { id: a.id }, data: { lastTriggeredAt: clock.now() } });
      await this.events.notify(tx, { ownerId, sourceEventId: `price-alert:${a.id}:${clock.now().toISOString().slice(0, 10)}`, type: 'market.price_alert', category: 'MARKET', priority: 'NORMAL', title: `${symbol} ${a.triggerType === 'ABOVE' ? '≥' : '≤'} ${a.threshold.toString()} FCFA`, body: 'Alerte déclenchée sur un cours non officiel ou différé. Aucun ordre n’est passé.', link: `/wealth/market/${securityId}` });
    }
  }
}
