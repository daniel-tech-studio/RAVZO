import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { clock } from '../../src/common/clock';
import { config } from '../../src/common/config';
import { FeexPayProvider } from '../../src/modules/payments/feexpay.provider';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { api, createTestApp, Ctx, idemKey, setupOwner } from '../helpers';

/**
 * Adaptateur FeexPay de bout en bout contre un serveur FeexPay SIMULÉ en local (aucun appel réseau externe,
 * aucun argent réel) : forme des requêtes, idempotence, webhooks signés, refus, issue incertaine puis statut.
 */
const SECRET = 'fxp_whsec_test_secret';
type Rec = { method: string; url: string; headers: IncomingMessage['headers']; body: any };

describe('FeexPay — adaptateur de paiement', () => {
  let server: Server;
  let reqs: Rec[] = [];
  let balance = { mtn: 200000, moov: 0, celtiis_benin: 0, card: 0 };
  let payoutReply: { status: number; body: any; hang?: boolean } = { status: 200, body: {} };
  const statusReply: Record<string, any> = {};
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = data ? JSON.parse(data) : undefined;
        reqs.push({ method: req.method!, url: req.url!, headers: req.headers, body });
        const send = (s: number, b: any) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
        if (req.headers.authorization !== 'Bearer test_key_ravzo') return send(401, { statusCode: 401, message: 'Token invalide', code: 'UNAUTHORIZED' });
        if (req.url!.startsWith('/api/balance/public/getByShop/shop_test')) return send(200, { balance });
        if (req.url!.startsWith('/api/payouts/status/public/')) { const ref = req.url!.split('/').pop()!; return statusReply[ref] ? send(200, statusReply[ref]) : send(404, { statusCode: 404, message: 'Transaction not found', code: 'NOT_FOUND' }); }
        if (req.method === 'POST' && req.url!.startsWith('/api/payouts/public/')) {
          if (payoutReply.hang) return; // pas de réponse : délai dépassé côté client
          return send(payoutReply.status, payoutReply.body);
        }
        send(404, { statusCode: 404, message: 'route inconnue' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    config.pspProvider = 'feexpay';
    Object.assign(config.feexpay, { base: `http://127.0.0.1:${port}`, apiKey: 'test_key_ravzo', shopId: 'shop_test', webhookSecret: SECRET, payoutFeeBp: 100, payoutFeeMinMinor: 50n, payinFeeBp: 170, timeoutMs: 800 });
    base = await createTestApp();
  });
  afterAll(async () => { await base.app.close(); server.close(); config.pspProvider = 'fake'; });
  beforeEach(async () => {
    ctx = await setupOwner(base.app, base.prisma);
    reqs = []; balance = { mtn: 200000, moov: 0, celtiis_benin: 0, card: 0 };
    payoutReply = { status: 200, body: {} };
  });
  afterEach(() => clock.reset());

  const provider = () => base.app.get(PaymentsService).provider as FeexPayProvider;
  async function connect() { return (await api(ctx).post('/payments/provider/connect', {}).expect(201)).body.data; }
  async function setup() {
    const conn = await connect();
    const ben = (await api(ctx).post('/beneficiaries', { displayName: 'Awa', phoneE164: '+2290197000000', operator: 'MTN_BJ' }).expect(201)).body.data;
    const cur = (await api(ctx).get('/wallets')).body.data.find((w: any) => w.kind === 'CURRENT');
    return { conn, ben, cur };
  }
  async function readyIntent(s: any, amount: string) {
    const i = (await api(ctx).post('/payments/payouts/intents', { sourceWalletId: s.cur.id, beneficiaryId: s.ben.id, amountMode: 'NET_RECEIVED', amountMinor: amount, currency: 'XOF' }, idemKey()).expect(201)).body.data;
    const ch = (await request(ctx.app.getHttpServer()).post(`/api/v1/payments/intents/${i.id}/challenge`).set('Authorization', `Bearer ${ctx.token}`).expect(201)).body.data;
    await request(ctx.app.getHttpServer()).post(`/api/v1/payments/intents/${i.id}/authorize`).set('Authorization', `Bearer ${ctx.token}`).send({ approval: ctx.device.signChallenge(ch), acknowledgeUnverifiedBeneficiary: true }).expect(202);
    return i;
  }
  function webhook(body: any, opts: { deliveryId?: string; ts?: number; secret?: string; event?: string } = {}) {
    const raw = JSON.stringify(body);
    const ts = String(opts.ts ?? Math.floor(clock.now().getTime() / 1000));
    const id = opts.deliveryId ?? `dlv-${Math.random().toString(36).slice(2)}`;
    return request(ctx.app.getHttpServer()).post('/api/v1/integrations/psp/webhooks/feexpay').set('Content-Type', 'application/json')
      .set('x-feexpay-timestamp', ts).set('x-feexpay-delivery-id', id).set('x-feexpay-event', opts.event ?? 'payout.successful')
      .set('x-feexpay-signature', `v1=${FeexPayProvider.sign(opts.secret ?? SECRET, ts, id, raw)}`).send(raw);
  }

  it('capacités : FeexPay sandbox exécutable hors production, opérateurs béninois, aucun argent réel', async () => {
    const c = (await api(ctx).get('/payments/capabilities').expect(200)).body.data;
    expect(c.provider).toBe('feexpay');
    expect(c.executionMode).toBe('SANDBOX');
    expect(c.executable).toBe(true);
    expect(c.realMoney).toBe(false);
    expect(c.operators).toEqual(['MTN_BJ', 'MOOV_BJ', 'CELTIIS_BJ']);
  });

  it('connexion du compte : solde d’ouverture = solde FeexPay attesté, idempotente, détail par réseau', async () => {
    const r = await connect();
    expect(r.account.type).toBe('CONTROLLED_PSP');
    expect(r.account.verificationLevel).toBe('PROVIDER_VERIFIED');
    expect((await api(ctx).get(`/accounts/${r.account.id}`)).body.data.balanceMinor).toBe('200000');
    expect((await connect()).alreadyConnected).toBe(true);
    const b = (await api(ctx).get('/payments/provider/balance').expect(200)).body.data;
    expect(b.channels.MTN_BJ).toBe('200000');
    expect(b.totalMinor).toBe('200000');
  });

  it('payout : requête FeexPay conforme + clé d’idempotence ; webhook signé → réussi, une seule écriture ; doublon ignoré', async () => {
    const s = await setup();
    const i = await readyIntent(s, '10000');
    expect(i.feeQuoteMinor).toBe('100'); // 1 % du contrat configuré
    payoutReply = { status: 200, body: { reference: 'fx-ref-1', status: 'PENDING', message: 'Payout request accepted', amount: 10000, callback_info: `RVZ-${i.id}` } };
    const r = (await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202)).body.data;
    expect(r.state).toBe('PROCESSING');
    const call = reqs.find((q) => q.method === 'POST')!;
    expect(call.url).toBe('/api/payouts/public/transfer/global');
    expect(call.headers['idempotency-key']).toBe(i.id);
    expect(call.body).toEqual({ shop: 'shop_test', amount: 10000, phoneNumber: '2290197000000', network: 'MTN', motif: expect.stringMatching(/^RAVZO [0-9a-f]{20}$/), callback_info: `RVZ-${i.id}` });
    expect(call.body.motif.length).toBeLessThanOrEqual(30);

    const ev = { reference: 'fx-ref-1', status: 'SUCCESSFUL', amount: 10000, callback_info: `RVZ-${i.id}`, type: 'Payout', email: 'ne-pas-stocker@exemple.com' };
    await webhook(ev, { deliveryId: 'dlv-1' }).expect(200);
    const dup = await webhook(ev, { deliveryId: 'dlv-1' }).expect(200);
    expect(dup.body.data?.duplicate ?? dup.body.duplicate).toBe(true);
    const p = (await api(ctx).get(`/payments/intents/${i.id}`)).body.data;
    expect(p.state).toBe('SUCCEEDED');
    expect(await ctx.prisma.ledgerTransaction.count({ where: { businessType: 'PAYOUT', businessId: i.id } })).toBe(1);
    expect((await api(ctx).get(`/accounts/${s.conn.account.id}`)).body.data.balanceMinor).toBe(String(200000 - 10100));
    const stored = await ctx.prisma.providerEvent.findFirstOrThrow({ where: { provider: 'feexpay' } });
    expect(JSON.stringify(stored.payloadRedacted)).not.toContain('ne-pas-stocker'); // données personnelles non conservées
  });

  it('webhooks rejetés : signature fausse, secret différent, horodatage trop ancien', async () => {
    const s = await setup();
    const i = await readyIntent(s, '5000');
    payoutReply = { status: 200, body: { reference: 'fx-ref-2', status: 'PENDING', amount: 5000 } };
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    const ev = { reference: 'fx-ref-2', status: 'SUCCESSFUL', amount: 5000, callback_info: `RVZ-${i.id}` };
    await webhook(ev, { secret: 'fxp_whsec_autre' }).expect(403);
    await webhook(ev, { ts: Math.floor(clock.now().getTime() / 1000) - 600 }).expect(403);
    await request(ctx.app.getHttpServer()).post('/api/v1/integrations/psp/webhooks/feexpay').set('Content-Type', 'application/json').send(JSON.stringify(ev)).expect(403);
    expect((await api(ctx).get(`/payments/intents/${i.id}`)).body.data.state).toBe('PROCESSING');
    expect(await ctx.prisma.securityEvent.count({ where: { type: 'WEBHOOK_REJECTED' } })).toBe(3);
  });

  it('refus FeexPay (400 solde insuffisant) : échec terminal, réservations libérées, aucun débit', async () => {
    const s = await setup();
    const i = await readyIntent(s, '8000');
    payoutReply = { status: 400, body: { statusCode: 400, message: 'Low Balance', code: 'ERR_INSUFFICIENT_BALANCE' } };
    const r = (await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202)).body.data;
    expect(r.state).toBe('FAILED');
    expect(r.holds.limit).toBe('RELEASED');
    expect((await api(ctx).get(`/accounts/${s.conn.account.id}`)).body.data.balanceMinor).toBe('200000');
  });

  it('délai dépassé : UNKNOWN, aucun renvoi ; le statut FeexPay (lecture seule) tranche ensuite', async () => {
    const s = await setup();
    const i = await readyIntent(s, '7000');
    payoutReply = { status: 200, body: {}, hang: true };
    const r = (await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202)).body.data;
    expect(r.state).toBe('UNKNOWN');
    // Sans référence FeexPay, la vérification ne peut pas conclure et ne renvoie jamais le payout.
    await api(ctx).post(`/payments/intents/${i.id}/recheck`).expect(202);
    expect(reqs.filter((q) => q.method === 'POST')).toHaveLength(1);
    // Le webhook (qui porte la référence marchande) fournit la référence et le statut final.
    await webhook({ reference: 'fx-ref-3', status: 'SUCCESSFUL', amount: 7000, callback_info: `RVZ-${i.id}` }).expect(200);
    expect((await api(ctx).get(`/payments/intents/${i.id}`)).body.data.state).toBe('SUCCEEDED');
  });

  it('PENDING puis statut consulté : SUCCESSFUL → réussi ; « introuvable » ne vaut jamais échec', async () => {
    const s = await setup();
    const i = await readyIntent(s, '6000');
    payoutReply = { status: 200, body: { reference: 'fx-ref-4', status: 'PENDING', amount: 6000 } };
    await api(ctx).post(`/payments/intents/${i.id}/submit`).expect(202);
    const nf = (await api(ctx).post(`/payments/intents/${i.id}/recheck`).expect(202)).body.data;
    expect(nf.state).toBe('PROCESSING');
    statusReply['fx-ref-4'] = { reference: 'fx-ref-4', amount: 6000, status: 'SUCCESSFUL', responsecode: 'SUCCESSFUL' };
    const ok = (await api(ctx).post(`/payments/intents/${i.id}/recheck`).expect(202)).body.data;
    expect(ok.state).toBe('SUCCEEDED');
    expect(reqs.some((q) => q.url === '/api/payouts/status/public/fx-ref-4')).toBe(true);
  });

  it('frais du contrat non renseignés : aucun paiement exécutable (jamais de frais inventés)', async () => {
    const saved = config.feexpay.payoutFeeBp;
    config.feexpay.payoutFeeBp = null;
    const p = provider() as any;
    p.o.payoutFeeBp = null;
    try {
      const c = (await api(ctx).get('/payments/capabilities').expect(200)).body.data;
      expect(c.executable).toBe(false);
      expect(c.nonExecutableReason).toBe('PSP_FEES_UNCONFIGURED');
    } finally { config.feexpay.payoutFeeBp = saved; p.o.payoutFeeBp = saved; }
  });
});
