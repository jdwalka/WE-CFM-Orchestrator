// ============================================================
// wecryp-nightly.ts — full-stack verification & setup pass
// Covers everything from tonight's session:
//   1. Tailscale: device inventory, WECRYPTO service discovery,
//      ACL check, DNS/MagicDNS status
//   2. Cloudflare: hub route verification, R2 status,
//      scalper-market-data binding check
//   3. hypedog: health, D1 readiness, BTC quote mapping check
//
// Run: TAILSCALE_TOKEN=... CF_API_TOKEN=... npx tsx wecryp-nightly.ts
// ============================================================

const TAILSCALE_TOKEN = process.env.TAILSCALE_TOKEN;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const TAILNET = "prairiedog-godzilla.ts.net";
const ZONE = "leaksnipe.win";
const HUB_URL = "https://hub.leaksnipe.win";
const HYPEDOG_URL = "https://trufflehype.leaksnipe.win";

const report: Record<string, unknown> = {};

// ------------------------------------------------------------
// 1. TAILSCALE PASS
// ------------------------------------------------------------
async function tailscalePass() {
  const headers = { Authorization: `Bearer ${TAILSCALE_TOKEN}` };
  const base = `https://api.tailscale.com/api/v2/tailnet/${TAILNET}`;

  // 1a. Device inventory — find the WECRYPTO app service
  const devicesRes = await fetch(`https://api.tailscale.com/api/v2/tailnet/${TAILNET}/devices`, { headers });
  const devices = await devicesRes.json();
  const wecrypto = (devices.devices ?? []).find((d: any) =>
    /wecryp/i.test(d.hostname ?? "") || /wecryp/i.test(d.name ?? "")
  );
  report.tailscale = {
    totalDevices: devices.devices?.length ?? 0,
    offline: (devices.devices ?? []).filter((d: any) => !d.connectedToControl).map((d: any) => d.hostname),
    wecryptoFound: !!wecrypto,
    wecryptoDevice: wecrypto
      ? { id: wecrypto.id, hostname: wecrypto.hostname, addresses: wecrypto.addresses, tags: wecrypto.tags }
      : null,
  };

  // 1b. ACL policy — verify tailnet can reach the hub endpoint
  const aclRes = await fetch(`${base}/acl`, { headers });
  const acl = await aclRes.json();
  report.acl = {
    raw: acl.acl ?? acl,
    note: "Verify an ACL rule allows the WECRYPTO device's tags to reach hub.leaksnipe.win (outbound HTTPS). Tailscale ACLs govern the tailnet, not public internet — public HTTPS needs no rule, but any internal service routing does.",
  };

  // 1c. DNS / MagicDNS status
  const dnsRes = await fetch(`${base}/dns/nameservers`, { headers });
  const dnsPrefsRes = await fetch(`${base}/dns/preferences`, { headers });
  report.dns = {
    nameservers: await dnsRes.json(),
    preferences: await dnsPrefsRes.json(),
  };

  // 1d. WECRYPTO service config update — wire in the hub URL
  if (wecrypto) {
    // The WECRYPTO app's service config lives on the device itself.
    // Push the hub URL via the device's local config endpoint if it
    // exposes one; otherwise flag for manual update.
    report.wecryptoServiceUpdate = {
      action: "flagged",
      hubUrl: HUB_URL,
      reason:
        "Service config is on-device. If the WECRYPTO app reads its " +
        "backend URL from an env file or local config, set " +
        `WECRYP_HUB_URL=${HUB_URL} and restart the service. ` +
        "Antigravity with device access should do this directly.",
    };
  }
}

