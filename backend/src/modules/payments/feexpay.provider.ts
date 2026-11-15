import { createHmac } from 'crypto';
import { clock } from '../../common/clock';
import { config } from '../../common/config';
import { safeEqual } from '../../common/crypto';
import { CreateResult, PaymentProviderPort, ProviderCapabilities, ProviderError, StatusResult, WebhookEvent } from './provider.port';

/**
 * Adaptateur FeexPay (API v2, Mobile Money Bénin) — https://docs.feexpay.me
 *
 * - Payout : POST /api/payouts/public/transfer/global (MTN/MOOV) ou /api/payouts/public/celtiis_bj ; PENDING au lancement,
 *   statut final OBLIGATOIREMENT vérifié via /api/payouts/status/public/{reference} (ou webhook signé).
 * - Payin : POST /api/transactions/public/requesttopay/{mtn|moov|celtiis_bj} ; statut via /api/transactions/public/single/status/{reference}.
 * - Idempotency-Key (UUID) sur chaque POST : un renvoi ne crée jamais une seconde transaction.
 * - Webhook : HMAC-SHA256(secret, "{timestamp}.{deliveryId}.{corps brut}"), en-tête x-feexpay-signature « v1=<hex> », fenêtre 5 min.
 * - Solde : GET /api/balance/public/getByShop/{shop}, tenu PAR CANAL (un payout MTN exige du solde sur le canal MTN).
 *
 * Les frais ne sont pas publiés par FeexPay (ils dépendent du contrat) : ils doivent être configurés
 * (FEEXPAY_PAYOUT_FEE_BP / FEEXPAY_PAYIN_FEE_BP). Sans barème, aucun paiement n'est exécutable — jamais de frais inventés.
 */
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const PAYOUT_ROUTE: Record<string, { path: string; network?: string }> = {
  MTN_BJ: { path: '/api/payouts/public/transfer/global', network: 'MTN' },
  MOOV_BJ: { path: '/api/payouts/public/transfer/global', network: 'MOOV' },
  CELTIIS_BJ: { path: '/api/payouts/public/celtiis_bj' },
};
const PAYIN_ROUTE: Record<string, string> = {
  MTN_BJ: '/api/transactions/public/requesttopay/mtn',
  MOOV_BJ: '/api/transactions/public/requesttopay/moov',
  CELTIIS_BJ: '/api/transactions/public/requesttopay/celtiis_bj',
};
/** Canaux du solde boutique correspondant aux opérateurs pris en charge. */
export const FEEXPAY_BALANCE_CHANNELS: Record<string, string> = { MTN_BJ: 'mtn', MOOV_BJ: 'moov', CELTIIS_BJ: 'celtiis_benin' };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'UND_ERR_CONNECT_TIMEOUT']);

export interface FeexPayOptions {
  base: string; apiKey: string; shopId: string; webhookSecret: string;
  payoutFeeBp: number | null; payoutFeeMinMinor: bigint; payinFeeBp: number | null; timeoutMs: number; fetchImpl?: FetchLike;
}

export function feexpayOptionsFromConfig(): FeexPayOptions {
  const f = config.feexpay;
  return { base: f.base, apiKey: f.apiKey, shopId: f.shopId, webhookSecret: f.webhookSecret, payoutFeeBp: f.payoutFeeBp, payoutFeeMinMinor: f.payoutFeeMinMinor, payinFeeBp: f.payinFeeBp, timeoutMs: f.timeoutMs };
}

export class FeexPayProvider implements PaymentProviderPort {
  readonly id = 'feexpay';
  private readonly fetch: FetchLike;
  constructor(private o: FeexPayOptions) { this.fetch = o.fetchImpl ?? ((u, i) => fetch(u, i) as any); }

  get balanceRef() { return this.o.shopId; }
  get isSandbox() { return this.o.apiKey.startsWith('test_key_') || /sandbox/.test(this.o.base); }

