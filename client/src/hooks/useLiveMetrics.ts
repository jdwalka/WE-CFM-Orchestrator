import { useEffect, useState, useCallback } from 'react';

export interface ValidatorStats {
  total: number;
  hitRate: number;
  calibration: Array<{
    confidenceBand: string;
    predictions: number;
    hits: number;
    actualRate: number;
    expectedRate: number;
    error: number;
  }>;
}

export interface Validation {
  id: number;
  sym: string;
  direction: 'UP' | 'DOWN';
  confidence: number;
  entryPrice: number;
  startTime: number;
  outcome: 'HIT' | 'MISS' | 'CANCELLED' | null;
  timeToHit: number | null;
  highPrice: number;
  lowPrice: number;
  logs: string[];
}

interface UseLiveMetricsOptions {
  pollInterval?: number; // ms between IPC queries (default 5000)
  enabled?: boolean;
}

/**
 * Hook to subscribe to real-time Validator15m metrics
 * Queries Electron IPC bridge to pull live validation stats
 */
export function useLiveMetrics(options: UseLiveMetricsOptions = {}) {
  const { pollInterval = 5000, enabled = true } = options;

  const [stats, setStats] = useState<ValidatorStats | null>(null);
  const [validations, setValidations] = useState<Validation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  const fetchMetrics = useCallback(async () => {
    if (!window.auditAPI?.validator) {
      setError('Audit API not available (running outside Electron?)');
      setLoading(false);
      return;
    }

    try {
      // Fetch stats and validations in parallel
      const [statsResult, validationsResult] = await Promise.all([
        window.auditAPI.validator.getStats(),
        window.auditAPI.validator.getAll(),
      ]);

      if (statsResult.success) {
        setStats(statsResult.data || null);
      } else {
        setError(statsResult.error || 'Failed to fetch stats');
      }

      if (validationsResult.success) {
        setValidations(validationsResult.data || []);
      }

      setError(null);
      setLastUpdate(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    // Fetch immediately
    fetchMetrics();

    // Set up polling
    const timer = setInterval(fetchMetrics, pollInterval);
    return () => clearInterval(timer);
  }, [enabled, pollInterval, fetchMetrics]);

  const recentValidations = validations.filter(
    (v) => v.outcome !== null && Date.now() - v.startTime < 24 * 60 * 60 * 1000 // Last 24h
  );

  const completedCount = recentValidations.length;
  const hitCount = recentValidations.filter((v) => v.outcome === 'HIT').length;
  const hitRate = completedCount > 0 ? (hitCount / completedCount) * 100 : 0;

  return {
    // Current stats
    stats,
    validations: recentValidations,
    
    // Derived metrics
    hitRate,
    completedCount,
    hitCount,

    // Metadata
    loading,
    error,
    lastUpdate,
    
    // Manual refresh
    refetch: fetchMetrics,
  };
}

/**
 * Hook to get metrics for a specific coin
 */
export function useCoinMetrics(coin: string, options: UseLiveMetricsOptions = {}) {
  const [coinValidations, setCoinValidations] = useState<Validation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCoinMetrics = useCallback(async () => {
    if (!window.auditAPI?.validator) {
      setError('Audit API not available');
      setLoading(false);
      return;
    }

    try {
      const result = await window.auditAPI.validator.getCoin(coin);
      if (result.success) {
        setCoinValidations(result.data || []);
        setError(null);
      } else {
        setError((result as any).error || 'Failed to fetch coin metrics');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [coin]);

  useEffect(() => {
    if (options.enabled === false) return;
    fetchCoinMetrics();

    const timer = setInterval(fetchCoinMetrics, options.pollInterval ?? 5000);
    return () => clearInterval(timer);
  }, [coin, options, fetchCoinMetrics]);

  const recentValidations = coinValidations.filter(
    (v) => v.outcome !== null && Date.now() - v.startTime < 24 * 60 * 60 * 1000
  );

  const hitRate =
    recentValidations.length > 0
      ? (recentValidations.filter((v) => v.outcome === 'HIT').length / recentValidations.length) * 100
      : 0;

  return {
    validations: recentValidations,
    hitRate,
    count: recentValidations.length,
    loading,
    error,
    refetch: fetchCoinMetrics,
  };
}

declare global {
  interface Window {
    auditAPI?: {
      validator: {
        getStats: () => Promise<{ success: boolean; data?: ValidatorStats; error?: string }>;
        getAll: () => Promise<{ success: boolean; data?: Validation[]; error?: string }>;
        getCoin: (sym: string) => Promise<{ success: boolean; data?: Validation[]; error?: string }>;
      };
    };
  }
}
