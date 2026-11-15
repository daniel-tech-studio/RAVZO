import { FeexPayOptions, FeexPayProvider } from '../../src/modules/payments/feexpay.provider';
import { ProviderError } from '../../src/modules/payments/provider.port';

const REF = 'RVZ-3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
function make(fetchImpl: any, over: Partial<FeexPayOptions> = {}) {
  return new FeexPayProvider({ base: 'https://api-v2.feexpay.me', apiKey: 'fp_live', shopId: 'shop', webhookSecret: 's', payoutFeeBp: 100, payoutFeeMinMinor: 0n, payinFeeBp: 170, timeoutMs: 1000, fetchImpl, ...over });
}
const reply = (status: number, body: any) => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
const payout = (p: FeexPayProvider, operator = 'MTN_BJ') => p.createPayout({ merchantRef: REF, phoneE164: '+2290166000000', operator, amountNetMinor: 1000n, currency: 'XOF' });
async function code(pr: Promise<unknown>) { try { await pr; return 'OK'; } catch (e) { return (e as ProviderError).code; } }

describe('FeexPayProvider (unitaire)', () => {
  it('clé fp_ = production ; test_key_ = sandbox', () => {
    expect(make(reply(200, {})).getCapabilities().mode).toBe('LIVE');
    expect(make(reply(200, {}), { apiKey: 'test_key_x' }).getCapabilities().mode).toBe('SANDBOX');
  });
  it('frais : arrondi au franc supérieur, minimum appliqué ; inconnus si non configurés', () => {
    expect(make(reply(200, {})).estimateFees('PAYOUT', 1050n).feeMinor).toBe(11n);
    expect(make(reply(200, {}), { payoutFeeMinMinor: 50n }).estimateFees('PAYOUT', 1000n).feeMinor).toBe(50n);
    const p = make(reply(200, {}), { payoutFeeBp: null });
    expect(p.getCapabilities().feesKnown).toBe(false);
    expect(p.estimateFees('PAYOUT', 1000n).basis).toBe('FEES_UNCONFIGURED');
  });
  it('Celtiis : route dédiée, sans champ network', async () => {
    let seen: any;
    const p = make(async (url: string, init: any) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => '{"reference":"r","status":"PENDING"}' }; });
    await payout(p, 'CELTIIS_BJ');
    expect(seen.url).toBe('https://api-v2.feexpay.me/api/payouts/public/celtiis_bj');
    expect(seen.body.network).toBeUndefined();
  });
  it('classification des issues : jamais « non exécuté » sans preuve', async () => {
    expect(await code(payout(make(reply(400, { message: 'Low Balance' }))))).toBe('REJECTED_TERMINAL');
    expect(await code(payout(make(reply(401, { code: 'UNAUTHORIZED' }))))).toBe('REJECTED_TERMINAL');
    expect(await code(payout(make(reply(503, { code: 'NETWORK_UNAVAILABLE' }))))).toBe('PROVIDER_UNAVAILABLE');
    expect(await code(payout(make(reply(502, {}))))).toBe('UNKNOWN_OUTCOME');
    expect(await code(payout(make(reply(409, { code: 'IDEMPOTENCY_IN_PROGRESS' }))))).toBe('UNKNOWN_OUTCOME');
    expect(await code(payout(make(reply(200, { status: 'PENDING' }))))).toBe('UNKNOWN_OUTCOME'); // sans référence
    expect(await code(payout(make(async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); })))).toBe('PROVIDER_UNAVAILABLE');
    expect(await code(payout(make(async () => { throw Object.assign(new Error('reset'), { cause: { code: 'ECONNRESET' } }); })))).toBe('UNKNOWN_OUTCOME');
  });
  it('numéro : format béninois exigé (229 + 10 chiffres)', async () => {
    const p = make(reply(200, { reference: 'r', status: 'PENDING' }));
    expect(await code(p.createPayout({ merchantRef: REF, phoneE164: '+22997000000', operator: 'MTN_BJ', amountNetMinor: 1000n, currency: 'XOF' }))).toBe('REJECTED_TERMINAL');
  });
  it('statut : sans référence FeexPay, incertain (aucun appel)', async () => {
    let called = false;
    const p = make(async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; });
    expect(await code(p.getPaymentStatus(REF, { providerRef: null }))).toBe('UNKNOWN_OUTCOME');
    expect(called).toBe(false);
  });
  it('webhook : signature v1 sur « timestamp.deliveryId.corps », rotation (deux signatures) acceptée', () => {
    const p = make(reply(200, {}), { webhookSecret: 'fxp_whsec_a' });
    const raw = Buffer.from('{"reference":"r1","status":"SUCCESSFUL","amount":250,"callback_info":"' + REF + '"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const good = FeexPayProvider.sign('fxp_whsec_a', ts, 'd1', raw);
    const ev = p.validateWebhook(raw, { 'x-feexpay-timestamp': ts, 'x-feexpay-delivery-id': 'd1', 'x-feexpay-signature': `v1=deadbeef, v1=${good}` });
    expect(ev).toMatchObject({ providerEventId: 'd1', merchantRef: REF, providerRef: 'r1', status: 'SUCCEEDED', amountMinor: 250n });
    // Delivery id modifié : signature invalide (il fait partie du message signé).
    expect(() => p.validateWebhook(raw, { 'x-feexpay-timestamp': ts, 'x-feexpay-delivery-id': 'd2', 'x-feexpay-signature': `v1=${good}` })).toThrow(ProviderError);
  });
  it('webhook refusé si aucun secret n’est configuré', () => {
    const p = make(reply(200, {}), { webhookSecret: '' });
    expect(() => p.validateWebhook(Buffer.from('{}'), {})).toThrow(/non configuré/);
  });
  it('solde : somme des canaux Bénin, détail par opérateur', async () => {
    const p = make(reply(200, { balance: { mtn: 1000, moov: 250, celtiis_benin: 5, card: 99999, mtn_ci: 7 } }));
    const b = (await p.balance())!;
    expect(b.totalMinor).toBe(1255n);
    expect(b.channels).toEqual({ MTN_BJ: 1000n, MOOV_BJ: 250n, CELTIIS_BJ: 5n });
  });
});
