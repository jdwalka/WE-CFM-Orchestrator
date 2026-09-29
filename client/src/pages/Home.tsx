// @ts-nocheck
/*
 * Swiss editorial forensic style for this page:
 * keep the layout asymmetrical, evidence-first, and audit-grade;
 * use dark graphite fields with restrained cyan, lime, and ember accents;
 * make every section reinforce the difference between directional accuracy,
 * selection filtering, live screenshot evidence, and futures-prediction contract viability.
 */
import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ArrowUpRight,
  Camera,
  FileCode2,
  Filter,
  Orbit,
  Scale,
  ShieldAlert,
  Target,
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  Database,
  HardDriveDownload,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { liveEvidence } from "@/data/liveEvidence";
import { reportData } from "@/data/reportData";
import { useLiveMetrics } from "@/hooks/useLiveMetrics";
import {
  getInferenceHistory,
  runInference,
  type InferenceRecord,
} from "@/services/aiService";
import {
  exportInferenceLogsToDrive,
  recoverInferenceLogsFromDrive,
} from "@/services/driveService";
import {
  hasFirebaseClientConfig,
  signInWithGoogle,
  signOutGoogle,
  subscribeGoogleUser,
} from "@/services/firebaseGoogleAuth";

const pct = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

const whole = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const summaryCards = [
  {
    title: "Selection filter ratio",
    value: `${pct.format(reportData.summary.overallSelectionRatio)}%`,
    note: `${whole.format(reportData.summary.totalActiveSignals)} active from ${whole.format(reportData.summary.totalObservations)} observations`,
    icon: Filter,
  },
  {
    title: "Directional hit rate",
    value: `${pct.format(reportData.summary.overallDirectionalHitRate)}%`,
    note: `Measured against a ${reportData.metadata.breakEvenHitRate}% futures-contract hurdle`,
    icon: Target,
  },
  {
    title: "Setups above hurdle",
    value: `${reportData.summary.aboveBreakEven}/${reportData.summary.aboveBreakEven + reportData.summary.belowBreakEven}`,
    note: `The attached backtest setups remain below the modeled contract threshold`,
    icon: Scale,
  },
  {
    title: "Live evidence mode",
    value: "Screenshot exhibits",
    note: "Live proof is shown, but bounded separately from the attached backtest report",
    icon: Camera,
  },
] as const;

const metricDefinitions = [
  {
    metric: "signalCount vs activeCount",
    meaning: "Shows how much filtering occurs before a futures-direction signal becomes actionable or visible.",
  },
  {
    metric: "Directional hit rate",
    meaning: "Measures whether a predicted UP or DOWN outcome matched the later contract direction.",
  },
  {
    metric: "Contract clearance vs 54% hurdle",
    meaning: "Uses your spread-plus-fee framing as the practical viability threshold for target-price prediction contracts.",
  },
  {
    metric: "Confidence distribution",
    meaning: "Checks whether stronger confidence buckets actually behave better than lighter ones.",
  },
] as const;

const setupWinRateData = reportData.mostActiveSetups.slice(0, 6).map((setup) => ({
  label: `${setup.coin}-${setup.horizonKey.toUpperCase()}`,
  winRate: Number(setup.winRate.toFixed(1)),
  selectionRatio: Number(setup.selectionRatio.toFixed(1)),
  hurdle: reportData.metadata.breakEvenHitRate,
}));

const confidenceData = reportData.confidenceDistribution.map((bucket) => ({
  name: bucket.bucket,
  count: bucket.count,
  weightedWinRate: Number(bucket.weightedWinRate.toFixed(1)),
}));

const sessionData = reportData.sessionDistribution.map((session) => ({
  name: session.session,
  total: session.total,
  weightedWinRate: Number(session.weightedWinRate.toFixed(1)),
}));

const setupTableRows = reportData.bestSetups.slice(0, 6).map((setup) => ({
  label: `${setup.coin} ${setup.horizonKey.toUpperCase()}`,
  selectionRatio: `${pct.format(setup.selectionRatio)}%`,
  hitRate: `${pct.format(setup.winRate)}%`,
  clearance: `${setup.netEdgeVsBreakEven >= 0 ? "+" : ""}${pct.format(setup.netEdgeVsBreakEven)} pts`,
  profitFactor: setup.profitFactor.toFixed(2),
}));

