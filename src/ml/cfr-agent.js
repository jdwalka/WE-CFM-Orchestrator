/**
 * Counterfactual Regret Minimization (CFR) for WAIT / UP / DOWN decisions.
 * Online regret matching over discretized information sets.
 */
(function (root, factory) {
  const CFRAgent = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CFRAgent };
  } else {
    root.CFRAgent = CFRAgent;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function bucket(v, bins = 5) {
    return clamp(Math.floor((clamp(v, -1, 1) + 1) * 0.5 * bins), 0, bins - 1);
  }

  class CFRAgent {
    constructor(actionSize = 3, options = {}) {
      this.actionSize = actionSize;
      this.regrets = new Map();
      this.strategySum = new Map();
      this.updates = 0;
      this.bins = options.bins ?? 5;
    }

    /** Discretize continuous state (+ optional order-book adversarial ctx) into an info set key. */
    infoSetKey(state, bookCtx = null) {
      if (!state?.length) return 'default';
      const parts = [
        bucket(state[0] ?? 0, this.bins),
        bucket(state[6] ?? 0, this.bins),
        bucket(state[5] ?? 0, this.bins),
        bucket(state[23] ?? 0, 3),
        bucket(state[28] ?? 0, 3),
        bucket(state[33] ?? 0, 3),
        bucket(state[38] ?? 0, 3),
      ];
      if (bookCtx) {
        parts.push(
          bucket(bookCtx.imbalance ?? 0, 4),
          bucket(clamp((bookCtx.spreadPct ?? 0) / 0.15, -1, 1), 3),
          bucket(bookCtx.toxicity ?? 0, 3),
          bucket(bookCtx.wallPressure ?? 0, 3),
        );
      }
      return parts.join('.');
    }

    _ensure(key) {
      if (!this.regrets.has(key)) {
        this.regrets.set(key, Array(this.actionSize).fill(0));
        this.strategySum.set(key, Array(this.actionSize).fill(0));
      }
    }

    /** Regret-matching strategy σ(a) = R+(a) / Σ R+ */
    getStrategy(key) {
      this._ensure(key);
      const regrets = this.regrets.get(key);
      const positive = regrets.map((r) => Math.max(0, r));
      const sum = positive.reduce((s, v) => s + v, 0);
      if (sum <= 1e-9) return Array(this.actionSize).fill(1 / this.actionSize);
      return positive.map((r) => r / sum);
    }

    getAverageStrategy(key) {
      this._ensure(key);
      const sums = this.strategySum.get(key);
      const total = sums.reduce((s, v) => s + v, 0);
      if (total <= 1e-9) return this.getStrategy(key);
      return sums.map((v) => v / total);
    }

    chooseAction(key, qValues = null) {
      const strategy = this.getStrategy(key);
      if (qValues && qValues.length === this.actionSize) {
        const blended = strategy.map((p, i) => p * 0.65 + (softmax(qValues)[i] ?? 0) * 0.35);
        const norm = blended.reduce((s, v) => s + v, 0) || 1;
        return sample(blended.map((v) => v / norm));
      }
      return sample(strategy);
    }

    /**
     * CFR outcome update using counterfactual values from Q-network or payoff table.
     * @param {string} key - information set
     * @param {number} actionTaken
     * @param {number[]} actionValues - estimated value of each action (counterfactual)
     */
    updateRegrets(key, actionTaken, actionValues) {
      this._ensure(key);
      const regrets = this.regrets.get(key);
      const strategy = this.getStrategy(key);
      const stratSum = this.strategySum.get(key);

      let nodeValue = 0;
      for (let a = 0; a < this.actionSize; a++) {
        nodeValue += strategy[a] * (actionValues[a] ?? 0);
      }

      for (let a = 0; a < this.actionSize; a++) {
        const cfRegret = (actionValues[a] ?? 0) - nodeValue;
        regrets[a] += cfRegret;
        stratSum[a] += strategy[a];
      }

      this.updates++;
      return { nodeValue, strategy: strategy.slice() };
    }

    /** Simpler online update from realized reward. */
    updateFromOutcome(key, actionTaken, reward, qValues = null) {
      const values = qValues?.length === this.actionSize
        ? qValues.slice()
        : Array(this.actionSize).fill(0);
      values[actionTaken] = reward;
      if (!qValues) {
        for (let a = 0; a < this.actionSize; a++) {
          if (a !== actionTaken) values[a] = -Math.abs(reward) * 0.35;
        }
      }
      return this.updateRegrets(key, actionTaken, values);
    }

    toJSON() {
      return {
        actionSize: this.actionSize,
        bins: this.bins,
        updates: this.updates,
        regrets: Object.fromEntries(this.regrets),
        strategySum: Object.fromEntries(this.strategySum),
      };
    }

    static fromJSON(obj) {
      const agent = new CFRAgent(obj.actionSize ?? 3, { bins: obj.bins ?? 5 });
      agent.updates = obj.updates ?? 0;
      agent.regrets = new Map(Object.entries(obj.regrets || {}));
      agent.strategySum = new Map(Object.entries(obj.strategySum || {}));
      return agent;
    }
  }

  function softmax(arr) {
    const max = Math.max(...arr);
    const exps = arr.map((v) => Math.exp(v - max));
    const sum = exps.reduce((s, v) => s + v, 0) || 1;
    return exps.map((e) => e / sum);
  }

  function sample(probs) {
    const r = Math.random();
    let c = 0;
    for (let i = 0; i < probs.length; i++) {
      c += probs[i];
      if (r <= c) return i;
    }
    return probs.length - 1;
  }

  return CFRAgent;
}));
