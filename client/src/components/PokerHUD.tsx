import { useEffect, useState } from "react";

declare global {
  interface Window {
    electron?: {
      poker?: {
        onAnalysisUpdate: (cb: (data: { rawHand?: string; analysis?: string }) => void) => () => void;
        onProcessingStart: (cb: (data: Record<string, unknown>) => void) => () => void;
      };
    };
  }
}

export default function PokerHUD() {
  const [analysis, setAnalysis] = useState("Waiting for next hand...");
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    const offUpdate = window.electron?.poker?.onAnalysisUpdate((data) => {
      setAnalysis(data.analysis || "No analysis returned.");
      setIsAnalyzing(false);
    });
    const offStart = window.electron?.poker?.onProcessingStart(() => setIsAnalyzing(true));
    return () => {
      if (typeof offUpdate === "function") offUpdate();
      if (typeof offStart === "function") offStart();
    };
  }, []);

  return (
    <div
      style={{
        backgroundColor: "rgba(18, 18, 18, 0.95)",
        color: "#E0E0E0",
        padding: "16px",
        borderRadius: "8px",
        border: "1px solid #333",
        width: "350px",
        fontFamily: "monospace",
        fontSize: "13px",
        pointerEvents: "none",
      }}
    >
      <h4 style={{ color: "#00E676", marginTop: 0, marginBottom: "12px" }}>
        {isAnalyzing ? "Analyzing Hand..." : "LeakSnipe Analysis"}
      </h4>
      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.4 }}>{analysis}</div>
    </div>
  );
}
