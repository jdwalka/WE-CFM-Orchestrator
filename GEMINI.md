# WE-CRYPTO Pair Programming & Session Rules

## Rule 1: Mandatory Session Synchronization (wecrypto-session-sync)
At the start of every session, after context resumption, and throughout interactions:
1. Always activate and execute the `wecrypto-session-sync` workflow:
   `python G:\WECRYP\.agents\skills\wecrypto-session-sync\scripts\sync_session.py`
2. Ensure `G:\WECRYP\claude-mem` is synced to WSL `/home/mauro/claude-mem`.
3. Verify that SOCKS5 (:18090), HTTP Bouncer (:3010), and Gemini Agent (:8003) remain active.
4. If Gemini agent on :8003 is down, auto-spawn it via `python G:\WECRYP\gemini_agent.py` as a background daemon.

## Rule 2: Anchor & Network Integrity
1. Anchor exclusively in `G:\WECRYP` on host and `/mnt/g/WECRYP` in WSL. Never touch `C:\` except for task logs.
2. Permanent ban on Google Finance; exclusively live exchange tape via Mullvad Sweden egress (`89.37.63.142` / port 3010 / port 18090).
3. Do NOT commit `claude-mem` to version control (it is ignored via `.gitignore`).
4. Keep GitHub PR #230 and GitLab MR #30 synchronized on branch `feat/mullvad-socks-routing-and-jdwalkaz-bridge`.
