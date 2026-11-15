import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentState } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth';
import { addMs, clock, economicToday } from '../../common/clock';
import { canonicalJson, digestOf, sha256 } from '../../common/crypto';
import { DomainError, notFound } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { toJsonSafe } from '../../common/http';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { WalletsService } from '../accounts/wallets.service';
import { StepUpService } from '../identity/step-up.service';
import { BooksService } from '../ledger/books.service';
import { LedgerService } from '../ledger/ledger.service';
import { LimitsService } from './limits.service';
import { executionMode, FakeProvider, PAYMENT_PROVIDER, PaymentProviderPort, ProviderError, WebhookEvent } from './provider.port';

const TERMINAL: PaymentState[] = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED_AFTER_SUCCESS'];
const E164 = /^\+229\d{8,10}$|^\+\d{8,15}$/;

/**
 * Machine d'états des paiements (backend.md §10, §20). Invariants :
 * - aucune seconde soumission PSP pour une intention (merchantRef déterministe unique, verrou de soumission) ;
 * - appel PSP HORS transaction SQL ; UNKNOWN n'est pas un échec et garde ses réservations ;
 * - posting terminal exactement une fois (unicité businessType/businessId).
 */
@Injectable()
export class PaymentsService {
  private log = new Logger('Payments');
  constructor(
    private prisma: PrismaService, @Inject(PAYMENT_PROVIDER) public provider: PaymentProviderPort, private limits: LimitsService, private stepUp: StepUpService,
    private ledger: LedgerService, private books: BooksService, private accounts: AccountsService, private wallets: WalletsService, private events: EventsService,
  ) {}

  capabilities() {
    const caps = this.provider.getCapabilities();
    const exec = executionMode(this.provider);
    return { ...caps, executable: exec.executable, executionMode: exec.mode, nonExecutableReason: exec.reason, paymentsLiveEnabled: exec.mode === 'LIVE', realMoney: exec.mode === 'LIVE', serverTime: clock.now() };
  }

