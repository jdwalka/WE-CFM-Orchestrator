// ================================================================
// WalkerEnterprise Crypto Tracker — Data Config
// Your portfolio coins + directional/asymmetric alts
// ================================================================

// ---- Your Coinbase holdings ----
// These are the coins from your portfolio history (SOL/AVAX/DOT/ATOM/POL/ADA etc.)
const PORTFOLIO_HOLDINGS = [
  { sym: 'BTC', name: 'Bitcoin', instrument: 'BTCUSD', amount: 0, costBasis: 0, color: '#f7931a', icon: '₿' },
  { sym: 'ETH', name: 'Ethereum', instrument: 'ETHUSD', amount: 0, costBasis: 0, color: '#627eea', icon: 'Ξ' },
  { sym: 'LTC', name: 'Litecoin', instrument: 'LTCUSD', amount: 0, costBasis: 0, color: '#345d9d', icon: 'Ł' },
  { sym: 'SOL', name: 'Solana', instrument: 'SOLUSD', amount: 5.2, costBasis: 120, color: '#9945ff', icon: '◎' },
  { sym: 'AVAX', name: 'Avalanche', instrument: 'AVAXUSD', amount: 18.5, costBasis: 28, color: '#e84142', icon: 'A' },
  { sym: 'DOT', name: 'Polkadot', instrument: 'DOTUSD', amount: 85.0, costBasis: 7.2, color: '#e6007a', icon: '●' },
  { sym: 'ATOM', name: 'Cosmos', instrument: 'ATOMUSD', amount: 60.0, costBasis: 6.5, color: '#2e3148', icon: '⬡' },
  { sym: 'POL', name: 'Polygon', instrument: 'POLUSD', amount: 350.0, costBasis: 0.85, color: '#7b3fe4', icon: '⬟' },
  { sym: 'ADA', name: 'Cardano', instrument: 'ADAUSD', amount: 220.0, costBasis: 0.42, color: '#0033ad', icon: '₳' },
  { sym: 'XTZ', name: 'Tezos', instrument: 'XTZUSD', amount: 95.0, costBasis: 1.1, color: '#2c7df7', icon: 'ꜩ' },
  { sym: 'BONK', name: 'Bonk', instrument: 'BONKUSD', amount: 8500000, costBasis: 0.0000085, color: '#f5a623', icon: '🐕' },
  { sym: 'JUP', name: 'Jupiter', instrument: 'JUPUSD', amount: 150.0, costBasis: 0.65, color: '#00b4d8', icon: '♃' },
  { sym: 'ARB', name: 'Arbitrum', instrument: 'ARBUSD', amount: 180.0, costBasis: 0.55, color: '#213147', icon: 'Ⓐ' },
  { sym: 'PYTH', name: 'Pyth Network', instrument: 'PYTHUSD', amount: 310.0, costBasis: 0.25, color: '#6c3fa6', icon: 'Ψ' },
  { sym: 'XLM', name: 'Stellar', instrument: 'XLMUSD', amount: 420.0, costBasis: 0.12, color: '#3d9fdc', icon: '✦' },
  { sym: 'RNDR', name: 'Render', instrument: 'RENDERUSD', amount: 25.0, costBasis: 5.0, color: '#e44d26', icon: 'R' },
  { sym: 'AERO', name: 'Aerodrome', instrument: 'AEROUSD', amount: 80.0, costBasis: 1.2, color: '#4ade80', icon: '⊛' },
];

