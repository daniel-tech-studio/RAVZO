import { clock, HOUR } from '../../src/common/clock';
import { MarketService } from '../../src/modules/wealth/market.service';
import { api, createTestApp, Ctx, setupOwner } from '../helpers';

describe('Cours BRVM via fournisseur (stub, aucun appel réseau)', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  let market: MarketService;
  let calls = 0;
  beforeAll(async () => {
    base = await createTestApp();
    market = base.app.get(MarketService);
    market.provider = {
      id: 'MANSA',
      capabilities: () => ({ listSecurities: true, quotes: true, history: false, corporateActions: false, licensed: true, note: 'stub', attribution: { text: 'Data by MansaAPI', url: 'https://mansaapi.com' }, freshness: 'DELAYED_30_MIN', cacheMaxHours: 24 }),
      fetchQuotes: async () => { calls++; return { updatedAt: clock.now(), quotes: [
        { symbol: 'SNTS', name: 'Sonatel', price: '25500', changePct: '1.25', volume: 1200n, asOf: new Date(clock.now().getTime() - 20 * 60_000) },
        { symbol: 'ORAC', name: 'Orange CI', price: '14800.5', changePct: null, volume: null, asOf: clock.now() },
      ] }; },
    };
  });
  afterAll(async () => { await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); calls = 0; });
  afterEach(() => clock.reset());

  it('import des cours : différés, datés, attribués ; alertes évaluées ; aucun « en direct »', async () => {
    await api(ctx).post('/market/securities', { symbol: 'SNTS', name: 'Sonatel' }).expect(201);
    const sec = (await api(ctx).get('/market/securities?q=SNTS')).body.data[0];
    await api(ctx).post('/investments/alerts', { securityId: sec.id, triggerType: 'ABOVE', threshold: '25000' }).expect(201);
    const r = (await api(ctx).post('/market/refresh').expect(201)).body.data;
    expect(r.refreshed).toBe(2);
    const list = (await api(ctx).get('/market/securities')).body.data;
    const snts = list.find((s: any) => s.symbol === 'SNTS');
    expect(snts.lastQuote.quality).toBe('DELAYED');
    expect(snts.lastQuote.sourceId).toBe('MANSA');
    expect(snts.changePercent).toBe(1.25);
    expect(snts.freshness.isLive).toBe(false);
    expect(snts.freshness.label).toMatch(/Différé · il y a 20 min/);
    const q = (await api(ctx).get(`/market/securities/${sec.id}/quotes`)).body.data;
    expect(q.attribution.text).toBe('Data by MansaAPI');
    expect((await api(ctx).get('/notifications')).body.data.items.some((n: any) => n.type === 'market.price_alert')).toBe(true);
    // Intervalle minimal : pas de seconde requête dans les 15 min
    expect((await api(ctx).post('/market/refresh').expect(201)).body.data.skipped).toBe('TOO_SOON');
    expect(calls).toBe(1);
  });

  it('réserve de quota respectée ; purge > 24 h ; saisies manuelles conservées', async () => {
    await api(ctx).post('/market/refresh').expect(201);
    const orac = (await api(ctx).get('/market/securities?q=ORAC')).body.data[0];
    await api(ctx).post('/market/manual-quotes', { securityId: orac.id, price: '15000', sessionDate: '2026-11-12' }).expect(201);
    for (let i = 0; i < 89; i++) await ctx.prisma.jobRun.create({ data: { job: 'market.provider_request', runKey: `fill-${i}` } });
    clock.advance(HOUR);
    expect((await market.refresh({ reason: 'TEST' })).skipped).toBe('QUOTA_RESERVE_REACHED');
    expect(calls).toBe(1);
    clock.advance(25 * HOUR);
    expect(await market.purgeExpiredProviderQuotes()).toBe(2);
    expect(await ctx.prisma.marketQuote.count({ where: { sourceId: 'MANUAL' } })).toBe(1);
  });
});
