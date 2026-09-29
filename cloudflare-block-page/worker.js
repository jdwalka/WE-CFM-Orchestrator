/**
 * leaksnipe-block-page — funny WAF/custom-error page for Walker Enterprises.
 * Pulls the visitor's REAL origin IP + full header data, then STRIPS every IP
 * before display (masked octets only — full IPs stay in edge logs, never on screen).
 *
 * Deploy as a Cloudflare Worker in front of the zone (or paste the HTML into
 * Zone > Custom Pages). The Worker injects real visitor data from `cf`.
 */

const REDACT_VALUE = new Set([
  "cookie", "authorization", "proxy-authorization", "set-cookie",
  "cf-access-jwt-assertion", "cf-access-client-id", "x-auth-token",
  "x-api-key", "api-key",
]);
const REDACT_SUBSTR = ["token", "secret", "passwd", "password", "session"];

function shouldRedact(name) {
  const n = name.toLowerCase();
  if (REDACT_VALUE.has(n)) return true;
  return REDACT_SUBSTR.some((s) => n.includes(s));
}

/** 203.0.113.45 -> "203.0.•.•" | 2001:db8::1 -> "2001:db8:••••:••••:••••:••••:••••:••••" */
function maskIP(ip) {
  if (!ip || ip === "???") return "???";
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.•.•`;
    return "•.•.•.•";
  }
  if (ip.includes(":")) {
    const head = ip.split(":").slice(0, 2).join(":");
    return `${head}:••••:••••:••••:••••:••••:••••`;
  }
  return "•redacted•";
}

function maskXff(xff) {
  if (!xff) return "—";
  return xff.split(",").map((h) => maskIP(h.trim())).join(", ");
}

export default {
  async fetch(request, env, ctx) {
    const cf = request.cf || {};
    const url = new URL(request.url);
    const ua = request.headers.get("user-agent") || "mysteriously blank (sus)";

    // ── Origin IP: trust ONLY the edge. XFF is user-controlled graffiti. ──
    const originIP = request.headers.get("cf-connecting-ip") || "???";
    const xff = request.headers.get("x-forwarded-for") || "";
    const xffHops = xff ? xff.split(",").map((h) => h.trim()).filter(Boolean) : [];
    const spoofed = xffHops.length > 0 && !xffHops.includes(originIP);

    // ── Header dump: everything, values redacted where sensitive. ──
    const headers = [];
    for (const [name, value] of request.headers) {
      const redacted = shouldRedact(name);
      headers.push({
        name,
        value: redacted ? "▓▓▓▓▓▓ (redacted — nice try)" : (value.length > 140 ? value.slice(0, 140) + "…" : value),
        redacted,
      });
    }
    headers.sort((a, b) => a.name.localeCompare(b.name));

    const data = {
      incident:  "INC-" + Date.now().toString(36).toUpperCase() + "-" +
                 Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0"),
      ipMasked:  maskIP(originIP),
      ipHint:    originIP === "???" ? "edge refused to say" : `ends in .${originIP.includes(".") ? originIP.split(".").slice(2).join(".").replace(/\d/g, "•") : "••••"}`,
      xffMasked: maskXff(xff),
      xffHops:   xffHops.length,
      spoofed,
      city:      cf.city || "Unknown",
      country:   cf.country || "XX",
      region:    cf.region || "—",
      asn:       cf.asn ? `AS${cf.asn} (${cf.asName || "mystery ISP"})` : "—",
      tls:       cf.tlsVersion || "ancient",
      tlsCipher: cf.tlsCipher || "—",
      http:      cf.httpProtocol || "—",
      bot:       cf.botManagement ? `score ${cf.botManagement.score}/100` : "ungraded",
      ja3:       (cf.botManagement && cf.botManagement.ja3Hash) || "withheld",
      trust:     (cf.clientTrustScore != null) ? `${cf.clientTrustScore}/100` : "unscored",
      continent: cf.continent || "—",
      postal:    cf.postalCode || "—",
      tz:        cf.timezone || "—",
      latlong:   (cf.latitude && cf.longitude) ? `${cf.latitude}, ${cf.longitude}` : "—",
      // Client Hints: the browser rats out its own hardware.
      chPlatform: request.headers.get("sec-ch-ua-platform") || "—",
      chVersion:  request.headers.get("sec-ch-ua-platform-version") || "—",
      chModel:    request.headers.get("sec-ch-ua-model") || "—",
      chMobile:   request.headers.get("sec-ch-ua-mobile") || "—",
      chArch:     request.headers.get("sec-ch-ua-arch") || "—",
      chBitness:  request.headers.get("sec-ch-ua-bitness") || "—",
      chFull:     request.headers.get("sec-ch-ua-full-version-list") || request.headers.get("sec-ch-ua") || "—",
      // MDM: no enrollment signal presented. A managed device shows one; this one didn't.
      mdm:        request.headers.get("cf-access-device-posture") ? "managed (posture presented)" : "UNMANAGED — no MDM enrollment signal presented",
      ray:       request.headers.get("cf-ray") || crypto.randomUUID().slice(0, 8),
      ua,
      os:        guessOS(ua),
      browser:   guessBrowser(ua),
      time:      new Date().toISOString(),
      host:      url.hostname,
      headers,
      headerCount: headers.length,
    };

    return new Response(renderPage(data, pickReasons(data)), {
      status: 403,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};

function guessOS(ua) {
  if (/windows nt 10/i.test(ua)) return "Windows 10/11";
  if (/windows/i.test(ua)) return "Windows (vintage?)";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/iphone|ipad/i.test(ua)) return "iOS";
  if (/linux/i.test(ua)) return "Linux (respect)";
  return "classified";
}

function guessBrowser(ua) {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/firefox/i.test(ua)) return "Firefox";
  if (/chrome/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return "Safari";
  if (/curl|wget|python|bot|crawl|spider/i.test(ua)) return "definitely-not-a-bot";
  return "unknown";
}

function pickReasons(d) {
  const all = [
    {
      title: "Not in the LeakSnipe Beta Program",
      body: "Walker Enterprises only lets beta members past this point. Membership is free, exclusive, and currently invitation-only. The invitations are also exclusive. You do the math.",
    },
    {
      title: `Encryption from the Mesozoic era (${esc(d.tls)})`,
      body: "Your connection negotiated weaker crypto than our coffee machine. We require TLS 1.2+ — preferably 1.3, like civilized packets.",
    },
    {
      title: d.spoofed ? "Caught forging your own IP" : "Your IP has a reputation (and not a good one)",
      body: d.spoofed
        ? `Your X-Forwarded-For claims ${esc(d.xffMasked)}, but the edge says you're ${esc(d.ipMasked)}. Forging headers to a firewall is bold. Wrong, but bold.`
        : `${esc(d.ipMasked)} (yes, masked — we're gentlemen) has been seen doing things. The firewall remembers, even if you don't.`,
    },
    {
      title: "Geography happened",
      body: `You appear to be in ${esc(d.city)}, ${esc(d.country)}. Nothing personal — the edge node assigned to you is on a coffee break.`,
    },
    {
      title: `Bot score: ${esc(d.bot)}`,
      body: "You move like a bot, you browse like a bot. If you ARE a bot, please present your bot union card. If you're human, try moving the mouse in a less suspiciously perfect straight line.",
    },
    {
      title: "The hamster is tired",
      body: "One (1) edge hamster powers this route. It has requested PTO. Your request is now #42,069 in line. It is not moving.",
    },
  ];
  const rest = all.slice(1).sort(() => Math.random() - 0.5).slice(0, 2);
  return [all[0], ...rest];
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderPage(d, reasons) {
  const rows = [
    ["Your IP", `<code>${esc(d.ipMasked)}</code> <span class="q">— masked. the full thing is in our logs, where it belongs</span>`],
    ["Forwarded-for chain", `<code>${esc(d.xffMasked)}</code> <span class="q">— ${d.xffHops} hop(s)${d.spoofed ? ", and at least one is a lie" : ""}</span>`],
    ["Location", `${esc(d.city)}, ${esc(d.region)}, ${esc(d.country)} <span class="q">— wave to the camera</span>`],
    ["Network", `${esc(d.asn)} <span class="q">— we called them, they know what you did</span>`],
    ["Browser", `${esc(d.browser)} on ${esc(d.os)} <span class="q">— bold choice</span>`],
    ["Encryption", `${esc(d.tls)} (${esc(d.tlsCipher)}) over ${esc(d.http)} <span class="q">— ${/^TLS 1\.[23]/.test(d.tls) ? "acceptable. barely." : "yikes."}</span>`],
    ["Bot score", `${esc(d.bot)} <span class="q">— no judgment. some judgment.</span>`],
    ["Headers sent", `${d.headerCount} <span class="q">— full dump below, secrets redacted</span>`],
    ["Time of denial", `${esc(d.time)} <span class="q">— memorialized forever</span>`],
    ["Ray ID", `<code>${esc(d.ray)}</code> <span class="q">— screenshot this for the group chat</span>`],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");

  const hdrRows = d.headers.map((h) =>
    `<tr class="${h.redacted ? "red" : ""}"><th>${esc(h.name)}</th><td><code>${esc(h.value)}</code></td></tr>`
  ).join("");

  const cards = reasons.map((r, i) => `
    <div class="card">
      <div class="num">${i + 1}</div>
      <h3>${esc(r.title)}</h3>
      <p>${r.body}</p>
    </div>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⛔ Nope. — Walker Enterprises</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #e6edf3; font-family: ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  .banner { border: 1px solid #f85149; border-radius: 12px; padding: 28px; background: linear-gradient(180deg, #2a1215, #0b0e14); text-align: center; }
  .banner h1 { margin: 0 0 8px; font-size: 34px; letter-spacing: -1px; }
  .banner p { margin: 4px 0; color: #9aa4b2; }
  .rec { display: inline-block; font-size: 12px; letter-spacing: 2px; color: #f85149; border: 1px solid #f85149; border-radius: 6px; padding: 4px 12px; margin-bottom: 14px; }
  .rec .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #f85149; margin-right: 8px; animation: blink 1.2s infinite; }
  @keyframes blink { 50% { opacity: 0.2; } }
  .host { color: #f85149; font-weight: bold; }
  h2 { margin: 36px 0 12px; font-size: 18px; color: #7ee787; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
  th { color: #9aa4b2; font-weight: normal; width: 170px; }
  td code { color: #79c0ff; word-break: break-all; }
  tr.red td code { color: #f85149; }
  .q { color: #6e7681; font-style: italic; }
  .cards { display: grid; gap: 12px; }
  .card { border: 1px solid #30363d; border-radius: 10px; padding: 16px 16px 16px 56px; position: relative; background: #11161d; }
  .card .num { position: absolute; left: 14px; top: 14px; width: 28px; height: 28px; border-radius: 50%; background: #f85149; color: #0b0e14; font-weight: bold; display: flex; align-items: center; justify-content: center; }
  .card h3 { margin: 2px 0 6px; font-size: 15px; }
  .card p { margin: 0; color: #9aa4b2; font-size: 14px; line-height: 1.5; }
  details { margin-top: 16px; border: 1px solid #30363d; border-radius: 10px; background: #11161d; }
  details summary { cursor: pointer; padding: 14px 16px; color: #7ee787; }
  details table { font-size: 12px; }
  .cta { margin-top: 28px; text-align: center; }
  .cta button { background: #238636; color: #fff; border: 0; border-radius: 8px; padding: 12px 28px; font-size: 15px; font-family: inherit; cursor: pointer; }
  .cta button:hover { background: #2ea043; }
  #queue { margin-top: 12px; color: #7ee787; min-height: 22px; }
  footer { margin-top: 48px; color: #6e7681; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="banner">
    <div class="rec"><span class="dot"></span>REC — THIS ATTEMPT IS BEING LOGGED</div>
    <h1>⛔ Yeah… no.</h1>
    <p>You tried to reach <span class="host">${esc(d.host)}</span> and the edge said absolutely not.</p>
    <p>Incident <code>${esc(d.incident)}</code> opened at ${esc(d.time)} and preserved. Yes, <em>yours</em>.</p>
    <p>We pulled your origin IP and every header you sent — then stripped the IPs, because unlike <em>some people</em>, we have manners.</p>
  </div>

  <h2>🔍 What you're broadcasting (redacted for your protection)</h2>
  <table>${rows}</table>
  <p class="q" style="font-size:13px">Full IPs live in edge logs only.</p>

  <h2>📟 Device &amp; posture dossier</h2>
  <table>
    <tr><th>Device model</th><td>${esc(d.chModel)} <span class="q">— your browser volunteered this</span></td></tr>
    <tr><th>Platform</th><td>${esc(d.chPlatform)} ${esc(d.chVersion)} ${esc(d.chArch)}${esc(d.chBitness) !== "—" ? " / " + esc(d.chBitness) + "-bit" : ""} ${esc(d.chMobile) === "?1" ? "(mobile)" : ""}</td></tr>
    <tr><th>Client build</th><td><code>${esc(d.chFull).slice(0, 120)}</code></td></tr>
    <tr><th>Country / continent</th><td>${esc(d.country)} / ${esc(d.continent)} ${esc(d.postal) !== "—" ? "(postal " + esc(d.postal) + ")" : ""}</td></tr>
    <tr><th>Coordinates</th><td><code>${esc(d.latlong)}</code> <span class="q">— accurate enough to wave at</span></td></tr>
    <tr><th>Timezone</th><td>${esc(d.tz)}</td></tr>
    <tr><th>TLS fingerprint (JA3)</th><td><code>${esc(d.ja3)}</code> <span class="q">— your handshake is unique. like a snowflake. a guilty snowflake.</span></td></tr>
    <tr><th>Trust score</th><td>${esc(d.trust)}</td></tr>
    <tr><th>MDM enrollment</th><td>${esc(d.mdm)} <span class="q">— personal hardware gets no benefit of the doubt</span></td></tr>
  </table>

  <h2>💻 …and your own browser just told us the rest</h2>
  <table id="liveSpecs"><tr><th>Probing…</th><td>hold still</td></tr></table>

  <h2>📦 Every header you sent us</h2>
  <details>
    <summary>Expand all ${d.headerCount} headers (cookies, tokens &amp; secrets pre-redacted)</summary>
    <table>${hdrRows}</table>
  </details>

  <h2>🚧 Why you're not getting in (pick your favorite)</h2>
  <div class="cards">${cards}</div>

  <div class="cta">
    <button id="joinBtn">Join the LeakSnipe Beta Waitlist</button>
    <div id="queue"></div>
  </div>

  <footer>Walker Enterprises · LeakSnipe Beta Program · Denial served from the edge in 0ms — faster than your excuses.</footer>
</div>
<script>
  document.getElementById('joinBtn').addEventListener('click', function () {
    var n = 42000 + Math.floor(Math.random() * 999);
    document.getElementById('queue').textContent =
      '🎉 You are #' + n + ' in line. Estimated wait: heat death of the universe.';
    this.disabled = true;
    this.textContent = 'Waitlisted (allegedly)';
  });
  try {
    var specs = [];
    specs.push(['CPU cores', navigator.hardwareConcurrency || 'hidden (cute)']);
    specs.push(['Device RAM', navigator.deviceMemory ? '~' + navigator.deviceMemory + ' GB' : 'hidden (cuter)']);
    specs.push(['Screen', window.screen.width + 'x' + window.screen.height + ' @' + (window.devicePixelRatio || 1) + 'x']);
    specs.push(['Touch points', navigator.maxTouchPoints || 0]);
    specs.push(['Timezone', Intl.DateTimeFormat().resolvedOptions().timeZone]);
    specs.push(['Language', navigator.language + (navigator.languages ? ' (+' + (navigator.languages.length - 1) + ' more)' : '')]);
    specs.push(['Automation flag', navigator.webdriver ? 'TRUE — hello, selenium' : 'false (allegedly human)']);
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl');
      var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
      specs.push(['GPU', dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'masked (paranoid GPU, respect)']);
    } catch (e) { specs.push(['GPU', 'refused to answer']); }
    document.getElementById('liveSpecs').innerHTML = specs.map(function (s) {
      return '<tr><th>' + s[0] + '</th><td><code>' + String(s[1]).replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></td></tr>';
    }).join('');
  } catch (e) {}
</script>
</body>
</html>`;
}
