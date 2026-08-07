// Shared signed-state encoder for browser and Node orbital pipelines.
(function attachOrbitalQuantumState(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.OrbitalQuantumState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildApi() {
  'use strict';

  const SHELL_KEYS = new Set(['s', 'p', 'd', 'f']);
  const NON_SIGNAL_FIELD = /^(ts|timestamp|time|source|id|market_id|contract_ticker)$/i;

  function clamp(value, min = -1, max = 1) {
    return Math.max(min, Math.min(max, value));
  }

  function charge(value) {
    if (!Number.isFinite(value) || Math.abs(value) < 1e-12) return '0';
    return value > 0 ? '+' : '-';
  }

  function spin(projection) {
    return projection >= 0 ? '+1/2' : '-1/2';
  }

  function resolveSubshell(shell, field) {
    const key = String(field || '').toLowerCase();
    if (shell === 's') {
      if (/price|vwap|twap/.test(key)) return 's1';
      if (/volume|liquidity|depth/.test(key)) return 's2';
      return 's3';
    }
    if (shell === 'p') {
      if (/momentum|return|change|accel|velocity/.test(key)) return 'p1';
      if (/price|vwap|twap/.test(key)) return 'p2';
      return 'p3';
    }
    if (shell === 'd') {
      if (/funding/.test(key)) return 'd1';
      if (/open_interest|\boi\b/.test(key)) return 'd2';
      if (/liquidation/.test(key)) return 'd3';
      return 'd4';
    }
    if (/yes|prob|odds/.test(key)) return 'f1';
    if (/sentiment|fear|social/.test(key)) return 'f2';
    if (/volume|open_interest|\boi\b/.test(key)) return 'f3';
    return 'f4';
  }

  function normalizeDirectionalValue(field, value, previousRaw) {
    const key = String(field || '').toLowerCase();
    const current = Number(value);
    if (!Number.isFinite(current) || NON_SIGNAL_FIELD.test(key)) return null;

    if (/yes|probability|prob|odds|confidence/.test(key)) {
      const centered = Math.abs(current) > 1 ? (current - 50) / 50 : (current - 0.5) * 2;
      return { value: clamp(centered), basis: 'neutral-probability' };
    }
    if (/funding/.test(key)) {
      return { value: clamp(current * 1000), basis: 'signed-funding' };
    }
    if (/imbalance|score|signal/.test(key)) {
      return { value: clamp(current), basis: 'signed-level' };
    }
    if (/ratio/.test(key)) {
      return { value: clamp(current - 1), basis: 'unit-ratio' };
    }
    if (/momentum|return|change|delta|spread|premium|accel|velocity/.test(key)) {
      const scaled = Math.abs(current) <= 1 ? current * 100 : current / 100;
      return { value: clamp(scaled), basis: 'signed-rate' };
    }
    if (!Number.isFinite(previousRaw) || previousRaw === 0) return null;

    const relativeChange = (current - previousRaw) / Math.abs(previousRaw);
    const scale = /price|vwap|twap/.test(key) ? 100 : 2;
    return { value: clamp(relativeChange * scale), basis: 'relative-change' };
  }

  function createQuantumStateTracker() {
    const previous = new Map();

    function enrich(shellKey, asset, payload, timestamp = Date.now()) {
      const shell = String(shellKey || '').toLowerCase();
      if (!SHELL_KEYS.has(shell) || !payload || typeof payload !== 'object') return payload;
      if (payload.quantum_state && typeof payload.quantum_state === 'object') return payload;

      const electrons = [];
      for (const [field, rawValue] of Object.entries(payload)) {
        if (field === 'quantum_state') continue;
        const numericValue = Number(rawValue);
        if (!Number.isFinite(numericValue)) continue;

        const stateKey = `${shell}:${String(asset || 'UNKNOWN').toUpperCase()}:${field}`;
        const prior = previous.get(stateKey) || null;
        const directional = normalizeDirectionalValue(field, numericValue, prior?.raw);
        previous.set(stateKey, {
          raw: numericValue,
          directional: directional?.value ?? prior?.directional ?? null,
        });
        if (!directional || Math.abs(directional.value) < 1e-12) continue;

        const spinProjection = prior?.directional == null
          ? Math.sign(directional.value)
          : directional.value - prior.directional;
        electrons.push({
          electron_id: field,
          subshell: resolveSubshell(shell, field),
          subatomic_orbital: `${resolveSubshell(shell, field)}:${field}`,
          charge: charge(directional.value),
          spin: spin(spinProjection),
          spin_projection: spinProjection >= 0 ? 0.5 : -0.5,
          amplitude: Number(Math.abs(directional.value).toFixed(6)),
          signed_value: Number(directional.value.toFixed(6)),
          basis: directional.basis,
        });
      }

      const subshellMap = new Map();
      for (const electron of electrons) {
        const group = subshellMap.get(electron.subshell) || [];
        group.push(electron);
        subshellMap.set(electron.subshell, group);
      }

      const subshells = [...subshellMap.entries()].map(([subshell, members]) => {
        const net = members.reduce((sum, item) => sum + item.signed_value, 0) / members.length;
        const spinProjection = members.reduce((sum, item) => sum + item.spin_projection, 0);
        const subatomicOrbitals = members.map((electron) => ({
          orbital_id: electron.subatomic_orbital,
          ion_charge: electron.charge,
          spin: electron.spin,
          occupancy: 1,
          amplitude: electron.amplitude,
          electrons: [electron],
        }));
        return {
          subshell,
          ion_charge: charge(net),
          spin: spin(spinProjection),
          occupancy: members.length,
          net_charge: Number(clamp(net).toFixed(6)),
          subatomic_orbitals: subatomicOrbitals,
        };
      });

      const signedTotal = electrons.reduce((sum, item) => sum + item.signed_value, 0);
      const absoluteTotal = electrons.reduce((sum, item) => sum + Math.abs(item.signed_value), 0);
      const netCharge = electrons.length ? clamp(signedTotal / electrons.length) : 0;
      const coherence = absoluteTotal > 0 ? Math.abs(signedTotal) / absoluteTotal : 0;

      return {
        ...payload,
        quantum_state: {
          shell,
          asset: String(asset || 'UNKNOWN').toUpperCase(),
          ion_charge: charge(netCharge),
          net_charge: Number(netCharge.toFixed(6)),
          coherence: Number(clamp(coherence, 0, 1).toFixed(6)),
          electron_count: electrons.length,
          subatomic_orbital_count: electrons.length,
          subshells,
          ts: Number(timestamp) || Date.now(),
        },
      };
    }

    function clear() {
      previous.clear();
    }

    return { enrich, clear };
  }

  return {
    charge,
    spin,
    normalizeDirectionalValue,
    resolveSubshell,
    createQuantumStateTracker,
  };
});