// ------------------------------------------------------------
// 2. CLOUDFLARE VERIFICATION
// ------------------------------------------------------------
async function cloudflarePass() {
  const headers = { Authorization: `Bearer ${CF_API_TOKEN}` };

  // 2a. Find the zone
  const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${ZONE}`, { headers });
  const zones = await zonesRes.json();
  const zoneId = zones.result?.[0]?.id;
  if (!zoneId) {
    report.cloudflare = { error: `zone ${ZONE} not found` };
    return;
  }

  // 2b. Hub route — must exist and beat the wildcard *.leaksnipe.win/*
  const routesRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/workers/routes`, { headers });
  const routes = await routesRes.json();
  const hubRoute = (routes.result ?? []).find((r: any) => r.pattern === "hub.leaksnipe.win/*");
  const wildcard = (routes.result ?? []).find((r: any) => r.pattern === "*.leaksnipe.win/*");
  report.cloudflare = {
    hubRoute: hubRoute ? { pattern: hubRoute.pattern, script: hubRoute.script } : null,
    hubRouteMissing: !hubRoute,
    wildcardCatchesHub: !hubRoute && !!wildcard,
    fix: !hubRoute
      ? `POST /zones/${zoneId}/workers/routes {"pattern":"hub.leaksnipe.win/*","script":"wecryp-hub"} — must be added BEFORE the wildcard will stop catching it`
      : null,
  };

  // 2c. R2 status — needed for the kodak-market-archiver
  const r2Res = await fetch(`https://api.cloudflare.com/client/v4/accounts`, { headers });
  const accounts = await r2Res.json();
  const accountId = accounts.result?.[0]?.id;
  if (accountId) {
    const bucketsRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets`,
      { headers }
    );
    const buckets = await bucketsRes.json();
    report.r2 = {
      enabled: buckets.success ?? false,
      buckets: (buckets.result?.buckets ?? []).map((b: any) => b.name),
      note: buckets.success
        ? "R2 live — kodak-market-archiver can be bound to a bucket"
        : "R2 not enabled (error 10042) — enable in dashboard if archiving is wanted",
    };
  }

  // 2d. scalper-market-data bindings — D1 check
  const workersRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    { headers }
  );
  const workers = await workersRes.json();
  const scalper = (workers.result ?? []).find((w: any) => w.id === "scalper-market-data");
  report.scalper = {
    deployed: !!scalper,
    note: "Script metadata shows bindings: [] even when D1 bindings exist (same as hypedog). Definitive check is the live hit below or the dashboard Bindings tab.",
  };
}

// ------------------------------------------------------------
// 3. HYPEDOG CHECKS
// ------------------------------------------------------------
async function hypedogPass() {
  async function safeFetchJson(url: string) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      const text = await res.text();
      try {
        return { status: res.status, ok: res.ok, data: JSON.parse(text) };
      } catch {
        return { status: res.status, ok: res.ok, raw: text.slice(0, 100), isHtml: text.trim().startsWith("<") };
      }
    } catch (e) {
      return { error: String(e && (e as any).message ? (e as any).message : e) };
    }
  }

  // 3a. Health — worker reachable + D1 binding ready
  const healthCustom = await safeFetchJson(`${HYPEDOG_URL}/health`);
  const healthDirect = await safeFetchJson("https://hypedog.gitgoin87.workers.dev/health");
  report.hypedogHealth = {
    customDomain: healthCustom,
    directWorker: healthDirect,
  };

  // 3b. BTC quote — mapping check against Polymarket UI
  const quoteCustom = await safeFetchJson(`${HYPEDOG_URL}/quote?symbol=bitcoin`);
  const quoteDirect = await safeFetchJson("https://hypedog.gitgoin87.workers.dev/quote?symbol=bitcoin");
  report.hypedogBtcQuote = {
    customDomain: quoteCustom,
    directWorker: quoteDirect,
  };

  // 3c. Hub status — probes all four services in parallel
  const hubCustom = await safeFetchJson(`${HUB_URL}/status`);
  const hubDirect = await safeFetchJson("https://wecryp-hub.gitgoin87.workers.dev/status");
  report.hubStatus = {
    customDomain: hubCustom,
    directWorker: hubDirect,
  };
}

// ------------------------------------------------------------
// RUN
// ------------------------------------------------------------
(async () => {
  if (!TAILSCALE_TOKEN) console.warn("⚠ TAILSCALE_TOKEN not set — Tailscale pass skipped");
  else await tailscalePass().catch((e) => (report.tailscaleError = String(e)));

  if (!CF_API_TOKEN) console.warn("⚠ CF_API_TOKEN not set — Cloudflare pass skipped");
  else await cloudflarePass().catch((e) => (report.cloudflareError = String(e)));

  await hypedogPass().catch((e) => (report.hypedogError = String(e)));

  console.log(JSON.stringify(report, null, 2));
})();
