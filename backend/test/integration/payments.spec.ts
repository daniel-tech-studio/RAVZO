import request from 'supertest';
import { clock, HOUR } from '../../src/common/clock';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { FakeProvider } from '../../src/modules/payments/provider.port';
import { advance, api, approve, createAccount, createTestApp, Ctx, EMAIL, idemKey, PASSWORD, setupOwner, TestDevice } from '../helpers';

describe('Paiements, plafonds, dérogations, rapprochement', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  let fake: FakeProvider;
  beforeAll(async () => { base = await createTestApp(); fake = base.app.get(PaymentsService).provider as FakeProvider; });
  afterAll(async () => { await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); fake.scenario = 'ACCEPT'; fake.calls = []; });
  afterEach(() => clock.reset());

  async function setup(opening = '500000') {
    const sb = (await api(ctx).post('/payments/sandbox/provision', { name: 'MoMo', openingMinor: opening }).expect(201)).body.data;
    const ben = (await api(ctx).post('/beneficiaries', { displayName: 'Awa', phoneE164: '+2290197000000', operator: 'MTN_BJ' }).expect(201)).body.data;
    const cur = (await api(ctx).get('/wallets')).body.data.find((w: any) => w.kind === 'CURRENT');
    return { sb, ben, cur };
  }
  async function intent(s: any, amount: string, mode = 'NET_RECEIVED', key = idemKey()) {
    return (await api(ctx).post('/payments/payouts/intents', { sourceWalletId: s.cur.id, beneficiaryId: s.ben.id, amountMode: mode, amountMinor: amount, currency: 'XOF' }, key).expect(201)).body.data;
  }
  async function authorize(id: string, c: Ctx = ctx, device = ctx.device) {
    const ch = (await request(c.app.getHttpServer()).post(`/api/v1/payments/intents/${id}/challenge`).set('Authorization', `Bearer ${c.token}`).expect(201)).body.data;
    return request(c.app.getHttpServer()).post(`/api/v1/payments/intents/${id}/authorize`).set('Authorization', `Bearer ${c.token}`).send({ approval: device.signChallenge(ch), acknowledgeUnverifiedBeneficiary: true });
  }
  function webhook(body: any) {
    const raw = JSON.stringify(body);
    return request(ctx.app.getHttpServer()).post('/api/v1/integrations/psp/webhooks/fake').set('Content-Type', 'application/json').set('X-Ravzo-Signature', FakeProvider.sign(raw)).send(raw);
  }

  it('capacités : prestataire simulé clairement étiqueté, pas d’argent réel', async () => {
    const c = (await api(ctx).get('/payments/capabilities').expect(200)).body.data;
    expect(c.executionMode).toBe('SANDBOX_FAKE');
    expect(c.realMoney).toBe(false);
    expect(c.verifyBeneficiary).toBe(false);
  });

  it('T25 — compte suivi déclaré : jamais source de paiement', async () => {
    const s = await setup();
    const acc = await createAccount(ctx);
    const r = await api(ctx).post('/payments/payouts/intents', { sourceWalletId: s.cur.id, beneficiaryId: s.ben.id, amountMode: 'NET_RECEIVED', amountMinor: '1000', currency: 'XOF', sourceAccountId: acc.id }, idemKey()).expect(422);
    expect(r.body.error.code).toBe('PSP_NOT_AUTHORIZED');
  });

  it('T03 — 30 000 + frais 450 : refus plafond par opération', async () => {
    const s = await setup();
    const i = await intent(s, '30000');
    expect(i.feeQuoteMinor).toBe('450');
    expect(i.totalDebitMinor).toBe('30450');
    expect(i.limits.wouldExceedPerOperation).toBe(true);
    const r = await authorize(i.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('LIMIT_PER_OPERATION_EXCEEDED');
    expect(fake.calls).toHaveLength(0);
  });

  it('bénéficiaire non vérifié : confirmation renforcée explicite exigée', async () => {
    const s = await setup();
    const i = await intent(s, '1000');
    const ch = (await api(ctx).post(`/payments/intents/${i.id}/challenge`).expect(201)).body.data;
    const r = await api(ctx).post(`/payments/intents/${i.id}/authorize`, { approval: ctx.device.signChallenge(ch) }).expect(422);
    expect(r.body.error.code).toBe('BENEFICIARY_UNVERIFIED_CONFIRMATION_REQUIRED');
  });

  it('T02 — deux appareils concurrents dépassant 60 000/24 h : jamais de dépassement', async () => {
    const s = await setup();
    const d2 = new TestDevice('iPhone');
    const l2 = (await request(ctx.app.getHttpServer()).post('/api/v1/identity/login').send({ email: EMAIL, password: PASSWORD, device: d2.info() }).expect(200)).body.data;
    const enr = (await request(ctx.app.getHttpServer()).post('/api/v1/devices/enrollment-requests').set('Authorization', `Bearer ${l2.accessToken}`).expect(201)).body.data;
    await api(ctx).post(`/devices/enrollment-requests/${enr.id}/approve`, { code: enr.code, approval: await approve(ctx, 'device.approve', { requestId: enr.id }) }).expect(200);
    const c2 = { ...ctx, token: l2.accessToken, device: d2 };
    const i1 = await intent(s, '25000'); const i2 = await intent(s, '25000'); const i3 = await intent(s, '10000');
    // 25 375 + 25 375 + 10 150 = 60 900 > 60 000 : au plus deux passent
    const res = await Promise.all([authorize(i1.id), authorize(i2.id, c2, d2), authorize(i3.id)]);
    const ok = res.filter((r) => r.status === 202);
    expect(ok.length).toBe(2);
    expect(res.some((r) => r.body.error?.code === 'LIMIT_ROLLING_WINDOW_EXCEEDED')).toBe(true);
    const lim = (await api(ctx).get('/security/limits')).body.data;
    expect(BigInt(lim.usedInWindowMinor)).toBeLessThanOrEqual(60000n);
  });

  it('T07 — webhook succès ×3 : un seul posting terminal ; T04 remboursement compte encore 24 h', async () => {
    const s = await setup();
    const i = await intent(s, '20000');
    expect((await authorize(i.id)).status).toBe(202);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202); // seconde soumission : aucun nouvel appel
    expect(fake.calls.filter((c) => c.op === 'payout')).toHaveLength(1);
    const ev = { eventId: 'evt-1', merchantRef: `RVZ-${i.id}`, status: 'SUCCEEDED', amountMinor: '20000', currency: 'XOF' };
    for (let k = 0; k < 3; k++) await webhook(ev).expect(200);
    const p = (await api(ctx).get(`/payments/intents/${i.id}`)).body.data;
    expect(p.state).toBe('SUCCEEDED');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { businessType: 'PAYOUT', businessId: i.id } })).toBe(1);
    const bal = (await api(ctx).get(`/accounts/${s.sb.account.id}`)).body.data.balanceMinor;
    expect(bal).toBe(String(500000 - 20300));
    await webhook({ eventId: 'evt-2', merchantRef: `RVZ-${i.id}`, status: 'REFUNDED', amountMinor: '20000', currency: 'XOF' }).expect(200);
    expect((await api(ctx).get(`/payments/intents/${i.id}`)).body.data.state).toBe('REFUNDED_AFTER_SUCCESS');
    expect((await api(ctx).get('/security/limits')).body.data.usedInWindowMinor).toBe('20300');
    // Webhook falsifié rejeté
    await request(ctx.app.getHttpServer()).post('/api/v1/integrations/psp/webhooks/fake').set('X-Ravzo-Signature', 'bad').set('Content-Type', 'application/json').send(JSON.stringify(ev)).expect(403);
  });

  it('T05 — annulation avant exécution : hold libéré une seule fois', async () => {
    const s = await setup();
    const i = await intent(s, '20000');
    await authorize(i.id);
    expect((await api(ctx).get('/security/limits')).body.data.usedInWindowMinor).toBe('20300');
    await api(ctx).post(`/payments/intents/${i.id}/cancel`, { approval: await approve(ctx, 'payment.cancel', { intentId: i.id }) }).expect(201);
    expect((await api(ctx).get('/security/limits')).body.data.usedInWindowMinor).toBe('0');
    await api(ctx).post(`/payments/intents/${i.id}/cancel`, { approval: await approve(ctx, 'payment.cancel', { intentId: i.id }) }).expect(409);
    expect(await ctx.prisma.limitHold.count({ where: { state: 'RELEASED' } })).toBe(1);
  });

  it('T06 — timeout après exécution : UNKNOWN, hold conservé, aucun nouvel essai ; statut rapproché ensuite', async () => {
    const s = await setup();
    const i = await intent(s, '10000');
    await authorize(i.id);
    fake.scenario = 'TIMEOUT_EXECUTED';
    const r = (await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202)).body.data;
    expect(r.state).toBe('UNKNOWN');
    expect(r.holds.limit).toBe('ACTIVE');
    await advance(ctx, 2 * HOUR);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    expect(fake.calls.filter((c) => c.op === 'payout')).toHaveLength(1);
    expect((await api(ctx).get('/security/limits')).body.data.usedInWindowMinor).toBe('10150');
    const after = (await api(ctx).post(`/payments/intents/${i.id}/recheck`).expect(202)).body.data;
    expect(after.state).toBe('SUCCEEDED');
    expect(after.holds.limit).toBe('SETTLED');
  });

  it('statut « introuvable » ≠ échec ; succès contredisant un échec terminal → anomalie, jamais ignoré', async () => {
    const s = await setup();
    const i = await intent(s, '10000');
    await authorize(i.id);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    fake.ledger.delete(`RVZ-${i.id}`); // autre instance / propagation lente
    const r = (await api(ctx).post(`/payments/intents/${i.id}/recheck`).expect(202)).body.data;
    expect(r.state).toBe('PROCESSING');
    expect(r.holds.limit).toBe('ACTIVE');
    // Échec déclaré par le prestataire puis succès contradictoire
    await webhook({ eventId: 'evt-f', merchantRef: `RVZ-${i.id}`, status: 'FAILED', amountMinor: '10000', currency: 'XOF' }).expect(200);
    expect((await api(ctx).get(`/payments/intents/${i.id}`)).body.data.state).toBe('FAILED');
    await webhook({ eventId: 'evt-s', merchantRef: `RVZ-${i.id}`, status: 'SUCCEEDED', amountMinor: '10000', currency: 'XOF' }).expect(200);
    const cases = (await api(ctx).get('/reconciliation/cases')).body.data;
    expect(cases[0].reason).toMatch(/CONTRADICTS_TERMINAL_FAILED/);
    expect((await api(ctx).get('/balances/overview')).body.data.transferRestrictions.blockedGroups).toHaveLength(1);
    // Résolution : écriture compensatoire du débit réellement exécuté, balance débloquée
    const before = BigInt((await api(ctx).get(`/accounts/${s.sb.account.id}`)).body.data.balanceMinor);
    const p = { caseId: cases[0].id, resolution: 'ADJUST', explanation: 'Le prestataire a bien exécuté le paiement' };
    await api(ctx).post(`/reconciliation/cases/${cases[0].id}/resolve`, { resolution: p.resolution, explanation: p.explanation, approval: await approve(ctx, 'reconciliation.resolve', p) }).expect(201);
    const after = BigInt((await api(ctx).get(`/accounts/${s.sb.account.id}`)).body.data.balanceMinor);
    expect(before - after).toBe(10150n);
    expect((await api(ctx).get('/security/limits')).body.data.usedInWindowMinor).toBe('10150'); // l'exécution réelle compte
    expect((await api(ctx).get('/balances/overview')).body.data.transferRestrictions.blockedGroups).toHaveLength(0);
  });

  it('T08 — webhook signé mais montant incohérent : aucun posting, anomalie et blocage ciblé', async () => {
    const s = await setup();
    const i = await intent(s, '10000');
    await authorize(i.id);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    await webhook({ eventId: 'evt-x', merchantRef: `RVZ-${i.id}`, status: 'SUCCEEDED', amountMinor: '99999', currency: 'XOF' }).expect(200);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { businessType: 'PAYOUT' } })).toBe(0);
    const cases = (await api(ctx).get('/reconciliation/cases')).body.data;
    expect(cases[0].reason).toMatch(/AMOUNT_MISMATCH/);
    expect((await api(ctx).get('/balances/overview')).body.data.transferRestrictions.blockedGroups).toHaveLength(1);
  });

  it('T09 — dérogation : refus avant 72 h, usage unique, expirée après 24 h', async () => {
    const s = await setup();
    const i = await intent(s, '45000');
    const params = { paymentIntentId: i.id, maxDebitMinor: '46000', reason: 'Achat ordinateur' };
    const ex = (await api(ctx).post('/security/exceptions', { ...params, approval: await approve(ctx, 'exception.request', params) }).expect(202)).body.data;
    expect(ex.effectiveState).toBe('WAITING');
    let r = await authorize(i.id);
    expect(r.body.error.code).toBe('EXCEPTION_NOT_ACTIVE');
    await advance(ctx, 72 * HOUR + 60_000);
    await api(ctx).post(`/payments/intents/${i.id}/requote`).expect(201);
    r = await authorize(i.id);
    expect(r.status).toBe(202);
    expect((await api(ctx).get(`/security/exceptions/${ex.id}`)).body.data.state).toBe('CONSUMED');
    // Une autre intention ne peut pas réutiliser la dérogation (non transférable)
    const i2 = await intent(s, '45000');
    const r2 = await authorize(i2.id);
    expect(r2.body.error.code).toBe('LIMIT_PER_OPERATION_EXCEEDED');
    // Expiration
    const i3 = await intent(s, '40000');
    const p3 = { paymentIntentId: i3.id, maxDebitMinor: '41000', reason: 'Autre achat' };
    await api(ctx).post('/security/exceptions', { ...p3, approval: await approve(ctx, 'exception.request', p3) }).expect(202);
    await advance(ctx, 97 * HOUR);
    await api(ctx).post(`/payments/intents/${i3.id}/requote`).expect(201);
    expect((await authorize(i3.id)).body.error.code).toBe('EXCEPTION_EXPIRED');
  });

  it('T10 — hausse ordinaire 48 h, hausse au-delà des références 72 h, baisse immédiate', async () => {
    await setup();
    const change = async (p: string, r: string) => api(ctx).post('/security/limit-changes', { perOperationMinor: p, rolling24hMinor: r, approval: await approve(ctx, 'limits.change', { perOperationMinor: p, rolling24hMinor: r }) });
    expect((await change('20000', '40000')).status).toBe(201);
    expect((await api(ctx).get('/security/limits')).body.data.perOperationMinor).toBe('20000'); // baisse immédiate
    const within = (await change('30000', '60000')).body.data;
    expect(within.kind).toBe('INCREASE_WITHIN_REFERENCE');
    expect(new Date(within.effectiveAt).getTime() - new Date(within.requestedAt).getTime()).toBe(48 * HOUR);
    expect((await change('35000', '70000')).body.error.code).toBe('LIMIT_CHANGE_PENDING');
    await advance(ctx, 48 * HOUR + 1000);
    await base.app.get(require('../../src/modules/payments/limits.service').LimitsService).applyDue();
    expect((await api(ctx).get('/security/limits')).body.data.perOperationMinor).toBe('30000');
    const beyond = (await change('50000', '100000')).body.data;
    expect(beyond.kind).toBe('INCREASE_BEYOND_REFERENCE');
    expect(new Date(beyond.effectiveAt).getTime() - new Date(beyond.requestedAt).getTime()).toBe(72 * HOUR);
  });

  it('T13 — balance PSP partagée bloquée ; balance indépendante active ; T12 webhook traité pendant suspension', async () => {
    const s = await setup();
    const other = (await api(ctx).post('/payments/sandbox/provision', { name: 'Autre', openingMinor: '100000' }).expect(201)).body.data;
    const goal = (await api(ctx).post('/savings/goals', { name: 'Coffre', targetMinor: '100000', deadline: '2027-12-31', plan: { triggerType: 'CALENDAR', amountRule: 'FIXED:10000', scheduleRule: 'MONTHLY:1' } }).expect(201)).body.data;
    await api(ctx).patch(`/wallets/${goal.walletId}/real-balance-group`, { realBalanceGroupId: s.sb.group.id }).expect(200);
    const i = await intent(s, '10000');
    await authorize(i.id);
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    fake.balances.set(s.sb.group.providerBalanceRef, 400000n); // écart inexpliqué
    fake.balances.set(other.group.providerBalanceRef, 100000n);
    const run = (await api(ctx).post('/reconciliation/run').expect(201)).body.data;
    expect(run.find((r: any) => r.groupId === s.sb.group.id).matched).toBe(false);
    expect(run.find((r: any) => r.groupId === other.group.id).matched).toBe(true);
    const i2 = await intent(s, '1000');
    expect((await authorize(i2.id)).body.error.code).toBe('BALANCE_RECONCILIATION_BLOCK');
    // Coffre adossé à la balance bloquée : sortie bloquée aussi
    const i3 = (await api(ctx).post('/payments/payouts/intents', { sourceWalletId: s.cur.id, beneficiaryId: s.ben.id, amountMode: 'NET_RECEIVED', amountMinor: '1000', currency: 'XOF', sourceAccountId: other.account.id }, idemKey()).expect(201)).body.data;
    expect((await authorize(i3.id)).status).toBe(202); // balance indépendante active
    // Événement entrant d'un paiement déjà engagé : comptabilisé malgré le blocage (T12)
    await webhook({ eventId: 'evt-ok', merchantRef: `RVZ-${i.id}`, status: 'SUCCEEDED', amountMinor: '10000', currency: 'XOF' }).expect(200);
    expect((await api(ctx).get(`/payments/intents/${i.id}`)).body.data.state).toBe('SUCCEEDED');
  });

  it('T26 — prestataire absent : brouillon non exécutable, aucun appel', async () => {
    const svc = base.app.get(PaymentsService);
    const { NoProvider } = require('../../src/modules/payments/provider.port');
    const orig = svc.provider;
    (svc as any).provider = new NoProvider();
    try {
      const sb = await (async () => { (svc as any).provider = orig; const x = await setup(); (svc as any).provider = new NoProvider(); return x; })();
      const ben2 = sb.ben;
      const r = (await api(ctx).post('/payments/payouts/intents', { sourceWalletId: sb.cur.id, beneficiaryId: ben2.id, amountMode: 'NET_RECEIVED', amountMinor: '1000', currency: 'XOF' }, idemKey()).expect(201)).body.data;
      expect(r.executable).toBe(false);
      expect(r.nonExecutableReason).toBe('PSP_NOT_CONFIGURED');
      const a = await authorize(r.id);
      expect(a.body.error.code).toBe('PSP_NOT_AUTHORIZED');
      expect((await api(ctx).get('/payments/capabilities')).body.data.executable).toBe(false);
    } finally { (svc as any).provider = orig; }
  });

  it('T11 bis — suspension de récupération : aucun paiement', async () => {
    const s = await setup();
    const i = await intent(s, '1000');
    const st = (await request(ctx.app.getHttpServer()).post('/api/v1/recovery/start').send({ email: EMAIL })).body.data;
    const d = new TestDevice('rec');
    const rec = (await request(ctx.app.getHttpServer()).post('/api/v1/recovery/verify').send({ recoveryId: st.recoveryId, challenge: st.challenge, recoveryCode: ctx.recoveryCodes[1], device: d.info() }).expect(200)).body.data;
    const c2 = { ...ctx, token: rec.accessToken, device: d };
    const r = await request(ctx.app.getHttpServer()).post(`/api/v1/payments/intents/${i.id}/challenge`).set('Authorization', `Bearer ${c2.token}`);
    expect(r.body.error.code).toBe('RECOVERY_READ_ONLY');
  });
});
