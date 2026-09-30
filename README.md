# WE-CFM-Orchestrator (WE|||CRYPTO)

WE-CFM-Orchestrator is a market-data, quantitative analytics, and prediction-market research application. It combines an Electron desktop interface with data-feed adapters, signal and probability models, adaptive calibration, and backtesting tools.

> **License notice:** This repository is publicly viewable, but it is **not open source** and public visibility does not grant permission to use, run, copy, modify, or redistribute the software. Access and use are governed by [`LICENSE`](./LICENSE); written authorization may be required.

> **Risk notice:** Outputs are model estimates for research and analysis, not investment advice or guaranteed outcomes. Market data can be delayed, incomplete, or unavailable, and model performance can change. Verify data and results independently; do not rely on this software as the sole basis for financial decisions.

## What it does

- Collects and displays cryptocurrency market, order-book, and prediction-market data from configured providers.
- Produces probabilistic directional and contract-related analytics for `BTC`, `ETH`, `SOL`, `XRP`, `DOGE`, `BNB`, and `HYPE`.
- Tracks model signals and outcomes and includes adaptive calibration and tuning components.
- Provides backtesting, diagnostics, and operational status tools for evaluating model behavior.
- Supports optional integrations for data oracles, language-model providers, cloud services, and streaming infrastructure. These require their own configuration and may not be needed for a basic local run.

The repository is under active development. Features, provider availability, and configuration requirements can vary between revisions; consult the source and relevant documentation for the version you have.

## Requirements

- Node.js (Node 20 LTS is recommended) and npm.
- A supported desktop environment for the Electron GUI.
- Optional integrations may additionally require provider credentials, Docker, or other services. Configure only the integrations you intend to use.

## Getting started

Install dependencies and launch the desktop app:

```bash
npm install
npm start
```

The `start` script builds the quant TypeScript layer and launches Electron. The first startup may show incomplete data while configured providers connect and populate their caches.

### Configuration and credentials

Use [`.env.example`](./.env.example) as a reference for supported environment settings. Copy it to `.env` only if needed, then configure only the variables for the providers and optional services you use. Some integrations can also load credentials from local secret files; follow the relevant provider documentation.

**Never commit `.env`, API keys, private keys, service-account files, tokens, or other credentials.** Keep real values in local environment files or an approved secret manager. The checked-in example should contain placeholders only.

See [Configuration](./docs/CONFIGURATION.md) and [Getting Started](./docs/GETTING-STARTED.md) for additional setup notes.

## Run modes

### Linux and WSL

The repository includes scripts for Linux setup, a headless server, Docker services, and an optional desktop GUI:

```bash
npm run setup:linux:check
npm run setup:linux
npm run start:linux
```

`start:linux` launches the headless server mode. Other options include:

```bash
npm run start:linux:docker
npm run start:linux:electron
```

The Electron GUI requires a working Linux display and Linux-compatible Electron dependencies. Review [`LINUX.md`](./LINUX.md) before setting up Linux or WSL; Docker and optional services have separate requirements.

### Build packages

The configured packaging scripts build Windows artifacts:

```bash
npm run build:portable
npm run build:installer
```

Build outputs are written to `dist/`. Release variants run preflight checks first; see [`package.json`](./package.json) for the available scripts.

## Tests and checks

Run the existing local test scripts with Node.js:

```bash
node tests/test-signal-logic-audit.js
node tests/test-integration.js
npm run test:mergekit
npm run test:resonance
npm run test:hud-perf
```

Some tests need live providers, credentials, a running proxy, or other services. For example, live-feed and API-status checks depend on configured connectivity. Check each test's requirements before running it.

## Architecture at a glance

The application is organized around a few major layers:

1. **Electron host** — `electron/main.js` starts the desktop process and coordinates application services.
2. **Renderer and interface** — `public/index.html` loads the renderer scripts; `src/core/app-core.js`, `src/core/app-init.js`, and related modules compose the interface and runtime behavior.
3. **Market data and prediction markets** — feed adapters and `src/prediction-markets/` modules collect and normalize provider data.
4. **Prediction and calibration** — `src/core/` and `src/quant/` contain signal generation, analytics, regime and calibration utilities, and learning components.
5. **Optional infrastructure** — `src/infra/`, `src/orbital/`, and `src/cloud/` contain proxy, streaming, and cloud integrations that can be enabled as configured.

Renderer modules use browser globals and are loaded as scripts rather than as an ES-module application. The order of scripts in `public/index.html` is significant; preserve it when changing renderer dependencies.

## Repository layout

| Path | Purpose |
| --- | --- |
| `electron/` | Electron main process, preload, workers, and desktop integrations |
| `public/` | Renderer HTML and static assets |
| `src/core/` | Application composition, predictions, signal processing, and calibration |
| `src/feeds/` | Market and external data-feed adapters |
| `src/prediction-markets/` | Prediction-market data, settlement, and scorecard modules |
| `src/quant/` | Statistical and quantitative utilities |
| `src/infra/`, `src/orbital/`, `src/cloud/` | Optional infrastructure and service integrations |
| `tests/` | Focused tests and diagnostics |
| `backtest/` | Backtesting and tuning tools |
| `docs/` | Guides and technical references |

## Documentation

- [Getting Started](./docs/GETTING-STARTED.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Development Setup](./docs/DEVELOPMENT.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Testing](./docs/TESTING.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Linux / WSL](./LINUX.md)
- [Security Policy](./SECURITY.md)
- [License](./LICENSE)

## License

This software is proprietary and all rights are reserved. See [`LICENSE`](./LICENSE) for the terms that apply to access and use. No open-source license is granted by this README or by making the repository viewable.
