#!/usr/bin/env bash
# Instala o timer que roda vps-pull-update.sh a cada 5 minutos. Rodar como root na VPS.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/deskcommcrm}"
chmod +x "$APP_DIR/deploy/vps-pull-update.sh"
cat > /etc/systemd/system/deskcomm-update.service <<UNIT
[Unit]
Description=Atualiza o DeskcommCRM a partir das imagens do fork
[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
ExecStart=$APP_DIR/deploy/vps-pull-update.sh
UNIT
cat > /etc/systemd/system/deskcomm-update.timer <<UNIT
[Unit]
Description=Busca atualizacoes do DeskcommCRM a cada 5 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now deskcomm-update.timer
systemctl list-timers deskcomm-update.timer --no-pager