const weakTableRows = reportData.weakestSetups.slice(0, 6).map((setup) => ({
  label: `${setup.coin} ${setup.horizonKey.toUpperCase()}`,
  selectionRatio: `${pct.format(setup.selectionRatio)}%`,
  hitRate: `${pct.format(setup.winRate)}%`,
  clearance: `${setup.netEdgeVsBreakEven >= 0 ? "+" : ""}${pct.format(setup.netEdgeVsBreakEven)} pts`,
  profitFactor: setup.profitFactor.toFixed(2),
}));

const heroExhibit = liveEvidence.claims[0];

function MetricCard({
  title,
  value,
  note,
  icon: Icon,
}: {
  title: string;
  value: string;
  note: string;
  icon: typeof Filter;
}) {
  return (
    <article className="audit-card audit-card--metric">
      <div className="audit-card__header">
        <span className="audit-icon-shell">
          <Icon size={18} />
        </span>
        <p className="audit-label">{title}</p>
      </div>
      <p className="audit-stat">{value}</p>
      <p className="audit-note">{note}</p>
    </article>
  );
}

function TableSection({
  title,
  caption,
  rows,
}: {
  title: string;
  caption: string;
  rows: Array<{
    label: string;
    selectionRatio: string;
    hitRate: string;
    clearance: string;
    profitFactor: string;
  }>;
}) {
  return (
    <section className="audit-table-card">
      <div className="audit-section-heading">
        <p className="audit-kicker">Evidence table</p>
        <h3>{title}</h3>
        <p>{caption}</p>
      </div>
      <div className="audit-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Setup</th>
              <th>Selection ratio</th>
              <th>Directional hit rate</th>
              <th>Clearance vs 54%</th>
              <th>Profit factor</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const coin = row.label.split(" ")[0];
              return (
                <tr key={row.label}>
                  <td>
                    <Link href={`/coin/${coin}`} className="audit-link-reset">
                      <span className="audit-coin-link">
                        {row.label}
                        <ChevronRight size={14} className="audit-coin-link-icon" />
                      </span>
                    </Link>
                  </td>
                  <td>{row.selectionRatio}</td>
                  <td>{row.hitRate}</td>
                  <td>{row.clearance}</td>
                  <td>{row.profitFactor}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Home() {
  // Fetch live metrics from Validator15m via IPC
  const { stats, hitRate, completedCount, loading, error } = useLiveMetrics({
    pollInterval: 5000, // Query every 5 seconds
  });

  // Fallback to static report data if live data unavailable
  const displayHitRate = stats ? stats.hitRate : reportData.summary.overallDirectionalHitRate;
  const displayCompleted = stats ? stats.total : reportData.summary.totalActiveSignals;

  const [inferencePrompt, setInferencePrompt] = useState(
    "Summarize current WECRYPTO risk posture and key directional bias in 3 bullets."
  );
  const [inferenceLogs, setInferenceLogs] = useState<InferenceRecord[]>([]);
  const [inferenceRunning, setInferenceRunning] = useState(false);
  const [backupRunning, setBackupRunning] = useState(false);
  const [inferenceMessage, setInferenceMessage] = useState<string | null>(null);
  const [googleUserEmail, setGoogleUserEmail] = useState<string | null>(null);
  const [authRunning, setAuthRunning] = useState(false);

  const liveStatusClass = error
    ? "live-status-banner live-status-banner--error"
    : loading
      ? "live-status-banner live-status-banner--loading"
      : "live-status-banner live-status-banner--ok";

  useEffect(() => {
    let mounted = true;
    getInferenceHistory(25)
      .then((rows) => {
        if (mounted) setInferenceLogs(rows);
      })
      .catch(() => {
        if (mounted) setInferenceMessage("Could not load AI inference history");
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return subscribeGoogleUser((user) => {
      setGoogleUserEmail(user?.email || null);
    });
  }, []);

  const handleRunInference = async () => {
    setInferenceRunning(true);
    setInferenceMessage(null);
    try {
      const entry = await runInference(inferencePrompt, {
        coin: "BTC",
        horizon: 15,
        hitRate: displayHitRate,
        completed: displayCompleted,
      });
      setInferenceLogs((prev) => [entry, ...prev].slice(0, 30));
      setInferenceMessage("AI analysis complete and logged.");
    } catch (err) {
      setInferenceMessage(err instanceof Error ? err.message : "Inference failed");
    } finally {
      setInferenceRunning(false);
    }
  };

  const handleBackupLogs = async () => {
    setBackupRunning(true);
    setInferenceMessage(null);
    try {
      const result = await exportInferenceLogsToDrive(inferenceLogs);
      if (!result.success) {
        setInferenceMessage(result.error || "Backup failed");
      } else {
        setInferenceMessage(
          `Backup created${(result as any).backupName ? `: ${(result as any).backupName}` : ""}`
        );
      }
    } catch (err) {
      setInferenceMessage(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBackupRunning(false);
    }
  };

  const handleDriveRecover = async () => {
    setBackupRunning(true);
    setInferenceMessage(null);
    try {
      const result = await recoverInferenceLogsFromDrive();
      if (!result.success) {
        setInferenceMessage(result.error || "Recovery failed");
        return;
      }

      const payload = (result as any).latestPayload as { inferences?: InferenceRecord[] } | null;
      const recoveredRows = Array.isArray(payload?.inferences)
        ? payload!.inferences!.map((row) => ({
          id: String(row.id || crypto.randomUUID()),
          prompt: String(row.prompt || ""),
          context: row.context && typeof row.context === "object" ? row.context : {},
          result: row.result ?? null,
          createdAt: String(row.createdAt || new Date().toISOString()),
          source: row.source === "electron-ipc" ? "electron-ipc" : "local-fallback",
        }))
        : [];

      if (recoveredRows.length) {
        setInferenceLogs((prev) => [...recoveredRows, ...prev].slice(0, 30));
      }

      setInferenceMessage(
        `Recovered ${(result as any).recovered ?? 0} backup file(s)${recoveredRows.length ? `, restored ${recoveredRows.length} entries from latest` : ""}.`
      );
    } catch (err) {
      setInferenceMessage(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setBackupRunning(false);
    }
  };

  const handleGoogleAuth = async () => {
    if (!hasFirebaseClientConfig) {
      setInferenceMessage("Firebase Google auth is not configured in client/.env.local");
      return;
    }
    setAuthRunning(true);
    setInferenceMessage(null);
    try {
      if (googleUserEmail) {
        await signOutGoogle();
        setInferenceMessage("Signed out from Firebase Google session.");
      } else {
        await signInWithGoogle();
        setInferenceMessage("Google account linked for Firebase logs.");
      }
    } catch (err) {
      setInferenceMessage(err instanceof Error ? err.message : "Google auth failed");
    } finally {
      setAuthRunning(false);
    }
  };

  return (
    <main className="audit-page">
      {/* Live status indicator */}
      {(stats || loading || error) && (
        <div className={liveStatusClass}>
          {loading ? <RefreshCw size={16} className="animate-spin" /> : error ? <AlertTriangle size={16} /> : <Orbit size={16} />}
          <span>
            {error ? `Live metrics: ${error}` : loading ? "Connecting to model..." : `Live: ${completedCount} validations, ${pct.format(hitRate)}% hit rate`}
          </span>
        </div>
      )}

      <section className="audit-card ai-bigdata-panel">
        <div className="audit-card__header ai-bigdata-header">
          <div className="ai-bigdata-title">
            <Database size={18} />
            <p className="audit-label">AI Big Data Logs</p>
          </div>
          <div className="ai-bigdata-actions">
            <button
              type="button"
              onClick={handleGoogleAuth}
              disabled={authRunning || !hasFirebaseClientConfig}
              className="ai-bigdata-btn ai-bigdata-btn--backup"
              title={hasFirebaseClientConfig ? "Connect Google account for Firebase auth" : "Set VITE_FIREBASE_* vars in client/.env.local"}
            >
              {authRunning
                ? "Auth…"
                : googleUserEmail
                  ? `Google: ${googleUserEmail}`
                  : "Google Sign In"}
            </button>
            <button
              type="button"
              onClick={handleRunInference}
              disabled={inferenceRunning}
              className="ai-bigdata-btn ai-bigdata-btn--run"
            >
              {inferenceRunning ? "Running…" : "Run TIDE Analysis"}
            </button>
            <button
              type="button"
              onClick={handleBackupLogs}
              disabled={backupRunning}
              className="ai-bigdata-btn ai-bigdata-btn--backup"
            >
              <HardDriveDownload size={14} />
              {backupRunning ? "Backing up…" : "Backup Logs"}
            </button>
            <button
              type="button"
              onClick={handleDriveRecover}
              disabled={backupRunning}
              className="ai-bigdata-btn ai-bigdata-btn--backup"
            >
              <RefreshCw size={14} />
              {backupRunning ? "Recovering…" : "Recover Backups"}
            </button>
          </div>
        </div>

        <label htmlFor="ai-inference-prompt" className="audit-label ai-bigdata-prompt-label">
          Inference prompt
        </label>
        <textarea
          id="ai-inference-prompt"
          value={inferencePrompt}
          onChange={(e) => setInferencePrompt(e.target.value)}
          rows={3}
          className="ai-bigdata-textarea"
          placeholder="Describe the analysis you want for current market telemetry..."
        />

        {inferenceMessage && <p className="audit-note">{inferenceMessage}</p>}

        <div className="ai-bigdata-log-list">
          {inferenceLogs.slice(0, 5).map((item) => (
            <article key={item.id} className="ai-bigdata-log-item">
              <p className="audit-label ai-bigdata-log-meta">{new Date(item.createdAt).toLocaleString()} • {item.source}</p>
              <p className="ai-bigdata-log-prompt">{item.prompt}</p>
              <p className="audit-note ai-bigdata-log-result">
                {typeof item.result === "string"
                  ? item.result
                  : JSON.stringify(item.result ?? {}, null, 2)}
              </p>
            </article>
          ))}
          {!inferenceLogs.length && <p className="audit-note">No inference logs yet.</p>}
        </div>
      </section>

      <section className="audit-hero">
        <div className="audit-hero__rail">
          <p className="audit-rail-label">Proof gradient</p>
          <div className="audit-rail-scale">
            <span>Claim</span>
            <span>Filter</span>
            <span>Hit rate</span>
            <span>Payout</span>
          </div>
        </div>

        <div className="audit-hero__content">
          <div className="audit-hero__copy">
            <p className="audit-kicker">WeCrypto futures-prediction audit</p>
            <h1>
              Measuring <span>predictive contract outcomes</span>, not generic trading metrics.
            </h1>
            <p className="audit-lead">
              This report site is built around your narrower claim: the system is used for
              <strong> futures-direction prediction and target-price contract calls</strong>, where the
              core question is whether filtered UP and DOWN predictions survive a realistic
              spread-plus-fee hurdle. The site therefore separates four layers on purpose:
              raw observations, filtered signals, attached backtest hit rates, and live screenshot
              exhibits of paid-out contracts.
            </p>
            <div className="audit-inline-points">
              <div>
                <span className="audit-inline-label">Attached report window</span>
                <strong>
                  {reportData.metadata.daysBack} days / {reportData.metadata.candlesPerCoin} candles per coin
                </strong>
              </div>
              <div>
                <span className="audit-inline-label">Modeled contract hurdle</span>
                <strong>{reportData.metadata.breakEvenHitRate}% directional hit rate</strong>
              </div>
            </div>
          </div>

          <aside className="audit-hero__panel">
            <div className="audit-panel-glow" />
            <div className="audit-terminal-row">
              <span>Lead exhibit</span>
              <ArrowUpRight size={16} />
            </div>
            <div className="audit-exhibit-hero">
              <img src={heroExhibit.imageSrc} alt={heroExhibit.imageAlt} />
            </div>
            <p className="audit-panel-title">A live payout card is shown, but it should be read as an exhibit, not a full ledger.</p>
            <p className="audit-note">{heroExhibit.detail}</p>
            <div className="audit-panel-stats">
              <div>
                <span>Original cost shown</span>
                <strong>{money.format(179.17)}</strong>
              </div>
              <div>
                <span>Payout shown</span>
                <strong>{money.format(233.94)}</strong>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="audit-grid audit-grid--metrics" id="proof">
        {summaryCards.map((card) => (
          <MetricCard key={card.title} {...card} />
        ))}
      </section>

      <section className="audit-split-section">
        <div className="audit-section-heading audit-section-heading--narrow">
          <p className="audit-kicker">Methodology shift</p>
          <h2>What the site now proves for futures predictions and payout contracts.</h2>
          <p>
            The report no longer reads like a generic trading critique. It is now scoped to
            futures-direction prediction, target-price contracts, and the distinction between
            predictive correctness and generalized trading claims. The evidence is split so live
            screenshot exhibits can strengthen the story without being overstated.
          </p>
        </div>

        <div className="audit-definition-card">
          <div className="audit-definition-card__header">
            <FileCode2 size={18} />
            <span>What the site needs to prove</span>
          </div>
          <div className="audit-definition-grid">
            {metricDefinitions.map((item) => (
              <div key={item.metric} className="audit-definition-item">
                <h3>{item.metric}</h3>
                <p>{item.meaning}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="audit-showcase-grid">
        <article className="audit-chart-card audit-chart-card--wide">
          <div className="audit-section-heading">
            <p className="audit-kicker">Attached backtest evidence</p>
            <h2>Most active setups still sit under the modeled contract hurdle in the supplied report.</h2>
            <p>
              This panel compares how aggressively each setup filters observations against its
              reported directional hit rate. The cyan reference line marks the 54% viability threshold
              you described for spread-plus-fee-aware prediction contracts.
            </p>
          </div>
          <div className="audit-chart-shell">
            <ResponsiveContainer width="100%" height={360}>
              <BarChart data={setupWinRateData} margin={{ top: 12, right: 16, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="rgba(163, 192, 255, 0.12)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "rgba(138, 248, 255, 0.08)" }}
                  contentStyle={{
                    background: "rgba(6, 14, 28, 0.96)",
                    border: "1px solid rgba(138, 248, 255, 0.18)",
                    borderRadius: 16,
                    color: "#eff7ff",
                  }}
                />
                <ReferenceLine
                  y={reportData.metadata.breakEvenHitRate}
                  stroke="rgba(138, 248, 255, 0.85)"
                  strokeDasharray="5 5"
                  label={{ value: "54% hurdle", fill: "#8af8ff", position: "right" }}
                />
                <Bar dataKey="winRate" radius={[10, 10, 0, 0]}>
                  {setupWinRateData.map((entry) => (
                    <Cell
                      key={entry.label}
                      fill={entry.winRate >= reportData.metadata.breakEvenHitRate ? "#86ffce" : "#6f84ff"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="audit-chart-card">
          <div className="audit-section-heading">
            <p className="audit-kicker">Confidence buckets</p>
            <h2>Confidence labels still need to earn their keep.</h2>
            <p>
              The site tracks whether stronger buckets actually earn higher weighted hit rates,
              instead of assuming that stronger dashboard wording guarantees better contract outcomes.
            </p>
          </div>
          <div className="audit-chart-shell audit-chart-shell--compact">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={confidenceData} margin={{ top: 6, right: 12, left: -22, bottom: 0 }}>
                <CartesianGrid stroke="rgba(163, 192, 255, 0.10)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "rgba(138, 248, 255, 0.08)" }}
                  contentStyle={{
                    background: "rgba(6, 14, 28, 0.96)",
                    border: "1px solid rgba(138, 248, 255, 0.18)",
                    borderRadius: 16,
                    color: "#eff7ff",
                  }}
                />
                <Bar dataKey="weightedWinRate" radius={[10, 10, 0, 0]} fill="#8af8ff" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>
      </section>

      <section className="audit-analysis-band">
        <div className="audit-analysis-band__copy">
          <p className="audit-kicker">Interpretation guardrail</p>
          <h2>Why live wins can be real and the attached backtest can still remain weaker.</h2>
          <p>
            These statements are not mutually exclusive. A live user may be applying discretion,
            timing, or contract selection on top of the engine. That can produce real winning payout
            screenshots while the attached backtest dataset still shows lower aggregate hit rates.
            The site keeps those layers separate so the report remains credible rather than flattening
            all evidence into one overconfident sentence.
          </p>
        </div>
        <div className="audit-analysis-band__stack">
          <div className="audit-mini-panel">
            <span>Raw observations</span>
            <strong>{whole.format(reportData.summary.totalObservations)}</strong>
          </div>
          <div className="audit-mini-panel">
            <span>Active signals</span>
            <strong>{whole.format(reportData.summary.totalActiveSignals)}</strong>
          </div>
          <div className="audit-mini-panel audit-mini-panel--accent">
            <span>Filtered out</span>
            <strong>{pct.format(100 - reportData.summary.overallSelectionRatio)}%</strong>
          </div>
        </div>
      </section>

      <section className="audit-live-evidence">
        <div className="audit-live-evidence__intro">
          <div className="audit-section-heading">
            <p className="audit-kicker">Live screenshot evidence</p>
            <h2>{liveEvidence.framing.title}</h2>
            <p>{liveEvidence.framing.summary}</p>
          </div>
          <div className="audit-boundary-card">
            <div className="audit-boundary-card__header">
              <ShieldAlert size={18} />
              <span>Audit boundary</span>
            </div>
            <p>{liveEvidence.framing.boundary}</p>
          </div>
        </div>

        <div className="audit-evidence-gallery">
          {liveEvidence.claims.map((claim) => (
            <article key={claim.label} className="audit-gallery-card">
              <div className="audit-gallery-card__image">
                <img src={claim.imageSrc} alt={claim.imageAlt} />
              </div>
              <div className="audit-gallery-card__copy">
                <p className="audit-kicker">Exhibit</p>
                <h3>{claim.label}</h3>
                <p>{claim.detail}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="audit-showcase-grid audit-showcase-grid--lower">
        <article className="audit-chart-card">
          <div className="audit-section-heading">
            <p className="audit-kicker">Session behavior</p>
            <h2>Directional quality still shifts by session context.</h2>
            <p>
              This matters because even a convincing payout contract can behave differently across NY,
              London, Asia, and off-hours windows.
            </p>
          </div>
          <div className="audit-chart-shell audit-chart-shell--compact">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={sessionData} margin={{ top: 6, right: 12, left: -22, bottom: 0 }}>
                <CartesianGrid stroke="rgba(163, 192, 255, 0.10)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <YAxis stroke="rgba(220, 232, 255, 0.68)" tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: "rgba(138, 248, 255, 0.08)" }}
                  contentStyle={{
                    background: "rgba(6, 14, 28, 0.96)",
                    border: "1px solid rgba(138, 248, 255, 0.18)",
                    borderRadius: 16,
                    color: "#eff7ff",
                  }}
                />
                <Bar dataKey="weightedWinRate" radius={[10, 10, 0, 0]} fill="#b7f26d" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </article>

        <article className="audit-evidence-card audit-evidence-card--image">
          <div className="audit-section-heading">
            <p className="audit-kicker">Microstructure framing</p>
            <h2>The site now treats contract friction as a narrower problem than traditional execution.</h2>
            <p>
              Your correction is preserved here: target-price prediction contracts should be judged
              differently from spot or perp execution. That narrows the friction model, but it does
              not erase the need to compare attached hit-rate evidence with live exhibits carefully.
            </p>
          </div>
          <div className="audit-microstructure-image">
            <img
              src="/manus-storage/wecrypto-risk-microstructure_7e65baa8.png"
              alt="Abstract microstructure graphic used as a visual anchor for the contract-friction section."
            />
          </div>
        </article>
      </section>

      <section className="audit-evidence-card audit-evidence-card--statements">
        <div className="audit-section-heading">
          <p className="audit-kicker">Interpretive statements</p>
          <h2>What the live exhibits do and do not establish.</h2>
        </div>
        <div className="audit-evidence-list">
          {liveEvidence.interpretation.map((line) => (
            <div key={line}>
              <Orbit size={18} />
              <p>{line}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="audit-table-grid">
        <TableSection
          title="Least-bad attached setups"
          caption="These setups rank highest by clearance versus the 54% hurdle, but they still remain below it in the attached report."
          rows={setupTableRows}
        />
        <TableSection
          title="Weakest attached setups"
          caption="These are the setups where selection filtering does not rescue directional performance enough to approach payout-contract viability."
          rows={weakTableRows}
        />
      </section>

      <section className="audit-footer-band">
        <div>
          <p className="audit-kicker">Bottom line</p>
          <h2>This website now compares backtest weakness against live exhibit strength.</h2>
        </div>
        <p>
          It presents the audit as a restrained investigative report rather than a generic product
          page. The framing now matches your futures-prediction use case more closely: the attached
          backtest evidence does not yet fully prove the stronger live claim on its own, but the live
          payout and transaction screenshots materially strengthen the case that the system is being
          used successfully in real prediction-contract contexts.
        </p>
      </section>
    </main>
  );
}
