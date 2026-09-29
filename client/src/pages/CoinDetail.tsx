// @ts-nocheck
import { useParams, useLocation } from "wouter";
import { ArrowLeft, TrendingUp, TrendingDown, Target, Zap } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { reportData } from "@/data/reportData";
import { useCoinMetrics } from "@/hooks/useLiveMetrics";

const pct = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export default function CoinDetail() {
  const params = useParams();
  const [, navigate] = useLocation();
  const coin = params?.coin?.toUpperCase() || "BTC";

  // Fetch live metrics for this coin
  const { validations, hitRate, count, loading, error } = useCoinMetrics(coin);

  // Get backtest data for this coin
  const coinSetups = reportData.bestSetups
    .filter((s) => s.coin === coin)
    .concat(reportData.weakestSetups.filter((s) => s.coin === coin));

  const avgWinRate = coinSetups.length > 0
    ? coinSetups.reduce((sum, s) => sum + s.winRate, 0) / coinSetups.length
    : 0;

  // Group by horizon for comparison
  const horizonData = [
    { horizon: "h5m", label: "5-min" },
    { horizon: "h10m", label: "10-min" },
    { horizon: "h15m", label: "15-min" },
  ].map((h) => {
    const setups = coinSetups.filter((s) => s.horizonKey === h.horizon);
    const avgWr = setups.length > 0 ? setups.reduce((sum, s) => sum + s.winRate, 0) / setups.length : 0;
    return {
      name: h.label,
      winRate: Number(avgWr.toFixed(1)),
      observations: setups.reduce((sum, s) => sum + s.observations, 0),
      signals: setups.reduce((sum, s) => sum + s.activeSignals, 0),
    };
  });

  // Session breakdown for this coin (if available)
  const sessionPerformance = reportData.sessionDistribution.map((s) => ({
    name: s.session,
    winRate: Number(s.weightedWinRate.toFixed(1)),
  }));

  const clearance = avgWinRate - reportData.metadata.breakEvenHitRate;
  const isBullish = clearance >= 0;

  return (
    <main className="audit-page">
      <button
        onClick={() => navigate("/")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          background: "none",
          border: "none",
          color: "rgba(138, 248, 255, 0.8)",
          cursor: "pointer",
          fontSize: "14px",
          padding: "8px",
          marginBottom: "16px",
        }}
      >
        <ArrowLeft size={16} /> Back to report
      </button>

      <section className="audit-hero">
        <div className="audit-hero__content">
          <div className="audit-hero__copy">
            <p className="audit-kicker">{coin} Deep Dive</p>
            <h1>
              Directional prediction performance for <span>{coin}</span>
            </h1>
            <p className="audit-lead">
              Backtest vs. live validation data for {coin} across 5, 10, and 15-minute horizons.
              Contract viability depends on sustained hit rates above {reportData.metadata.breakEvenHitRate}%.
            </p>
            <div className="audit-inline-points">
              <div>
                <span className="audit-inline-label">Backtest avg win rate</span>
                <strong>{pct.format(avgWinRate)}%</strong>
              </div>
              <div>
                <span className="audit-inline-label">Live completions</span>
                <strong>{count}</strong>
              </div>
              <div>
                <span className="audit-inline-label">Live hit rate</span>
                <strong>{pct.format(hitRate)}%</strong>
              </div>
              <div>
                <span className="audit-inline-label">Edge vs hurdle</span>
                <strong style={{ color: isBullish ? "#66ff99" : "#ff6666" }}>
                  {isBullish ? "+" : ""}{pct.format(clearance)} pts
                </strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="audit-evidence-section">
        <div className="audit-section-heading">
          <h2>Horizon comparison</h2>
          <p>Win rate and signal volume by timeframe</p>
        </div>

        <div className="audit-chart-shell">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={horizonData}>
              <CartesianGrid stroke="rgba(163, 192, 255, 0.10)" vertical={false} />
              <XAxis dataKey="name" stroke="rgba(220, 232, 255, 0.68)" />
              <YAxis stroke="rgba(220, 232, 255, 0.68)" />
              <Tooltip
                contentStyle={{
                  background: "rgba(6, 14, 28, 0.96)",
                  border: "1px solid rgba(138, 248, 255, 0.18)",
                  borderRadius: 8,
                }}
              />
              <Legend />
              <Bar dataKey="winRate" fill="#a8f26d" name="Win Rate %" />
              <Bar dataKey="signals" fill="#66e8ff" name="Active Signals" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <table className="audit-table">
          <thead>
            <tr>
              <th>Horizon</th>
              <th>Observations</th>
              <th>Signals</th>
              <th>Win Rate</th>
              <th>vs Hurdle</th>
            </tr>
          </thead>
          <tbody>
            {horizonData.map((row) => {
              const edge = row.winRate - reportData.metadata.breakEvenHitRate;
              return (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td>{row.observations.toLocaleString()}</td>
                  <td>{row.signals.toLocaleString()}</td>
                  <td>{pct.format(row.winRate)}%</td>
                  <td style={{ color: edge >= 0 ? "#66ff99" : "#ff6666" }}>
                    {edge >= 0 ? "+" : ""}{pct.format(edge)} pts
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="audit-evidence-section">
        <div className="audit-section-heading">
          <h2>Session performance</h2>
          <p>Hit rate by trading session (Asia, London, NY)</p>
        </div>

        <div className="audit-chart-shell">
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={sessionPerformance}>
              <CartesianGrid stroke="rgba(163, 192, 255, 0.10)" vertical={false} />
              <XAxis dataKey="name" stroke="rgba(220, 232, 255, 0.68)" />
              <YAxis stroke="rgba(220, 232, 255, 0.68)" />
              <Tooltip
                contentStyle={{
                  background: "rgba(6, 14, 28, 0.96)",
                  border: "1px solid rgba(138, 248, 255, 0.18)",
                  borderRadius: 8,
                }}
              />
              <Bar dataKey="winRate" fill="#ffa366" name="Win Rate %" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="audit-evidence-section">
        <div className="audit-section-heading">
          <h2>Live validation status</h2>
          <p>Recent 24-hour real-time validations</p>
        </div>

        {loading && <p style={{ color: "#66ffcc" }}>Loading live data...</p>}
        {error && <p style={{ color: "#ff9999" }}>Error: {error}</p>}
        {count === 0 && !loading && <p style={{ color: "#aaa" }}>No validations yet today</p>}

        {validations.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "12px",
            }}
          >
            {validations.slice(0, 6).map((v) => (
              <div
                key={v.id}
                style={{
                  background: "rgba(10, 16, 32, 0.6)",
                  border: `1px solid ${v.outcome === "HIT" ? "rgba(102, 255, 153, 0.3)" : "rgba(255, 102, 102, 0.3)"}`,
                  borderRadius: 8,
                  padding: "12px",
                  fontSize: "13px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <span style={{ color: "#66ffcc" }}>
                    {v.direction} @ {v.entryPrice.toFixed(4)}
                  </span>
                  <span
                    style={{
                      color: v.outcome === "HIT" ? "#66ff99" : "#ff6666",
                      fontWeight: "bold",
                    }}
                  >
                    {v.outcome}
                  </span>
                </div>
                <div style={{ color: "#aaa", fontSize: "12px" }}>
                  Confidence: {v.confidence}% | Range: {v.lowPrice.toFixed(4)}-{v.highPrice.toFixed(4)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