  getCapabilities(): ProviderCapabilities {
    const feesKnown = this.o.payoutFeeBp !== null && this.o.payinFeeBp !== null;
    const configured = !!this.o.apiKey && !!this.o.shopId;
    return {
      provider: 'feexpay', mode: this.isSandbox ? 'SANDBOX' : 'LIVE', payin: configured, payout: configured, verifyBeneficiary: false, balanceSnapshot: configured,
      enforceableSavings: false, operators: Object.keys(PAYOUT_ROUTE), currencies: ['XOF'], feesKnown,
      note: !configured ? 'FeexPay : clé API ou identifiant de boutique manquant.'
        : !feesKnown ? 'FeexPay : barème de frais non configuré (FEEXPAY_PAYOUT_FEE_BP / FEEXPAY_PAYIN_FEE_BP). Aucun paiement exécutable tant que les frais réels de votre contrat ne sont pas renseignés.'
        : `FeexPay ${this.isSandbox ? 'sandbox (aucun argent réel)' : 'production (argent réel)'} — Mobile Money MTN, Moov et Celtiis Bénin. Le solde est tenu par réseau.`,
    };
  }

  /** Frais du contrat FeexPay (points de base), arrondis au franc supérieur ; aucun frais inventé. */
  estimateFees(direction: 'PAYIN' | 'PAYOUT', amountMinor: bigint) {
    const bp = direction === 'PAYOUT' ? this.o.payoutFeeBp : this.o.payinFeeBp;
    if (bp === null) return { feeMinor: 0n, quoteTtlMs: 10 * 60_000, basis: 'FEES_UNCONFIGURED' };
    let fee = (amountMinor * BigInt(bp) + 9999n) / 10000n;
    if (direction === 'PAYOUT' && fee < this.o.payoutFeeMinMinor) fee = this.o.payoutFeeMinMinor;
    return { feeMinor: fee, quoteTtlMs: 10 * 60_000, basis: `FEEXPAY_${direction}_${bp}BP` };
  }

  /** +22901XXXXXXXX → 22901XXXXXXXX (format attendu par FeexPay : indicatif + 10 chiffres). */
  static phone(e164: string) {
    const d = e164.replace(/\D/g, '');
    if (!/^229\d{10}$/.test(d)) throw new ProviderError('REJECTED_TERMINAL', 'Numéro béninois attendu : +229 suivi de 10 chiffres (01XXXXXXXX)');
    return d;
  }
  static idempotencyKey(merchantRef: string) {
    const m = merchantRef.match(UUID_RE);
    if (!m) throw new ProviderError('REJECTED_TERMINAL', 'Référence marchande sans UUID');
    return m[0].toLowerCase();
  }
  /** Motif : 30 caractères max, sans caractères spéciaux (règle FeexPay). */
  static motif(merchantRef: string) { return `RAVZO ${FeexPayProvider.idempotencyKey(merchantRef).replace(/-/g, '').slice(0, 20)}`; }

