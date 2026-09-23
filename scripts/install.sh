#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${EUID} -eq 0 ]]; then SUDO=(); else SUDO=(sudo); fi
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y ca-certificates curl gnupg
  "${SUDO[@]}" install -d -m 755 /etc/apt/keyrings
  TEMP_KEY=$(mktemp)
  trap 'rm -f "$TEMP_KEY"' EXIT
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o "$TEMP_KEY"
  gpg --batch --yes --dearmor -o "${TEMP_KEY}.gpg" "$TEMP_KEY"
  "${SUDO[@]}" install -m 644 "${TEMP_KEY}.gpg" /etc/apt/keyrings/nodesource.gpg
  rm -f "${TEMP_KEY}.gpg"
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' | "${SUDO[@]}" tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  "${SUDO[@]}" apt-get update
  "${SUDO[@]}" apt-get install -y nodejs
fi
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
printf '\nГотово. Выполни: npm run setup\nЗатем: npm run login\nЗатем: bash scripts/service.sh install\n'
