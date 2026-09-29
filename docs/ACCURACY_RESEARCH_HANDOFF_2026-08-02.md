# WECRYPTO Accuracy Research Handoff — 2026-08-02

Deep research + 3 parallel agents (general research, codebase explore, plan architect).

## Baseline (advanced backtest 30d)

| Coin | h15 WR | PF | Coverage | Action |
|------|--------|-----|----------|--------|
| ETH | 52.7% | 1.10 | 15.7% | **Promote** |
| BTC | 51.0% | 1.10 | 17.0% | **Promote** (session-gate) |
| SOL | 49.0% | 0.92 | 6.5% | **Disable default trade** |
| XRP | 41.2% | 0.86 | 13.0% | **Hard disable** |

Portfolio: h1/h5 **39.6%**, h10 **46.8%**, h15 **48.8%**.  
**Critical bug:** advanced-backtest h1 ≡ h5 (both use 1×5m bar; 1m candles fetched unused).

Logs: `backtest-logs/advanced-2026-08-02.log` + per-coin JSON.

---

## Proprietary methods that transfer (ranked)

1. **Binary-native objective** — y = settle > PTB / Kalshi ref (not free OHLC)
2. **OFI / multi-level LOB imbalance** (Cont–Kukanov–Stoikov) — seconds→few min half-life; use *integrated* OFI
3. **Meta-labeling** (López de Prado) — primary proposes side; secondary predicts *correctness* → trade/skip
4. **VPIN / toxicity as gate** — not direction; raise threshold or abstain
5. **Hawkes buy/sell intensity** — burst into settlement (research tier)
6. **Settlement oracle / TWAP path** — RTI/Chainlink path ≠ Binance last
7. **Isotonic / Venn-ABERS + selective prediction** — fix strong < moderate inversion
8. **Regime HMM + session buckets** — ETH Asia 58%, BTC NY Open 54% already in log

Sources: AFML meta-labeling (Hudson Thames), LOB imbalance crypto literature (Bybit LOB arxiv 2025), Cont et al. OFI, conformal/isotonic calibration literature.

---

## Code forensics (top gaps)

1. Offline labels = close→close OHLC; product pays PTB/Kalshi
2. Final direction still momentum-locked; `dirConflict` / Kalshi CDF often diagnostic-only
3. `SCORE_AMPLIFIER` 1.6 + low thresholds → inverted conf buckets
4. Dead voters (RSI/MACD/momentum ~45–48% acc) still vote full weight
5. Live bias extremes (XRP vwap/rsi 3.5+) vs recommended ~1.0
6. Microstructure weights high live, **excluded** from walk-forward (`includeMicrostructure: false`)
7. Edge committee soft-abstain (×0.35) not stand-aside

---

## Implementation order (ship)

| WP | Name | Status |
|----|------|--------|
| WP1 | Coin policy XRP off / SOL paper | **this session** |
| WP2 | Shrink PER_COIN_INDICATOR_BIAS from 30d recs | **this session** |
| WP3 | Horizon-specific bias + tighter h5 | next |
| WP4 | PTB/Kalshi as primary head (no late sign flip) | next |
| WP5 | Isotonic p_cal gate | next |
| WP6 | Meta-label abstain layer | week |
| WP7 | Session hard gates ETH Asia / BTC NY+Asia | next |
| WP8 | Settlement labels in advanced-backtest + 1m h1/h5 | next |

Realistic targets after WP1–5: portfolio traded WR **≥54%** (ETH/BTC only), coverage lower; XRP/SOL fills = 0.

---

## Agent IDs (resume)

- Research: `019fc0a7-1163-7d43-8679-558c6c5af5e5`
- Explore audit: `019fc0a7-1163-7d43-8679-559e0b791c90`
- Plan: `019fc0a7-1163-7d43-8679-55a4c170ac7c`

---

*Do not re-enable XRP without offline WR≥52% and PF≥1.05 on fresh 14d OOS.*
