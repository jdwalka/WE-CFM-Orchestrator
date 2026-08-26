// network-health-dashboard.js
// UI panel for displaying network health of all market data providers
(function () {
    if (window.NetworkHealthDashboard) return;

    const MINIMIZED_STORAGE_KEY = 'wecrypto.networkHealthDashboard.minimized';
    const dash = document.createElement('div');
    dash.id = 'network-health-dashboard';
    dash.style.position = 'fixed';
    dash.style.bottom = '18px';
    dash.style.left = 'max(16px, calc(var(--sidebar-w, 280px) + 16px))';
    dash.style.right = 'auto';
    dash.style.maxWidth = 'min(380px, calc(100vw - 32px))';
    dash.style.zIndex = 8990;
    dash.style.background = 'rgba(24,28,36,0.98)';
    dash.style.border = '1.5px solid #333';
    dash.style.borderRadius = '10px';
    dash.style.boxShadow = '0 2px 12px #0008';
    dash.style.padding = '14px 18px 10px 18px';
    dash.style.minWidth = '280px';
    dash.style.maxHeight = 'min(78vh, 760px)';
    dash.style.overflow = 'hidden';
    dash.style.fontFamily = 'JetBrains Mono, monospace';
    dash.style.fontSize = '14px';
    dash.style.color = '#e0e6f0';
    dash.style.pointerEvents = 'auto';

    dash.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <div style="font-weight:600;font-size:15px;letter-spacing:0.5px;">Network Health</div>
            <div style="display:flex;align-items:center;gap:6px;">
                <button id="network-health-reconnect-btn" class="hud-icon-btn" type="button" title="Reconnect all feeds"
                    style="padding:2px 8px;border-radius:6px;font-size:11px;color:#8ab4f8;background:transparent;border:1px solid #334;cursor:pointer;">↻</button>
                <button id="network-health-min-btn" class="hud-icon-btn" type="button" title="Minimize"
                    style="padding:2px 6px;border-radius:6px;font-size:12px;color:#aab2c0;background:transparent;border:1px solid #333;cursor:pointer;">▼</button>
            </div>
        </div>
        <div id="network-health-body">
            <div id="network-health-recovery" style="display:none;margin-bottom:8px;"></div>
            <div id="network-health-summary" style="font-size:12px;color:#9aa6b2;margin-bottom:8px;"></div>
            <div id="network-health-alert" style="display:none;margin-bottom:8px;"></div>
            <div id="network-health-buckets" style="font-size:12px;color:#9aa6b2;margin-bottom:6px;"></div>
            <div id="network-health-list"></div>
            <div style="font-size:12px;color:#8ab4f8;margin-top:10px;font-weight:600;">Transports (WSS → gRPC → RPC → HTTP)</div>
            <div id="network-transport-stats" style="margin-top:4px;padding-top:6px;border-top:1px solid #333;font-size:12px;"></div>
            <div style="font-size:12px;color:#8ab4f8;margin-top:10px;font-weight:600;">Orbital Matrix (Redpanda)</div>
            <div id="orbital-matrix-stats" style="margin-top:4px;padding-top:6px;border-top:1px solid #333;font-size:12px;"></div>
            <div style="font-size:12px;color:#8ab4f8;margin-top:10px;font-weight:600;">AI Inference (5m PTB)</div>
            <div id="ai-inference-status" style="margin-top:4px;padding-top:6px;border-top:1px solid #333;font-size:12px;"></div>
            <div id="network-health-lastupdate" style="font-size:12px;color:#aaa;margin-top:6px;"></div>
        </div>
    `;

    document.body.appendChild(dash);
    let minimized = false;

    try {
        minimized = window.localStorage.getItem(MINIMIZED_STORAGE_KEY) === '1';
    } catch (_) {
        minimized = false;
    }

    function applyMinimizedState() {
        const body = document.getElementById('network-health-body');
        const btn = document.getElementById('network-health-min-btn');
        if (!body || !btn) return;
        body.style.display = minimized ? 'none' : '';
        body.style.overflowY = minimized ? 'hidden' : 'auto';
        body.style.overflowX = 'hidden';
        body.style.maxHeight = minimized ? '0' : 'min(68vh, 660px)';
        dash.style.padding = minimized ? '10px 14px' : '14px 18px 10px 18px';
        dash.style.minWidth = minimized ? '220px' : '280px';
        btn.textContent = minimized ? '▲' : '▼';
        btn.title = minimized ? 'Expand' : 'Minimize';
    }

    function persistMinimizedState() {
        try {
            window.localStorage.setItem(MINIMIZED_STORAGE_KEY, minimized ? '1' : '0');
        } catch (_) {
            // Session-only fallback when localStorage is unavailable.
        }
    }

    document.getElementById('network-health-min-btn')?.addEventListener('click', () => {
        const wasMinimized = minimized;
        minimized = !minimized;
        persistMinimizedState();
        applyMinimizedState();
        if (wasMinimized && !minimized) {
            try { window.NetworkHealth?.syncLiveProbe?.(); } catch (_) { }
            try { window.ExchangeWS?.warmOptionalWsRoutes?.('dashboard-expand'); } catch (_) { }
            scheduleRender(true);
        }
    });

    document.getElementById('network-health-reconnect-btn')?.addEventListener('click', () => {
        const btn = document.getElementById('network-health-reconnect-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '…';
        }
        const done = () => {
            if (btn) {
                btn.disabled = false;
                btn.textContent = '↻';
            }
        };
        const run = window.NetworkRecovery?.run?.('dashboard-reconnect');
        if (run && typeof run.then === 'function') run.finally(done);
        else done();
    });
    applyMinimizedState();

    const STATUS_ORDER = { down: 0, recovering: 1, degraded: 2, unknown: 3, healthy: 4 };

    function statusColor(status) {
        if (status === 'healthy') return '#3ecf8e';
        if (status === 'recovering') return '#8ab4f8';
        if (status === 'degraded') return '#ffd166';
        if (status === 'down') return '#ff5e5e';
        return '#888';
    }

    function statusLabel(status) {
        if (status === 'recovering') return 'RECONNECT';
        return String(status || 'unknown').toUpperCase();
    }

    function providerRank(provider, row) {
        const critical = window.NetworkHealth?.isCriticalProvider?.(provider);
        const severity = STATUS_ORDER[row?.status] ?? 3;
        return (critical ? 0 : 100) + severity;
    }

    function renderSummary(summary, recovery) {
        const el = document.getElementById('network-health-summary');
        if (!el || !summary) return;
        const criticalLine = `${summary.criticalHealthy}/${summary.criticalTotal} critical live`;
        const parts = [
            `<span style="color:#3ecf8e;">${summary.healthy} healthy</span>`,
            summary.recovering ? `<span style="color:#8ab4f8;">${summary.recovering} reconnecting</span>` : '',
            summary.degraded ? `<span style="color:#ffd166;">${summary.degraded} degraded</span>` : '',
            summary.down ? `<span style="color:#ff5e5e;">${summary.down} down</span>` : '',
            summary.unknown ? `<span style="color:#888;">${summary.unknown} idle</span>` : '',
        ].filter(Boolean).join(' · ');
        el.innerHTML = `${parts}<div style="margin-top:3px;color:#c7d2fe;">${criticalLine}${recovery?.active && recovery.phase ? ` · phase ${escapeHtml(recovery.phase)}` : ''}</div>`;
    }

    function renderRecoveryBanner(recovery) {
        const el = document.getElementById('network-health-recovery');
        if (!el) return;
        if (!recovery?.active) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        el.style.display = '';
        el.innerHTML = `<div style="background:rgba(138,180,248,0.12);border:1px solid rgba(138,180,248,0.35);color:#dbeafe;padding:7px 10px;border-radius:6px;font-size:12px;">
            Reconnecting feeds${recovery.phase ? ` · <span style="color:#8ab4f8;">${escapeHtml(recovery.phase)}</span>` : ''}
            ${recovery.reason ? `<span style="color:#888;"> (${escapeHtml(recovery.reason)})</span>` : ''}
        </div>`;
    }

    function formatAgo(ts) {
        if (!ts) return '—';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 2) return 'just now';
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        return new Date(ts).toLocaleTimeString();
    }

    function formatMs(ms) {
        const safe = Math.max(0, Number(ms || 0));
        if (safe < 1000) return '<1s';
        const sec = Math.ceil(safe / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        const rem = sec % 60;
        return rem ? `${min}m ${rem}s` : `${min}m`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function fetchJsonWithTimeout(url, timeoutMs = 2500) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error(`timeout:${timeoutMs}`)), timeoutMs);
        try {
            const res = await fetch(url, {
                signal: ctrl.signal,
                headers: { Accept: 'application/json' }
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }

    let lastProbeTime = 0;
    let lastProbeResult = null;
    let probeBackoffMs = 2500;
    let probePromise = null;

    async function probeOrbitalLocalEndpoints() {
        if (Date.now() - lastProbeTime < probeBackoffMs && lastProbeResult) {
            return lastProbeResult;
        }

        if (probePromise) {
            return probePromise;
        }

        probePromise = (async () => {
            const out = {
                docker: 'unknown',
                redpanda: 'unknown',
                nodes: 0,
                nodesDown: [],
                topics: [],
                notifications: [],
            };

            try {
                const brokers = await fetchJsonWithTimeout('http://127.0.0.1:8080/redpanda/v1/brokers', 2500)
                    .catch(() => fetchJsonWithTimeout('http://127.0.0.1:9644/v1/brokers', 2500));
                if (brokers) {
                    out.docker = 'healthy';
                    const brokerList = Array.isArray(brokers) ? brokers : [];
                    out.nodes = brokerList.filter(broker => broker?.is_alive !== false && broker?.membership_status === 'active').length;
                    out.nodesDown = brokerList
                        .filter(broker => broker?.is_alive === false || broker?.membership_status !== 'active')
                        .map(broker => broker?.node_id)
                        .filter(nodeId => Number.isFinite(nodeId));
                    out.redpanda = out.nodesDown.length ? 'degraded' : 'healthy';
                    out.notifications.push({
                        ts: Date.now(),
                        level: 'success',
                        source: 'renderer-probe',
                        message: `Redpanda admin API reachable (${out.nodes} node${out.nodes === 1 ? '' : 's'})`,
                    });
                }
            } catch (_) { }

            try {
                const topicData = await fetchJsonWithTimeout('http://127.0.0.1:8080/redpanda-console/api/topics', 2500)
                    .catch(() => fetchJsonWithTimeout('http://127.0.0.1:8081/api/topics', 2500));
                const topics = Array.isArray(topicData?.topics)
                    ? topicData.topics.map((topic) => topic?.topicName).filter((name) => name && name.includes('wecrypto.orbital'))
                    : [];
                if (topics.length || out.redpanda === 'healthy') {
                    out.docker = 'healthy';
                    out.redpanda = 'healthy';
                }
                out.topics = topics;
                if (topics.length) {
                    out.notifications.push({
                        ts: Date.now(),
                        level: 'info',
                        source: 'renderer-probe',
                        message: `Topic API reachable (${topics.length} orbital topics)`,
                    });
                }
            } catch (_) { }

            lastProbeTime = Date.now();
            lastProbeResult = out;

            if (out.redpanda !== 'healthy') {
                probeBackoffMs = Math.min(30000, probeBackoffMs * 1.5);
            } else {
                probeBackoffMs = 2500;
            }

            return out;
        })();

        try {
            return await probePromise;
        } finally {
            probePromise = null;
        }
    }

    function renderTransport() {
        const el = document.getElementById('network-transport-stats');
        if (!el) return;

        const t = window.NetworkHealth?.getTransport?.() || {};
        const byKey = t.byKey || {};
        const preferred = t.preferred || {};
        const priority = t.priority || ['wss', 'grpc', 'rpc', 'http'];
        const proxy = t.proxy || {};
        const bus = t.bus || {};
        const coordination = t.coordination || {};

        if (!Object.keys(byKey).length) {
            el.innerHTML = '<span style="color:#888;">No transport activity yet</span>';
            return;
        }

        const providers = [...new Set(Object.keys(byKey).map(k => k.split(':')[0]))];
        const rows = providers.map((provider) => {
            const pref = preferred[provider] || '—';
            const cells = priority.map((transport) => {
                const row = byKey[`${provider}:${transport}`];
                if (!row) return `<span style="color:#555;margin-right:6px;">${transport}:—</span>`;
                const active = pref === transport;
                const color = row.fail > row.ok ? '#ff5e5e' : (active ? '#3ecf8e' : '#aaa');
                return `<span style="color:${color};margin-right:6px;${active ? 'font-weight:600;' : ''}">${transport}:${row.ok}/${row.fail}</span>`;
            }).join('');
            return `<div style="margin-bottom:5px;"><span style="color:#e0e6f0;width:72px;display:inline-block;">${provider}</span> ${cells}</div>`;
        }).join('');

        const polyState = window.PolymarketWS?.getStatus?.() || {};
        let wsHint = '<span style="color:#888;">Polymarket WS connecting</span>';
        if (polyState.clobConnected || polyState.rtdsConnected) {
            wsHint = `<span style="color:#3ecf8e;">Polymarket WS live (${polyState.subscribedAssetsCount || 0} feeds)</span>`;
        }

        let hybridHint = '<span style="color:#888;">Hybrid mode: normal</span>';
        if (proxy.mode === 'bypass' || proxy.bypassActive) {
            hybridHint = `<span style="color:#ffd166;">Hybrid mode: proxy bypass (${proxy.bypassMsLeft > 0 ? Math.round(proxy.bypassMsLeft / 1000) + 's' : 'active'})</span>`;
        } else if (proxy.healthy === false) {
            hybridHint = `<span style="color:#ffd166;">Hybrid mode: degraded proxy (${proxy.failures || 0} fails)</span>`;
        } else if (proxy.mode === 'proxy') {
            hybridHint = '<span style="color:#3ecf8e;">Hybrid mode: proxy active</span>';
        }

        const endpointCount = Object.keys(bus.endpoints || {}).length;
        const busHint = endpointCount
            ? `<span style="color:#8ab4f8;">Bus ${bus.updates || 0} upd/${bus.errors || 0} err (${endpointCount} ep)</span>`
            : '<span style="color:#888;">Bus idle</span>';
        const coordDomainCount = Object.keys(coordination.domains || {}).length;
        const coordHint = coordDomainCount
            ? `<span style="color:#8ab4f8;">Coord ${coordDomainCount} domains</span>`
            : '<span style="color:#888;">Coord idle</span>';

        const domainRows = Object.entries(coordination.domains || {})
            .slice(0, 4)
            .map(([domain, row]) => {
                const selected = row?.selected || '—';
                const reason = row?.reason || '';
                return `<div style="color:#9aa6b2;margin-top:2px;">${domain}: <span style="color:#e0e6f0;">${selected}</span>${reason ? ` <span style="color:#888;">(${reason})</span>` : ''}</div>`;
            }).join('');

        // Polymarket WS status (legacy Kalshi wsState removed — never reintroduce bare `wsState`)
        const polyWs = window.PolymarketWS?.getStatus?.() || {};
        const wsState = {
            lastConnectAttempt: t.ws?.lastConnectAttempt || null,
            lastHandshakeStatus: polyWs.clobConnected || polyWs.rtdsConnected ? 'ok' : 'connecting',
            lastHandshakeError: '',
            lastAuthStatus: 'n/a',
            lastAuthError: '',
            lastIssueBucket: '',
            lastIssueReason: '',
            suspended: false,
            suspendInMs: 0,
            suspendReason: '',
            ...(t.ws || {}),
        };
        const wsDiag = t.ws || {};
        const connectAttempt = wsDiag.lastConnectAttempt || wsState.lastConnectAttempt || null;
        const connectLine = connectAttempt
            ? `WSS connect: ${connectAttempt.status || 'unknown'}${connectAttempt.reason ? ` (${connectAttempt.reason})` : ''}${connectAttempt.error ? ` · ${connectAttempt.error}` : ''}`
            : (polyWs.clobConnected || polyWs.rtdsConnected)
                ? `WSS connect: polymarket live (clob=${!!polyWs.clobConnected} rtds=${!!polyWs.rtdsConnected})`
                : 'WSS connect: polymarket connecting';
        const hsStatus = wsDiag.lastHandshakeStatus || wsState.lastHandshakeStatus || 'unknown';
        const hsError = wsDiag.lastHandshakeError || wsState.lastHandshakeError || '';
        const authStatus = wsDiag.lastAuthStatus || wsState.lastAuthStatus || 'not-attempted';
        const authError = wsDiag.lastAuthError || wsState.lastAuthError || '';
        const demoteReason = wsDiag.lastDemoteReason || '';
        const issueBucket = wsDiag.lastIssueBucket || wsState.lastIssueBucket || 'unknown';
        const issueReason = wsDiag.lastIssueReason || wsState.lastIssueReason || '';
        const suspendLine = wsState.suspended
            ? `<div style="color:#ffd166;margin-top:2px;">Suspend: active (${formatMs(wsState.suspendInMs || 0)} left)${wsState.suspendReason ? ` <span style="color:#888;">(${wsState.suspendReason})</span>` : ''}</div>`
            : '<div style="color:#9aa6b2;margin-top:2px;">Suspend: inactive</div>';
        const wsDiagRows = [
            `<div style="color:#9aa6b2;margin-top:4px;">${connectLine}</div>`,
            `<div style="color:#9aa6b2;margin-top:2px;">Handshake: <span style="color:#e0e6f0;">${hsStatus}</span>${hsError ? ` <span style="color:#888;">(${hsError})</span>` : ''}</div>`,
            `<div style="color:#9aa6b2;margin-top:2px;">Auth: <span style="color:#e0e6f0;">${authStatus}</span>${authError ? ` <span style="color:#888;">(${authError})</span>` : ''}</div>`,
            `<div style="color:#9aa6b2;margin-top:2px;">Demote reason: <span style="color:#e0e6f0;">${demoteReason || '—'}</span></div>`,
            `<div style="color:#9aa6b2;margin-top:2px;">Issue bucket: <span style="color:#e0e6f0;">${issueBucket}</span>${issueReason ? ` <span style="color:#888;">(${issueReason})</span>` : ''}</div>`,
            suspendLine,
        ].join('');

        el.innerHTML = rows
            + `<div style="margin-top:6px;">${wsHint} · ${hybridHint} · ${busHint} · ${coordHint} · sync ${formatAgo(t.lastSync)}</div>`
            + `<div style="margin-top:4px;border-top:1px dotted #3a3f4a;padding-top:4px;">${domainRows}${wsDiagRows}</div>`;
    }

    function renderCore() {
        const state = window.NetworkHealth?.getAll?.() || {};
        const summary = window.NetworkHealth?.getSummary?.() || {};
        const recovery = window.NetworkHealth?.getRecoveryState?.() || {};
        renderSummary(summary, recovery);
        renderRecoveryBanner(recovery);
        const bucketCounts = window.NetworkHealth?.getBucketCounters?.() || {};
        const bucketEl = document.getElementById('network-health-buckets');
        if (bucketEl) {
            bucketEl.innerHTML =
                `<span style="color:#8ab4f8;">Buckets</span> · ` +
                `<span>App/Logic: ${bucketCounts['app/logic'] || 0}</span> · ` +
                `<span>Network/Transport: ${bucketCounts['network/transport'] || 0}</span> · ` +
                `<span>Provider/API: ${bucketCounts['provider/api'] || 0}</span>`;
        }
        const sorted = Object.entries(state)
            .filter(([provider]) => {
                const hostKey = String(provider || '').toLowerCase();
                if (!hostKey.includes('.')) return true;
                const canonical = window.NetworkHealth?.HOST_CANONICAL?.[hostKey];
                if (!canonical) return true;
                const canonicalRow = state[canonical];
                return !canonicalRow || Number(canonicalRow.lastFetch || 0) < Number(state[provider]?.lastFetch || 0);
            })
            .sort(([providerA, rowA], [providerB, rowB]) => {
            const rankDiff = providerRank(providerA, rowA) - providerRank(providerB, rowB);
            if (rankDiff !== 0) return rankDiff;
            return String(providerA).localeCompare(String(providerB));
        });
        const list = sorted.map(([provider, v]) => {
            const retryAt = Number(v.retryAt || v.cooldownUntil || 0);
            const cooldownMs = retryAt > Date.now() ? retryAt - Date.now() : 0;
            const retryLabel = cooldownMs > 0 ? `Retry ${formatMs(cooldownMs)}` : '';
            const bucketLabel = v.status !== 'healthy' && v.bucket && v.bucket !== 'unknown' ? ` [${v.bucket}]` : '';
            const reasonParts = [v.reason, v.bucketReason]
                .map((x) => String(x || '').trim())
                .filter(Boolean)
                .filter((x, idx, arr) => arr.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === idx);
            const reason = v.status === 'degraded' || v.status === 'down' || v.status === 'recovering' || (v.status === 'unknown' && v.reason)
                ? reasonParts.join(' · ')
                : '';
            const critical = window.NetworkHealth?.isCriticalProvider?.(provider);
            const optional = v.optional && !critical;
            const pulse = v.status === 'recovering' ? 'animation:nh-pulse 1.4s ease-in-out infinite;' : '';
            const tag = critical
                ? '<span style="font-size:10px;color:#c7d2fe;margin-left:4px;">CORE</span>'
                : (optional ? '<span style="font-size:10px;color:#666;margin-left:4px;">OPT</span>' : '');
            return `<div style="display:flex;align-items:center;margin-bottom:4px;">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${statusColor(v.status)};margin-right:8px;${pulse}"></span>
        <span style="font-weight:500;width:110px;display:inline-block;">${provider}${tag}</span>
        <span style="color:#666;font-size:10px;width:58px;display:inline-block;">${statusLabel(v.status)}</span>
        <span style="color:#aaa;font-size:12px;width:72px;display:inline-block;">${formatAgo(v.lastFetch)}</span>
        <span style="font-size:12px;color:${v.fallback ? '#ffd166' : '#aaa'};margin-left:4px;">${v.fallback ? 'Fallback' : ''}</span>
        <span style="font-size:12px;color:#8ab4f8;margin-left:4px;">${retryLabel}</span>
        <span style="font-size:12px;color:${v.status === 'recovering' ? '#8ab4f8' : '#ff5e5e'};margin-left:4px;">${bucketLabel}${reason ? ` ${escapeHtml(reason)}` : ''}</span>
      </div>`;
        }).join('');
        document.getElementById('network-health-list').innerHTML = list || '<span style="color:#888;">No provider activity yet</span>';
        document.getElementById('network-health-lastupdate').textContent = 'Updated ' + formatAgo(Date.now());
        renderTransport();

        const alertDiv = document.getElementById('network-health-alert');
        let alertMsg = '';
        if (window.NetworkHealth?.failureCounters) {
            for (const [provider, fc] of Object.entries(window.NetworkHealth.failureCounters)) {
                if (!fc.alertActive) continue;
                if (recovery.active && !window.NetworkHealth?.isCriticalProvider?.(provider)) continue;
                alertMsg += `<div style="background:#ff5e5e;color:#fff;padding:7px 12px;border-radius:6px;font-weight:600;margin-bottom:2px;">
                        ${provider} is DOWN (${fc.count} cycles): ${escapeHtml(state[provider]?.reason || '')}
                    </div>`;
            }
        }
        alertDiv.innerHTML = alertMsg;
        alertDiv.style.display = alertMsg ? '' : 'none';
    }

    let orbitalRenderInFlight = false;
    let lastOrbitalRenderAt = 0;
    const ORBITAL_RENDER_MS = 30000;
    const DASHBOARD_RENDER_MS = 4000;

    async function renderOrbitalSafe() {
        if (orbitalRenderInFlight) return;
        orbitalRenderInFlight = true;
        lastOrbitalRenderAt = Date.now();
        try {
            await renderOrbital();
        } catch (err) {
            console.warn('[NetworkHealthDashboard] orbital render failed:', err?.message || err);
        } finally {
            orbitalRenderInFlight = false;
        }
    }

    async function renderAIInference() {
        const el = document.getElementById('ai-inference-status');
        if (!el) return;
        try {
            let diagRaw = null;
            if (window.electron?.invoke) {
                diagRaw = await window.electron.invoke('llm:getDiagnostics');
            } else if (window.LLMSignalAssistant && typeof window.LLMSignalAssistant.getDiagnostics === 'function') {
                diagRaw = window.LLMSignalAssistant.getDiagnostics();
            } else if (window._llmDiagnostics) {
                diagRaw = window._llmDiagnostics;
            }
            const diag = (diagRaw && diagRaw.diagnostics) ? diagRaw.diagnostics : diagRaw;
            if (!diag) {
                el.innerHTML = '<span style="color:#888;">AI status unavailable</span>';
                return;
            }
            const rawProv = String(diag.fiveMinuteProvider || diag.provider || 'ASI1');
            const rawModel = String(diag.fiveMinuteModel || diag.model || 'asi1-mini');
            const fiveProv = rawProv.toUpperCase();
            const is5m = !!diag.fiveMinuteProvider;
            const COLOR_MAP = { XAI: '#a78bfa', ASI: '#34d399', OPENAI: '#f59e0b' };
            const color = Object.entries(COLOR_MAP).find(([k]) => fiveProv.includes(k))?.[1] ?? '#60a5fa';
            const enabledLabel = diag.enabled !== false ? 'active' : 'disabled';
            const cooldownSecs = diag.cooldown?.active ? Math.ceil((diag.cooldown.remaining_ms || 0) / 1000) : 0;
            const accId = String(diag.env?.asi1AccountId || diag.currentAccount || '');

            // Build DOM nodes — textContent auto-escapes; no user data touches innerHTML.
            el.textContent = '';

            const row1 = document.createElement('div');

            const lbl = document.createElement('span');
            lbl.style.color = '#e0e6f0';
            lbl.textContent = '5m PTB: ';
            row1.appendChild(lbl);

            const provSpan = document.createElement('span');
            provSpan.style.cssText = `color:${color};font-weight:600;`;
            provSpan.textContent = fiveProv;
            row1.appendChild(provSpan);

            const modelSpan = document.createElement('span');
            modelSpan.style.cssText = 'color:#666;font-size:10px;margin-left:4px;';
            modelSpan.textContent = rawModel;
            row1.appendChild(modelSpan);

            // Route mode is measured from real request latency (asi1-client.js),
            // not assumed — the direct-punch route can silently fall back to a
            // slow tunnel while still "working", so this must reflect reality.
            const ROUTE_BADGE = {
                native: { label: 'native route', color: '#3ecf8e' },
                fallback: { label: 'tunneled (slow)', color: '#f59e0b' },
                unreachable: { label: 'route probe failed', color: '#e5484d' },
                unknown: { label: 'route unknown', color: '#666' },
            };
            const routeInfo = ROUTE_BADGE[diag.routeMode] || ROUTE_BADGE.unknown;
            const badge = document.createElement('span');
            badge.style.cssText = `color:${routeInfo.color};font-size:9px;margin-left:6px;border:1px solid ${routeInfo.color};border-radius:3px;padding:0 4px;`;
            // For 'unreachable' the elapsed ms is the probe timeout firing, not a
            // real connection latency — showing it as "Xms" would read as "slow but
            // working" when the probe never actually connected.
            badge.textContent = diag.lastLatencyMs != null && diag.routeMode !== 'unreachable'
                ? `${routeInfo.label} · ${Math.round(diag.lastLatencyMs)}ms`
                : routeInfo.label;
            row1.appendChild(badge);

            el.appendChild(row1);

            const row2 = document.createElement('div');
            row2.style.cssText = 'font-size:10px;color:#9aa6b2;';
            let statusText = enabledLabel;
            if (cooldownSecs > 0) statusText += ` (cooldown ${cooldownSecs}s)`;
            statusText += ` · ${is5m ? 'specialized 5m path' : 'main path'}`;
            row2.textContent = statusText;
            if (accId) {
                const accSpan = document.createElement('span');
                accSpan.style.color = '#a3e635';
                accSpan.textContent = ` · ${accId}`;
                row2.appendChild(accSpan);
            }
            el.appendChild(row2);
        } catch (err) {
            el.innerHTML = `<span style="color:#ff5e5e;">AI diag error: ${escapeHtml((err && err.message) || err)}</span>`;
        }
    }

    let renderQueued = false;
    function scheduleRender(forceOrbital = false) {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(() => {
            renderQueued = false;
            try {
                renderCore();
            } catch (err) {
                console.warn('[NetworkHealthDashboard] render failed:', err?.message || err);
            }
            const orbitalDue = forceOrbital || (Date.now() - lastOrbitalRenderAt >= ORBITAL_RENDER_MS);
            if (orbitalDue) void renderOrbitalSafe();
            void renderAIInference();
        });
    }

    function render() {
        scheduleRender(false);
    }

    if (!document.getElementById('network-health-pulse-style')) {
        const style = document.createElement('style');
        style.id = 'network-health-pulse-style';
        style.textContent = '@keyframes nh-pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.45; transform:scale(0.85); } }';
        document.head.appendChild(style);
    }

    window.addEventListener('network-health-update', render);
    window.addEventListener('network-health-alert', render);
    window.addEventListener('network-transport-update', render);
    window.addEventListener('network-recovery-start', render);
    window.addEventListener('network-recovery-phase', render);
    window.addEventListener('network-recovery-end', render);
    window.addEventListener('network-recovery-complete', render);
    setInterval(() => scheduleRender(false), DASHBOARD_RENDER_MS);
    setInterval(() => scheduleRender(true), ORBITAL_RENDER_MS);
    setTimeout(() => scheduleRender(true), 250);
    // initial AI status
    setTimeout(() => renderAIInference(), 1200);

        async function renderOrbital() {
        const el = document.getElementById('orbital-matrix-stats');
        if (!el) return;

        try {
            let status = null;
            if (window._orbitalBroadcaster?.getOrbitalStatus) {
                status = await window._orbitalBroadcaster.getOrbitalStatus();
            } else if (window.electron?.invoke) {
                status = await window.electron.invoke('orbital:status');
            }
            status = status || { ready: false };
            if (status.redpanda !== 'healthy' || status.docker !== 'healthy' || !Array.isArray(status.topics) || !status.topics.length) {
                const probed = await probeOrbitalLocalEndpoints();
                if (probed.redpanda === 'healthy') {
                    status = {
                        ...status,
                        docker: probed.docker || status.docker,
                        redpanda: status.redpanda === 'degraded' ? 'degraded' : (probed.redpanda || status.redpanda),
                        nodes: Number.isFinite(probed.nodes) && probed.nodes > 0 ? probed.nodes : status.nodes,
                        nodesDown: Array.isArray(status.nodesDown) && status.nodesDown.length ? status.nodesDown : (probed.nodesDown || []),
                        topics: Array.isArray(probed.topics) && probed.topics.length ? probed.topics : (status.topics || []),
                        notifications: [...(probed.notifications || []), ...(Array.isArray(status.notifications) ? status.notifications : [])].slice(0, 8),
                    };
                }
            }
            const dotColor = status.redpanda === 'healthy' ? '#3ecf8e' : (status.redpanda === 'degraded' ? '#ffd166' : '#ff5e5e');
            const dockerStatus = status.docker === 'healthy' ? '<span style="color:#3ecf8e;">Docker UP</span>' : '<span style="color:#ff5e5e;">Docker DOWN</span>';
            const topicsCount = Array.isArray(status.topics) ? status.topics.length : 0;
            const nodeCount = Number.isFinite(status.nodes) ? status.nodes : 0;
            const nodesDown = Array.isArray(status.nodesDown) ? status.nodesDown : [];
            const bridge = status.bridge || {};
            const activity = status.activity || {};
            const totalMessages = Number(activity.totalMessages || bridge.totalMessages || 0);
            const activeOrbitals = Array.isArray(activity.activeOrbitals) ? activity.activeOrbitals : [];
            const bridgeState = bridge.connected ? '<span style="color:#3ecf8e;">Bridge live</span>' : '<span style="color:#ffd166;">Bridge idle</span>';
            const orbitalCounts = Object.entries(bridge.messageCounts || {})
                .map(([orbital, count]) => `<span style="color:#8ab4f8;">${escapeHtml(orbital)}:${Number(count || 0)}</span>`)
                .join(' · ') || '<span style="color:#666;">no orbital ticks yet</span>';
            const notifications = Array.isArray(status.notifications) ? status.notifications.slice(0, 5) : [];
            const notificationRows = notifications.length
                ? notifications.map((event) => {
                    const level = String(event?.level || 'info').toLowerCase();
                    const color = level === 'error' ? '#ff5e5e' : (level === 'warn' ? '#ffd166' : (level === 'success' ? '#3ecf8e' : '#8ab4f8'));
                    const source = event?.source ? `${escapeHtml(event.source)} · ` : '';
                    return `<div style="margin-top:3px;color:${color};">• ${source}${escapeHtml(event?.message || '')} <span style="color:#666;">(${formatAgo(event?.ts)})</span></div>`;
                }).join('')
                : '<div style="margin-top:3px;color:#666;">No cluster notifications yet</div>';

            el.innerHTML = `
                <div style="display:flex;align-items:center;margin-bottom:4px;">
                    <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};margin-right:8px;"></span>
                    <span style="font-weight:600;color:#e0e6f0;">Redpanda Cluster</span>
                    ${!bridge.connected ? '<button id="orbital-restart-btn" type="button" title="Restart orbital pipeline" style="margin-left:8px;padding:2px 7px;border:1px solid #8ab4f8;background:#171c24;color:#8ab4f8;font-size:10px;cursor:pointer;">Restart</button>' : ''}
                    <span style="margin-left:auto;color:#aaa;">${nodeCount} Nodes</span>
                </div>
                <div style="color:#9aa6b2;margin-left:18px;">
                    <div>Status: <span style="color:${dotColor};">${status.redpanda?.toUpperCase() || 'OFFLINE'}</span> &middot; ${dockerStatus}</div>
                    ${nodesDown.length ? `<div style="color:#ffd166;">Nodes down: ${nodesDown.map(escapeHtml).join(', ')}</div>` : ''}
                    <div>Active Topics: <span style="color:#8ab4f8;">${topicsCount}</span></div>
                    <div style="font-size:10px;color:#666;margin-top:2px;">${(status.topics || []).map(escapeHtml).join(', ') || 'no active topics'}</div>
                    <div style="margin-top:5px;">${bridgeState} &middot; Messages: <span style="color:#8ab4f8;">${totalMessages}</span>${activeOrbitals.length ? ` &middot; Active orbitals: <span style="color:#e0e6f0;">${activeOrbitals.map(escapeHtml).join(', ')}</span>` : ''}</div>
                    <div style="font-size:10px;color:#888;margin-top:2px;">Counts: ${orbitalCounts}</div>
                    <div style="font-size:10px;color:#888;margin-top:2px;">Last activity: ${status.activity?.lastProducedAt ? formatAgo(new Date(status.activity.lastProducedAt).getTime()) : '—'}</div>
                    <div style="margin-top:6px;padding-top:6px;border-top:1px dotted #3a3f4a;">
                        <div style="color:#8ab4f8;font-size:11px;margin-bottom:2px;">Cluster notifications</div>
                        <div style="font-size:10px;">${notificationRows}</div>
                    </div>
                </div>
            `;

            const restartButton = document.getElementById('orbital-restart-btn');
            if (restartButton) {
                restartButton.addEventListener('click', async () => {
                    restartButton.disabled = true;
                    restartButton.textContent = 'Starting...';
                    const result = window._orbitalBroadcaster?.restartOrbitalSystem
                        ? await window._orbitalBroadcaster.restartOrbitalSystem()
                        : await window.electron?.invoke?.('orbital:restart');
                    if (!result?.success) {
                        restartButton.disabled = false;
                        restartButton.textContent = 'Retry';
                        restartButton.title = result?.error || 'Orbital restart failed';
                        return;
                    }
                    setTimeout(() => scheduleRender(true), 500);
                });
            }
        } catch (err) {
            const message = err?.message || String(err || 'unknown error');
            el.innerHTML = `<span style="color:#ff5e5e;">Failed to poll orbital status: ${escapeHtml(message)}</span>`;
        }
    }

window.NetworkHealthDashboard = { render };
})();
