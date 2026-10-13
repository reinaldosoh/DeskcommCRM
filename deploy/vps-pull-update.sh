#!/usr/bin/env bash
# Atualizacao pull-based: a VPS busca as imagens publicadas pelo GitHub Actions
# do fork e recria SO os servicos que mudaram. O GitHub nunca acessa a VPS.
# Instalado por deploy/vps-install-timer.sh (systemd timer, a cada 5 min).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/deskcommcrm}"
cd "$APP_DIR"

COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env"

# Estado antes: IDs das imagens em uso.
antes="$(docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml images -q app worker scheduler 2>/dev/null | sort | tr '\n' ' ')"

$COMPOSE pull app worker scheduler >/dev/null 2>&1 || { echo "pull falhou (imagem ainda nao publicada?) - nada alterado"; exit 0; }

# 'up -d' so recria o que mudou; sem mudanca e no-op.
$COMPOSE up -d app worker scheduler

depois="$(docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml images -q app worker scheduler 2>/dev/null | sort | tr '\n' ' ')"
if [ "$antes" != "$depois" ]; then
  echo "$(date -Is) imagens atualizadas"
  docker image prune -f >/dev/null
else
  echo "$(date -Is) sem novidades"
fi

# Sanidade pos-deploy (CLAUDE.md): / = 200 e /app = 307.
sleep 10
raiz=$(curl -s -o /dev/null -w '%{http_code}' https://agentesdeatendimento.sbs/ || true)
app=$(curl -s -o /dev/null -w '%{http_code}' https://agentesdeatendimento.sbs/app || true)
echo "check: / = $raiz  /app = $app"
