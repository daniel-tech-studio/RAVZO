# Déploiement et exploitation — état réel

## Production (en ligne)
- **API** : https://ravzo-api.72-60-186-169.sslip.io/api/v1 — domaine gratuit et fixe (sslip.io, tant que l'IP du serveur ne change pas), certificat Let's Encrypt géré par Caddy.
- **Serveur** : hôte SSH `souven` (72.60.186.169, utilisateur `deploy`), dossier `/home/deploy/apps/ravzo`, projet Docker Compose `ravzo` : postgres 17, redis 7 (AOF), migrate, api (127.0.0.1:3400), worker, backup (pg_dump quotidien, 14 jours, dans `backups/`).
- **Caddy** : `/etc/caddy/sites/ravzo.caddy` (copie de `deploy/caddy/ravzo.caddy`), importé par le Caddyfile partagé du serveur.
- **Secrets** : `/home/deploy/apps/ravzo/.env.production` (600) et `secrets/firebase-service-account.json` (400, uid 10001) — jamais dans git. Identifiants du propriétaire : `deploy/.prod-owner.local` (local, ignoré par git).
- **Déployer** : `./deploy/deploy.sh` (rsync du backend → build de l'image → `docker compose up -d` → rechargement Caddy).
- **Exploitation** : `ssh souven 'cd ~/apps/ravzo && docker compose ps'`, `docker compose logs -f api worker`.
- **Webhook FeexPay** : `https://ravzo-api.72-60-186-169.sslip.io/api/v1/integrations/psp/webhooks/feexpay`.
- **Paiements réels activés** (`PAYMENTS_LIVE_ENABLED=true`, `PSP_PROVIDER=feexpay`) ; le prestataire simulé est interdit en production.

## Fait
- `infra/docker-compose.yml` : PostgreSQL 17 + Redis 7 **locaux mono-hôte** (développement).
- API (`node dist/src/main.js`) et worker (`node dist/src/worker.js`) sont deux processus distincts partageant les mêmes modules.
- `DB_READ_URL` facultatif : lectures analytiques/historiques via réplica ; **toute décision financière reste sur le primaire**.

## NON fait
- Topologie multi-hôte B38/B39 (primaire + réplicas sur nœuds distincts, réseau chiffré, reverse proxy HTTPS).
- Copie des sauvegardes HORS du serveur, archivage WAL / PITR et exercice de restauration (T19).
- CI/CD, scan d'images, signature, monitoring/alerting.

## Procédure de crise (à outiller)
STOP outbound (mettre `PAYMENTS_LIVE_ENABLED=false`) → préserver logs → restaurer primaire isolé → `GET /api/v1/ledger/integrity` → rapprocher chaque balance (`POST /reconciliation/run`) → vérifier holds/plafonds → rouvrir.
