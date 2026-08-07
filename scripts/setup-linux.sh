#!/usr/bin/env bash
# setup-linux.sh — prepare a Linux/WSL host to run WECRYPTO without Windows Electron.
# Safe to re-run. Does not print .env secrets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIN_NODE_MAJOR=18
MODE="${1:-check}"   # check | install-node | install-deps | build-proxy | all

log()  { printf '[setup-linux] %s\n' "$*"; }
warn() { printf '[setup-linux] WARN: %s\n' "$*" >&2; }
die()  { printf '[setup-linux] ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

is_linux_node() {
  have node || return 1
  # Reject Windows node.exe interop when we need native Linux modules/electron
  local p
  p="$(command -v node)"
  case "$p" in
    *.exe|*/Program\ Files/*|*/ProgramFiles/*) return 1 ;;
  esac
  # node -p process.platform
  [[ "$(node -p "process.platform" 2>/dev/null || true)" == "linux" ]]
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

check_env() {
  if [[ ! -f "$ROOT/.env" ]]; then
    die "Master .env not found at $ROOT/.env — copy .env.example and fill keys first"
  fi
  log ".env present"
}

check_node() {
  if is_linux_node; then
    local maj
    maj="$(node_major)"
    if (( maj >= MIN_NODE_MAJOR )); then
      log "Linux Node OK: $(node -v) at $(command -v node)"
      return 0
    fi
    warn "Node $(node -v) is too old (need v${MIN_NODE_MAJOR}+)"
    return 1
  fi
  if have node; then
    warn "Node is present but not a Linux binary: $(command -v node)"
    warn "WSL often picks Windows node.exe — install Linux Node (nvm recommended)"
  else
    warn "No node on PATH"
  fi
  return 1
}

install_node_nvm() {
  if is_linux_node && (( $(node_major) >= MIN_NODE_MAJOR )); then
    log "Linux Node already OK"
    return 0
  fi
  if ! have curl; then
    die "curl required to install nvm"
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    log "Installing nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  log "Installing Node 22 via nvm..."
  nvm install 22
  nvm alias default 22
  nvm use 22
  check_node || die "nvm install finished but Linux node still not usable"
}

check_docker() {
  if have docker && docker info >/dev/null 2>&1; then
    log "Docker OK: $(docker --version)"
    if docker compose version >/dev/null 2>&1; then
      log "Docker Compose OK: $(docker compose version --short 2>/dev/null || true)"
      return 0
    fi
  fi
  warn "Docker not usable from this shell"
  warn "WSL: enable Docker Desktop → Settings → Resources → WSL integration → this distro"
  return 1
}

install_deps() {
  check_node || die "Install Linux Node first: $0 install-node"
  check_env
  log "Installing npm dependencies (legacy-peer-deps)..."
  # Prefer a clean electron binary for this platform when running GUI mode later
  npm install --legacy-peer-deps
  log "npm install done"
  if [[ -f node_modules/electron/path.txt ]]; then
    log "electron path.txt → $(cat node_modules/electron/path.txt)"
  fi
}

build_proxy() {
  if ! have cargo; then
    warn "cargo not found — proxy will use JS fallback or cargo-less path"
    warn "Install Rust: https://rustup.rs  then re-run: $0 build-proxy"
    return 1
  fi
  log "Building we-crypto-proxy (release) for Linux..."
  (cd "$ROOT/proxy" && cargo build --release --bin we-crypto-proxy)
  local bin="$ROOT/proxy/target/release/we-crypto-proxy"
  if [[ -x "$bin" ]]; then
    log "Proxy binary: $bin"
    # Convenience copy at repo root (matches Windows we-crypto-proxy.exe layout)
    cp -f "$bin" "$ROOT/we-crypto-proxy"
    chmod +x "$ROOT/we-crypto-proxy"
    log "Also copied to $ROOT/we-crypto-proxy"
  else
    die "Build finished but binary missing: $bin"
  fi
}

print_summary() {
  cat <<EOF

Next steps
----------
  Headless (recommended for Canada / tunnel trde):
    ./launch_dev.sh
    # or:  ./launch_dev.sh server

  Optional GUI (needs Linux Electron + display):
    ./launch_dev.sh electron

  Docker-only backend (compose service):
    ./launch_dev.sh docker

  Tunnel origin (after server is up):
    http://127.0.0.1:\${WECRYPTO_WEB_PORT:-3450}
    proxy: http://127.0.0.1:3010

EOF
}

cmd_check() {
  check_env
  local ok=0
  check_node || ok=1
  check_docker || true
  if have cargo; then
    log "Rust/cargo OK: $(cargo --version)"
  else
    warn "cargo not installed (optional; needed for native proxy)"
  fi
  if [[ -x "$ROOT/proxy/target/release/we-crypto-proxy" || -x "$ROOT/we-crypto-proxy" ]]; then
    log "Linux proxy binary present"
  else
    warn "No Linux proxy binary yet (run: $0 build-proxy)"
  fi
  print_summary
  return "$ok"
}

case "$MODE" in
  check)         cmd_check ;;
  install-node)  install_node_nvm ;;
  install-deps)  install_deps ;;
  build-proxy)   build_proxy ;;
  all)
    install_node_nvm
    install_deps
    build_proxy || warn "proxy build skipped/failed — JS fallback may still work"
    check_docker || true
    print_summary
    log "setup-linux all finished"
    ;;
  *)
    die "Usage: $0 {check|install-node|install-deps|build-proxy|all}"
    ;;
esac