  private headers(extra: Record<string, string> = {}) { return { Authorization: `Bearer ${this.o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extra }; }

  /** POST d'exécution : classe chaque issue sans jamais supposer qu'un échec réseau prouve la non-exécution. */
  private async postExec(path: string, body: Record<string, unknown>, idemKey: string): Promise<CreateResult> {
    if (!this.o.apiKey || !this.o.shopId) throw new ProviderError('REJECTED_TERMINAL', 'FeexPay non configuré');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.fetch(`${this.o.base}${path}`, { method: 'POST', headers: this.headers({ 'Idempotency-Key': idemKey }), body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e: any) {
      const code = e?.cause?.code ?? e?.code;
      // Connexion jamais établie : la requête n'a pas pu atteindre FeexPay.
      if (code && NOT_SENT_CODES.has(code)) throw new ProviderError('PROVIDER_UNAVAILABLE', `FeexPay injoignable (${code})`);
      throw new ProviderError('UNKNOWN_OUTCOME', `Réponse FeexPay non reçue (${e?.name === 'AbortError' ? 'délai dépassé' : code ?? 'erreur réseau'})`);
    } finally { clearTimeout(timer); }
    const text = await res.text().catch(() => '');
    let j: any = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
    const evidence = { httpStatus: res.status, reference: j.reference, status: j.status, message: j.message, code: j.code, reason: j.reason, idempotency_code: j.idempotency_code };
    if (res.ok) {
      if (!j.reference) throw new ProviderError('UNKNOWN_OUTCOME', 'Réponse FeexPay sans référence');
      const st = String(j.status ?? '').toUpperCase();
      return { status: st === 'SUCCESSFUL' ? 'SUCCEEDED' : st === 'FAILED' ? 'FAILED' : 'PROCESSING', providerRef: String(j.reference), evidence };
    }
    // Une requête refusée (validation, auth, solde, boutique) ne consomme pas la clé et ne crée pas de transaction (doc Idempotence).
    if (res.status === 429 || res.status === 503) throw new ProviderError('PROVIDER_UNAVAILABLE', `FeexPay indisponible (${res.status} ${j.code ?? ''})`.trim());
    if (res.status === 409) throw new ProviderError('UNKNOWN_OUTCOME', 'Requête FeexPay identique encore en cours (409)');
    if (res.status >= 400 && res.status < 500) throw new ProviderError('REJECTED_TERMINAL', `FeexPay a refusé la demande (${res.status}) : ${Array.isArray(j.message) ? j.message.join(', ') : j.message ?? j.code ?? 'refus'}`);
    throw new ProviderError('UNKNOWN_OUTCOME', `Erreur FeexPay ${res.status} : issue inconnue`);
  }

  async createPayout(r: { merchantRef: string; phoneE164: string; operator: string; amountNetMinor: bigint; currency: string }): Promise<CreateResult> {
    const route = PAYOUT_ROUTE[r.operator];
    if (!route) throw new ProviderError('REJECTED_TERMINAL', `Opérateur ${r.operator} non pris en charge par FeexPay`);
    if (r.currency !== 'XOF') throw new ProviderError('REJECTED_TERMINAL', 'FeexPay Bénin : XOF uniquement');
    const body: Record<string, unknown> = { shop: this.o.shopId, amount: Number(r.amountNetMinor), phoneNumber: FeexPayProvider.phone(r.phoneE164), motif: FeexPayProvider.motif(r.merchantRef), callback_info: r.merchantRef };
    if (route.network) body.network = route.network;
    return this.postExec(route.path, body, FeexPayProvider.idempotencyKey(r.merchantRef));
  }

  async createPayin(r: { merchantRef: string; phoneE164: string; operator: string; amountMinor: bigint; currency: string }): Promise<CreateResult> {
    const path = PAYIN_ROUTE[r.operator];
    if (!path) throw new ProviderError('REJECTED_TERMINAL', `Opérateur ${r.operator} non pris en charge par FeexPay`);
    if (r.currency !== 'XOF') throw new ProviderError('REJECTED_TERMINAL', 'FeexPay Bénin : XOF uniquement');
    return this.postExec(path, { shop: this.o.shopId, amount: Number(r.amountMinor), phoneNumber: FeexPayProvider.phone(r.phoneE164), description: FeexPayProvider.motif(r.merchantRef), callback_info: r.merchantRef }, FeexPayProvider.idempotencyKey(r.merchantRef));
  }

  /** Lecture seule. Sans référence FeexPay connue, aucune consultation possible : le statut reste incertain (jamais de renvoi). */
  async getPaymentStatus(_merchantRef: string, ctx?: { providerRef?: string | null; direction?: 'PAYIN' | 'PAYOUT' }): Promise<StatusResult> {
    if (!ctx?.providerRef) throw new ProviderError('UNKNOWN_OUTCOME', 'Référence FeexPay inconnue : attente du webhook ou rapprochement');
    const path = ctx.direction === 'PAYIN' ? `/api/transactions/public/single/status/${encodeURIComponent(ctx.providerRef)}` : `/api/payouts/status/public/${encodeURIComponent(ctx.providerRef)}`;
    let res;
    try { res = await this.fetch(`${this.o.base}${path}`, { headers: this.headers() }); } catch (e: any) { throw new ProviderError('PROVIDER_UNAVAILABLE', `Statut FeexPay indisponible (${e?.cause?.code ?? e?.code ?? 'réseau'})`); }
    const text = await res.text().catch(() => '');
    let j: any = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* corps illisible */ }
    if (res.status === 404) return { status: 'NOT_FOUND', providerRef: ctx.providerRef, evidence: { httpStatus: 404, code: j.code } };
    if (!res.ok) throw new ProviderError('PROVIDER_UNAVAILABLE', `Statut FeexPay : HTTP ${res.status}`);
    const st = String(j.status ?? '').toUpperCase();
    const status: StatusResult['status'] = st === 'SUCCESSFUL' ? 'SUCCEEDED' : st === 'FAILED' ? 'FAILED' : 'PROCESSING'; // PENDING / « IN PENDING STATE »
    return { status, providerRef: String(j.reference ?? ctx.providerRef), amountMinor: j.amount !== undefined && Number.isSafeInteger(Number(j.amount)) ? BigInt(j.amount) : undefined, evidence: { httpStatus: res.status, status: j.status, responsecode: j.responsecode, reason: j.reason, date: j.date, operator_id: j.operator_id } };
  }

  /** Solde FeexPay de la boutique : somme des canaux Mobile Money Bénin pris en charge (détail par canal dans `channels`). */
  async getBalanceSnapshot(shopRef: string) {
    const d = await this.balance(shopRef);
    return d ? { balanceMinor: d.totalMinor, asOf: d.asOf } : null;
  }
  async balance(shopRef = this.o.shopId): Promise<{ totalMinor: bigint; channels: Record<string, bigint>; asOf: Date } | null> {
    if (!this.o.apiKey || !shopRef) return null;
    const res = await this.fetch(`${this.o.base}/api/balance/public/getByShop/${encodeURIComponent(shopRef)}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : 'PROVIDER_UNAVAILABLE', `Solde FeexPay : HTTP ${res.status}`);
    const j: any = JSON.parse(await res.text());
    const channels: Record<string, bigint> = {};
    let total = 0n;
    for (const [op, ch] of Object.entries(FEEXPAY_BALANCE_CHANNELS)) {
      const v = Number(j?.balance?.[ch] ?? 0);
      if (!Number.isFinite(v) || !Number.isInteger(v)) throw new ProviderError('PROVIDER_UNAVAILABLE', `Solde FeexPay non entier sur ${ch}`);
      channels[op] = BigInt(v); total += BigInt(v);
    }
    return { totalMinor: total, channels, asOf: clock.now() };
  }

