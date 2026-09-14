# Truffle Back Online — TODO

## Current state

- **ASI1 HUD error:** `ASI1_PREFERRED_ACCOUNT=mauro` in `.env`, but the current
  client only supports the `leaksnipe` account. The resolver therefore filters
  out all valid keys and reports “API key missing.”
- **Valid ASI1 key exists:** `secrets/ASI1_LEAKSNIPE.txt` is readable and the
  resolver confirms `hasAsi1Credentials() === true`.
- **Truffle HTTP service:** nothing is listening on `127.0.0.1:8002` from WSL
  or Windows, so the HUD cannot reach `POST /query`.

## Recovery checklist

1. **Fix the ASI1 account mismatch**
   - [x] Set `ASI1_PREFERRED_ACCOUNT=leaksnipe` in both env files.
   - [x] Validated ASI1 resolver and account tests.
   - Set `ASI1_PREFERRED_ACCOUNT=leaksnipe` in:
     - `G:\WECRYP\.env`
     - `C:\Users\gitgo\AppData\Roaming\WE-CRYPTO-Polymarket-v2.15.6\.env`
   - Do not change the API key; `secrets/ASI1_LEAKSNIPE.txt` is already valid.

2. **Restart the WECRYP HUD**
   - [ ] Close Electron completely, then relaunch.
   - Confirm the HUD no longer shows “ASI:One API key missing.”

3. **Verify ASI1 routing**
   - [ ] In the HUD, run the ASI1 diagnostics/check.
   - Expected result: credentials present and account `leaksnipe`.
   - If it still reports missing, confirm the app is loading one of the `.env`
     files above and that no stale process remains.

4. **Start the Truffle local service**
   - [x] Located the service at `/home/mauro/leaksnipe-mcp-agent`.
   - [x] Bound the uagents HTTP server explicitly to `127.0.0.1:8002`.
   - [x] Added `GET /health` for the HUD availability probe.
   - [x] Started the service and confirmed registration with Agentverse.
   - Truffle must expose `POST http://127.0.0.1:8002/query`.
   - Start the service on the same host as the HUD.
   - Confirm it is listening before opening the Truffle panel.

5. **Validate the service**
   - Send:
     `curl -X POST http://127.0.0.1:8002/query -H 'Content-Type: application/json' -d '{"query":"ping"}'`
   - Expected response shape: `{ "ok": true, "content": "..." }`.

6. **Retest from iPhone**
   - Open the iPhone messaging flow, select Truffle, and send a short message.
   - A stall should now surface as an explicit HUD error if the service is
     unreachable, rather than a silent hang.

7. **Harden after recovery**
   - [x] Added a 5s availability probe for `127.0.0.1:8002`.
   - [x] Added a red-bordered "Truffle offline" indicator on the Truffle button.
   - [x] Fail fast with an explicit message instead of a 30s stall when offline.
   - [x] Added `wecryp-truffle.service` user unit with automatic restart.
   - [x] Enabled the service so it starts automatically on WSL login.