// ---- Watchlist / Directional + Asymmetric plays ----
const WATCHLIST = [
  { sym: 'BTC', name: 'Bitcoin', instrument: 'BTCUSD', group: 'core' },
  { sym: 'ETH', name: 'Ethereum', instrument: 'ETHUSD', group: 'core' },
  { sym: 'LTC', name: 'Litecoin', instrument: 'LTCUSD', group: 'core' },
  { sym: 'SOL', name: 'Solana', instrument: 'SOLUSD', group: 'core' },
  { sym: 'AVAX', name: 'Avalanche', instrument: 'AVAXUSD', group: 'core' },
  { sym: 'DOT', name: 'Polkadot', instrument: 'DOTUSD', group: 'core' },
  { sym: 'ATOM', name: 'Cosmos', instrument: 'ATOMUSD', group: 'core' },
  { sym: 'POL', name: 'Polygon', instrument: 'POLUSD', group: 'core' },
  { sym: 'ADA', name: 'Cardano', instrument: 'ADAUSD', group: 'core' },
  { sym: 'XTZ', name: 'Tezos', instrument: 'XTZUSD', group: 'core' },
  { sym: 'ARB', name: 'Arbitrum', instrument: 'ARBUSD', group: 'layer2' },
  { sym: 'OP', name: 'Optimism', instrument: 'OPUSD', group: 'layer2' },
  { sym: 'SUI', name: 'Sui', instrument: 'SUIUSD', group: 'layer1' },
  { sym: 'APT', name: 'Aptos', instrument: 'APTUSD', group: 'layer1' },
  { sym: 'SEI', name: 'Sei', instrument: 'SEIUSD', group: 'layer1' },
  { sym: 'NEAR', name: 'Near Protocol', instrument: 'NEARUSD', group: 'layer1' },
  { sym: 'BONK', name: 'Bonk', instrument: 'BONKUSD', group: 'meme' },
  { sym: 'PEPE', name: 'Pepe', instrument: 'PEPEUSD', group: 'meme' },
  { sym: 'WIF', name: 'dogwifhat', instrument: 'WIFUSD', group: 'meme' },
  { sym: 'FLOKI', name: 'Floki', instrument: 'FLOKIUSD', group: 'meme' },
  { sym: 'JUP', name: 'Jupiter', instrument: 'JUPUSD', group: 'defi' },
  { sym: 'AERO', name: 'Aerodrome', instrument: 'AEROUSD', group: 'defi' },
  { sym: 'DYDX', name: 'dYdX', instrument: 'DYDXUSD', group: 'defi' },
  { sym: 'PYTH', name: 'Pyth Network', instrument: 'PYTHUSD', group: 'defi' },
  { sym: 'RNDR', name: 'Render', instrument: 'RENDERUSD', group: 'ai' },
  { sym: 'FET', name: 'Fetch.ai', instrument: 'FETUSD', group: 'ai' },
  { sym: 'TAO', name: 'Bittensor', instrument: 'TAOUSD', group: 'ai' },
  { sym: 'XLM', name: 'Stellar', instrument: 'XLMUSD', group: 'core' },
  { sym: 'LINK', name: 'Chainlink', instrument: 'LINKUSD', group: 'defi' },
  { sym: 'UNI', name: 'Uniswap', instrument: 'UNIUSD', group: 'defi' },
  { sym: 'AAVE', name: 'Aave', instrument: 'AAVEUSD', group: 'defi' },
  { sym: 'ICP', name: 'Internet Computer', instrument: 'ICPUSD', group: 'layer1' },
  { sym: 'HBAR', name: 'Hedera', instrument: 'HBARUSD', group: 'layer1' },
  { sym: 'XRP', name: 'XRP', instrument: 'XRPUSD', group: 'core' },
  { sym: 'DOGE', name: 'Dogecoin', instrument: 'DOGEUSD', group: 'meme' },
  { sym: 'HYPE', name: 'Hyperliquid', instrument: 'HYPEUSD', group: 'defi' },
  { sym: 'BNB', name: 'BNB', instrument: 'BNBUSD', group: 'core' },
];

// ---- Chain configs for on-chain lookups (Blockscout/EVM) ----
const CHAINS = {
  ethereum: { name: 'Ethereum', chainId: 1, symbol: 'ETH', color: '#627eea' },
  polygon: { name: 'Polygon', chainId: 137, symbol: 'POL', color: '#7b3fe4' },
  arbitrum: { name: 'Arbitrum', chainId: 42161, symbol: 'ARB', color: '#213147' },
  base: { name: 'Base', chainId: 8453, symbol: 'ETH', color: '#0052ff' },
};