  private async transition(tx: Tx, intentId: string, from: PaymentState | null, to: PaymentState, cause: string, actor: string, evidenceRef?: string, extra: Record<string, unknown> = {}) {
    const upd = await tx.paymentIntent.updateMany({ where: { id: intentId, ...(from ? { state: from } : {}) }, data: { state: to, version: { increment: 1 }, ...extra } });
    if (upd.count !== 1) throw new DomainError('PAYMENT_STATE_CONFLICT', `Transition ${from} → ${to} impossible`);
    await tx.paymentStateHistory.create({ data: { intentId, from, to, cause, actor, evidenceRef } });
    const i = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intentId } });
    await this.events.emit(tx, { ownerId: i.ownerId, eventType: 'payment.updated', aggregateType: 'PaymentIntent', aggregateId: intentId, version: i.version, payload: { state: to } });
    return i;
  }

  // ─── Bac à sable : compte PSP simulé (jamais disponible en production ni avec un PSP réel) ───
  async provisionSandbox(tx: Tx, auth: AuthContext, dto: { name: string; openingMinor: bigint }) {
    if (!(this.provider instanceof FakeProvider)) throw new DomainError('PSP_NOT_AUTHORIZED', 'Bac à sable disponible uniquement avec le prestataire simulé');
    const group = await tx.realBalanceGroup.create({ data: { ownerId: auth.ownerId, name: `${dto.name} (bac à sable)`, providerId: 'fake', providerBalanceRef: `fake-bal-${randomUUID().slice(0, 8)}` } });
    const id = randomUUID();
    const la = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:FA:${id}`, name: `PSP simulé — ${dto.name}`, kind: 'ASSET' });
    const fa = await tx.financialAccount.create({ data: { id, ownerId: auth.ownerId, ledgerAccountId: la.id, name: `${dto.name} — SIMULÉ`, institution: 'Prestataire simulé', type: 'CONTROLLED_PSP', realBalanceGroupId: group.id, verificationLevel: 'PROVIDER_VERIFIED', lastVerifiedAt: clock.now(), includeInSpendable: false, providerAccountId: group.providerBalanceRef } });
    if (dto.openingMinor > 0n) {
      const eq = await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING');
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ACCOUNT_OPENING', businessId: fa.id, memo: 'Fonds fictifs du bac à sable', source: 'SANDBOX', postings: [{ accountId: la.id, amount: dto.openingMinor }, { accountId: eq.id, amount: -dto.openingMinor }] });
      (this.provider as FakeProvider).balances.set(group.providerBalanceRef!, dto.openingMinor);
    }
    return { group, account: fa, simulated: true };
  }

  // ─── Bénéficiaires ───
  async beneficiaries(auth: AuthContext) { return this.prisma.beneficiary.findMany({ where: { ownerId: auth.ownerId, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } }); }
  async createBeneficiary(auth: AuthContext, dto: { displayName: string; phoneE164: string; operator: string; isOwnAccount?: boolean }) {
    const phone = dto.phoneE164.replace(/[\s.-]/g, '');
    if (!E164.test(phone)) throw new DomainError('VALIDATION_FAILED', 'Numéro au format international E.164 requis (ex. +22901XXXXXXXX)');
    const caps = this.provider.getCapabilities();
    if (caps.operators.length && !caps.operators.includes(dto.operator)) throw new DomainError('BENEFICIARY_NOT_SUPPORTED', 'Opérateur non pris en charge par le prestataire', { supported: caps.operators });
    return this.prisma.beneficiary.create({ data: { ownerId: auth.ownerId, displayName: dto.displayName, phoneE164: phone, operator: dto.operator, isOwnAccount: dto.isOwnAccount ?? false, verificationSource: caps.verifyBeneficiary ? 'NONE' : 'UNAVAILABLE' } });
  }
  /** Vérification officielle uniquement si le PSP l'offre ; sinon UNAVAILABLE (jamais d'identité inventée). */
  async verifyBeneficiary(auth: AuthContext, id: string) {
    const b = await this.prisma.beneficiary.findUnique({ where: { id } });
    if (!b || b.ownerId !== auth.ownerId) throw notFound('Bénéficiaire');
    if (!this.provider.getCapabilities().verifyBeneficiary || !this.provider.verifyBeneficiary) {
      const r = await this.prisma.beneficiary.update({ where: { id }, data: { verificationSource: 'UNAVAILABLE' } });
      return { ...r, verification: 'UNAVAILABLE', message: 'Vérification officielle du nom indisponible chez le prestataire : contrôle renforcé exigé à chaque paiement.' };
    }
    const res = await this.provider.verifyBeneficiary(b.phoneE164, b.operator);
    return this.prisma.beneficiary.update({ where: { id }, data: { officialName: res.officialName, officialVerificationAt: clock.now(), verificationSource: 'PROVIDER' } });
  }

  /** Compte prestataire du PSP ACTIF uniquement (un ancien compte de bac à sable ne peut jamais servir de source réelle). */
  private async sourceAccount(db: Tx | PrismaService, ownerId: string) {
    const groups = await db.realBalanceGroup.findMany({ where: { ownerId, providerId: this.provider.id }, select: { id: true } });
    return db.financialAccount.findFirst({ where: { ownerId, type: 'CONTROLLED_PSP', status: 'ACTIVE', realBalanceGroupId: { in: groups.map((g) => g.id) } }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * Relie le compte du prestataire réel (ex. boutique FeexPay) : balance réelle + compte CONTROLLED_PSP dont le solde
   * d'ouverture est l'instantané du prestataire (PROVIDER_VERIFIED). Idempotent : un seul compte par référence de solde.
   */
  async connectProvider(tx: Tx, auth: AuthContext, dto: { name?: string }) {
    const caps = this.provider.getCapabilities();
    if (caps.mode === 'NONE' || caps.mode === 'SANDBOX_FAKE') throw new DomainError('PSP_NOT_AUTHORIZED', 'Aucun prestataire réel configuré');
    const ref = this.provider.balanceRef;
    if (!ref || !this.provider.getBalanceSnapshot) throw new DomainError('PSP_NOT_AUTHORIZED', 'Le prestataire ne fournit pas de solde consultable');
    const existing = await tx.realBalanceGroup.findFirst({ where: { ownerId: auth.ownerId, providerId: this.provider.id, providerBalanceRef: ref } });
    if (existing) {
      const fa = await tx.financialAccount.findFirst({ where: { realBalanceGroupId: existing.id, type: 'CONTROLLED_PSP' } });
      return { group: existing, account: fa, alreadyConnected: true };
    }
    let snap;
    try { snap = await this.provider.getBalanceSnapshot(ref); } catch (e: any) { throw new DomainError('PSP_UNAVAILABLE', `Solde du prestataire illisible : ${e?.message ?? e}`); }
    if (!snap) throw new DomainError('PSP_NOT_AUTHORIZED', 'Compte prestataire introuvable');
    const label = dto.name?.trim() || (this.provider.id === 'feexpay' ? 'FeexPay' : this.provider.id);
    const group = await tx.realBalanceGroup.create({ data: { ownerId: auth.ownerId, name: label, providerId: this.provider.id, providerBalanceRef: ref, verifiedBalanceMinor: snap.balanceMinor, verifiedAt: snap.asOf } });
    const id = randomUUID();
    const la = await this.ledger.ensureAccount(tx, { ownerId: auth.ownerId, code: `ASSET:FA:${id}`, name: label, kind: 'ASSET' });
    const fa = await tx.financialAccount.create({ data: { id, ownerId: auth.ownerId, ledgerAccountId: la.id, name: label, institution: caps.mode === 'SANDBOX' ? `${label} (sandbox)` : label, type: 'CONTROLLED_PSP', realBalanceGroupId: group.id, verificationLevel: 'PROVIDER_VERIFIED', lastVerifiedAt: snap.asOf, includeInSpendable: true, providerAccountId: ref } });
    await tx.providerBalanceSnapshot.create({ data: { realBalanceGroupId: group.id, providerRef: ref, balanceMinor: snap.balanceMinor, asOf: snap.asOf, source: 'CONNECT', rawDigest: sha256(`${snap.balanceMinor}|${snap.asOf.toISOString()}`) } });
    if (snap.balanceMinor > 0n) {
      const eq = await this.books.core(tx, auth.ownerId, 'EQUITY:OPENING');
      await this.ledger.post(tx, { ownerId: auth.ownerId, businessType: 'ACCOUNT_OPENING', businessId: fa.id, memo: `Solde ${label} attesté par le prestataire`, source: 'PSP', actorDeviceId: auth.deviceId, postings: [{ accountId: la.id, amount: snap.balanceMinor }, { accountId: eq.id, amount: -snap.balanceMinor }] });
    }
    await this.events.audit(tx, { ownerId: auth.ownerId, actorId: auth.deviceId, action: 'PSP_ACCOUNT_CONNECTED', resource: `FinancialAccount:${fa.id}`, context: { provider: this.provider.id, mode: caps.mode } });
    await this.events.emit(tx, { ownerId: auth.ownerId, eventType: 'balance.updated', aggregateType: 'FinancialAccount', aggregateId: fa.id, version: 1 });
    return { group, account: fa, alreadyConnected: false };
  }

  /** Solde détaillé (par réseau) chez le prestataire — lecture seule. */
  async providerBalance() {
    const p: any = this.provider;
    if (typeof p.balance !== 'function') throw new DomainError('PSP_NOT_AUTHORIZED', 'Solde détaillé non disponible pour ce prestataire');
    try {
      const b = await p.balance();
      if (!b) throw new DomainError('NOT_FOUND', 'Compte prestataire introuvable');
      return { provider: this.provider.id, totalMinor: b.totalMinor, channels: b.channels, asOf: b.asOf };
    } catch (e: any) {
      if (e instanceof DomainError) throw e;
      throw new DomainError('PSP_UNAVAILABLE', `Solde du prestataire illisible : ${e?.message ?? e}`);
    }
  }

  // ─── Intentions ───
  async createPayout(auth: AuthContext, key: string | undefined, dto: { sourceWalletId: string; beneficiaryId: string; amountMode: 'TOTAL_DEBIT' | 'NET_RECEIVED'; amountMinor: bigint; currency: string; purposeCategoryId?: string; clientReference?: string; sourceAccountId?: string }) {
    if (!key || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key requis');
    const requestDigest = digestOf(dto);
    const existing = await this.prisma.paymentIntent.findUnique({ where: { ownerId_direction_idempotencyKey: { ownerId: auth.ownerId, direction: 'PAYOUT', idempotencyKey: key } } });
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Clé déjà utilisée avec un contenu différent');
      return this.view(this.prisma, existing.id);
    }
    if (dto.currency !== 'XOF') throw new DomainError('VALIDATION_FAILED', 'Seul le XOF est pris en charge');
    const wallet = await this.wallets.getOwned(this.prisma, auth.ownerId, dto.sourceWalletId);
    if (wallet.kind !== 'CURRENT') throw new DomainError('BUSINESS_RULE_VIOLATION', 'Un paiement sort exclusivement du portefeuille courant');
    const b = await this.prisma.beneficiary.findUnique({ where: { id: dto.beneficiaryId } });
    if (!b || b.ownerId !== auth.ownerId || b.status !== 'ACTIVE') throw notFound('Bénéficiaire');
    const exec = executionMode(this.provider);
    const src = dto.sourceAccountId ? await this.accounts.getOwned(this.prisma, auth.ownerId, dto.sourceAccountId) : await this.sourceAccount(this.prisma, auth.ownerId);
    if (src && src.type !== 'CONTROLLED_PSP') throw new DomainError('PSP_NOT_AUTHORIZED', 'Un solde déclaré manuellement ne peut pas alimenter un paiement (T25)');
    const quote = this.quote(dto.amountMode, dto.amountMinor, b.operator);
    const intent = await this.prisma.tx(async (tx) => {
      const i = await tx.paymentIntent.create({
        data: {
          ownerId: auth.ownerId, direction: 'PAYOUT', sourceAccountId: src?.id, sourceWalletId: wallet.id, beneficiaryId: b.id, amountMode: dto.amountMode,
          amountNetMinor: quote.net, feeQuoteMinor: quote.fee, totalDebitMinor: quote.net + quote.fee, currency: 'XOF', idempotencyKey: key, requestDigest,
          executable: exec.executable && !!src, nonExecutableReason: exec.reason ?? (!src ? 'NO_CONTROLLED_PSP_ACCOUNT' : null), quoteExpiresAt: addMs(clock.now(), quote.ttl),
          purposeCategoryId: dto.purposeCategoryId, clientReference: dto.clientReference, state: 'DRAFT',
        },
      });
      await tx.paymentStateHistory.create({ data: { intentId: i.id, to: 'DRAFT', cause: 'CREATED', actor: auth.deviceId ?? 'OWNER' } });
      await this.transition(tx, i.id, 'DRAFT', 'AWAITING_CONFIRMATION', 'QUOTED', auth.deviceId ?? 'OWNER', undefined, {});
      return i;
    });
    return this.view(this.prisma, intent.id);
  }

  private quote(mode: string, amount: bigint, operator: string) {
    const est = this.provider.estimateFees('PAYOUT', amount, operator);
    if (mode === 'NET_RECEIVED') return { net: amount, fee: est.feeMinor, ttl: est.quoteTtlMs || 10 * 60_000, basis: est.basis };
    // TOTAL_DEBIT : chercher le net maximal tel que net + frais(net) ≤ montant
    let net = amount - est.feeMinor;
    for (let k = 0; k < 20 && net > 0n; k++) {
      const f = this.provider.estimateFees('PAYOUT', net, operator).feeMinor;
      if (net + f <= amount) { const f2 = this.provider.estimateFees('PAYOUT', net + 1n, operator).feeMinor; if (net + 1n + f2 > amount) return { net, fee: f, ttl: est.quoteTtlMs || 600_000, basis: est.basis }; net += 1n; } else net -= 1n;
    }
    if (net <= 0n) throw new DomainError('VALIDATION_FAILED', 'Montant insuffisant pour couvrir les frais');
    return { net, fee: this.provider.estimateFees('PAYOUT', net, operator).feeMinor, ttl: est.quoteTtlMs || 600_000, basis: est.basis };
  }

  /** Vue avec plafonds, vérification bénéficiaire, restrictions — statuts canoniques serveur. */
  async view(db: Tx | PrismaService, id: string) {
    const i = await db.paymentIntent.findUniqueOrThrow({ where: { id }, include: { attempts: true, history: { orderBy: { at: 'asc' } } } });
    const b = i.beneficiaryId ? await db.beneficiary.findUnique({ where: { id: i.beneficiaryId } }) : null;
    const pol = await this.limits.activePolicy(db, i.ownerId);
    const used = await this.limits.usedInWindow(db, i.ownerId);
    const funds = await db.fundsHold.findUnique({ where: { paymentIntentId: id } });
    const lim = await db.limitHold.findUnique({ where: { paymentIntentId: id } });
    const exc = i.exceptionId ? this.limits.exceptionView(await db.exceptionAuthorization.findUniqueOrThrow({ where: { id: i.exceptionId } })) : null;
    return {
      ...i, attempts: i.attempts.map((a) => ({ id: a.id, provider: a.provider, state: a.state, submittedAt: a.submittedAt, lastStatusCheckedAt: a.lastStatusCheckedAt })),
      beneficiary: b && { id: b.id, displayName: b.displayName, phoneE164: b.phoneE164, operator: b.operator, officialName: b.officialName, verification: b.officialVerificationAt ? 'OFFICIAL' : 'UNVERIFIED_CONTACT_NAME', isOwnAccount: b.isOwnAccount },
      limits: { perOperationMinor: pol.perOperationMinor, rolling24hMinor: pol.rolling24hMinor, usedInWindowMinor: used.usedMinor, wouldExceedPerOperation: i.totalDebitMinor > pol.perOperationMinor, wouldExceedRolling: !lim && used.usedMinor + i.totalDebitMinor > pol.rolling24hMinor },
      holds: { funds: funds?.state ?? null, limit: lim?.state ?? null }, exception: exc,
      quoteExpired: !!i.quoteExpiresAt && i.quoteExpiresAt < clock.now() && ['DRAFT', 'AWAITING_CONFIRMATION'].includes(i.state),
      resultReliable: TERMINAL.includes(i.state), isUncertain: i.state === 'UNKNOWN', simulated: this.provider instanceof FakeProvider,
    };
  }
  async get(auth: AuthContext, id: string) {
    const i = await this.prisma.paymentIntent.findUnique({ where: { id } });
    if (!i || i.ownerId !== auth.ownerId) throw notFound('Paiement');
    return this.view(this.prisma, id);
  }
  async list(auth: AuthContext, state?: string) {
    const items = await this.prisma.paymentIntent.findMany({ where: { ownerId: auth.ownerId, ...(state ? { state: state as PaymentState } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return items;
  }

  /** Paramètres canoniques signés : toute modification après signature invalide la preuve (T20). */
  canonicalAuthorizeParams(i: { id: string; sourceAccountId: string | null; beneficiaryId: string | null; amountNetMinor: bigint; feeQuoteMinor: bigint; totalDebitMinor: bigint; currency: string; quoteExpiresAt: Date | null; version: number }, policyVersion: number) {
    return { intentId: i.id, sourceAccountId: i.sourceAccountId, beneficiaryId: i.beneficiaryId, amountNetMinor: i.amountNetMinor.toString(), feeMinor: i.feeQuoteMinor.toString(), totalDebitMinor: i.totalDebitMinor.toString(), currency: i.currency, quoteExpiresAt: i.quoteExpiresAt?.toISOString() ?? null, policyVersion, intentVersion: i.version };
  }
  async authorizationChallenge(auth: AuthContext, id: string) {
    const i = await this.prisma.paymentIntent.findUnique({ where: { id } });
    if (!i || i.ownerId !== auth.ownerId) throw notFound('Paiement');
    if (i.state !== 'AWAITING_CONFIRMATION') throw new DomainError('PAYMENT_STATE_CONFLICT', 'Paiement non en attente de confirmation');
    const pol = await this.limits.activePolicy(this.prisma, auth.ownerId);
    const params = this.canonicalAuthorizeParams(i, pol.policyVersion);
    return { ...(await this.stepUp.createChallenge(auth, 'payment.authorize', params, { policyVersion: pol.policyVersion })), summary: params };
  }
  async requote(auth: AuthContext, id: string) {
    const i = await this.prisma.paymentIntent.findUnique({ where: { id } });
    if (!i || i.ownerId !== auth.ownerId) throw notFound('Paiement');
    if (i.state !== 'AWAITING_CONFIRMATION') throw new DomainError('PAYMENT_STATE_CONFLICT', 'Paiement déjà engagé');
    const b = await this.prisma.beneficiary.findUniqueOrThrow({ where: { id: i.beneficiaryId! } });
    const q = this.quote('NET_RECEIVED', i.amountNetMinor, b.operator);
    await this.prisma.paymentIntent.update({ where: { id }, data: { feeQuoteMinor: q.fee, totalDebitMinor: q.net + q.fee, quoteExpiresAt: addMs(clock.now(), q.ttl), version: { increment: 1 } } });
    return this.view(this.prisma, id);
  }

  /** Garde de Payout complète (backend.md §10.2) puis réservation atomique fonds + plafond (+ dérogation). */
  async authorize(auth: AuthContext, id: string, dto: { approval?: { challengeId: string; signature: string }; acknowledgeUnverifiedBeneficiary?: boolean }) {
    const exec = executionMode(this.provider);
    return this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${id}::uuid FOR UPDATE`;
      const i = await tx.paymentIntent.findUnique({ where: { id } });
      if (!i || i.ownerId !== auth.ownerId) throw notFound('Paiement');
      if (i.direction !== 'PAYOUT') throw new DomainError('PAYMENT_STATE_CONFLICT', 'Autorisation forte réservée aux paiements sortants');
      if (i.state !== 'AWAITING_CONFIRMATION') {
        if (['RESERVED', 'SUBMITTING', 'PROCESSING', 'SUCCEEDED', 'UNKNOWN'].includes(i.state)) return this.view(tx, id); // idempotent
        throw new DomainError('PAYMENT_STATE_CONFLICT', `Paiement en état ${i.state}`);
      }
      // 1. Prestataire / drapeau
      if (!exec.executable || !i.executable) throw new DomainError('PSP_NOT_AUTHORIZED', 'Paiements réels non activés : ce paiement reste un brouillon non exécutable', { reason: i.nonExecutableReason ?? exec.reason });
      // 2. Appareil + suspension (contrôleur) + balance bloquée
      const src = await this.accounts.getOwned(tx, auth.ownerId, i.sourceAccountId!);
      const group = src.realBalanceGroupId ? await tx.realBalanceGroup.findUnique({ where: { id: src.realBalanceGroupId } }) : null;
      if (group?.status === 'BLOCKED_OUTBOUND') throw new DomainError('BALANCE_RECONCILIATION_BLOCK', 'Sorties bloquées : écart de rapprochement non résolu', { reason: group.blockReason });
      // 3. Bénéficiaire non vérifié → confirmation renforcée explicite
      const b = await tx.beneficiary.findUniqueOrThrow({ where: { id: i.beneficiaryId! } });
      if (!b.officialVerificationAt && !dto.acknowledgeUnverifiedBeneficiary) throw new DomainError('BENEFICIARY_UNVERIFIED_CONFIRMATION_REQUIRED', 'Nom du bénéficiaire non vérifié officiellement : confirmez explicitement le destinataire');
      // 4. Devis à jour
      if (i.quoteExpiresAt && i.quoteExpiresAt < clock.now()) throw new DomainError('PAYMENT_STATE_CONFLICT', 'Devis de frais expiré : actualisez et confirmez à nouveau', { requote: true });
      // 8. Preuve forte liée aux paramètres exacts
      const pol = await this.limits.lockPolicy(tx, auth.ownerId);
      await this.stepUp.verifyAndConsume(tx, auth, dto.approval, 'payment.authorize', this.canonicalAuthorizeParams(i, pol.policyVersion));
      // 5. Fonds réels confirmés (primaire), holds actifs déduits ; portefeuille courant suffisant
      await tx.$queryRaw`SELECT 1 FROM "AccountBalance" WHERE "ledgerAccountId" = ${src.ledgerAccountId}::uuid FOR UPDATE`;
      const bal = await this.ledger.balance(tx, src.ledgerAccountId);
      const held = (await tx.fundsHold.aggregate({ where: { financialAccountId: src.id, state: 'ACTIVE' }, _sum: { amountMinor: true } }))._sum.amountMinor ?? 0n;
      if (bal - held < i.totalDebitMinor) throw new DomainError('INSUFFICIENT_CONFIRMED_FUNDS', 'Fonds confirmés insuffisants', { availableMinor: bal - held });
      // 6–7. Plafonds (frais inclus, holds concurrents inclus) ou dérogation unique
      const used = await this.limits.usedInWindow(tx, auth.ownerId);
      const overOp = i.totalDebitMinor > pol.perOperationMinor;
      const overRolling = used.usedMinor + i.totalDebitMinor > pol.rolling24hMinor;
      if (overOp || overRolling) {
        if (!i.exceptionId) throw new DomainError(overOp ? 'LIMIT_PER_OPERATION_EXCEEDED' : 'LIMIT_ROLLING_WINDOW_EXCEEDED', overOp ? 'Plafond par opération dépassé (frais inclus)' : 'Plafond sur 24 h glissantes dépassé', { perOperationMinor: pol.perOperationMinor, rolling24hMinor: pol.rolling24hMinor, usedInWindowMinor: used.usedMinor, totalDebitMinor: i.totalDebitMinor });
        await this.limits.consumeException(tx, auth.ownerId, i);
      }
      // 9. Réservations atomiques + états + outbox
      const now = clock.now();
      await this.transition(tx, id, 'AWAITING_CONFIRMATION', 'AUTHORIZED', 'STRONG_APPROVAL', auth.deviceId!, undefined, { authorizedAt: now, policyVersion: pol.policyVersion, operationDigest: digestOf(this.canonicalAuthorizeParams(i, pol.policyVersion)) });
      await tx.fundsHold.create({ data: { ownerId: auth.ownerId, paymentIntentId: id, realBalanceGroupId: group?.id, financialAccountId: src.id, amountMinor: i.totalDebitMinor } });
      await tx.limitHold.create({ data: { ownerId: auth.ownerId, paymentIntentId: id, amountDebitMinor: i.totalDebitMinor, windowAnchoredAt: now } });
      await this.transition(tx, id, 'AUTHORIZED', 'RESERVED', 'HOLDS_CREATED', 'SERVER');
      await this.events.notify(tx, { ownerId: auth.ownerId, sourceEventId: `payout-authorized:${id}`, type: 'payment.authorized', category: 'PAYMENT', priority: 'HIGH', title: 'Paiement autorisé', body: 'Un paiement sortant a été autorisé depuis un de vos appareils.', link: `/money/payments/${id}` });
      return this.view(tx, id);
    }, { serializable: true });
  }

  /** Soumission unique : merchantRef définitif persistant AVANT l'appel réseau, appel hors transaction (§20.3). */
  async submit(ownerId: string, id: string, actor = 'OWNER') {
    const prepared = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${id}::uuid FOR UPDATE`;
      const i = await tx.paymentIntent.findUnique({ where: { id } });
      if (!i || i.ownerId !== ownerId) throw notFound('Paiement');
      if (i.state !== 'RESERVED') return null; // déjà soumis ou non soumettable : idempotent
      const merchantRef = `RVZ-${i.id}`;
      const attempt = await tx.paymentAttempt.create({ data: { intentId: i.id, provider: this.provider.id, merchantRef, state: 'SUBMITTING', submittedAt: clock.now() } });
      await this.transition(tx, id, 'RESERVED', 'SUBMITTING', 'SUBMIT_REQUESTED', actor, undefined, { currentAttemptId: attempt.id });
      return { i, attempt };
    });
    if (!prepared) return this.view(this.prisma, id);
    const { i, attempt } = prepared;
    let outcome: { kind: 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'UNAVAILABLE'; providerRef?: string; evidence: any };
    try {
      const b = i.beneficiaryId ? await this.prisma.beneficiary.findUnique({ where: { id: i.beneficiaryId } }) : null;
      const r = i.direction === 'PAYOUT'
        ? await this.provider.createPayout({ merchantRef: attempt.merchantRef, phoneE164: b!.phoneE164, operator: b!.operator, amountNetMinor: i.amountNetMinor, currency: i.currency })
        : await this.provider.createPayin({ merchantRef: attempt.merchantRef, phoneE164: b?.phoneE164 ?? '', operator: b?.operator ?? '', amountMinor: i.totalDebitMinor, currency: i.currency }); // le payeur règle net + frais
      outcome = { kind: r.status, providerRef: r.providerRef, evidence: r.evidence };
    } catch (e) {
      const pe = e instanceof ProviderError ? e : new ProviderError('UNKNOWN_OUTCOME', String((e as any)?.message ?? e));
      // Seule une indisponibilité AVANT envoi (refus de connexion) prouve la non-exécution ; tout le reste est UNKNOWN.
      outcome = pe.code === 'PROVIDER_UNAVAILABLE' ? { kind: 'UNAVAILABLE', evidence: { error: pe.code } } : pe.code === 'REJECTED_TERMINAL' ? { kind: 'FAILED', evidence: { error: pe.code } } : { kind: 'UNKNOWN', evidence: { error: pe.code } };
    }
    await this.prisma.tx(async (tx) => {
      const evidenceRef = sha256(canonicalJson(toJsonSafe(outcome.evidence)));
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { state: outcome.kind, providerRef: outcome.providerRef, resultEvidenceRef: evidenceRef } });
      if (outcome.kind === 'PROCESSING') await this.transition(tx, id, 'SUBMITTING', 'PROCESSING', 'PROVIDER_ACCEPTED', 'PSP', evidenceRef);
      else if (outcome.kind === 'SUCCEEDED') { await this.transition(tx, id, 'SUBMITTING', 'PROCESSING', 'PROVIDER_ACCEPTED', 'PSP', evidenceRef); await this.finalize(tx, id, 'SUCCEEDED', 'PROVIDER_SYNC_SUCCESS', evidenceRef); }
      else if (outcome.kind === 'FAILED') { await this.transition(tx, id, 'SUBMITTING', 'PROCESSING', 'PROVIDER_RESPONSE', 'PSP', evidenceRef); await this.finalize(tx, id, 'FAILED', 'PROVIDER_REJECTED_TERMINAL', evidenceRef); }
      else if (outcome.kind === 'UNAVAILABLE') {
        // Non envoyé : on revient à un état NON soumis ; une nouvelle confirmation sera exigée (§10.5).
        await this.transition(tx, id, 'SUBMITTING', 'PROCESSING', 'PROVIDER_UNAVAILABLE', 'PSP', evidenceRef);
        await this.finalize(tx, id, 'FAILED', 'PROVIDER_UNAVAILABLE_NOT_SENT', evidenceRef);
        await tx.pspAvailability.upsert({ where: { provider_capability: { provider: this.provider.id, capability: i.direction } }, create: { provider: this.provider.id, capability: i.direction, state: 'DOWN', checkedAt: clock.now(), nextProbeAt: addMs(clock.now(), 60_000), failureCount: 1 }, update: { state: 'DOWN', checkedAt: clock.now(), failureCount: { increment: 1 } } });
      } else {
        await this.transition(tx, id, 'SUBMITTING', 'PROCESSING', 'PROVIDER_CALL_AMBIGUOUS', 'PSP', evidenceRef);
        await this.transition(tx, id, 'PROCESSING', 'UNKNOWN', 'TIMEOUT_OR_AMBIGUOUS', 'SERVER', evidenceRef);
        await this.events.notify(tx, { ownerId, sourceEventId: `payment-unknown:${id}`, type: 'payment.unknown', category: 'PAYMENT', priority: 'CRITICAL', title: 'Résultat de paiement incertain', body: 'Le prestataire n’a pas confirmé le résultat. Aucun nouvel essai ne sera fait ; le statut est vérifié automatiquement.', link: `/money/payments/${id}` });
      }
    });
    return this.view(this.prisma, id);
  }

  /**
   * Transition terminale + écriture + conversion/libération des réservations, une seule fois (§20.4).
   * SUCCEEDED : débit PSP, dépense/transfert, holds SETTLED (le plafond reste consommé 24 h).
   * FAILED/CANCELLED avec preuve de non-exécution : holds RELEASED.
   */
  async finalize(tx: Tx, id: string, to: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED_AFTER_SUCCESS', cause: string, evidenceRef?: string, refundMinor?: bigint) {
    const i = await tx.paymentIntent.findUniqueOrThrow({ where: { id } });
    if (to === 'REFUNDED_AFTER_SUCCESS') {
      if (i.state !== 'SUCCEEDED') return i;
      const src = await tx.financialAccount.findUniqueOrThrow({ where: { id: i.sourceAccountId! } });
      const cat = await tx.category.findFirst({ where: { ownerId: i.ownerId, type: 'EXPENSE', name: 'Divers' } });
      const exp = await this.books.forCategory(tx, i.ownerId, cat!.id, 'EXPENSE', cat!.name);
      const amt = refundMinor ?? i.amountNetMinor;
      await this.ledger.post(tx, { ownerId: i.ownerId, businessType: 'PAYOUT_REFUND', businessId: i.id, memo: 'Remboursement après exécution', source: 'PSP', postings: [{ accountId: src.ledgerAccountId, amount: amt }, { accountId: exp.id, amount: -amt }] });
      return this.transition(tx, id, 'SUCCEEDED', 'REFUNDED_AFTER_SUCCESS', cause, 'PSP', evidenceRef); // LimitHold reste SETTLED (T04)
    }
    if (TERMINAL.includes(i.state)) return i; // pas de recul d'un terminal (§10.1)
    const from = i.state;
    if (to === 'SUCCEEDED') {
      const src = await tx.financialAccount.findUniqueOrThrow({ where: { id: i.sourceAccountId! } });
      const fee = await this.books.core(tx, i.ownerId, 'EXPENSE:FEES');
      if (i.direction === 'PAYOUT') {
        const b = await tx.beneficiary.findUniqueOrThrow({ where: { id: i.beneficiaryId! } });
        const catId = i.purposeCategoryId ?? (await tx.category.findFirst({ where: { ownerId: i.ownerId, type: 'EXPENSE', name: 'Divers' } }))!.id;
        const cat = await tx.category.findUniqueOrThrow({ where: { id: catId } });
        const destAcc = i.destinationAccountId ? await tx.financialAccount.findUnique({ where: { id: i.destinationAccountId } }) : null;
        const target = destAcc ? destAcc.ledgerAccountId : (await this.books.forCategory(tx, i.ownerId, cat.id, 'EXPENSE', cat.name)).id;
        const { transaction } = await this.ledger.post(tx, { ownerId: i.ownerId, businessType: 'PAYOUT', businessId: i.id, memo: `Paiement à ${b.displayName}`, source: 'PSP', externalCorrelationId: `RVZ-${i.id}`, postings: [{ accountId: src.ledgerAccountId, amount: -i.totalDebitMinor }, { accountId: target, amount: i.amountNetMinor }, { accountId: fee.id, amount: i.feeQuoteMinor }] });
        if (!destAcc) {
          const cycle = await tx.budgetCycle.findFirst({ where: { ownerId: i.ownerId, state: 'OPEN', startsAt: { lte: economicToday() }, plannedEndAt: { gte: economicToday() } } });
          await tx.expense.create({ data: { ownerId: i.ownerId, accountId: src.id, ledgerTransactionId: transaction.id, categoryId: cat.id, economicDate: economicToday(), amountMinor: i.amountNetMinor, label: `Paiement à ${b.displayName}`, source: 'PAYOUT', externalRef: `RVZ-${i.id}`, cycleId: cycle?.id ?? null, offCycle: !cycle } });
        }
      } else {
        const destAcc = await tx.financialAccount.findUniqueOrThrow({ where: { id: i.destinationAccountId! } });
        const srcTracked = i.sourceAccountId ? await tx.financialAccount.findUnique({ where: { id: i.sourceAccountId } }) : null;
        await this.ledger.post(tx, { ownerId: i.ownerId, businessType: 'PAYIN', businessId: i.id, memo: 'Dépôt confirmé (transfert de trésorerie, pas un revenu)', source: 'PSP', postings: [{ accountId: destAcc.ledgerAccountId, amount: i.amountNetMinor }, { accountId: srcTracked ? srcTracked.ledgerAccountId : (await this.books.core(tx, i.ownerId, 'CLEARING:PSP_TRANSIT')).id, amount: -(i.amountNetMinor + i.feeQuoteMinor) }, { accountId: fee.id, amount: i.feeQuoteMinor }] });
      }
      await tx.fundsHold.updateMany({ where: { paymentIntentId: id, state: 'ACTIVE' }, data: { state: 'SETTLED', settledAt: clock.now() } });
      await tx.limitHold.updateMany({ where: { paymentIntentId: id, state: 'ACTIVE' }, data: { state: 'SETTLED', settledAt: clock.now() } });
    } else {
      await tx.fundsHold.updateMany({ where: { paymentIntentId: id, state: 'ACTIVE' }, data: { state: 'RELEASED', settledAt: clock.now() } });
      await tx.limitHold.updateMany({ where: { paymentIntentId: id, state: 'ACTIVE' }, data: { state: 'RELEASED', releasedAt: clock.now() } });
    }
    const r = await this.transition(tx, id, from, to, cause, 'PSP', evidenceRef, { executedAt: to === 'SUCCEEDED' ? clock.now() : undefined });
    await this.events.notify(tx, { ownerId: i.ownerId, sourceEventId: `payment-${to}:${id}`, type: `payment.${to.toLowerCase()}`, category: 'PAYMENT', priority: to === 'SUCCEEDED' ? 'NORMAL' : 'HIGH', title: to === 'SUCCEEDED' ? 'Paiement confirmé' : to === 'CANCELLED' ? 'Paiement annulé' : 'Paiement échoué', body: to === 'SUCCEEDED' ? 'Le prestataire a confirmé l’exécution.' : 'Aucun débit : les réservations ont été libérées.', link: `/money/payments/${id}` });
    if (i.fundingStepId) await this.onFundingStepResult(tx, i.fundingStepId, to);
    return r;
  }

  async cancel(tx: Tx, auth: AuthContext, id: string) {
    await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${id}::uuid FOR UPDATE`;
    const i = await tx.paymentIntent.findUnique({ where: { id } });
    if (!i || i.ownerId !== auth.ownerId) throw notFound('Paiement');
    if (!['DRAFT', 'AWAITING_CONFIRMATION', 'AUTHORIZED', 'RESERVED'].includes(i.state)) throw new DomainError('PAYMENT_STATE_CONFLICT', 'Annulation impossible : le paiement a pu être transmis au prestataire. Vérifiez son statut.');
    await this.finalize(tx, id, 'CANCELLED', 'OWNER_CANCELLED_BEFORE_SUBMISSION');
    return this.view(tx, id);
  }

  /** Lecture de statut (jamais une nouvelle exécution) — réessayable (T06). */
  async recheck(ownerId: string, id: string) {
    const i = await this.prisma.paymentIntent.findUnique({ where: { id }, include: { attempts: true } });
    if (!i || i.ownerId !== ownerId) throw notFound('Paiement');
    const attempt = i.attempts.find((a) => a.id === i.currentAttemptId);
    if (!attempt || !['PROCESSING', 'UNKNOWN'].includes(i.state)) return this.view(this.prisma, id);
    let s;
    try { s = await this.provider.getPaymentStatus(attempt.merchantRef, { providerRef: attempt.providerRef, direction: i.direction }); } catch (e) {
      await this.prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { lastStatusCheckedAt: clock.now(), statusCheckCount: { increment: 1 } } });
      return this.view(this.prisma, id);
    }
    await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${id}::uuid FOR UPDATE`;
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { lastStatusCheckedAt: clock.now(), statusCheckCount: { increment: 1 }, providerRef: attempt.providerRef ?? s.providerRef } });
      const evidenceRef = sha256(canonicalJson(toJsonSafe(s.evidence)));
      if (s.status === 'SUCCEEDED') await this.finalizeFromUnknown(tx, id, 'SUCCEEDED', 'STATUS_API_CONFIRMED', evidenceRef);
      else if (s.status === 'FAILED') await this.finalizeFromUnknown(tx, id, 'FAILED', 'STATUS_API_FAILED', evidenceRef);
      // « Introuvable » n'est JAMAIS une preuve de non-exécution (délais de propagation, autre instance, panne) : l'état reste incertain.
    });
    return this.view(this.prisma, id);
  }
  private async finalizeFromUnknown(tx: Tx, id: string, to: 'SUCCEEDED' | 'FAILED', cause: string, ev: string) {
    const i = await tx.paymentIntent.findUniqueOrThrow({ where: { id } });
    if (i.state === 'UNKNOWN') await this.transition(tx, id, 'UNKNOWN', 'PROCESSING', 'NEW_EVIDENCE', 'SERVER', ev);
    return this.finalize(tx, id, to, cause, ev);
  }

  /** Webhook : authentifié, append-only, dédupliqué, contrôlé (montant/devise/référence), traité idempotemment (T07, T08, T12). */
  async handleWebhook(provider: string, raw: Buffer, headers: Record<string, any>) {
    if (provider !== this.provider.id) throw new DomainError('NOT_FOUND', 'Prestataire inconnu');
    let ev: WebhookEvent;
    try { ev = this.provider.validateWebhook(raw, headers); } catch (e) {
      await this.prisma.securityEvent.create({ data: { type: 'WEBHOOK_REJECTED', resourceType: provider, decision: 'INVALID_SIGNATURE', evidenceHash: sha256(raw) } });
      throw new DomainError('FORBIDDEN', 'Webhook non authentifié');
    }
    const digest = sha256(raw);
    const stored = await this.prisma.providerEvent.upsert({
      where: { provider_providerEventId: { provider, providerEventId: ev.providerEventId } },
      create: { provider, providerEventId: ev.providerEventId, payloadDigest: digest, payloadRedacted: toJsonSafe(ev.raw), verified: true, eventAt: ev.eventAt },
      update: {},
    });
    if (stored.processedAt) return { accepted: true, duplicate: true };
    await this.prisma.tx(async (tx) => {
      const claim = await tx.providerEvent.updateMany({ where: { id: stored.id, processedAt: null }, data: { processedAt: clock.now(), processState: 'PROCESSING' } });
      if (claim.count !== 1) return;
      // Référence marchande renvoyée par le prestataire (callback_info) ; à défaut, sa propre référence de transaction.
      const attempt = ev.merchantRef
        ? await tx.paymentAttempt.findUnique({ where: { merchantRef: ev.merchantRef }, include: { intent: true } })
        : ev.providerRef ? await tx.paymentAttempt.findFirst({ where: { provider: this.provider.id, providerRef: ev.providerRef }, include: { intent: true } }) : null;
      const anomaly = async (note: string) => {
        await tx.providerEvent.update({ where: { id: stored.id }, data: { processState: 'ANOMALY', processNote: note, attemptId: attempt?.id } });
        if (attempt) {
          const src = attempt.intent.sourceAccountId ? await tx.financialAccount.findUnique({ where: { id: attempt.intent.sourceAccountId } }) : null;
          // Contradiction d'état terminal : exprimée en mouvement sur le compte source, pour qu'une écriture compensatoire
          // éventuelle aille dans le bon sens (succès après échec : −total débité ; échec après succès : +total débité).
          const total = attempt.intent.totalDebitMinor;
          const [expected, observed] = note.startsWith('CONTRADICTS_TERMINAL_FAILED') || note.startsWith('CONTRADICTS_TERMINAL_CANCELLED') ? [0n, -total]
            : note.startsWith('CONTRADICTS_TERMINAL_SUCCEEDED') || note.startsWith('CONTRADICTS_TERMINAL_REFUNDED') ? [-total, 0n]
            : [attempt.intent.amountNetMinor, ev.amountMinor];
          const c = await tx.reconciliationCase.create({ data: { ownerId: attempt.intent.ownerId, realBalanceGroupId: src?.realBalanceGroupId, financialAccountId: src?.id, expectedMinor: expected, observedMinor: observed, reason: `WEBHOOK_MISMATCH: ${note}` } });
          await tx.reconciliationEvidence.create({ data: { caseId: c.id, kind: 'PROVIDER_EVENT', providerRef: ev.providerRef, note: `intent:${attempt.intent.id}`, digest } });
          if (src?.realBalanceGroupId) await tx.realBalanceGroup.update({ where: { id: src.realBalanceGroupId }, data: { status: 'BLOCKED_OUTBOUND', blockReason: 'Événement prestataire incohérent en cours d’analyse', version: { increment: 1 } } });
          await this.events.notify(tx, { ownerId: attempt.intent.ownerId, sourceEventId: `webhook-anomaly:${stored.id}`, type: 'reconciliation.anomaly', category: 'RECONCILIATION', priority: 'CRITICAL', title: 'Anomalie prestataire détectée', body: 'Un événement du prestataire ne correspond pas au paiement attendu. Les sorties de cette balance sont suspendues.', link: `/activity/reconciliation/${c.id}` });
        }
        await this.events.audit(tx, { ownerId: attempt?.intent.ownerId ?? null, actorType: 'PSP_WEBHOOK', action: 'WEBHOOK_ANOMALY', decision: 'NO_POSTING', context: { note } });
      };
      if (!attempt) return anomaly('UNKNOWN_MERCHANT_REF');
      const i = attempt.intent;
      if (ev.currency !== i.currency) return anomaly('CURRENCY_MISMATCH');
      // Payout : montant reçu par le bénéficiaire ; payin : montant réglé par le payeur (frais inclus).
      if (ev.amountMinor !== (i.direction === 'PAYIN' ? i.totalDebitMinor : i.amountNetMinor)) return anomaly('AMOUNT_MISMATCH');
      if (ev.providerRef && attempt.providerRef && ev.providerRef !== attempt.providerRef) return anomaly('PROVIDER_REF_MISMATCH');
      await tx.$queryRaw`SELECT id FROM "PaymentIntent" WHERE id = ${i.id}::uuid FOR UPDATE`;
      const cur = await tx.paymentIntent.findUniqueOrThrow({ where: { id: i.id } });
      // Preuve contradictoire avec un état terminal : jamais ignorée ni corrigée silencieusement (§20.4).
      const contradicts = (ev.status === 'SUCCEEDED' && ['FAILED', 'CANCELLED'].includes(cur.state)) || (ev.status === 'FAILED' && ['SUCCEEDED', 'REFUNDED_AFTER_SUCCESS'].includes(cur.state));
      if (contradicts) return anomaly(`CONTRADICTS_TERMINAL_${cur.state}`);
      if (ev.status === 'PROCESSING') { await tx.providerEvent.update({ where: { id: stored.id }, data: { processState: 'PROCESSED', processNote: 'INTERMEDIATE', attemptId: attempt.id } }); return; }
      if (ev.providerRef && !attempt.providerRef) await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { providerRef: ev.providerRef } });
      if (ev.status === 'SUCCEEDED') await this.finalizeFromUnknown(tx, i.id, 'SUCCEEDED', 'WEBHOOK_SUCCESS', digest);
      else if (ev.status === 'FAILED') await this.finalizeFromUnknown(tx, i.id, 'FAILED', 'WEBHOOK_FAILED', digest);
      else if (ev.status === 'REFUNDED') await this.finalize(tx, i.id, 'REFUNDED_AFTER_SUCCESS', 'WEBHOOK_REFUND', digest);
      await tx.providerEvent.update({ where: { id: stored.id }, data: { processState: 'PROCESSED', attemptId: attempt.id } });
    });
    return { accepted: true, duplicate: false };
  }

  /** Job : vérification des statuts incertains/en cours, avec backoff ; escalade sans jamais rejouer le transfert. */
  async checkPending() {
    const now = clock.now();
    const pending = await this.prisma.paymentIntent.findMany({ where: { state: { in: ['UNKNOWN', 'PROCESSING'] } }, include: { attempts: true } });
    let checked = 0;
    for (const i of pending) {
      const a = i.attempts.find((x) => x.id === i.currentAttemptId);
      if (!a) continue;
      const backoff = Math.min(3600_000, 30_000 * 2 ** Math.min(a.statusCheckCount, 7));
      if (a.lastStatusCheckedAt && now.getTime() - a.lastStatusCheckedAt.getTime() < backoff) continue;
      await this.recheck(i.ownerId, i.id);
      checked++;
      if (a.statusCheckCount === 10) await this.prisma.tx((tx) => this.events.notify(tx, { ownerId: i.ownerId, sourceEventId: `payment-escalate:${i.id}`, type: 'payment.unknown_escalation', category: 'PAYMENT', priority: 'CRITICAL', title: 'Paiement toujours incertain', body: 'Le statut reste inconnu après plusieurs vérifications. Contactez le prestataire avec la référence du paiement.', link: `/money/payments/${i.id}` }));
    }
    return checked;
  }

  // ─── Payins séquentiels (D49/D52, §10.4) ───
  async createFundingPlan(tx: Tx, auth: AuthContext, incomeId: string, dto: { sourceAccountId: string; steps: { destinationAccountId: string; amountMinor: bigint }[]; payerBeneficiaryId: string }) {
    const inc = await tx.income.findUnique({ where: { id: incomeId } });
    if (!inc || inc.ownerId !== auth.ownerId) throw notFound('Revenu');
    const total = dto.steps.reduce((s, x) => s + x.amountMinor, 0n);
    if (total > inc.grossMinor) throw new DomainError('BUSINESS_RULE_VIOLATION', 'Les dépôts dépassent le revenu');
    const plan = await tx.incomeFundingPlan.create({ data: { ownerId: auth.ownerId, incomeId } });
    let n = 1;
    for (const s of dto.steps) {
      const dest = await this.accounts.getOwned(tx, auth.ownerId, s.destinationAccountId);
      if (dest.type !== 'CONTROLLED_PSP') throw new DomainError('PSP_NOT_AUTHORIZED', 'Destination non contrôlée par un prestataire');
      // Le payeur règle s.amountMinor ; le prestataire crédite ce montant moins ses frais d'encaissement.
      const payinFee = this.provider.estimateFees('PAYIN', s.amountMinor, '').feeMinor;
      if (payinFee >= s.amountMinor) throw new DomainError('VALIDATION_FAILED', 'Montant insuffisant pour couvrir les frais d’encaissement');
      const intent = await tx.paymentIntent.create({ data: { ownerId: auth.ownerId, direction: 'PAYIN', sourceAccountId: dto.sourceAccountId, destinationAccountId: dest.id, beneficiaryId: dto.payerBeneficiaryId, amountMode: 'NET_RECEIVED', amountNetMinor: s.amountMinor - payinFee, feeQuoteMinor: payinFee, totalDebitMinor: s.amountMinor, idempotencyKey: `plan-${plan.id}-${n}`, requestDigest: digestOf(s), executable: executionMode(this.provider).executable, nonExecutableReason: executionMode(this.provider).reason, state: 'RESERVED' } });
      const step = await tx.incomeFundingStep.create({ data: { planId: plan.id, ordinal: n++, destinationWalletId: (await this.wallets.currentWallet(tx, auth.ownerId)).id, amountMinor: s.amountMinor, paymentIntentId: intent.id } });
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { fundingStepId: step.id } });
      await tx.paymentStateHistory.create({ data: { intentId: intent.id, to: 'RESERVED', cause: 'FUNDING_PLAN_PREPARED', actor: auth.deviceId ?? 'OWNER' } });
    }
    return tx.incomeFundingPlan.findUniqueOrThrow({ where: { id: plan.id }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
  }
  /** Lance l'étape suivante UNIQUEMENT si la précédente est terminalement réussie (jamais en parallèle). */
  async runNextFundingStep(auth: AuthContext, planId: string, resumeAfterFailure = false) {
    const step = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "IncomeFundingPlan" WHERE id = ${planId}::uuid FOR UPDATE`;
      const plan = await tx.incomeFundingPlan.findUnique({ where: { id: planId }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
      if (!plan || plan.ownerId !== auth.ownerId) throw notFound('Plan de dépôt');
      if (plan.status === 'PAUSED_UNKNOWN') throw new DomainError('PAYMENT_RESULT_UNKNOWN', 'Étape précédente incertaine : rapprochement requis avant de continuer');
      if (plan.status === 'PAUSED_FAILURE' && !resumeAfterFailure) throw new DomainError('PAYMENT_STATE_CONFLICT', 'Étape précédente échouée : décision explicite de reprise requise');
      if (plan.steps.some((s) => s.state === 'IN_FLIGHT')) throw new DomainError('PAYMENT_STATE_CONFLICT', 'Un dépôt est déjà en cours');
      const next = plan.steps.find((s) => ['PENDING', 'FROZEN'].includes(s.state));
      if (!next) { await tx.incomeFundingPlan.update({ where: { id: planId }, data: { status: 'COMPLETED' } }); return null; }
      if (!executionMode(this.provider).executable) throw new DomainError('PSP_NOT_AUTHORIZED', 'Paiements réels non activés');
      await tx.incomeFundingStep.update({ where: { id: next.id }, data: { state: 'IN_FLIGHT' } });
      await tx.incomeFundingPlan.update({ where: { id: planId }, data: { status: 'RUNNING' } });
      return next;
    });
    if (!step) return this.fundingPlan(auth, planId);
    await this.submit(auth.ownerId, step.paymentIntentId!, auth.deviceId ?? 'OWNER');
    return this.fundingPlan(auth, planId);
  }
  async onFundingStepResult(tx: Tx, stepId: string, result: string) {
    const step = await tx.incomeFundingStep.findUniqueOrThrow({ where: { id: stepId } });
    if (result === 'SUCCEEDED') {
      await tx.incomeFundingStep.update({ where: { id: stepId }, data: { state: 'SUCCEEDED' } });
      await tx.incomeFundingPlan.update({ where: { id: step.planId }, data: { lastCompletedStep: step.ordinal, status: 'READY' } });
    } else {
      await tx.incomeFundingStep.update({ where: { id: stepId }, data: { state: 'FAILED' } });
      await tx.incomeFundingStep.updateMany({ where: { planId: step.planId, state: 'PENDING' }, data: { state: 'FROZEN' } });
      await tx.incomeFundingPlan.update({ where: { id: step.planId }, data: { status: 'PAUSED_FAILURE' } });
    }
  }
  async fundingPlan(auth: AuthContext, planId: string) {
    const plan = await this.prisma.incomeFundingPlan.findUnique({ where: { id: planId }, include: { steps: { orderBy: { ordinal: 'asc' } } } });
    if (!plan || plan.ownerId !== auth.ownerId) throw notFound('Plan de dépôt');
    const intents = await this.prisma.paymentIntent.findMany({ where: { id: { in: plan.steps.map((s) => s.paymentIntentId!).filter(Boolean) } } });
    if (intents.some((i) => i.state === 'UNKNOWN') && plan.status !== 'PAUSED_UNKNOWN') await this.prisma.incomeFundingPlan.update({ where: { id: planId }, data: { status: 'PAUSED_UNKNOWN' } });
    return { ...plan, steps: plan.steps.map((s) => ({ ...s, payment: intents.find((i) => i.id === s.paymentIntentId) && { id: s.paymentIntentId, state: intents.find((i) => i.id === s.paymentIntentId)!.state } })), nextActionAllowed: !plan.steps.some((s) => s.state === 'IN_FLIGHT') };
  }
}
