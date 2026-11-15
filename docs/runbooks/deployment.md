# Déploiement et exploitation — état réel

## Fait
- `infra/docker-compose.yml` : PostgreSQL 17 + Redis 7 **locaux mono-hôte** (développement).
- API (`node dist/src/main.js`) et worker (`node dist/src/worker.js`) sont deux processus distincts partageant les mêmes modules.
- `DB_READ_URL` facultatif : lectures analytiques/historiques via réplica ; **toute décision financière reste sur le primaire**.

## NON fait (bloqué : aucun VPS / budget / accès fourni)
- Topologie multi-hôte B38/B39 (primaire + réplicas sur nœuds distincts, réseau chiffré, reverse proxy HTTPS).
- Sauvegardes chiffrées externes + archivage WAL / PITR et exercice de restauration (T19).
- CI/CD, scan d'images, signature, monitoring/alerting.
- APNs/FCM/SMTP : les livraisons push/email sont créées et marquées `NOT_CONFIGURED`.

## Procédure de crise (à outiller)
STOP outbound (mettre `PAYMENTS_LIVE_ENABLED=false`) → préserver logs → restaurer primaire isolé → `GET /api/v1/ledger/integrity` → rapprocher chaque balance (`POST /reconciliation/run`) → vérifier holds/plafonds → rouvrir.
