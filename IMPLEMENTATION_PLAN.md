# RAVZO — Plan d'implémentation

> Sources de vérité : `llm.md` (produit, UX, design « Calm Wealth — Expressive Edition ») et `backend.md` (backend V1, B01–B42, T01–T26).
> Ce plan pilote le travail. Statuts : `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE` (DONE = implémenté **et** vérifié).
> Suivi réel : `IMPLEMENTATION_STATUS.md`. Traçabilité exigences → code → tests : `IMPLEMENTATION_TRACEABILITY.md`.

## 1. Objectif global (GOAL)

Livrer RAVZO, application privée mono-utilisateur de finances personnelles (XOF, Africa/Porto-Novo) :
backend NestJS/TypeScript/PostgreSQL/Prisma (monolithe modulaire + worker), client Flutter (macOS, iOS, Android),
registre à double entrée, budgets par cycles, coffres à discipline indicative, dettes/créances, patrimoine, BRVM manuel,
paiements PSP derrière adaptateur **désactivé en réel** (`PAYMENTS_LIVE_ENABLED=false`), sécurité appareils/step-up,
offline avec confirmation individuelle, SSE, notifications, imports, rapprochement, exports.

## 2. État initial (14/11/2026)

- Dépôt vierge : `llm.md`, `backend.md`, `full.png` (logo RAVZO), `monograme.png` (monogramme). Aucun code.
- Outils disponibles : Node 23, pnpm 9, Flutter 3.44 / Dart 3.12, Docker 29, Xcode. Pas de PostgreSQL/Redis natif → Docker Compose dédié (ports 55440/56390, n'interfère pas avec les conteneurs `rfg-dev` existants).
- Aucune identité PSP, clé BRVM, SMTP, APNs/FCM, VPS disponibles.

## 3. Contradictions / points ouverts identifiés entre documents

| # | Sujet | Résolution retenue |
|---|---|---|
| C1 | `llm.md` 4.1 laisse ORM « à figer » ; `backend.md` B01 valide Prisma | Prisma (backend.md prime : décision B01 VALIDÉ) |
| C2 | `llm.md` « SSE ou WebSocket » ; `backend.md` B28–B30 SSE | SSE + delta `/sync/changes` |
| C3 | B38 exige réplicas PostgreSQL dès la V1 ; environnement local mono-machine | Code prêt (`DB_READ_URL` facultatif, finance toujours primaire) ; topologie multi-hôte = livrable d'exploitation **BLOCKED** (pas de VPS) |
| C4 | Login : backend.md `email + passwordHash?` ; llm.md « connexion sécurisée » | Email + mot de passe Argon2id + appareil à clé Ed25519 ; premier appareil enrôlé au bootstrap propriétaire |
| C5 | Statut `SUBMITTING` (backend.md) vs `submitted` (llm.md) | Enum backend.md fait foi (`SUBMITTING`) |
| C6 | Convention 24 h glissantes « à figer » | Ancrage = horodatage serveur d'autorisation (création du `LimitHold`), jamais déplacé (ADR-002) |
| C7 | Base 20 %/30 j « à tester » | Formule backend.md §9, arrondi plancher, verrou par coffre (ADR-003) |

## 4. Architecture retenue

```
backend/            NestJS 11+ (API + worker même code, entrée distincte)
  prisma/           schema.prisma + migrations SQL (trigger d'équilibre des postings)
  src/common/       envelope, erreurs normalisées, correlation-id, idempotency, money, pagination
  src/modules/      identity security devices ledger accounts allocations income expenses budgets
                    savings payments liabilities assets investments market imports reconciliation
                    sync operations notifications documents analytics activity events(SSE) outbox
  src/worker.ts     dispatcher outbox, jobs planifiés (clôture cycles, contributions, expirations, rapprochement)
  test/             unit, intégration (PostgreSQL réel), concurrence, scénarios T01–T26
app/                Flutter (macos, ios, android)
  lib/core/         api client, auth/keys, cache, sync, sse
  lib/design/       foundations (tokens), primitives, financial components, motion, layouts
  lib/features/     home money savings wealth activity security ops notifications search settings onboarding
infra/              docker-compose (postgres, redis), env exemples
docs/adr/           décisions d'architecture
```

## 5. Phases et tâches atomiques

Format : `ID — Titre` · périmètre · dépendances · validation.

### Phase A — Fondations
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| FND-001 | Infra locale Docker Compose (Postgres 17, Redis 7) | — | `docker compose up` sain | voir STATUS |
| FND-002 | Projet NestJS, config typée, lint/typecheck | FND-001 | `tsc --noEmit` OK | voir STATUS |
| FND-003 | Envelope `{data,meta}`, erreurs normalisées §18.2, correlation-id, ValidationPipe allowlist (`forbidNonWhitelisted`) | FND-002 | tests API 400/404/409 | voir STATUS |
| FND-004 | Utilitaires argent (BigInt mineur, chaînes JSON), pagination curseur signé | FND-002 | tests unitaires | voir STATUS |
| FND-005 | Schéma Prisma complet §14 + migration SQL (trigger équilibre, append-only) | FND-001 | migrate OK, tests intégration | voir STATUS |
| FND-006 | Idempotency-Key (digest, 409 mismatch) | FND-005 | test API | voir STATUS |
| FND-007 | Outbox + SyncEvent séquence monotone, atomique avec métier | FND-005 | test T22 | voir STATUS |

### Phase B — Identité, sécurité, noyau financier
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| BACK-001 | Bootstrap propriétaire unique (CLI) + login Argon2id + rate-limit | FND-005 | tests | voir STATUS |
| BACK-002 | Sessions access/refresh, rotation, détection réutilisation (famille) | BACK-001 | tests | voir STATUS |
| BACK-003 | Appareils Ed25519 : enrôlement, approbation par appareil fiable, révocation immédiate | BACK-002 | tests | voir STATUS |
| BACK-004 | Step-up : challenge + signature sur digest canonique, nonce unique, TTL (SignedApproval) | BACK-003 | T20 | voir STATUS |
| BACK-005 | Récupération par codes de secours → suspension 48 h lecture seule finance | BACK-003 | T11 | voir STATUS |
| BACK-006 | Journal sécurité / audit append-only | FND-005 | trigger anti-update | voir STATUS |
| BACK-010 | LedgerService : postings équilibrés par devise, verrous ordonnés, projections, unicité businessEvent | FND-005 | T01, invariants | voir STATUS |
| BACK-011 | Corrections compensatoires (contrepassation) step-up | BACK-010 | test | voir STATUS |
| BACK-012 | Comptes financiers (EXTERNAL_TRACKED, CASH_MANUAL, BROKER_CASH, CONTROLLED_PSP), solde d'ouverture par écriture | BACK-010 | test | voir STATUS |
| BACK-013 | Wallets (CURRENT/SAVINGS/RESERVE), allocations, transferts d'allocation (T01) | BACK-012 | T01 | voir STATUS |
| BACK-014 | Vue soldes : confirmé / suivi / disponible conseillé / bloqué | BACK-013, BACK-022 | test | voir STATUS |

### Phase C — Finance personnelle hors PSP
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| BACK-020 | Revenus (EXTERNAL_TRACKING), propositions d'affectation, confirmation | BACK-013 | pas de double revenu | voir STATUS |
| BACK-021 | Dépenses + catégories (arbre sans boucle), catégorisation suggérée | BACK-012 | test | voir STATUS |
| BACK-022 | Cycles budgétaires (ouverture manuelle, clôture auto, hors cycle, rattachement), budgets, analytics | BACK-020, BACK-021 | test | voir STATUS |
| BACK-023 | Charges récurrentes + occurrences, règlement sans double charge | BACK-022 | test | voir STATUS |
| BACK-024 | Dettes/créances/engagements, échéancier, remboursements (principal/intérêts/frais) | BACK-010 | T16 | voir STATUS |
| BACK-025 | Biens physiques, réévaluations, patrimoine net | BACK-024 | test | voir STATUS |

### Phase D — Épargne, offline, opérations
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| BACK-030 | Coffres : cible/échéance/programme obligatoires, protection ADVISORY explicite | BACK-013 | test | voir STATUS |
| BACK-031 | Contributions planifiées (préparation seule), confirmation, rattrapage, replanification | BACK-030 | test | voir STATUS |
| BACK-032 | Retraits : ordinaire (cible atteinte) / exceptionnel 20 % 30 j reconstitué, 72 h, verrou | BACK-030 | T23, T24 | voir STATUS |
| BACK-033 | Sync : changes par curseur, drafts prepare/confirm individuel, conflits | FND-007 | T17, T18 | voir STATUS |
| BACK-034 | Centre d'opérations agrégé | tous | test | voir STATUS |
| BACK-035 | Notifications persistantes + livraisons PUSH/EMAIL (canaux non configurés → statut `NOT_CONFIGURED` explicite) | FND-007 | test | voir STATUS |
| BACK-036 | SSE `/events/stream` après commit, reprise par curseur | FND-007 | test | voir STATUS |

### Phase E — Paiements (sandbox/fake, live désactivé)
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| BACK-040 | `PaymentProviderPort` + `FakeProvider` (dev/test seulement, étiqueté) + capabilities | FND-002 | T26 | voir STATUS |
| BACK-041 | Bénéficiaires E.164, vérification `UNAVAILABLE` sans capability | BACK-040 | test | voir STATUS |
| BACK-042 | LimitPolicy 30k/60k, LimitHold, changements (baisse immédiate, 48 h/72 h) | BACK-004 | T02, T03, T10 | voir STATUS |
| BACK-043 | Payout intents → authorize (signature) → reserve → submit unique → statuts, UNKNOWN | BACK-042 | T03–T06, T20 | voir STATUS |
| BACK-044 | Webhooks signés HMAC, ProviderEvent dédup, posting terminal unique | BACK-043 | T07, T08, T12 | voir STATUS |
| BACK-045 | Dérogations 72 h + 24 h usage unique | BACK-042 | T09 | voir STATUS |
| BACK-046 | Payin + IncomeFundingPlan séquentiel | BACK-043 | test | voir STATUS |
| BACK-047 | Rapprochement : snapshots, cases, blocage RealBalanceGroup | BACK-044 | T13 | voir STATUS |

### Phase F — BRVM, imports, documents, analytics
| ID | Tâche | Dép. | Validation | Statut |
|---|---|---|---|---|
| BACK-050 | SGI : brokers + compte espèces, trades exécutés, lots coût (FIFO indicatif) | BACK-012 | test P&L | voir STATUS |
| BACK-051 | Dividendes annonce → entitlement → réception rapprochée | BACK-050 | T15 | voir STATUS |
| BACK-052 | Marché : `MarketDataProviderPort`, cotations manuelles `MANUAL_UNVERIFIED`, fraîcheur | BACK-050 | test | voir STATUS |
| BACK-053 | Projets d'achat (réservation virtuelle), alertes de cours | BACK-052 | test | voir STATUS |
| BACK-054 | Documents (stockage local chiffré AES-256-GCM, accès temporaire) | FND-005 | test | voir STATUS |
| BACK-055 | Imports CSV (relevés + avis d'opéré) : preview, dédup, confirmation par ligne idempotente | BACK-054 | T14 | voir STATUS |
| BACK-056 | Activité / recherche globale / analytics / export CSV | tous | test | voir STATUS |

### Phase G — Client Flutter
| ID | Tâche | Statut |
|---|---|---|
| FRONT-001 | Projet Flutter macOS/iOS/Android, design tokens Calm Wealth (clair/sombre), Sora/Inter, chiffres tabulaires | voir STATUS |
| FRONT-002 | Primitives + composants financiers (Money, badges de provenance, cartes, états vide/erreur/offline/incertain) | voir STATUS |
| FRONT-003 | Motion system (chorégraphies, reduce-motion), graphiques animés CustomPainter | voir STATUS |
| FRONT-004 | Shell adaptatif : bottom nav mobile / sidebar macOS, raccourcis clavier, accès ops/notifs/recherche | voir STATUS |
| FRONT-005 | Onboarding + connexion + enrôlement appareil (clé Ed25519 en stockage sécurisé) | voir STATUS |
| FRONT-006 | Accueil analytique (widgets réorganisables, disponible conseillé, labels de provenance) | voir STATUS |
| FRONT-007 | Argent : comptes, détail, ajout, revenu guidé (3 étapes), dépense, budgets/cycles, charges, dettes | voir STATUS |
| FRONT-008 | Épargne : dashboard analytique, création, détail hybride, contribution, retrait + timer | voir STATUS |
| FRONT-009 | Patrimoine : valeur nette, biens, SGI, trades, dividendes, marché, projets, alertes | voir STATUS |
| FRONT-010 | Activité : historique, filtres, export, imports, rapprochement | voir STATUS |
| FRONT-011 | Paiements : capacités, bénéficiaires, nouveau paiement + récap + step-up, suivi (désactivé réel affiché) | voir STATUS |
| FRONT-012 | Sécurité : appareils, sessions, plafonds, dérogations, journal, récupération | voir STATUS |
| FRONT-013 | Notifications, centre des opérations, recherche globale, masquage des montants | voir STATUS |
| FRONT-014 | Offline : cache, brouillons, centre sync avec validation individuelle | voir STATUS |

### Phase H — Intégration, tests, finalisation
| ID | Tâche | Statut |
|---|---|---|
| INT-001 | Parcours connexion → accueil réel | voir STATUS |
| INT-002 | Parcours revenu → répartition → confirmation | voir STATUS |
| INT-003 | Parcours coffre → contribution → retrait | voir STATUS |
| TEST-001 | Suite T01–T26 backend (Postgres réel) | voir STATUS |
| TEST-002 | Tests widgets Flutter + analyse statique | voir STATUS |
| TEST-003 | Validation visuelle macOS (captures) | voir STATUS |
| DOC-001 | README démarrage, runbooks, ADR, limites connues | voir STATUS |

## 6. Risques et blocages connus

| Risque | Impact | Traitement |
|---|---|---|
| Aucun PSP contractuel (FeexPay/FedaPay/KKiaPay non vérifiés) | Paiements réels impossibles | Adaptateur + FakeProvider dev/test ; `PAYMENTS_LIVE_ENABLED=false` ; UI « paiements réels non activés » — **BLOCKED externe** |
| Aucune source BRVM licenciée | Cours officiels indisponibles | Saisie manuelle `MANUAL_UNVERIFIED` + port remplaçable — **BLOCKED externe** |
| Pas de SMTP / APNs / FCM | Push/email non livrés | Livraisons créées et marquées `NOT_CONFIGURED`, centre in-app fonctionnel — **BLOCKED externe** |
| Pas de VPS multi-hôte (B38/B39) | Réplicas, PITR non démontrables | Compose local + docs ; **BLOCKED externe** |
| Signature iOS/Android, appareils physiques | Tests mobiles réels | Build macOS vérifié localement ; iOS simulateur si disponible |
| Volume du périmètre | Livraison en plusieurs sessions | Incréments verticaux, statut honnête |
