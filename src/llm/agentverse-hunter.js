/**
 * Agentverse Autonomous Contract Hunter & Agent Audit Engine
 *
 * Proactive multi-agent scouting engine using ASI:One Planner Mode and
 * curated Agentverse agents. When the app opens, a non-blocking 60-second
 * timer cues agents to hunt upcoming Polymarket contracts, orderbook anomalies,
 * whale movements, and crowd sentiment divergences on their own.
 */
'use strict';

const Asi1Client = require('../infra/asi1-client');
const CoinPrecision = require('../shared/coin-precision');


/**
 * Curated, audited Agentverse agents verified live on the Fetch.ai registry.
 */
const AUDITED_AGENTVERSE_ROSTER = Object.freeze([
  {
    id: 'polymarket-live',
    name: 'Polymarket Live Data Agent',
    address: 'agent1qw27dykr22mkr8nrp4l8gd8k0xs7xskv578n8l4kllmkkrca6wrxs5zna6f',
    role: 'Live Contract Scout',
    description: 'Queries Polymarket live contracts, open prices, trades, events, and volume',
    capability: 'prediction-market-data',
    rating: 3.5,
    tags: ['polymarket', 'contracts', 'orderbook', 'strikes'],
  },
  {
    id: 'polymarket-scout',
    name: 'Polymarket Conversational Scout',
    address: 'agent1q27j0eghd2ph57vdkk66f50v8cjekmfs5698v87z6j26lkkwameq2p8tcxd',
    role: 'Prediction Market Explorer',
    description: 'Explores prediction market depth, outcome pricing, and liquidity distributions',
    capability: 'market-discovery',
    rating: 3.0,
    tags: ['prediction-markets', 'liquidity', 'probability'],
  },
  {
    id: 'whale-radar',
    name: 'Crypto Whale Radar',
    address: 'agent1q240kxgq5u77auplgtypuwtzwe9suk9asayfuczernje4wzzthvzq59agj5',
    role: 'Whale & Smart Money Radar',
    description: 'Real-time crypto market pulse, derivatives tracking, and native-ETH/BTC whale transfers',
    capability: 'whale-tracking',
    rating: 4.5,
    tags: ['whales', 'derivatives', 'smart-money', 'flows'],
  },
  {
    id: 'vedetta-divergence',
    name: 'Vedetta Sentiment & Divergence',
    address: 'agent1qg6hwwk7zltxq7pamh4ufw04kjywl2ntrkgspmvhdq5yc3mkkjjmk872mxn',
    role: 'Sentiment Divergence Hunter',
    description: 'Evaluates crowd sentiment vs price action divergence verdicts',
    capability: 'sentiment-divergence',
    rating: 4.6,
    tags: ['sentiment', 'divergence', 'crowd-bias'],
  },
  {
    id: 'technical-analysis',
    name: 'Technical Analysis Agent',
    address: 'agent1q085746wlr3u2uh4fmwqplude8e0w6fhrmqgsnlp49weawef3ahlutypvu6',
    role: 'Technical Indicator Analyst',
    description: 'Multi-indicator technical analysis (RSI, MACD, key support/resistance levels)',
    capability: 'technical-indicators',
    rating: 4.5,
    tags: ['technical-analysis', 'rsi', 'macd', 'support-resistance'],
  },
  {
    id: 'crypto-fear-greed',
    name: 'Crypto Fear & Greed Agent',
    address: 'agent1qgrzma5mem02n03zeeqzj4e6k6rz9p4v283frt6k8mkvm050l22q25qhltx',
    role: 'Macro Sentiment Index',
    description: 'Alternative.me real-time market sentiment & regime scores',
    capability: 'macro-sentiment',
    rating: 3.9,
    tags: ['fear-greed', 'sentiment', 'macro'],
  },
  {
    id: 'macro-regime',
    name: 'Macro Regime Agent',
    address: 'agent1q04ply7r2k78xy9l25rmufme7m36qugmhzqzt7ezmehz3jwrct5tqqwjyqt',
    role: 'Composite Risk Regime',
    description: 'Composite risk-on/risk-off regime indicator from Fear & Greed, VIX, and Binance L/S',
    capability: 'regime-detection',
    rating: 3.8,
    tags: ['regime', 'risk-on-off', 'binance-ls'],
  },
]);