  /** Vérifie la signature HMAC (corps brut), la fraîcheur (± 5 min) et extrait l'événement normalisé. */
  validateWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent {
    const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v ?? ''; };
    const ts = h('x-feexpay-timestamp'), deliveryId = h('x-feexpay-delivery-id'), sigHeader = h('x-feexpay-signature'), eventName = h('x-feexpay-event');
    if (!this.o.webhookSecret) throw new ProviderError('AUTH_FAILED', 'Secret de webhook FeexPay non configuré : webhook refusé');
    if (!/^\d+$/.test(ts) || !deliveryId || !sigHeader) throw new ProviderError('AUTH_FAILED', 'En-têtes de signature FeexPay absents');
    if (Math.abs(Math.floor(clock.now().getTime() / 1000) - Number(ts)) > 300) throw new ProviderError('AUTH_FAILED', 'Webhook FeexPay trop ancien (rejeu possible)');
    const expected = FeexPayProvider.sign(this.o.webhookSecret, ts, deliveryId, raw);
    const ok = sigHeader.split(',').some((p) => { const [v, val] = p.trim().split('='); return v === 'v1' && !!val && safeEqual(val, expected); });
    if (!ok) throw new ProviderError('AUTH_FAILED', 'Signature de webhook FeexPay invalide');
    let b: any;
    try { b = JSON.parse(raw.toString('utf8')); } catch { throw new ProviderError('AUTH_FAILED', 'Webhook FeexPay illisible'); }
    const st = String(b.status ?? '').toUpperCase();
    if (!b.reference || !['SUCCESSFUL', 'FAILED', 'PENDING'].includes(st) || !Number.isSafeInteger(Number(b.amount))) throw new ProviderError('AUTH_FAILED', 'Webhook FeexPay mal formé');
    const cb = typeof b.callback_info === 'string' ? b.callback_info : '';
    return {
      providerEventId: deliveryId, merchantRef: cb, providerRef: String(b.reference),
      status: st === 'SUCCESSFUL' ? 'SUCCEEDED' : st === 'FAILED' ? 'FAILED' : 'PROCESSING',
      amountMinor: BigInt(b.amount), currency: 'XOF', eventAt: b.date ? new Date(b.date) : undefined,
      // Données personnelles du payeur (nom, e-mail) non conservées.
      raw: { event: eventName, reference: b.reference, status: b.status, amount: b.amount, type: b.type, reseau: b.reseau, reason: b.reason, callback_info: cb, date: b.date, env: b.env },
    };
  }
  static sign(secret: string, ts: string, deliveryId: string, raw: Buffer | string) {
    return createHmac('sha256', secret).update(`${ts}.${deliveryId}.`).update(raw).digest('hex');
  }

  async healthCheck() { try { return (await this.balance()) !== null; } catch { return false; } }
}
