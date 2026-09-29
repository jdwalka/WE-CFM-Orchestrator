(function () {
    "use strict";

    const MAX_HISTORY = 180;
    const MAX_TRADES = 140;

    const stateBySym = {};

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function toNum(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    function avg(arr) {
        if (!arr || !arr.length) return 0;
        return arr.reduce((s, v) => s + v, 0) / arr.length;
    }

    function std(arr) {
        if (!arr || arr.length < 2) return 0;
        const m = avg(arr);
        const variance = arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
        return Math.sqrt(variance);
    }

    function median(arr) {
        if (!arr || !arr.length) return 0;
        const sorted = arr.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function initSym(sym) {
        if (!stateBySym[sym]) {
            stateBySym[sym] = {
                spreadPctHist: [],
                depthHist: [],
                imbalanceHist: [],
                imbalanceVelocityHist: [],
                sweepHist: [],
                vacuumHist: [],
                toxicityHist: [],
                last: null,
            };
        }
        return stateBySym[sym];
    }

    function getLevelQty(level) {
        return toNum(level && level.qty, 0);
    }

    function normalizeBook(book) {
        if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
        const bids = book.bids.slice(0, 20).map(l => ({ price: toNum(l.price, 0), qty: toNum(l.qty, 0) })).filter(l => l.price > 0 && l.qty > 0);
        const asks = book.asks.slice(0, 20).map(l => ({ price: toNum(l.price, 0), qty: toNum(l.qty, 0) })).filter(l => l.price > 0 && l.qty > 0);
        if (!bids.length || !asks.length) return null;
        return { bids, asks };
    }

    function normalizeTrades(trades) {
        if (!Array.isArray(trades) || !trades.length) return [];
        return trades.slice(-MAX_TRADES).map(t => ({
            side: (t.side || "").toLowerCase(),
            qty: toNum(t.qty, 0),
            price: toNum(t.price, 0),
            ts: toNum(t.ts || t.timestamp, Date.now()),
        })).filter(t => t.qty > 0 && (t.side === "buy" || t.side === "sell"));
    }

    function analyzeImbalance(bookN) {
        if (!bookN) {
            return {
                value: 0,
                bidVolume: 0,
                askVolume: 0,
                weighted10: 0,
                weighted20: 0,
                liquidityNotional20: 0,
                spreadPct: 0,
            };
        }
        function weighted(rows, levels) {
            return rows.slice(0, levels).reduce((acc, l, index) => {
                const w = 1 / (1 + index * (levels <= 10 ? 0.22 : 0.15));
                acc.qty += l.qty;
                acc.notional += l.price * l.qty;
                acc.weightedNotional += l.price * l.qty * w;
                return acc;
            }, { qty: 0, notional: 0, weightedNotional: 0 });
        }
        function sideImbalance(bid, ask) {
            const total = bid.weightedNotional + ask.weightedNotional;
            return total > 0 ? clamp((bid.weightedNotional - ask.weightedNotional) / total, -1, 1) : 0;
        }
        const bid10 = weighted(bookN.bids, 10);
        const ask10 = weighted(bookN.asks, 10);
        const bid20 = weighted(bookN.bids, 20);
        const ask20 = weighted(bookN.asks, 20);
        const bidVolume = bid20.qty;
        const askVolume = ask20.qty;
        const weighted10 = sideImbalance(bid10, ask10);
        const weighted20 = sideImbalance(bid20, ask20);
        const value = clamp(weighted10 * 0.62 + weighted20 * 0.38, -1, 1);
        const bestBid = bookN.bids[0].price;
        const bestAsk = bookN.asks[0].price;
        const spreadPct = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
        return {
            value: clamp(value, -1, 1),
            bidVolume,
            askVolume,
            weighted10,
            weighted20,
            bidNotional20: bid20.notional,
            askNotional20: ask20.notional,
            liquidityNotional20: bid20.notional + ask20.notional,
            spreadPct,
        };
    }

    function analyzeImbalanceVelocity(symState, imbalance) {
        const prev = symState.last?.imbalance?.value ?? imbalance;
        const prevTs = symState.last?.ts || Date.now();
        const dtMin = Math.max((Date.now() - prevTs) / 60000, 1 / 60);
        const shortPerMin = (imbalance - prev) / dtMin;
        const anchor = symState.imbalanceHist.length ? symState.imbalanceHist[0] : imbalance;
        const windowPerMin = (imbalance - anchor) / 15;
        const value = clamp((shortPerMin * 0.65 + windowPerMin * 0.35) * 4, -1, 1);
        return {
            value,
            shortPerMin,
            windowPerMin,
            band: Math.abs(value) >= 0.55 ? (value > 0 ? "bid_accelerating" : "ask_accelerating")
                : Math.abs(value) >= 0.25 ? (value > 0 ? "bid_building" : "ask_building")
                    : "stable",
        };
    }

    function analyzeSweep(tradesN, bookN) {
        if (!tradesN.length) {
            return {
                score: 0,
                direction: 0,
                hitRate: 0,
                burstRatio: 0,
                sideDominance: 0,
                label: "No tape",
            };
        }

        const totalQty = tradesN.reduce((s, t) => s + t.qty, 0);
        const buyQty = tradesN.reduce((s, t) => s + (t.side === "buy" ? t.qty : 0), 0);
        const sellQty = totalQty - buyQty;
        const sideDominance = totalQty > 0 ? (buyQty - sellQty) / totalQty : 0;

        const qtySeries = tradesN.map(t => t.qty);
        const medQty = Math.max(1e-9, median(qtySeries));
        const largeTrades = tradesN.filter(t => t.qty >= medQty * 3.2);
        const burstRatio = tradesN.length ? largeTrades.length / tradesN.length : 0;

        let hitRate = 0;
        if (bookN) {
            const bestAsk = bookN.asks[0]?.price || 0;
            const bestBid = bookN.bids[0]?.price || 0;
            let crossing = 0;
            for (const t of tradesN) {
                if (t.side === "buy" && bestAsk > 0 && t.price >= bestAsk) crossing++;
                if (t.side === "sell" && bestBid > 0 && t.price <= bestBid) crossing++;
            }
            hitRate = tradesN.length ? crossing / tradesN.length : 0;
        }

        const dir = sideDominance > 0.06 ? 1 : sideDominance < -0.06 ? -1 : 0;
        const raw = sideDominance * 0.55 + burstRatio * 0.25 + hitRate * 0.20;
        const score = clamp(raw, -1, 1);

        return {
            score,
            direction: dir,
            hitRate,
            burstRatio,
            sideDominance,
            label: Math.abs(score) >= 0.40
                ? (score > 0 ? "Buy-side sweep" : "Sell-side sweep")
                : "No clear sweep",
        };
    }

    function analyzeVacuum(symState, imbalance, bookN) {
        const spreadHist = symState.spreadPctHist;
        const depthHist = symState.depthHist;

        const spreadNow = imbalance.spreadPct;
        const depthNow = bookN
            ? bookN.bids.slice(0, 10).reduce((s, l) => s + l.qty, 0) + bookN.asks.slice(0, 10).reduce((s, l) => s + l.qty, 0)
            : 0;

        const spreadAvg = avg(spreadHist);
        const spreadStd = std(spreadHist);
        const depthAvg = avg(depthHist);

        const spreadZ = spreadStd > 1e-9 ? (spreadNow - spreadAvg) / spreadStd : 0;
        const depthCollapse = depthAvg > 1e-9 ? 1 - depthNow / depthAvg : 0;

        const spreadExpanded = spreadNow > (spreadAvg + spreadStd * 1.2);
        const depthCollapsed = depthCollapse > 0.33;
        const active = spreadExpanded && depthCollapsed;

        // Liquidity vacuum increases slippage and makes directional calls less reliable.
        const severity = clamp((Math.max(0, spreadZ) * 0.6 + Math.max(0, depthCollapse) * 1.25) / 2, 0, 1);

        return {
            active,
            severity,
            spreadNow,
            spreadAvg,
            spreadZ,
            depthNow,
            depthAvg,
            depthCollapse,
            score: -severity,
            label: active ? "Liquidity vacuum" : "Normal liquidity",
        };
    }

    function analyzeToxicity(tradesN) {
        if (!tradesN.length) {
            return {
                available: false,
                proxy: 0,
                vpin: 0,
                tox: 0,
                imbalance: 0,
                signedMean: 0,
                signedStd: 0,
                bucketCount: 0,
                label: "No flow",
            };
        }

        const signed = tradesN.map(t => (t.side === "buy" ? 1 : -1) * t.qty);
        const signedMean = avg(signed);
        const signedStd = std(signed);
        const absFlow = signed.reduce((s, v) => s + Math.abs(v), 0);
        const netFlow = signed.reduce((s, v) => s + v, 0);
        const imbalance = absFlow > 0 ? netFlow / absFlow : 0;

        // VPIN-style toxicity proxy: strong one-sided signed flow with high signed variance.
        const variancePressure = signedStd > 0 ? Math.min(1, Math.abs(signedMean) / (signedStd + 1e-9) * 1.7) : 0;
        const proxy = clamp(Math.abs(imbalance) * 0.65 + variancePressure * 0.35, 0, 1);

        // Bucketed VPIN approximation using rolling trade volume buckets.
        const totalQty = tradesN.reduce((s, t) => s + t.qty, 0);
        const bucketTarget = Math.max(1e-9, totalQty / 6);
        const buckets = [];
        let buyVol = 0;
        let sellVol = 0;
        let bucketVol = 0;

        for (const t of tradesN) {
            const qty = t.qty;
            bucketVol += qty;
            if (t.side === "buy") buyVol += qty;
            else sellVol += qty;

            if (bucketVol >= bucketTarget) {
                const denom = buyVol + sellVol;
                const imb = denom > 0 ? Math.abs(buyVol - sellVol) / denom : 0;
                buckets.push(imb);
                buyVol = 0;
                sellVol = 0;
                bucketVol = 0;
            }
        }
        if ((buyVol + sellVol) > bucketTarget * 0.45) {
            const denom = buyVol + sellVol;
            buckets.push(denom > 0 ? Math.abs(buyVol - sellVol) / denom : 0);
        }

        const vpin = buckets.length ? clamp(avg(buckets), 0, 1) : proxy;
        const tox = clamp(vpin * 0.7 + proxy * 0.3, 0, 1);

        return {
            available: true,
            proxy,
            vpin,
            tox,
            imbalance,
            signedMean,
            signedStd,
            bucketCount: buckets.length,
            label: tox > 0.62 ? "High toxicity" : tox > 0.42 ? "Elevated toxicity" : "Calm flow",
        };
    }

    function analyzeSpoofing(sym, bookN) {
        const alerts = Array.isArray(window.OB?.wallAlerts) ? window.OB.wallAlerts : [];
        const now = Date.now();
        const recent = alerts.filter(a => a?.sym === sym && (now - toNum(a.ts, 0)) <= 180000);
        if (!recent.length) {
            return {
                score: 0,
                direction: 0,
                side: "none",
                appeared: 0,
                pulledFast: 0,
                reappears: 0,
                label: "No spoofing signal",
            };
        }

        let appearedBid = 0, appearedAsk = 0;
        let pulledFastBid = 0, pulledFastAsk = 0;
        let reappearBid = 0, reappearAsk = 0;

        const bidEvents = recent.filter(e => e.side === "BID").sort((a, b) => toNum(a.ts, 0) - toNum(b.ts, 0));
        const askEvents = recent.filter(e => e.side === "ASK").sort((a, b) => toNum(a.ts, 0) - toNum(b.ts, 0));

        function countReappears(sideEvents) {
            let count = 0;
            const minTick = (() => {
                if (!bookN) return 0.01;
                const bestBid = bookN.bids[0]?.price || 0;
                const bestAsk = bookN.asks[0]?.price || 0;
                const spread = Math.abs(bestAsk - bestBid);
                return Math.max(spread / 10, bestBid * 1e-5, 1e-6);
            })();

            for (let i = 0; i < sideEvents.length; i++) {
                const e = sideEvents[i];
                if (e.type !== "PULLED") continue;
                const p = toNum(e.price, NaN);
                const ts = toNum(e.ts, 0);
                for (let j = i + 1; j < sideEvents.length; j++) {
                    const n = sideEvents[j];
                    const nts = toNum(n.ts, 0);
                    if (nts - ts > 15000) break;
                    if (n.type !== "APPEARED") continue;
                    const np = toNum(n.price, NaN);
                    if (Number.isFinite(p) && Number.isFinite(np) && Math.abs(np - p) <= minTick * 3) {
                        count++;
                        break;
                    }
                }
            }
            return count;
        }

        for (const e of bidEvents) {
            if (e.type === "APPEARED") appearedBid++;
            if (e.type === "PULLED" && toNum(e.ageMs, 999999) < 2000) pulledFastBid++;
        }
        for (const e of askEvents) {
            if (e.type === "APPEARED") appearedAsk++;
            if (e.type === "PULLED" && toNum(e.ageMs, 999999) < 2000) pulledFastAsk++;
        }

        reappearBid = countReappears(bidEvents);
        reappearAsk = countReappears(askEvents);

        const askPullRate = appearedAsk > 0 ? pulledFastAsk / appearedAsk : 0;
        const bidPullRate = appearedBid > 0 ? pulledFastBid / appearedBid : 0;
        const askReappearRate = pulledFastAsk > 0 ? reappearAsk / pulledFastAsk : 0;
        const bidReappearRate = pulledFastBid > 0 ? reappearBid / pulledFastBid : 0;

        const askScore = clamp(askPullRate * 0.7 + askReappearRate * 0.3, 0, 1);
        const bidScore = clamp(bidPullRate * 0.7 + bidReappearRate * 0.3, 0, 1);

        const side = askScore > bidScore ? "ask" : bidScore > askScore ? "bid" : "none";
        const score = side === "ask" ? askScore : side === "bid" ? bidScore : 0;
        const direction = side === "ask" ? 1 : side === "bid" ? -1 : 0;

        return {
            score,
            direction,
            side,
            appeared: appearedAsk + appearedBid,
            pulledFast: pulledFastAsk + pulledFastBid,
            reappears: reappearAsk + reappearBid,
            label: score > 0.68 ? (side === "ask" ? "Ask spoof risk" : side === "bid" ? "Bid spoof risk" : "No spoofing signal") : "No spoofing signal",
        };
    }

    function analyzeIceberg(tradesN, bookN) {
        if (!tradesN.length || !bookN) {
            return {
                score: 0,
                direction: 0,
                side: "none",
                touches: 0,
                execToDisplay: 0,
                label: "No iceberg signal",
            };
        }

        const bestBid = bookN.bids[0]?.price || 0;
        const bestAsk = bookN.asks[0]?.price || 0;
        const spread = Math.abs(bestAsk - bestBid);
        const tick = Math.max(spread / 10, bestBid * 1e-5, 1e-6);
        const band = tick * 2;

        const buyNearAsk = tradesN.filter(t => t.side === "buy" && Math.abs(t.price - bestAsk) <= band);
        const sellNearBid = tradesN.filter(t => t.side === "sell" && Math.abs(t.price - bestBid) <= band);

        const execAsk = buyNearAsk.reduce((s, t) => s + t.qty, 0);
        const execBid = sellNearBid.reduce((s, t) => s + t.qty, 0);
        const dispAsk = Math.max(1e-9, bookN.asks.slice(0, 3).reduce((s, l) => s + getLevelQty(l), 0));
        const dispBid = Math.max(1e-9, bookN.bids.slice(0, 3).reduce((s, l) => s + getLevelQty(l), 0));

        const askTouches = buyNearAsk.length;
        const bidTouches = sellNearBid.length;
        const askExecDisplay = execAsk / dispAsk;
        const bidExecDisplay = execBid / dispBid;

        const askTouchDensity = clamp((askTouches - 2) / 6, 0, 1);
        const bidTouchDensity = clamp((bidTouches - 2) / 6, 0, 1);
        const askExecNorm = clamp(askExecDisplay / 3, 0, 1);
        const bidExecNorm = clamp(bidExecDisplay / 3, 0, 1);

        const askPriceAnchor = clamp(1 - std(buyNearAsk.map(t => t.price)) / (tick * 3 + 1e-9), 0, 1);
        const bidPriceAnchor = clamp(1 - std(sellNearBid.map(t => t.price)) / (tick * 3 + 1e-9), 0, 1);

        const askScore = clamp(askTouchDensity * 0.5 + askExecNorm * 0.35 + askPriceAnchor * 0.15, 0, 1);
        const bidScore = clamp(bidTouchDensity * 0.5 + bidExecNorm * 0.35 + bidPriceAnchor * 0.15, 0, 1);

        const side = bidScore > askScore ? "bid" : askScore > bidScore ? "ask" : "none";
        const score = side === "bid" ? bidScore : side === "ask" ? askScore : 0;
        const direction = side === "bid" ? 1 : side === "ask" ? -1 : 0;
        const touches = side === "bid" ? bidTouches : side === "ask" ? askTouches : 0;
        const execToDisplay = side === "bid" ? bidExecDisplay : side === "ask" ? askExecDisplay : 0;

        return {
            score,
            direction,
            side,
            touches,
            execToDisplay,
            label: score > 0.62 ? (side === "bid" ? "Bid iceberg absorption" : side === "ask" ? "Ask iceberg absorption" : "No iceberg signal") : "No iceberg signal",
        };
    }

    function pushHist(arr, value) {
        arr.push(value);
        if (arr.length > MAX_HISTORY) arr.shift();
    }

    function analyze(sym, book, trades, options) {
        const symKey = String(sym || "UNK").toUpperCase();
        const state = initSym(symKey);
        const bookN = normalizeBook(book);
        const tradesN = normalizeTrades(trades);

        const imbalance = analyzeImbalance(bookN);
        const imbalanceVelocity = analyzeImbalanceVelocity(state, imbalance.value);
        const sweep = analyzeSweep(tradesN, bookN);
        const vacuum = analyzeVacuum(state, imbalance, bookN);
        const toxicity = analyzeToxicity(tradesN);
        const spoofing = analyzeSpoofing(symKey, bookN);
        const iceberg = analyzeIceberg(tradesN, bookN);

        pushHist(state.spreadPctHist, imbalance.spreadPct);
        pushHist(state.depthHist, bookN
            ? bookN.bids.slice(0, 10).reduce((s, l) => s + l.qty, 0) + bookN.asks.slice(0, 10).reduce((s, l) => s + l.qty, 0)
            : 0);
        pushHist(state.imbalanceHist, imbalance.value);
        pushHist(state.imbalanceVelocityHist, imbalanceVelocity.value);
        pushHist(state.sweepHist, sweep.score);
        pushHist(state.vacuumHist, vacuum.severity);
        pushHist(state.toxicityHist, toxicity.tox || toxicity.proxy || 0);

        // Conservative composite: imbalance remains dominant; new micro features are bounded.
        const toxPenalty = clamp(toxicity.tox || toxicity.proxy || 0, 0, 1);
        const flowSign = Math.sign((imbalance.value || 0) + (sweep.score || 0)) || 1;
        const composite = clamp(
            imbalance.value * 0.48 +
            imbalanceVelocity.value * 0.10 +
            sweep.score * 0.22 +
            vacuum.score * 0.12 +
            (spoofing.direction * spoofing.score) * 0.08 +
            (iceberg.direction * iceberg.score) * 0.10 +
            (toxicity.available ? (-flowSign * toxPenalty * 0.10) : 0),
            -1,
            1
        );

        const snapshot = {
            sym: symKey,
            ts: Date.now(),
            imbalance,
            imbalanceVelocity,
            sweep,
            vacuum,
            toxicity,
            spoofing,
            iceberg,
            composite,
            latencySafe: true,
            sampleSize: {
                bookLevels: bookN ? (bookN.bids.length + bookN.asks.length) : 0,
                trades: tradesN.length,
            },
            options: options || null,
        };

        state.last = snapshot;
        return snapshot;
    }

    function getSnapshot(sym) {
        const key = String(sym || "").toUpperCase();
        return stateBySym[key]?.last || null;
    }

    function getAll() {
        const out = {};
        Object.keys(stateBySym).forEach(sym => {
            out[sym] = stateBySym[sym].last;
        });
        return out;
    }

    window.MicrostructureEngine = {
        analyze,
        getSnapshot,
        getAll,
    };

    window.getMicrostructureDiagnostics = function () {
        return window.MicrostructureEngine.getAll();
    };

    // Emergency dashboard data hook: minimal, serializable, always safe.
    window.__MICROSTRUCTURE_EMERGENCY__ = function () {
        const all = window.MicrostructureEngine.getAll();
        const reduced = {};
        Object.keys(all).forEach(sym => {
            const s = all[sym];
            if (!s) return;
            reduced[sym] = {
                ts: s.ts,
                composite: s.composite,
                imbalance: s.imbalance?.value || 0,
                imbalanceVelocity: s.imbalanceVelocity?.value || 0,
                liquidityNotional20: s.imbalance?.liquidityNotional20 || 0,
                sweep: s.sweep?.score || 0,
                vacuum: s.vacuum?.severity || 0,
                toxicity: s.toxicity?.tox || s.toxicity?.proxy || 0,
                vpin: s.toxicity?.vpin || 0,
                spoofing: s.spoofing?.score || 0,
                spoofSide: s.spoofing?.side || 'none',
                iceberg: s.iceberg?.score || 0,
                icebergSide: s.iceberg?.side || 'none',
                label: s.vacuum?.active ? "vacuum" : s.sweep?.label || "normal",
            };
        });
        return reduced;
    };
})();