const AGENTVERSE_SEARCH_URL = 'https://agentverse.ai/v1/search/agents';

// Hunter state
let _hunterStatus = 'IDLE'; // 'IDLE' | 'CUED' | 'HUNTING' | 'COMPLETED' | 'ERROR'
let _cuedTargetMs = 0;
let _cueTimer = null;
let _recurringTimer = null;
let _latestHunt = null;
let _lastAudit = null;
let _isHunting = false;
let _onHuntCompletedCb = null;

/**
 * Audit live Agentverse agents against the registry directory.
 * Queries agent health, ratings, and registry presence.
 */
async function auditAgentverseRoster() {
  const auditResults = [];
  for (const agent of AUDITED_AGENTVERSE_ROSTER) {
    const started = Date.now();
    try {
      const resp = await fetch(AGENTVERSE_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_text: agent.address, limit: 1 }),
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - started;
      if (resp.ok) {
        const json = await resp.json().catch(() => ({}));
        const match = (json.agents || json.items || [])[0];
        auditResults.push({
          ...agent,
          reachable: true,
          latencyMs,
          status: 'ONLINE',
          verifiedName: match?.name || agent.name,
          verifiedRating: match?.rating ?? agent.rating,
          interactions: match?.num_interactions ?? match?.interactions ?? 'active',
          auditedAt: new Date().toISOString(),
        });
      } else {
        auditResults.push({
          ...agent,
          reachable: false,
          latencyMs,
          status: 'HTTP_' + resp.status,
          auditedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      auditResults.push({
        ...agent,
        reachable: false,
        latencyMs: Date.now() - started,
        status: 'UNREACHABLE',
        error: err.message,
        auditedAt: new Date().toISOString(),
      });
    }
  }

  _lastAudit = {
    timestamp: Date.now(),
    totalAgents: AUDITED_AGENTVERSE_ROSTER.length,
    onlineCount: auditResults.filter((a) => a.reachable).length,
    results: auditResults,
  };
  return _lastAudit;
}

/**
 * Format structured hunting prompt for ASI1 in Planner Mode.
 */
function buildHuntPrompt(marketContext = {}) {
  const coins = marketContext.coins || ['BTC', 'ETH', 'SOL'];
  const snapshotLines = coins.map((c) => {
    const data = marketContext[c] || {};
    const spotStr = data.spot ? CoinPrecision.formatCoinPrice(c, data.spot) : 'live';
    const ptb15m = data.ptb15m ? CoinPrecision.formatCoinStrike(c, data.ptb15m) : 'forming';
    const ptb1h = data.ptb1h ? CoinPrecision.formatCoinStrike(c, data.ptb1h) : 'forming';
    const pinRisk = data.pinRisk ? `[PIN RISK DEFENDED: ${data.pinRisk.distanceBps?.toFixed(1)} bps]` : '[CLEAR]';
    return `- ${c}: Spot=${spotStr} | 15m PTB=${ptb15m} | 1h PTB=${ptb1h} | Strike Status=${pinRisk}`;

  }).join('\n');

  return `AUTONOMOUS CONTRACT & INTEL HUNT MISSION:

You are the Lead Autonomous Agentverse Scout orchestrating a team of specialized Fetch.ai / Agentverse agents:
- Polymarket Live Data Agent: Inspecting prediction market order books, open prices, and liquidity.
- Crypto Whale Radar: Tracking on-chain whale transfers, smart money exchange inflows/outflows.
- Vedetta Sentiment & Divergence: Measuring crowd sentiment vs price divergence.
- Technical Analysis Agent: Identifying key Fibonacci, support/resistance, and momentum levels.
- Crypto Fear & Greed / Macro Regime Agent: Risk-on / Risk-off bias.

CURRENT MARKET SNAPSHOT:
${snapshotLines}

HUNT OBJECTIVES:
1. Polymarket Contract Scouting: For BTC, ETH, and SOL, identify the most viable upcoming Up/Down contract strikes (15m and 1h). Flag any contracts threatened by MM strike defense / pin-risk walls.
2. Smart Money & Whale Footprint: Summarize any accumulation, exchange dumps, or whale skew.
3. Sentiment Divergence: Detect where crowd probability disagrees with underlying momentum.
4. Top Alpha Opportunities: Select the top 1-3 highest-conviction contract targets with an explicit action (BUY_UP, BUY_DOWN, HOLD_FLAT), estimated edge vs crowd %, confidence (0.50-0.95), and sizing hint.

OUTPUT REQUIREMENT:
Respond with a valid JSON object matching this schema:
{
  "macroRegime": "RISK_ON" | "RISK_OFF" | "NEUTRAL",
  "whaleRadar": {
    "bias": "BULLISH_ACCUMULATION" | "BEARISH_DISTRIBUTION" | "NEUTRAL",
    "summary": "Brief 1-sentence summary of whale activity"
  },
  "sentimentDivergence": {
    "crowdBias": "UP" | "DOWN" | "BALANCED",
    "edgeDirection": "UP" | "DOWN" | "NEUTRAL",
    "verdict": "Brief explanation of divergence"
  },
  "technicalOutlook": {
    "btcKeyLevels": "Support $X / Resistance $Y",
    "ethKeyLevels": "Support $X / Resistance $Y"
  },
  "scoutedOpportunities": [
    {
      "symbol": "BTC" | "ETH" | "SOL",
      "horizon": "15m" | "1h",
      "targetStrike": number,
      "action": "BUY_UP" | "BUY_DOWN" | "HOLD_FLAT",
      "confidence": number,
      "edgePct": string,
      "sizeHint": "full" | "half" | "quarter" | "skip",
      "pinRiskSafe": boolean,
      "rationale": "Brief rationale"
    }
  ]
}`;
}

/**
 * Execute an autonomous hunt using ASI1 Planner Mode + Agentverse agents.
 */
async function runAutonomousHunt(marketContext = {}) {
  if (_isHunting) {
    return _latestHunt || { status: 'ALREADY_HUNTING' };
  }

  _isHunting = true;
  _hunterStatus = 'HUNTING';

  const pinnedAgentAddresses = AUDITED_AGENTVERSE_ROSTER.map((a) => a.address);
  const prompt = buildHuntPrompt(marketContext);
  const sessionId = `wecrypto-hunt-${Date.now().toString(36)}`;
  const started = Date.now();

  try {
    const messages = [
      {
        role: 'system',
        content: 'You are an autonomous Agentverse multi-agent hunting planner. Return strictly valid JSON containing your synthesized findings.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ];

    const response = await Asi1Client.chatCompletion(messages, {
      model: 'asi1',
      candidateModels: ['asi1', 'asi1-ultra', 'asi1-mini'],
      plannerMode: true,
      agents: pinnedAgentAddresses,
      sessionId,
      max_tokens: 1500,
      temperature: 0.15,
      timeoutMs: 60_000, // 60s timeout for planner mode deliberation
    });

    const latencyMs = Date.now() - started;
    let parsed = null;
    const content = String(response?.content || '').trim();

    // Parse JSON response or extract from code fences
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1] || content);
    } catch (_) {
      parsed = {
        macroRegime: 'NEUTRAL',
        rawContent: content,
        scoutedOpportunities: [],
      };
    }

    _latestHunt = {
      timestamp: Date.now(),
      latencyMs,
      status: 'COMPLETED',
      sessionId,
      modelUsed: response?.model || 'asi1',
      macroRegime: parsed.macroRegime || 'NEUTRAL',
      whaleRadar: parsed.whaleRadar || { bias: 'NEUTRAL', summary: 'Neutral flow observed' },
      sentimentDivergence: parsed.sentimentDivergence || { verdict: 'Balanced sentiment' },
      technicalOutlook: parsed.technicalOutlook || {},
      scoutedOpportunities: Array.isArray(parsed.scoutedOpportunities) ? parsed.scoutedOpportunities : [],
      agentsConsulted: AUDITED_AGENTVERSE_ROSTER.map((a) => ({ name: a.name, role: a.role, address: a.address })),
    };

    _hunterStatus = 'COMPLETED';

    if (typeof _onHuntCompletedCb === 'function') {
      try { _onHuntCompletedCb(_latestHunt); } catch (_) {}
    }

    return _latestHunt;
  } catch (err) {
    _hunterStatus = 'ERROR';
    _latestHunt = {
      timestamp: Date.now(),
      latencyMs: Date.now() - started,
      status: 'ERROR',
      error: err.message,
      scoutedOpportunities: [],
      agentsConsulted: AUDITED_AGENTVERSE_ROSTER.map((a) => ({ name: a.name, role: a.role })),
    };
    return _latestHunt;
  } finally {
    _isHunting = false;
  }
}

/**
 * Start the autonomous boot scheduler.
 * Cues 60 seconds after app boot, allowing pristine, instant startup before
 * launching autonomous Agentverse hunting in the background.
 */
function startAutonomousScheduler(options = {}) {
  const bootDelayMs = options.bootDelayMs != null ? options.bootDelayMs : 60_000;
  const intervalMs = Math.max(options.intervalMs != null ? options.intervalMs : 900_000, 900_000); // 15 mins max (credit preservation)

  if (_cueTimer) clearTimeout(_cueTimer);
  if (_recurringTimer) clearInterval(_recurringTimer);

  _hunterStatus = 'CUED';
  _cuedTargetMs = Date.now() + bootDelayMs;

  _cueTimer = setTimeout(async () => {
    try {
      await runAutonomousHunt(options.marketContext || {});
    } catch (_) {}

    // Then schedule gentle recurring 5-minute scans
    _recurringTimer = setInterval(async () => {
      try {
        await runAutonomousHunt(options.marketContext || {});
      } catch (_) {}
    }, intervalMs);
  }, bootDelayMs);

  return {
    status: _hunterStatus,
    cuedTargetMs: _cuedTargetMs,
    bootDelayMs,
    intervalMs,
  };
}

/**
 * Get current hunter status and diagnostics for IPC/UI.
 */
function getHunterStatus() {
  const now = Date.now();
  const cuedSecondsLeft = _cuedTargetMs > now ? Math.round((_cuedTargetMs - now) / 1000) : 0;
  return {
    status: _hunterStatus,
    isHunting: _isHunting,
    cuedSecondsLeft,
    cuedTargetMs: _cuedTargetMs,
    latestHunt: _latestHunt,
    lastAudit: _lastAudit,
    roster: AUDITED_AGENTVERSE_ROSTER,
  };
}

function stopAutonomousScheduler() {
  if (_cueTimer) {
    clearTimeout(_cueTimer);
    _cueTimer = null;
  }
  if (_recurringTimer) {
    clearInterval(_recurringTimer);
    _recurringTimer = null;
  }
  _hunterStatus = 'IDLE';
  _cuedTargetMs = 0;
}

function onHuntCompleted(cb) {
  _onHuntCompletedCb = cb;
}

module.exports = {
  AUDITED_AGENTVERSE_ROSTER,
  auditAgentverseRoster,
  buildHuntPrompt,
  runAutonomousHunt,
  startAutonomousScheduler,
  stopAutonomousScheduler,
  getHunterStatus,
  onHuntCompleted,
};
