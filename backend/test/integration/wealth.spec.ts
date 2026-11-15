import { clock } from '../../src/common/clock';
import { api, createAccount, createTestApp, Ctx, idemKey, setupOwner } from '../helpers';

describe('Dettes, patrimoine, BRVM', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { base = await createTestApp(); });
  afterAll(async () => { await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); });
  afterEach(() => clock.reset());

  const incomeSum = async () => (await ctx.prisma.ledgerPosting.aggregate({ where: { ledgerAccount: { kind: 'INCOME' } }, _sum: { signedAmountMinor: true } }))._sum.signedAmountMinor ?? 0n;

  it('T16 — prêt contracté : cash et dette montent, aucun revenu ; remboursement sépare intérêts', async () => {
    const acc = await createAccount(ctx, 'Banque', '0');
    const l = (await api(ctx).post('/liabilities', { kind: 'DEBT', counterpartyName: 'Tonton', label: 'Prêt moto', principalMinor: '300000', startDate: '2026-11-01', cashAccountId: acc.id, schedule: { count: 3, rule: 'MONTHLY:5', firstDueDate: '2026-12-05' } }).expect(201)).body.data;
    expect(l.outstandingMinor).toBe('300000');
    expect(l.installments).toHaveLength(3);
    expect(await incomeSum()).toBe(0n);
    const ov = (await api(ctx).get('/balances/overview')).body.data;
    expect(ov.trackedBalanceMinor).toBe('300000');
    const w = (await api(ctx).get('/wealth/overview')).body.data;
    expect(w.netWorthMinor).toBe('0');
    const r = (await api(ctx).post(`/liabilities/${l.id}/repayments`, { cashAccountId: acc.id, principalMinor: '100000', interestMinor: '5000' }).expect(201)).body.data;
    expect(r.liability.outstandingMinor).toBe('200000');
    expect(r.liability.installments[0].state).toBe('PAID');
    const w2 = (await api(ctx).get('/wealth/overview')).body.data;
    expect(w2.netWorthMinor).toBe('-5000'); // seuls les intérêts sont une charge
  });

  it('T15 — dividende annoncé : aucun crédit d’espèces ; encaissement unique après rapprochement', async () => {
    const acc = await createAccount(ctx, 'Banque', '1000000');
    const b = (await api(ctx).post('/investments/brokers', { name: 'SGI Bénin', accountAlias: 'Compte titres' }).expect(201)).body.data;
    await api(ctx).post(`/investments/brokerage-accounts/${b.brokerageAccount.id}/cash-movements`, { type: 'DEPOSIT', amountMinor: '500000', counterpartAccountId: acc.id }).expect(201);
    const sec = (await api(ctx).post('/market/securities', { symbol: 'SNTS', name: 'Sonatel' }).expect(201)).body.data;
    const t = (await api(ctx).post('/investments/trades', { brokerageAccountId: b.brokerageAccount.id, securityId: sec.id, side: 'BUY', quantity: '20', unitPrice: '20000', feesMinor: '4000', executedAt: '2026-11-10T10:00:00Z', externalRef: 'AVIS-1' }).expect(201)).body.data;
    expect(t.grossMinor).toBe('400000');
    const dup = (await api(ctx).post('/investments/trades', { brokerageAccountId: b.brokerageAccount.id, securityId: sec.id, side: 'BUY', quantity: '20', unitPrice: '20000', feesMinor: '4000', executedAt: '2026-11-10T10:00:00Z', externalRef: 'AVIS-1' }).expect(201)).body.data;
    expect(dup.duplicate).toBe(true);
    const cashBefore = (await api(ctx).get('/investments/brokers')).body.data[0].accounts[0].cashBalanceMinor;
    expect(cashBefore).toBe('96000');
    await api(ctx).post('/investments/dividends/announcements', { securityId: sec.id, declaredPerShare: '1500', source: 'Avis BRVM' }).expect(201);
    const divs = (await api(ctx).get('/investments/dividends')).body.data;
    expect(divs[0].expectedMinor).toBe('30000');
    expect(divs[0].cashCredited).toBe(false);
    expect((await api(ctx).get('/investments/brokers')).body.data[0].accounts[0].cashBalanceMinor).toBe('96000');
    expect(await incomeSum()).toBe(-1000000n + 1000000n - 0n - 1000000n + 1000000n); // aucune écriture de revenu
    await api(ctx).post(`/investments/dividends/${divs[0].id}/match-receipt`, { receivedMinor: '27000', receivedAt: '2026-11-12' }).expect(201);
    await api(ctx).post(`/investments/dividends/${divs[0].id}/match-receipt`, { receivedMinor: '27000', receivedAt: '2026-11-12' }).expect(409);
    expect((await api(ctx).get('/investments/brokers')).body.data[0].accounts[0].cashBalanceMinor).toBe('123000');
  });

  it('vente : P&L réalisé distinct des frais ; coût de revient indicatif ; cours manuel signalé', async () => {
    await createAccount(ctx, 'Banque', '0');
    const b = (await api(ctx).post('/investments/brokers', { name: 'SGI', accountAlias: 'CT', openingCashMinor: '1000000' }).expect(201)).body.data;
    const sec = (await api(ctx).post('/market/securities', { symbol: 'ORAC', name: 'Orange CI' }).expect(201)).body.data;
    const ba = b.brokerageAccount.id;
    await api(ctx).post('/investments/trades', { brokerageAccountId: ba, securityId: sec.id, side: 'BUY', quantity: '10', unitPrice: '10000', feesMinor: '1000', executedAt: '2026-11-01T10:00:00Z' }).expect(201);
    await api(ctx).post('/investments/trades', { brokerageAccountId: ba, securityId: sec.id, side: 'BUY', quantity: '10', unitPrice: '12000', feesMinor: '1000', executedAt: '2026-11-02T10:00:00Z' }).expect(201);
    const sell = (await api(ctx).post('/investments/trades', { brokerageAccountId: ba, securityId: sec.id, side: 'SELL', quantity: '15', unitPrice: '13000', feesMinor: '1500', executedAt: '2026-11-05T10:00:00Z' }).expect(201)).body.data;
    // FIFO : 10×(101000/10) + 5×(121000/10) = 101000 + 60500 = 161500 ; produit net = 195000 − 1500 = 193500
    expect(sell.realizedPnlMinor).toBe('32000');
    expect(sell.costMethod).toBe('FALLBACK_FIFO');
    await api(ctx).post('/investments/trades', { brokerageAccountId: ba, securityId: sec.id, side: 'SELL', quantity: '6', unitPrice: '13000', executedAt: '2026-11-05T11:00:00Z' }).expect(422);
    let h = (await api(ctx).get('/investments/holdings')).body.data[0];
    expect(h.quantity).toBe('5');
    expect(h.valuationBasis).toBe('COST');
    expect(h.costBasisStatus).toBe('INDICATIVE');
    await api(ctx).post('/market/manual-quotes', { securityId: sec.id, price: '14000', sessionDate: '2026-11-13' }).expect(201);
    h = (await api(ctx).get('/investments/holdings')).body.data[0];
    expect(h.marketValueMinor).toBe('70000');
    expect(h.freshness.state).toBe('MANUAL');
    expect(h.freshness.isLive).toBe(false);
  });

  it('réévaluation d’un bien : patrimoine ajusté, aucun revenu ni cash', async () => {
    const acc = await createAccount(ctx, 'Banque', '2000000');
    const a = (await api(ctx).post('/assets', { name: 'Moto', kind: 'VEHICLE', acquisitionCostMinor: '800000', paidFromAccountId: acc.id, acquiredAt: '2026-10-01' }).expect(201)).body.data;
    let w = (await api(ctx).get('/wealth/overview')).body.data;
    expect(w.netWorthMinor).toBe('2000000'); // échange cash → bien
    await api(ctx).post(`/assets/${a.id}/valuations`, { valueMinor: '650000', valuationDate: '2026-11-10', source: 'OWNER_ESTIMATE' }).expect(201);
    w = (await api(ctx).get('/wealth/overview')).body.data;
    expect(w.netWorthMinor).toBe('1850000');
    expect((await api(ctx).get('/balances/overview')).body.data.trackedBalanceMinor).toBe('1200000');
    expect(await incomeSum()).toBe(0n);
  });
});
