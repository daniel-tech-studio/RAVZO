#!/usr/bin/env bash
# Déploiement RAVZO sur le serveur « souven » : synchronise le backend, construit l'image, migre, redémarre.
# Les secrets de production (.env.production, secrets/) restent sur le serveur et ne sont jamais synchronisés.
set -euo pipefail
HOST="${HOST:-souven}"
DIR="${DIR:-/home/deploy/apps/ravzo}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ssh "$HOST" "mkdir -p $DIR/backend $DIR/secrets $DIR/backups"
rsync -az --exclude node_modules --exclude dist --exclude .env --exclude secrets --exclude storage --exclude coverage --exclude .dev-owner.local "$ROOT/backend/" "$HOST:$DIR/backend/"
rsync -az "$ROOT/deploy/docker-compose.prod.yml" "$HOST:$DIR/docker-compose.yml"
rsync -az "$ROOT/deploy/caddy/ravzo.caddy" "$HOST:$DIR/ravzo.caddy"
ssh "$HOST" "cd $DIR && docker build -t ravzo-backend:latest backend && docker compose --env-file .env.production up -d --remove-orphans"
ssh "$HOST" "sudo cp $DIR/ravzo.caddy /etc/caddy/sites/ravzo.caddy && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && sudo systemctl reload caddy"
echo "Déployé : https://ravzo-api.72-60-186-169.sslip.io"
