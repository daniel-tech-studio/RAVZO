# Traçabilité exigences → code → vérification

Légende : ✅ implémenté et vérifié (test automatisé ou écran) · 🟡 implémenté, non vérifié · ⛔ bloqué (justifié) · ❌ non implémenté.

## Scénarios critiques backend.md §34
| ID | Code | Test | État |
|---|---|---|---|
| T01 réaffectation sans création de richesse | `accounts/wallets.service.ts` (livre ALLOCATION) | core.spec | ✅ |
| T02 deux appareils / 60 000 F | `payments.service.ts#authorize`, `limits.service.ts#lockPolicy` | payments.spec | ✅ |
| T03 30 000 + frais | idem | payments.spec | ✅ |
| T04 remboursé compte 24 h | `finalize(REFUNDED_AFTER_SUCCESS)` | payments.spec | ✅ |
| T05 annulation libère une fois | `cancel` | payments.spec | ✅ |
| T06 timeout exécuté → UNKNOWN | `submit`, `recheck` | payments.spec | ✅ |
| T07 webhook ×3 | `handleWebhook` (ProviderEvent unique) | payments.spec | ✅ |
| T08 webhook incohérent | `handleWebhook#anomaly` (+ contradiction d'état terminal) | payments.spec | ✅ |
| T06 bis « introuvable » ≠ échec | `recheck` | payments.spec | ✅ |
| T09 dérogation 72 h / 24 h / unique | `limits.service.ts#consumeException` | payments.spec | ✅ |
| T10 hausses 48 h / 72 h | `requestChange`, `apply` | payments.spec | ✅ |
| T11 récupération 48 h | `identity.service.ts#verifyRecovery`, `AuthGuard` | core.spec, payments.spec | ✅ |
| T12 webhook pendant blocage | webhook hors garde de suspension | payments.spec | ✅ |
| T13 balance partagée bloquée | `reconciliation.service.ts`, `wallets.move` | payments.spec | ✅ |
| T14 import avis deux fois | `imports.service.ts`, `Trade.externalRef` unique | platform.spec | ✅ |
| T15 dividende annoncé | `investments.service.ts` | wealth.spec | ✅ |
| T16 prêt ≠ revenu | `liabilities.service.ts#create` | wealth.spec | ✅ |
| T17 5 brouillons / 2 confirmés | `sync.service.ts` | platform.spec | ✅ |
| T18 reprise par curseur | `sync.service.ts#changes`, SSE | platform.spec | ✅ |
| T19 PITR | — | — | ⛔ infra absente |
| T20 paramètres modifiés après signature | `step-up.service.ts` | core.spec | ✅ |
| T21 réplica en retard | `PrismaService.reader` hors décisions | revue de code | 🟡 |
| T22 deux workers même événement | `worker/outbox.ts#once` | platform.spec | ✅ |
| T23 objectif atteint → 72 h | `savings.service.ts` | core.spec | ✅ |
| T24 20 % / 30 j concurrent | `savings.service.ts#capacity` | core.spec | ✅ |
| T25 compte déclaré ≠ source de payout | `createPayout` | payments.spec | ✅ |
| T26 PSP désactivé | `executionMode`, `NoProvider` | payments.spec | ✅ |
| Adaptateur PSP réel FeexPay (payout/payin/statut/solde/webhook HMAC) | `FeexPayProvider`, `connectProvider` | feexpay.spec (unit + intégration) | ✅ (exécution réelle non activée) |

## Décisions UX01–UX24 (llm.md §3.2)
| ID | Implémentation (app/lib/features) | État |
|---|---|---|
| UX01 disponible conseillé distinct du confirmé | `home/home.dart#_Hero`, `/balances/overview` | ✅ écran |
| UX02 raccourcis selon usage, jamais auto | `_QuickActions` + `actionUsage` | ✅ écran (réordonnés après usage) |
| UX03 accueil complet hiérarchisé | `home.dart` | ✅ écran |
| UX04 Argent hybride | `money/money.dart` | ✅ écran |
| UX05 revenu en 3 étapes | `_IncomeWizard` | ✅ écran |
| UX06 paiement : récap + preuve forte | `money/payments.dart#_PayoutFlow` | ✅ écran (prestataire simulé) |
| UX07 coffres analytiques | `savings/savings.dart` | ✅ écran |
| UX08 détail coffre hybride | `GoalDetailScreen` | ✅ écran |
| UX09 budgets analytiques | `money/budgets.dart` | 🟡 |
| UX10 dettes/créances communes | `LiabilitiesTab` | 🟡 |
| UX11 patrimoine hybride | `wealth/wealth.dart#_Overview` | ✅ écran |
| UX12 BRVM complet | `_Brvm`, `_Sgi`, `_Dividends`, `_Plans`, `SecurityDetailScreen` | 🟡 |
| UX13 historique complet + export | `activity/activity.dart#_History` | ✅ écran / export testé API |
| UX14 notifications intelligentes | `tools.dart#NotificationsScreen`, `/notifications` tri | 🟡 |
| UX15 centre de sécurité | `security/security.dart` | 🟡 |
| UX16 personnalisation widgets | `HomeScreen._customize` | 🟡 |
| UX17 offline + validation individuelle | `AppState.addLocalDraft`, `SyncCenterScreen` | 🟡 (API testée T17) |
| UX18 Mac sidebar/raccourcis vs mobile | `shell.dart` | ✅ écran (largeur Mac et largeur mobile) ; appareils iOS/Android non lancés |
| UX19 recherche globale | `SearchScreen`, `/search` | 🟡 (API testée) |
| UX20 analyses avancées | `_Analytics`, `/analytics/finance` | 🟡 (API testée) |
| UX21 centre des opérations | `OperationsScreen`, `/operations` | ✅ écran |
| UX22 onboarding progressif | `auth_screens.dart`, états vides | ✅ écran |
| UX23 masquage global | `Money`, export `masked`, graphiques | ✅ test widget + export testé |
| UX24 accès discret aux opérations | sidebar badge / point dans l'en-tête | ✅ écran |

## Exigences transverses
| Exigence | État |
|---|---|
| Montants BigInt / chaînes JSON, jamais float | ✅ |
| Enveloppe `{data, meta}`, erreurs §18.2, 401/403/404/409/422/423/429 | ✅ |
| DTO allowlist (`forbidNonWhitelisted`) | ✅ testé |
| Idempotency-Key + 409 mismatch | ✅ testé |
| Outbox atomique + SSE après commit | ✅ |
| Documents chiffrés AES-256-GCM, accès temporaire usage unique, anti-MIME spoofing | ✅ testé |
| Cache client chiffré + secrets Keychain | 🟡 (macOS lancé, non audité) |
| Motion expressive + reduce-motion | 🟡 (rendu vu, reduce-motion non vérifié) |
| Contrastes WCAG AA | ❌ non mesurés |
| B31 push + e-mail | ✅ push FCM (Android vérifié en réel ; APNs requis pour iOS/macOS) ; ✅ SMTP authentifié (envoi réel à tester) — `fcm.spec`, `push.spec`, `email.spec` |
| B38/B39/B40 | ⛔ infra absente |
