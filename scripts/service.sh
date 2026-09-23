#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR=$(cd "$(dirname "$0")/.." && pwd)
if [[ ${EUID} -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
case "${1:-}" in
install)
  cd "$PROJECT_DIR"
  [[ -f config.json && -f data/session.json ]] || { echo 'Сначала: npm run setup и npm run login'; exit 1; }
  NODE_BIN=$(command -v node)
  SERVICE_USER=$(id -un)
  if [[ ! "$PROJECT_DIR" =~ ^/[a-zA-Z0-9_./-]+$ || ! "$NODE_BIN" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    echo 'Перемести проект в путь без пробелов и специальных символов.'; exit 1
  fi
  if [[ -d data/instance.lock ]]; then echo 'Сначала останови запущенную вручную программу (Ctrl+C).'; exit 1; fi
  "${SUDO[@]}" tee /etc/systemd/system/steam-hours.service >/dev/null <<UNIT
[Unit]
Description=ReVerfyx Steam Hours
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN $PROJECT_DIR/src/cli.js start
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=78
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
StandardInput=null
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  "${SUDO[@]}" systemctl daemon-reload
  "${SUDO[@]}" systemctl enable --now steam-hours
  echo 'Автозапуск включён. Логи: sudo journalctl -u steam-hours -f'
  ;;
start|stop|restart|status) "${SUDO[@]}" systemctl "$1" steam-hours ;;
logs) "${SUDO[@]}" journalctl -u steam-hours -f ;;
*) echo 'Использование: bash scripts/service.sh install|start|stop|restart|status|logs'; exit 1 ;;
esac
