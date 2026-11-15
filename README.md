# RAVZO — finances personnelles privées

Application mono-utilisateur (XOF, Africa/Porto-Novo) : backend **NestJS + PostgreSQL + Prisma + Redis/BullMQ**, client **Flutter** (macOS, iOS, Android). Spécifications : `llm.md`, `backend.md`. Suivi : `IMPLEMENTATION_PLAN.md`, `IMPLEMENTATION_STATUS.md`, `IMPLEMENTATION_TRACEABILITY.md`.

> **Paiements réels désactivés.** Aucun PSP n'est contractuellement autorisé. Le prestataire `fake` est un simulateur de développement, interdit en production.

## Démarrage local
```bash
docker compose -f infra/docker-compose.yml up -d
cd backend && npm install && cp .env.example .env   # puis renseigner DOCUMENT_MASTER_KEY (openssl rand -base64 32)
npx prisma migrate deploy && npm run build
npm run owner:bootstrap -- vous@exemple.bj "Votre nom"   # affiche UNE FOIS : code du 1er appareil + 10 codes de secours
node dist/src/main.js        # API http://127.0.0.1:3000/api/v1 — OpenAPI : /api/docs
node dist/src/worker.js      # outbox, notifications, jobs planifiés
cd ../app && flutter run -d macos   # --dart-define=RAVZO_API=https://… pour un autre serveur
```
Première connexion : e-mail + mot de passe, puis **code d'initialisation** (premier appareil). Les appareils suivants sont approuvés depuis un appareil de confiance (Sécurité › Appareils) avec le code affiché.

## Tests
```bash
cd backend && docker exec ravzo-dev-postgres-1 psql -U ravzo -c "create database ravzo_test" ; npm test
cd app && flutter analyze && flutter test
```

## Architecture
- `backend/src/common` : enveloppe `{data,meta}`, erreurs normalisées, garde d'authentification (session vérifiée à chaque requête), idempotence, outbox/SSE, horloge serveur.
- `backend/src/modules` : identity (appareils Ed25519, step-up signé, récupération 48 h), ledger (double entrée + triggers SQL), accounts/wallets, money, budgets, savings, wealth (dettes, biens, BRVM), payments (port PSP, plafonds, dérogations, webhooks, rapprochement), platform (sync, SSE, documents chiffrés, imports, activité, exports).
- `app/lib` : `core` (API, clé d'appareil, cache chiffré, temps réel, brouillons hors ligne), `design` (tokens Calm Wealth, motion, composants, graphiques), `features` (5 espaces + outils globaux).
- Décisions : `docs/adr/`. Exploitation : `docs/runbooks/`.