// ---- Color palette for coins ----
const COIN_COLORS = {
  BTC: '#f7931a', ETH: '#627eea', LTC: '#345d9d',
  SOL: '#9945ff', AVAX: '#e84142', DOT: '#e6007a', ATOM: '#6f7390',
  POL: '#7b3fe4', ADA: '#0033ad', XTZ: '#2c7df7', BONK: '#f5a623',
  JUP: '#00b4d8', ARB: '#213147', PYTH: '#6c3fa6', XLM: '#3d9fdc',
  RNDR: '#e44d26', AERO: '#4ade80', OP: '#ff0420', SUI: '#6fbcf0',
  APT: '#05e0b5', SEI: '#ff4940', NEAR: '#00c08b', PEPE: '#2eb62c',
  WIF: '#c9842a', FLOKI: '#f5a623', DYDX: '#5fa4e7', FET: '#1f3b68',
  TAO: '#5e35b1', LINK: '#375bd2', UNI: '#ff007a', AAVE: '#b6509e',
  ICP: '#3b00b9', HBAR: '#222',
  XRP: '#00aae4', DOGE: '#c2a633', HYPE: '#50e3c2', BNB: '#f3ba2f',
};

// ---- Short names for display ----
const COIN_SHORT = {
  BTC: 'Bitcoin', ETH: 'Ethereum', LTC: 'Litecoin',
  SOL: 'Solana', AVAX: 'Avalanche', DOT: 'Polkadot', ATOM: 'Cosmos',
  POL: 'Polygon', ADA: 'Cardano', XTZ: 'Tezos', BONK: 'Bonk',
  JUP: 'Jupiter', ARB: 'Arbitrum', PYTH: 'Pyth', XLM: 'Stellar',
  RNDR: 'Render', AERO: 'Aerodrome', OP: 'Optimism', SUI: 'Sui',
  APT: 'Aptos', SEI: 'Sei', NEAR: 'Near', PEPE: 'Pepe',
  WIF: 'dogwifhat', FLOKI: 'Floki', DYDX: 'dYdX', FET: 'Fetch.ai',
  TAO: 'Bittensor', LINK: 'Chainlink', UNI: 'Uniswap', AAVE: 'Aave',
  ICP: 'Internet Comp.', HBAR: 'Hedera',
  XRP: 'XRP', DOGE: 'Dogecoin', HYPE: 'Hyperliquid', BNB: 'BNB',
};

