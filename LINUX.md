# WECRYPTO on Linux / WSL

Windows desktop launcher: `launch_dev.bat`  
Linux / WSL launcher: **`launch_dev.sh`**

## What works on Linux

| Mode | Command | Use case |
|------|---------|----------|
| **Headless server** (default) | `./launch_dev.sh` or `npm run start:linux` | Canada node, `trde` tunnel origin, 24/7 |
| **Docker backend** | `./launch_dev.sh docker` | Full compose service on `:3443` / `:3010` |
| **Electron GUI** | `./launch_dev.sh electron` | Needs Linux Node + Linux Electron + display |
| **Infra only** | `./launch_dev.sh infra` | Redis + Redpanda only |

## One-time setup

```bash
cd /mnt/g/WECRYP   # or your clone path
chmod +x launch_dev.sh scripts/setup-linux.sh

# Install Linux Node (nvm), npm deps, optional Rust proxy
./scripts/setup-linux.sh all

# Or step by step:
./scripts/setup-linux.sh check
./scripts/setup-linux.sh install-node
./scripts/setup-linux.sh install-deps
./scripts/setup-linux.sh build-proxy   # needs rustup/cargo
```

Requirements:

- **Linux Node 18+** (not Windows `node.exe` via WSL interop)
- **Docker** reachable from the distro (Docker Desktop → WSL integration)
- Existing **`.env`** at repo root (same as Windows)
- Optional: **Rust** for native `we-crypto-proxy` (else JS fallback / skip)

## Daily launch (headless)

```bash
cd /mnt/g/WECRYP
./launch_dev.sh
# web default: http://127.0.0.1:3450
```

Override port (e.g. match tunnel):

```bash
WECRYPTO_WEB_PORT=3450 WECRYPTO_WEB_HOST=127.0.0.1 ./launch_dev.sh server
```

Skip compose if Redis/Redpanda already run elsewhere:

```bash
SKIP_DOCKER=1 ./launch_dev.sh server
```

## Cloudflare tunnel (`trde.leaksnipe.win`)

Headless `start:server` serves **HTTPS** with a self-signed cert on port **3450**.

Public hostname on the **Canada** connector:

| Field | Value |
|-------|--------|
| Service | `https://127.0.0.1:3450` |
| Origin TLS | **No TLS Verify** (self-signed) |

Dashboard: Public Hostname → Additional application settings → TLS → **No TLS Verify**.

(or `:3443` **HTTP** if you use `./launch_dev.sh docker`)

Proxy hostname (optional):

```text
http://127.0.0.1:3010
```

Local smoke test:

```bash
curl -sk https://127.0.0.1:3450/ | head
curl -sk https://127.0.0.1:3450/api/status
```

## Windows vs Linux paths

| Asset | Windows | Linux |
|-------|---------|-------|
| Launcher | `launch_dev.bat` | `launch_dev.sh` |
| Proxy binary | `we-crypto-proxy.exe` | `we-crypto-proxy` / `proxy/target/release/` |
| Electron | `node_modules/.../electron.exe` | reinstall via `setup-linux.sh install-deps` |
| node_modules | OK on NTFS for JS | Prefer Linux Node; reinstall electron after switching OS |

**Note:** `node_modules` on `/mnt/g` is shared with Windows. After `npm install` under Linux, Windows Electron may need a Windows-side reinstall. For a clean split, use a Linux git clone under `~/src/WECRYP`.

## Health checks

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3450/health
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3450/api/status
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3010/health
```

## npm scripts

```bash
npm run setup:linux        # all setup steps
npm run setup:linux:check
npm run start:linux        # headless
npm run start:linux:electron
npm run start:linux:docker
npm run build:proxy:linux
```
