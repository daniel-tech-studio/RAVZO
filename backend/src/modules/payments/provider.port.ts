import { createHmac, randomUUID } from 'crypto';
import { config } from '../../common/config';
import { safeEqual } from '../../common/crypto';

export type ProviderErrorCode = 'PROVIDER_UNAVAILABLE' | 'REJECTED_TERMINAL' | 'UNKNOWN_OUTCOME' | 'RATE_LIMITED' | 'NOT_SUPPORTED' | 'AUTH_FAILED';
export class ProviderError extends Error {
  constructor(public code: ProviderErrorCode, message: string, public rawEvidenceRef?: string) { super(message); }
}
export interface ProviderCapabilities {
  provider: string; mode: 'NONE' | 'SANDBOX_FAKE' | 'SANDBOX' | 'LIVE'; payin: boolean; payout: boolean; verifyBeneficiary: boolean;
  balanceSnapshot: boolean; enforceableSavings: boolean; operators: string[]; currencies: string[]; note: string;
  /** false = barème de frais réel inconnu : aucune exécution possible (jamais de frais inventés). Absent = connus. */
  feesKnown?: boolean;
}
export interface CreateResult { status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED'; providerRef: string; evidence: Record<string, unknown> }
export interface StatusResult { status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'NOT_FOUND'; providerRef?: string; amountMinor?: bigint; feeMinor?: bigint; evidence: Record<string, unknown> }
export interface WebhookEvent { providerEventId: string; merchantRef: string; providerRef?: string; status: 'SUCCEEDED' | 'FAILED' | 'REFUNDED' | 'PROCESSING'; amountMinor: bigint; feeMinor?: bigint; currency: string; eventAt?: Date; raw: Record<string, unknown> }

/** Contrat interne unique (backend.md §21.2). Aucune capacité n'est supposée : chaque adaptateur déclare ce qu'il sait faire. */
export interface PaymentProviderPort {
  readonly id: string;
  /** Référence du solde chez le prestataire (ex. identifiant de boutique), si le compte est unique. */
  readonly balanceRef?: string;
  getCapabilities(): ProviderCapabilities;
  estimateFees(direction: 'PAYIN' | 'PAYOUT', amountNetMinor: bigint, operator: string): { feeMinor: bigint; quoteTtlMs: number; basis: string };
  verifyBeneficiary?(phoneE164: string, operator: string): Promise<{ officialName: string | null }>;
  createPayout(req: { merchantRef: string; phoneE164: string; operator: string; amountNetMinor: bigint; currency: string }): Promise<CreateResult>;
  createPayin(req: { merchantRef: string; phoneE164: string; operator: string; amountMinor: bigint; currency: string }): Promise<CreateResult>;
  /** Lecture seule. `providerRef` = référence attribuée par le prestataire (requise par certains, ex. FeexPay). */
  getPaymentStatus(merchantRef: string, ctx?: { providerRef?: string | null; direction?: 'PAYIN' | 'PAYOUT' }): Promise<StatusResult>;
  /** null = le prestataire ne connaît pas (ou plus) ce solde : aucune comparaison possible, aucun blocage. */
  getBalanceSnapshot?(providerBalanceRef: string): Promise<{ balanceMinor: bigint; asOf: Date } | null>;
  validateWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent;
  healthCheck(): Promise<boolean>;
}

/** Aucun PSP configuré : toute opération réelle est refusée (état V1 par défaut). */
export class NoProvider implements PaymentProviderPort {
  id = 'none';
  getCapabilities(): ProviderCapabilities { return { provider: 'none', mode: 'NONE', payin: false, payout: false, verifyBeneficiary: false, balanceSnapshot: false, enforceableSavings: false, operators: [], currencies: [], note: 'Aucun prestataire de paiement n’est configuré. Les paiements réels sont désactivés.' }; }
  estimateFees() { return { feeMinor: 0n, quoteTtlMs: 0, basis: 'NONE' }; }
  async createPayout(): Promise<CreateResult> { throw new ProviderError('NOT_SUPPORTED', 'Aucun prestataire'); }
  async createPayin(): Promise<CreateResult> { throw new ProviderError('NOT_SUPPORTED', 'Aucun prestataire'); }
  async getPaymentStatus(): Promise<StatusResult> { throw new ProviderError('NOT_SUPPORTED', 'Aucun prestataire'); }
  validateWebhook(): WebhookEvent { throw new ProviderError('AUTH_FAILED', 'Aucun prestataire'); }
  async healthCheck() { return false; }
}

type FakeScenario = 'ACCEPT' | 'ACCEPT_AND_SUCCEED' | 'REJECT' | 'TIMEOUT_EXECUTED' | 'TIMEOUT_NOT_EXECUTED' | 'UNAVAILABLE';

/**
 * Prestataire SIMULÉ — environnements local/test UNIQUEMENT (interdit en production par la configuration).
 * Sert à exercer la machine d'états (UNKNOWN, webhooks doublons, timeouts). Ne déplace aucun argent réel.
 */
export class FakeProvider implements PaymentProviderPort {
  id = 'fake';
  scenario: FakeScenario = 'ACCEPT';
  calls: { op: string; merchantRef: string }[] = [];
  readonly ledger = new Map<string, { status: StatusResult['status']; providerRef: string; amountMinor: bigint; feeMinor: bigint }>();
  balances = new Map<string, bigint>();