// ---- Prediction Analytics Target Coins ----
// iconSources: ordered CDN array used by coinIcon() with waterfall fallback.
//   [0] CoinGecko /small/ = 64×64 px (crisp at 52px display, rate-limited but reliable)
//   [1] jsDelivr/spothq cryptocurrency-icons = SVG, global CDN, no rate limits
//       Note: HYPE is not in spothq repo (too new) — text fallback only if CoinGecko fails.
// icon: Unicode symbol — always rendered first, CDN image fades in on top.
const PREDICTION_COINS = [
  {
    sym: 'BTC', name: 'Bitcoin', instrument: 'BTCUSD', geckoId: 'bitcoin',
    color: '#f7931a', icon: '\u20bf',
    iconSources: [
      'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/btc.svg',
    ],
  },
  {
    sym: 'ETH', name: 'Ethereum', instrument: 'ETHUSD', geckoId: 'ethereum',
    color: '#627eea', icon: '\u039e',
    iconSources: [
      'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/eth.svg',
    ],
  },
  {
    sym: 'SOL', name: 'Solana', instrument: 'SOLUSD', geckoId: 'solana',
    color: '#9945ff', icon: '\u25ce',
    iconSources: [
      'https://assets.coingecko.com/coins/images/4128/small/solana.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/sol.svg',
    ],
  },
  {
    sym: 'XRP', name: 'XRP', instrument: 'XRPUSD', geckoId: 'ripple',
    color: '#00aae4', icon: 'X',
    iconSources: [
      'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/xrp.svg',
    ],
  },
  {
    sym: 'DOGE', name: 'Dogecoin', instrument: 'DOGEUSD', geckoId: 'dogecoin',
    color: '#c2a633', icon: 'Ð',
    iconSources: [
      'https://assets.coingecko.com/coins/images/5/small/dogecoin.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/doge.svg',
    ],
  },
  {
    sym: 'BNB', name: 'BNB', instrument: 'BNBUSD', geckoId: 'binancecoin',
    color: '#f3ba2f', icon: 'B',
    iconSources: [
      'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
      'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/bnb.svg',
    ],
  },
  {
    sym: 'HYPE', name: 'Hyperliquid', instrument: 'HYPEUSD', geckoId: 'hyperliquid',
    color: '#50e3c2', icon: 'H',
    iconSources: [
      'https://assets.coingecko.com/coins/images/50882/small/hyperliquid.png',
    ],
  },
];
window.PREDICTION_COINS = PREDICTION_COINS;

const COIN_WEIGHT = {
  BTC: 'heavy', ETH: 'heavy',
  SOL: 'mid', XRP: 'mid', BNB: 'mid',
  DOGE: 'light', HYPE: 'light',
};
window.COIN_WEIGHT = COIN_WEIGHT;

const WEIGHT_RANK = { heavy: 3, mid: 2, light: 1 };
window.WEIGHT_RANK = WEIGHT_RANK;

const ORBITAL_ACCESS = { all: 1, mid: 2, heavy: 3 };
window.ORBITAL_ACCESS = ORBITAL_ACCESS;

// Defensive fallbacks for cross-script helpers before secondary scripts finish loading
if (typeof window.formatUtc4Time !== 'function') {
  window.formatUtc4Time = function(input) {
    const ms = typeof input === 'number' ? input : new Date(input).getTime();
    if (!Number.isFinite(ms)) return '—';
    return new Date(ms - (4 * 60 * 60 * 1000)).toISOString().slice(11, 19);
  };
}
if (typeof window.isHighConfidenceOverlayOn !== 'function') {
  window.isHighConfidenceOverlayOn = function() {
    return false;
  };
}
if (typeof window.fmtCompactUsd !== 'function') {
  window.fmtCompactUsd = function(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const num = Number(n);
    if (Math.abs(num) >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
    if (Math.abs(num) >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
    if (Math.abs(num) >= 1e3) return '$' + (num / 1e3).toFixed(1) + 'K';
    return '$' + num.toFixed(2);
  };
}

// ---- 7 MAJORS FOCUS (CORE 4 FIRST) ──────────────────────────────────────────
// 7 MAJORS: BTC, ETH, SOL, XRP, DOGE, BNB, HYPE
// Primary traded 4: BTC, ETH, SOL, XRP (prioritized in UI display and inference)
// Secondary 3: DOGE, BNB, HYPE (active for 5m/15m contract monitoring & screening)
// ─────────────────────────────────────────────────────────────────────────────

// ---- Market Universe display groups (used by renderUniverse / Periodic Table view) ----
const UNIVERSE_GROUPS = {
  core: { name: 'Core', emoji: '⚡', color: '#f7931a' },
  platform: { name: 'Platform L1', emoji: '🔗', color: '#627eea' },
  defi: { name: 'DeFi', emoji: '🏦', color: '#00b4d8' },
  ai: { name: 'AI / Compute', emoji: '🧠', color: '#a78bfa' },
  meme: { name: 'Meme / Culture', emoji: '🐸', color: '#f5a623' },
  highbeta: { name: 'High Beta', emoji: '🚀', color: '#ff4b6e' },
};
