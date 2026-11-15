import { addMs, clock, HOUR } from '../../src/common/clock';
import { advance, api, approve, createAccount, createTestApp, Ctx, EMAIL, idemKey, PASSWORD, setupOwner, TestDevice } from '../helpers';
import request from 'supertest';

describe('Identité, registre, affectations, épargne', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { base = await createTestApp(); });
  afterAll(async () => { await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); });
  afterEach(() => clock.reset());

  it('enveloppe standard et erreurs normalisées', async () => {
    const me = await api(ctx).get('/identity/me').expect(200);
    expect(me.body.data.email).toBe(EMAIL);
    expect(me.body.meta.correlationId).toBeDefined();
    const bad = await api(ctx).post('/accounts', { name: 'x', type: 'EXTERNAL_TRACKED', hacker: 1 }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    await request(ctx.app.getHttpServer()).get('/api/v1/accounts').expect(401);
  });

  it('solde d’ouverture → écriture équilibrée et projection cohérente', async () => {
    const acc = await createAccount(ctx);
    expect(acc.balanceMinor).toBe('200000');
    const ov = await api(ctx).get('/balances/overview').expect(200);
    expect(ov.body.data.trackedBalanceMinor).toBe('200000');
    expect(ov.body.data.confirmedBalanceMinor).toBe('0'); // suivi manuel ≠ confirmé
    const integ = await api(ctx).get('/ledger/integrity').expect(200);
    expect(integ.body.data.healthy).toBe(true);
  });

  it('le registre est append-only et refuse une écriture déséquilibrée (SQL)', async () => {
    await createAccount(ctx);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE "LedgerPosting" SET "signedAmountMinor" = 1`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM "LedgerTransaction"`)).rejects.toThrow(/APPEND_ONLY/);
    const acc = await ctx.prisma.ledgerAccount.findFirstOrThrow({ where: { kind: 'ASSET' } });
    await expect(ctx.prisma.$transaction(async (tx) => {
      const t = await tx.ledgerTransaction.create({ data: { ownerId: ctx.ownerId, businessType: 'HACK', businessId: 'x', economicDate: new Date() } });
      await tx.ledgerPosting.create({ data: { transactionId: t.id, ledgerAccountId: acc.id, signedAmountMinor: 100n, currency: 'XOF', postingOrdinal: 1 } });
    })).rejects.toThrow(/LEDGER_UNBALANCED/);
  });

  it('T01 — réaffecter 20 000 F courant → coffre : patrimoine inchangé, affectation unique', async () => {
    await createAccount(ctx);
    const goal = (await api(ctx).post('/savings/goals', { name: 'Voyage', targetMinor: '100000', deadline: '2027-06-30', plan: { triggerType: 'CALENDAR', amountRule: 'FIXED:20000', scheduleRule: 'MONTHLY:5' } }).expect(201)).body.data;
    expect(goal.protection.mode).toBe('ADVISORY');
    const prep = (await api(ctx).post(`/savings/goals/${goal.id}/contributions/prepare`).expect(201)).body.data;
    expect(prep.suggestedMinor).toBe('20000'); // prochain versement prévu, pas toute la cible
    expect(prep.executesMovement).toBe(false);
    const before = (await api(ctx).get('/balances/overview')).body.data;
    const key = idemKey();
    await api(ctx).post(`/savings/goals/${goal.id}/contributions/manual/confirm`, { amountMinor: '20000' }, key).expect(201);
    await api(ctx).post(`/savings/goals/${goal.id}/contributions/manual/confirm`, { amountMinor: '20000' }, key).expect(201); // rejeu idempotent
    const after = (await api(ctx).get('/balances/overview')).body.data;
    expect(after.trackedBalanceMinor).toBe(before.trackedBalanceMinor);
    expect(after.allocatedToEnvelopesMinor).toBe('20000');
    expect(BigInt(after.currentWalletMinor)).toBe(BigInt(before.currentWalletMinor) - 20000n);
    const g = (await api(ctx).get(`/savings/goals/${goal.id}`)).body.data;
    expect(g.savedMinor).toBe('20000');
    // Même clé, corps différent → 409
    const mismatch = await api(ctx).post(`/savings/goals/${goal.id}/contributions/manual/confirm`, { amountMinor: '1' }, key).expect(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    // Sortie directe d'un coffre interdite hors demande de retrait
    const cur = (await api(ctx).get('/wallets')).body.data.find((w: any) => w.kind === 'CURRENT');
    const out = await api(ctx).post('/allocations/transfers', { fromWalletId: goal.walletId, toWalletId: cur.id, amountMinor: '1000' }, idemKey()).expect(422);
    expect(out.body.error.code).toBe('SAVINGS_WITHDRAWAL_DELAY');
  });

  it('revenu : reconnu une seule fois, répartition sans double revenu', async () => {
    const acc = await createAccount(ctx, 'Banque', '0');
    const goal = (await api(ctx).post('/savings/goals', { name: 'Urgence', targetMinor: '500000', deadline: '2027-12-31', plan: { triggerType: 'INCOME_TRIGGER', amountRule: 'PERCENT:1000' } }).expect(201)).body.data;
    const inc = (await api(ctx).post('/incomes', { accountId: acc.id, source: 'Salaire', grossMinor: '300000' }, idemKey()).expect(201)).body.data;
    const prop = (await api(ctx).post(`/incomes/${inc.id}/allocation-proposals`).expect(201)).body.data;
    expect(prop.proposals[0].amountMinor).toBe('30000');
    await api(ctx).post(`/incomes/${inc.id}/confirm-allocations`, { allocations: [{ walletId: goal.walletId, amountMinor: '30000' }] }, idemKey()).expect(201);
    await api(ctx).post(`/incomes/${inc.id}/confirm-allocations`, { allocations: [{ walletId: goal.walletId, amountMinor: '30000' }] }, idemKey()).expect(409);
    const ov = (await api(ctx).get('/balances/overview')).body.data;
    expect(ov.trackedBalanceMinor).toBe('300000');
    expect(ov.currentWalletMinor).toBe('270000');
    const incomeTotal = await ctx.prisma.ledgerPosting.aggregate({ where: { ledgerAccount: { kind: 'INCOME' } }, _sum: { signedAmountMinor: true } });
    expect(incomeTotal._sum.signedAmountMinor).toBe(-300000n);
  });

  it('dépense : non bloquée par budget dépassé, avertissement retourné', async () => {
    const acc = await createAccount(ctx);
    const cycle = (await api(ctx).post('/budget-cycles', { durationDays: 30 }).expect(201)).body.data;
    const cats = (await api(ctx).get('/categories?type=EXPENSE')).body.data;
    const food = cats.find((c: any) => c.name === 'Alimentation');
    await api(ctx).post('/budgets', { cycleId: cycle.id, categoryId: food.id, plannedMinor: '10000' }).expect(201);
    const e = (await api(ctx).post('/expenses', { accountId: acc.id, amountMinor: '15000', label: 'Courses au marché' }, idemKey()).expect(201)).body.data;
    expect(e.categoryId).toBe(food.id); // suggestion par mot-clé
    expect(e.warnings[0].code).toBe('BUDGET_EXCEEDED');
    const an = (await api(ctx).get('/budgets/analytics')).body.data;
    expect(an.categories[0].status).toBe('EXCEEDED');
  });

  it('T23 — objectif atteint : pas de libération automatique, 72 h et confirmation forte', async () => {
    await createAccount(ctx);
    const goal = (await api(ctx).post('/savings/goals', { name: 'Moto', targetMinor: '50000', deadline: '2027-06-30', plan: { triggerType: 'CALENDAR', amountRule: 'FIXED:10000', scheduleRule: 'WEEKLY:1' } }).expect(201)).body.data;
    await api(ctx).post(`/savings/goals/${goal.id}/contributions/manual/confirm`, { amountMinor: '50000' }, idemKey()).expect(201);
    const g = (await api(ctx).get(`/savings/goals/${goal.id}`)).body.data;
    expect(g.status).toBe('TARGET_REACHED');
    expect(g.savedMinor).toBe('50000'); // toujours dans le coffre
    // Sans preuve forte → refus
    await api(ctx).post(`/savings/goals/${goal.id}/withdrawal-requests`, { kind: 'ORDINARY', amountMinor: '50000' }).expect(403);
    const params = { goalId: goal.id, kind: 'ORDINARY', amountMinor: '50000' };
    const req = (await api(ctx).post(`/savings/goals/${goal.id}/withdrawal-requests`, { ...params, goalId: undefined, approval: await approve(ctx, 'savings.withdrawal.request', params) }).expect(201)).body.data;
    const early = await api(ctx).post(`/savings/withdrawal-requests/${req.id}/confirm`, { approval: await approve(ctx, 'savings.withdrawal.confirm', { requestId: req.id }) }).expect(422);
    expect(early.body.error.code).toBe('SAVINGS_WITHDRAWAL_DELAY');
    await advance(ctx, 72 * HOUR + 1000);
    await api(ctx).post(`/savings/withdrawal-requests/${req.id}/confirm`, { approval: await approve(ctx, 'savings.withdrawal.confirm', { requestId: req.id }) }).expect(201);
    const g2 = (await api(ctx).get(`/savings/goals/${goal.id}`)).body.data;
    expect(g2.savedMinor).toBe('0');
    expect(g2.status).toBe('RELEASED');
  });

  it('T24 — retraits exceptionnels : 20 % reconstitué sur 30 j, demandes concurrentes incluses', async () => {
    await createAccount(ctx, 'Banque', '1000000');
    const goal = (await api(ctx).post('/savings/goals', { name: 'Maison', targetMinor: '5000000', deadline: '2028-01-31', plan: { triggerType: 'CALENDAR', amountRule: 'FIXED:100000', scheduleRule: 'MONTHLY:1' } }).expect(201)).body.data;
    await api(ctx).post(`/savings/goals/${goal.id}/contributions/manual/confirm`, { amountMinor: '500000' }, idemKey()).expect(201);
    // Contribution récente exclue de la base pendant 72 h (anti dépôt-puis-retrait)
    let cap = (await api(ctx).get(`/savings/goals/${goal.id}/withdrawal-capacity`)).body.data;
    expect(cap.capacityMinor).toBe('0');
    await advance(ctx, 73 * HOUR);
    cap = (await api(ctx).get(`/savings/goals/${goal.id}/withdrawal-capacity`)).body.data;
    expect(cap.capacityMinor).toBe('100000');
    const ask = async (amount: string) => {
      const p = { goalId: goal.id, kind: 'EXCEPTIONAL', amountMinor: amount };
      return api(ctx).post(`/savings/goals/${goal.id}/withdrawal-requests`, { kind: 'EXCEPTIONAL', amountMinor: amount, approval: await approve(ctx, 'savings.withdrawal.request', p) });
    };
    // Deux demandes concurrentes de 60 000 : une seule passe (verrou par coffre).
    const [r1, r2] = await Promise.all([ask('60000'), ask('60000')]);
    expect([r1.status, r2.status].sort()).toEqual([201, 422]);
    // Fractionnement : 40 000 restants passent, 1 de plus non.
    await ask('40000').then((r) => expect(r.status).toBe(201));
    const over = await ask('1');
    expect(over.body.error.code).toBe('SAVINGS_CAP_EXCEEDED');
    cap = (await api(ctx).get(`/savings/goals/${goal.id}/withdrawal-capacity`)).body.data;
    expect(cap.reservedMinor).toBe('100000');
    expect(cap.baseMinor).toBe('500000');
  });

  it('T11 — récupération complète : 48 h lecture seule finance, lecture et révocation possibles', async () => {
    await createAccount(ctx);
    const s = request(ctx.app.getHttpServer());
    const start = (await s.post('/api/v1/recovery/start').send({ email: EMAIL }).expect(200)).body.data;
    const newDevice = new TestDevice('iPhone récupéré');
    const rec = (await s.post('/api/v1/recovery/verify').send({ recoveryId: start.recoveryId, challenge: start.challenge, recoveryCode: ctx.recoveryCodes[0], device: newDevice.info() }).expect(200)).body.data;
    expect(rec.financialReadOnlyUntil).toBeDefined();
    // Ancienne session révoquée
    await api(ctx).get('/accounts').expect(401);
    const c2 = { ...ctx, token: rec.accessToken, device: newDevice };
    clock.advance(12 * HOUR);
    c2.token = (await s.post('/api/v1/identity/refresh').send({ refreshToken: rec.refreshToken }).expect(200)).body.data.accessToken;
    await api(c2).get('/accounts').expect(200); // lecture OK
    const w = await api(c2).post('/accounts', { name: 'X', type: 'CASH_MANUAL' }).expect(403);
    expect(w.body.error.code).toBe('RECOVERY_READ_ONLY');
    // Code de secours non réutilisable
    const start2 = (await s.post('/api/v1/recovery/start').send({ email: EMAIL })).body.data;
    await s.post('/api/v1/recovery/verify').send({ recoveryId: start2.recoveryId, challenge: start2.challenge, recoveryCode: ctx.recoveryCodes[0], device: newDevice.info() }).expect(403);
    await advance(c2, 37 * HOUR);
    await api(c2).post('/accounts', { name: 'X', type: 'CASH_MANUAL' }).expect(201);
  });

  it('T20 — paramètres modifiés après signature : refus ; rejeu refusé', async () => {
    const other = new TestDevice('Android');
    const login = (await request(ctx.app.getHttpServer()).post('/api/v1/identity/login').send({ email: EMAIL, password: PASSWORD, device: other.info() }).expect(200)).body.data;
    expect(login.enrollmentRequired).toBe(true);
    const signed = await approve(ctx, 'device.revoke', { deviceId: login.device.id });
    // On réutilise la preuve pour un autre appareil → digest différent
    const wrong = await api(ctx).post(`/devices/${ctx.ownerId}/revoke`, { approval: signed }).expect(403);
    expect(wrong.body.error.code).toBe('SIGNED_APPROVAL_INVALID');
    const signed2 = await approve(ctx, 'device.revoke', { deviceId: login.device.id });
    await api(ctx).post(`/devices/${login.device.id}/revoke`, { approval: signed2 }).expect(200);
    const replay = await api(ctx).post(`/devices/${login.device.id}/revoke`, { approval: signed2 }).expect(403);
    expect(replay.body.error.code).toBe('SIGNED_APPROVAL_INVALID');
    // Session de l'appareil révoqué rejetée
    await request(ctx.app.getHttpServer()).get('/api/v1/identity/me').set('Authorization', `Bearer ${login.accessToken}`).expect(401);
  });

  it('rotation du refresh : la réutilisation révoque la famille', async () => {
    const d = new TestDevice('Mac 2');
    const s = request(ctx.app.getHttpServer());
    const l = (await s.post('/api/v1/identity/login').send({ email: EMAIL, password: PASSWORD, device: ctx.device.info() }).expect(200)).body.data;
    const r1 = (await request(ctx.app.getHttpServer()).post('/api/v1/identity/refresh').send({ refreshToken: l.refreshToken }).expect(200)).body.data;
    await request(ctx.app.getHttpServer()).post('/api/v1/identity/refresh').send({ refreshToken: l.refreshToken }).expect(401);
    await request(ctx.app.getHttpServer()).post('/api/v1/identity/refresh').send({ refreshToken: r1.refreshToken }).expect(401);
    expect(d).toBeDefined();
  });
});
