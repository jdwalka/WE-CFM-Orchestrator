# Contributing to WE-CFM-Orchestrator

Thank you for your interest in contributing! This guide covers the process for submitting changes.

---

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/WE-CFM-Orchestrator.git
   cd WE-CFM-Orchestrator
   npm install
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feature/my-improvement
   ```

---

## Development Workflow

1. Make your changes following the conventions below
2. Test locally:
   ```bash
   npm start                       # verify the app runs
   node test-integration.js        # run integration tests
   node test-signal-logic-audit.js # check for signal inversions
   ```
3. Commit with a clear message:
   ```bash
   git commit -m "feat: improve ETH spin state calibration"
   ```
4. Push and open a Pull Request against `main`

---

## Code Conventions

### Script Load Order

`public/index.html` defines the renderer's **dependency graph** via `<script>` tag order.  
If you add a new module, place it **before** `src/core/app.js` and **after** any modules it depends on.

### Global Runtime Contract

Expose cross-module APIs on `window`, not via ES module imports:

```javascript
// Good
window.MyModule = (function() {
  return { doThing };
})();

// Not supported in renderer
export function doThing() { ... }
```

### Coin Universe

The canonical coin list is **BTC, ETH, SOL, XRP, DOGE, BNB, HYPE**.  
Any addition or removal must be synchronised across `predictions.js`, Kalshi mapping, orchestrator, and UI tables.

### localStorage Keys

All persistent state must use the **`beta1_*`** prefix. Do not rename existing keys.

### Build Preservation

**Never overwrite previous `.exe` builds.** Each build must produce a uniquely versioned artifact in `dist/`.

---

## Pull Request Guidelines

- Keep PRs focused on a single concern
- Include a description of *what* changed and *why*
- Reference any related issues (`Fixes #123`)
- Ensure `npm start` runs without errors before submitting

---

## Reporting Issues

Use [GitHub Issues](https://github.com/JohnDaWalka/WE-CFM-Orchestrator/issues) to report bugs.

Include:
- WE-CRYPTO version (shown in the title bar)
- Operating system
- Steps to reproduce
- Expected vs actual behaviour
- Relevant console output

---

## Documentation

Documentation lives in `docs/`. If your change affects:

- System behaviour → update [ARCHITECTURE.md](./docs/ARCHITECTURE.md) or [SIGNALS.md](./docs/SIGNALS.md)
- Configuration → update [CONFIGURATION.md](./docs/CONFIGURATION.md)
- API / console commands → update [API.md](./docs/API.md)
- Deployment → update [DEPLOYMENT.md](./docs/DEPLOYMENT.md)

---

## License

By contributing you agree that your contributions will be licensed under the [MIT License](./LICENSE).