  getCapabilities(): ProviderCapabilities {
    return { provider: 'fake', mode: 'SANDBOX_FAKE', payin: true, payout: true, verifyBeneficiary: false, balanceSnapshot: true, enforceableSavings: false, operators: ['MTN_BJ', 'MOOV_BJ', 'CELTIIS_BJ'], currencies: ['XOF'], note: 'Prestataire simulé de développement : aucune opération réelle. Ne jamais utiliser en production.' };
  }
  /** Barème fictif transparent : 1,5 % arrondi au supérieur, minimum 50 F. */
  estimateFees(direction: 'PAYIN' | 'PAYOUT', amountNetMinor: bigint) {
    if (direction === 'PAYIN') return { feeMinor: 0n, quoteTtlMs: 10 * 60_000, basis: 'FAKE_PAYIN_FREE' };
    const fee = (amountNetMinor * 15n + 999n) / 1000n;
    return { feeMinor: fee < 50n ? 50n : fee, quoteTtlMs: 10 * 60_000, basis: 'FAKE_1_5_PERCENT_MIN_50' };
  }
  private async exec(op: string, merchantRef: string, amount: bigint, fee: bigint): Promise<CreateResult> {
    this.calls.push({ op, merchantRef });
    const providerRef = `FAKE-${randomUUID().slice(0, 8)}`;
    switch (this.scenario) {
      case 'UNAVAILABLE': throw new ProviderError('PROVIDER_UNAVAILABLE', 'Service indisponible (simulé)');
      case 'REJECT': this.ledger.set(merchantRef, { status: 'FAILED', providerRef, amountMinor: amount, feeMinor: fee }); return { status: 'FAILED', providerRef, evidence: { simulated: true, reason: 'REJECTED' } };
      case 'TIMEOUT_EXECUTED': this.ledger.set(merchantRef, { status: 'SUCCEEDED', providerRef, amountMinor: amount, feeMinor: fee }); throw new ProviderError('UNKNOWN_OUTCOME', 'Délai dépassé (simulé, exécuté côté prestataire)');
      case 'TIMEOUT_NOT_EXECUTED': throw new ProviderError('UNKNOWN_OUTCOME', 'Délai dépassé (simulé, non exécuté)');
      case 'ACCEPT_AND_SUCCEED': this.ledger.set(merchantRef, { status: 'SUCCEEDED', providerRef, amountMinor: amount, feeMinor: fee }); return { status: 'PROCESSING', providerRef, evidence: { simulated: true } };
      default: this.ledger.set(merchantRef, { status: 'PROCESSING', providerRef, amountMinor: amount, feeMinor: fee }); return { status: 'PROCESSING', providerRef, evidence: { simulated: true } };
    }
  }
  createPayout(r: { merchantRef: string; amountNetMinor: bigint }) { return this.exec('payout', r.merchantRef, r.amountNetMinor, this.estimateFees('PAYOUT', r.amountNetMinor).feeMinor); }
  createPayin(r: { merchantRef: string; amountMinor: bigint }) { return this.exec('payin', r.merchantRef, r.amountMinor, 0n); }
  async getPaymentStatus(merchantRef: string): Promise<StatusResult> {
    this.calls.push({ op: 'status', merchantRef });
    const e = this.ledger.get(merchantRef);
    if (!e) return { status: 'PROCESSING', evidence: { simulated: true, unknownToThisInstance: true } };
    return { status: e.status, providerRef: e.providerRef, amountMinor: e.amountMinor, feeMinor: e.feeMinor, evidence: { simulated: true } };
  }
  async getBalanceSnapshot(ref: string) { const b = this.balances.get(ref); return b === undefined ? null : { balanceMinor: b, asOf: new Date() }; }
  /** Webhook signé HMAC-SHA256 (en-tête X-Ravzo-Signature) sur le corps brut. */
  static sign(body: string) { return createHmac('sha256', config.webhookVerifySecret).update(body).digest('hex'); }
  validateWebhook(raw: Buffer, headers: Record<string, any>): WebhookEvent {
    const sig = String(headers['x-ravzo-signature'] ?? '');
    if (!config.webhookVerifySecret || !safeEqual(sig, createHmac('sha256', config.webhookVerifySecret).update(raw).digest('hex'))) throw new ProviderError('AUTH_FAILED', 'Signature de webhook invalide');
    const b = JSON.parse(raw.toString('utf8'));
    if (!b.eventId || !b.merchantRef || !b.status || !/^\d+$/.test(String(b.amountMinor))) throw new ProviderError('AUTH_FAILED', 'Webhook mal formé');
    return { providerEventId: String(b.eventId), merchantRef: String(b.merchantRef), providerRef: b.providerRef, status: b.status, amountMinor: BigInt(b.amountMinor), feeMinor: b.feeMinor !== undefined ? BigInt(b.feeMinor) : undefined, currency: b.currency ?? 'XOF', eventAt: b.eventAt ? new Date(b.eventAt) : undefined, raw: { ...b, signature: undefined } };
  }
  async healthCheck() { return this.scenario !== 'UNAVAILABLE'; }
}

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';
export function providerFactory(): PaymentProviderPort {
  if (config.pspProvider === 'fake') return new FakeProvider();
  if (config.pspProvider === 'feexpay') {
    // Import tardif : évite une dépendance circulaire (l'adaptateur importe les types de ce module).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FeexPayProvider, feexpayOptionsFromConfig } = require('./feexpay.provider');
    return new FeexPayProvider(feexpayOptionsFromConfig());
  }
  return new NoProvider();
}
/** Exécution autorisée ? Fake = bac à sable uniquement ; un vrai PSP exige en plus PAYMENTS_LIVE_ENABLED (T26). */
export function executionMode(p: PaymentProviderPort): { executable: boolean; mode: string; reason: string | null } {
  const caps = p.getCapabilities();
  if (caps.mode === 'NONE') return { executable: false, mode: 'NONE', reason: 'PSP_NOT_CONFIGURED' };
  if (caps.mode === 'SANDBOX_FAKE') return { executable: config.appEnv !== 'production', mode: 'SANDBOX_FAKE', reason: config.appEnv === 'production' ? 'FAKE_FORBIDDEN' : null };
  if (caps.feesKnown === false) return { executable: false, mode: caps.mode, reason: 'PSP_FEES_UNCONFIGURED' };
  if (!caps.payout && !caps.payin) return { executable: false, mode: caps.mode, reason: 'PSP_NOT_CONFIGURED' };
  // Bac à sable d'un vrai prestataire (aucun argent réel) : autorisé hors production sans le drapeau « live ».
  if (caps.mode === 'SANDBOX' && config.appEnv !== 'production') return { executable: true, mode: 'SANDBOX', reason: null };
  if (!config.paymentsLiveEnabled) return { executable: false, mode: caps.mode, reason: 'PAYMENTS_LIVE_DISABLED' };
  return { executable: true, mode: 'LIVE', reason: null };
}
