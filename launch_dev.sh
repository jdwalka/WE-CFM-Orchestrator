#!/usr/bin/env bash
# launch_dev.sh — Linux/WSL counterpart to launch_dev.bat
#
# Modes:
#   server   (default)  headless: orbital + web API  → good for trde tunnel
#   electron            desktop GUI (needs Linux electron + DISPLAY)
#   docker              docker compose wecrypto-backend + infra
#   infra               only redis + redpanda (+ console)
#
# Usage:
#   ./launch_dev.sh
#   ./launch_dev.sh server
#   ./launch_dev.sh electron
#   WECRYPTO_WEB_PORT=3450 ./launch_dev.sh server
#   SKIP_DOCKER=1 ./launch_dev.sh server
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MODE="${1:-server}"
SKIP_DOCKER="${SKIP_DOCKER:-0}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

log()  { printf '[launch_dev] %s\n' "$*"; }
warn() { printf '[launch_dev] WARN: %s\n' "$*" >&2; }
die()  { printf '[launch_dev] ERROR: %s\n' "$*" >&2; exit 1; }

# Prefer nvm Node if present (Linux native)
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
fi

have() { command -v "$1" >/dev/null 2>&1; }

is_linux_node() {
  have node || return 1
  local p
  p="$(command -v node)"
  case "$p" in
    *.exe|*/Program\ Files/*) return 1 ;;
  esac
  [[ "$(node -p "process.platform" 2>/dev/null || true)" == "linux" ]]
}

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    die "Master .env not found at $ENV_FILE"
  fi
  log "Loading env from $ENV_FILE"
  # Export KEY=VALUE; skip comments/blanks; strip CR; no export of bare flags
  set -a
  # shellcheck disable=SC1090
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//$'\r'/}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      # shellcheck disable=SC2163
      export "$line"
    fi
  done < "$ENV_FILE"
  set +a
}

start_infra() {
  if [[ "$SKIP_DOCKER" == "1" ]]; then
    warn "SKIP_DOCKER=1 — not starting redis/redpanda"
    return 0
  fi
  if ! have docker; then
    warn "docker not on PATH — start redis/redpanda yourself or enable Docker Desktop WSL integration"
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "docker daemon not reachable — skip infra"
    return 0
  fi
  log "Starting Redpanda + Redis infrastructure..."
  docker compose up -d --no-recreate redis redpanda redpanda-console
  log "Infrastructure containers started (or already running)"
}

require_linux_node() {
  if ! is_linux_node; then
    die "Need a Linux Node.js binary (v18+). Run: ./scripts/setup-linux.sh install-node
Currently: $(command -v node 2>/dev/null || echo 'no node')"
  fi
  local maj
  maj="$(node -p "process.versions.node.split('.')[0]")"
  if (( maj < 18 )); then
    die "Node $(node -v) too old; need v18+"
  fi
  log "Using $(node -v) ($(command -v node))"
}

run_server() {
  require_linux_node
  load_env
  start_infra

  export WECRYPTO_OPEN_DEVTOOLS="${WECRYPTO_OPEN_DEVTOOLS:-0}"
  export ELECTRON_ENABLE_LOGGING="${ELECTRON_ENABLE_LOGGING:-0}"
  export PYTH_LAZER_CHANNEL="${PYTH_LAZER_CHANNEL:-fixed_rate@1000ms}"
  export PYTH_FALLBACK_TIMEOUT_MS="${PYTH_FALLBACK_TIMEOUT_MS:-9000}"
  export PYTH_FALLBACK_GRACE_MS="${PYTH_FALLBACK_GRACE_MS:-3000}"
  export PYTH_LIVE_FEED_BACKOFF_MS="${PYTH_LIVE_FEED_BACKOFF_MS:-250}"
  export WECRYPTO_WEB_HOST="${WECRYPTO_WEB_HOST:-127.0.0.1}"
  export WECRYPTO_WEB_PORT="${WECRYPTO_WEB_PORT:-3450}"
  export NODE_ENV="${NODE_ENV:-development}"
  # Without Docker/Redpanda, skip orbital so the web service still binds for tunnels.
  if [[ "$SKIP_DOCKER" == "1" ]] || ! have docker || ! docker info >/dev/null 2>&1; then
    export WECRYPTO_SKIP_ORBITAL="${WECRYPTO_SKIP_ORBITAL:-1}"
    export WECRYPTO_REDPANDA_CONNECT_MS="${WECRYPTO_REDPANDA_CONNECT_MS:-5000}"
    warn "Docker/Redpanda not available — WECRYPTO_SKIP_ORBITAL=${WECRYPTO_SKIP_ORBITAL}"
  fi

  log "Headless server mode"
  log "  web:   https://${WECRYPTO_WEB_HOST}:${WECRYPTO_WEB_PORT}  (self-signed; use curl -sk)"
  log "  proxy: http://127.0.0.1:3010 (if started by app/proxy binary)"
  log "  tunnel: https://127.0.0.1:${WECRYPTO_WEB_PORT}  + origin noTLSVerify"

  # Fail fast with a clear message if port already bound
  local port="${WECRYPTO_WEB_PORT}"
  if (echo >/dev/tcp/127.0.0.1/"$port") >/dev/null 2>&1; then
    if curl -sk --max-time 2 "https://127.0.0.1:${port}/api/status" 2>/dev/null | grep -q '"success"'; then
      die "Port ${port} already in use by a healthy WECRYPTO instance.
  Use it:  curl -sk https://127.0.0.1:${port}/api/status
  Or stop:  fuser -k ${port}/tcp
  Then re-run: ./launch_dev.sh server"
    fi
    die "Port ${port} already in use (EADDRINUSE).
  Free it:  fuser -k ${port}/tcp
  Then re-run: ./launch_dev.sh server"
  fi

  exec npm run start:server
}

run_electron() {
  require_linux_node
  load_env
  start_infra

  export WECRYPTO_OPEN_DEVTOOLS="${WECRYPTO_OPEN_DEVTOOLS:-1}"
  export ELECTRON_ENABLE_LOGGING="${ELECTRON_ENABLE_LOGGING:-1}"
  export PYTH_LAZER_CHANNEL="${PYTH_LAZER_CHANNEL:-fixed_rate@1000ms}"
  export PYTH_FALLBACK_TIMEOUT_MS="${PYTH_FALLBACK_TIMEOUT_MS:-9000}"
  export PYTH_FALLBACK_GRACE_MS="${PYTH_FALLBACK_GRACE_MS:-3000}"
  export PYTH_LIVE_FEED_BACKOFF_MS="${PYTH_LIVE_FEED_BACKOFF_MS:-250}"

  if [[ ! -x "$ROOT/node_modules/electron/dist/electron" ]]; then
    warn "Linux Electron binary missing (node_modules still look Windows-only)"
    die "Run: ./scripts/setup-linux.sh install-deps
Then retry: ./launch_dev.sh electron"
  fi

  if [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    warn "No DISPLAY/WAYLAND_DISPLAY — GUI may fail under headless WSL"
  fi

  log "Electron GUI mode"
  exec npm run start:dev
}

run_docker_backend() {
  load_env
  have docker || die "docker required for docker mode"
  docker info >/dev/null 2>&1 || die "docker daemon not reachable"
  log "Starting infra + wecrypto-backend via compose..."
  docker compose up -d --no-recreate redis redpanda redpanda-console wecrypto-backend
  log "Backend published on host :3443 (web) and :3010 (proxy) per docker-compose.yml"
  docker compose ps
}

run_infra_only() {
  SKIP_DOCKER=0
  start_infra
}

case "$MODE" in
  server|headless) run_server ;;
  electron|gui|ui) run_electron ;;
  docker|backend)  run_docker_backend ;;
  infra)           run_infra_only ;;
  help|-h|--help)
    sed -n '1,25p' "$0"
    ;;
  *)
    die "Unknown mode '$MODE'. Use: server | electron | docker | infra"
    ;;
esac
