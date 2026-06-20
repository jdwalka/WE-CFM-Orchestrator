/**
 * Vanilla Monte Carlo Tree Search for discrete trading actions (WAIT / UP / DOWN).
 */
(function (root, factory) {
  const MCTS = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MCTS;
  } else {
    root.MCTS = MCTS;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class MCTSNode {
    constructor(action = null, parent = null) {
      this.action = action;
      this.parent = parent;
      this.children = new Map();
      this.visits = 0;
      this.value = 0;
      this.untried = [];
    }

    uct(child, c = 1.41) {
      if (!child.visits) return Infinity;
      const exploit = child.value / child.visits;
      const explore = c * Math.sqrt(Math.log(this.visits + 1) / child.visits);
      return exploit + explore;
    }

    bestChild(c = 1.41) {
      let best = null;
      let bestScore = -Infinity;
      for (const child of this.children.values()) {
        const s = this.uct(child, c);
        if (s > bestScore) {
          bestScore = s;
          best = child;
        }
      }
      return best;
    }
  }

  /**
   * @param {object} opts
   * @param {number[]} opts.state - encoded feature vector
   * @param {function(number[]): number[]} opts.qValues - Q(s) for each action
   * @param {number} opts.iterations
   * @param {number} opts.rapidBoost - extra iterations weight for fast markets
   */
  function search(opts) {
    const {
      state,
      qValues = () => [0, 0, 0],
      iterations = 120,
      rapidBoost = 0,
      actionSize = 3,
      exploration = 1.41,
      bookCtx = null,
      adversarialWeight = 0.18,
    } = opts;

    const totalIters = Math.max(40, Math.round(iterations * (1 + rapidBoost * 0.8)));
    const root = new MCTSNode();
    root.untried = Array.from({ length: actionSize }, (_, i) => i);
    const baseQ = qValues(state);
    const imb = Number(bookCtx?.imbalance ?? 0);
    const toxicity = Number(bookCtx?.toxicity ?? 0);
    const wallPressure = Number(bookCtx?.wallPressure ?? 0);

    function adversarialPenalty(action) {
      if (!bookCtx) return 0;
      const upAction = action === 1;
      const downAction = action === 2;
      if (!upAction && !downAction) return 0;
      const bookFavorsUp = imb > 0.08 || wallPressure > 0.12;
      const bookFavorsDown = imb < -0.08 || wallPressure < -0.12;
      let penalty = 0;
      if (upAction && bookFavorsDown) penalty += Math.abs(imb) * adversarialWeight + toxicity * 0.08;
      if (downAction && bookFavorsUp) penalty += Math.abs(imb) * adversarialWeight + toxicity * 0.08;
      if (upAction && bookFavorsUp) penalty -= Math.abs(imb) * adversarialWeight * 0.35;
      if (downAction && bookFavorsDown) penalty -= Math.abs(imb) * adversarialWeight * 0.35;
      return penalty;
    }

    function rollout(action) {
      const q = baseQ[action] ?? 0;
      const noise = (Math.random() - 0.5) * 0.15;
      const adv = adversarialPenalty(action);
      return clamp(q + noise - adv, -1.5, 1.5);
    }

    for (let i = 0; i < totalIters; i++) {
      let node = root;
      let depth = 0;

      while (node.untried.length === 0 && node.children.size > 0 && depth < 4) {
        node = node.bestChild(exploration);
        depth++;
      }

      if (node.untried.length > 0) {
        const idx = Math.floor(Math.random() * node.untried.length);
        const action = node.untried.splice(idx, 1)[0];
        const child = new MCTSNode(action, node);
        node.children.set(action, child);
        node = child;
      }

      const reward = rollout(node.action ?? 0);

      while (node) {
        node.visits++;
        node.value += reward;
        node = node.parent;
      }
    }

    const stats = Array.from({ length: actionSize }, (_, a) => ({
      action: a,
      visits: 0,
      meanValue: 0,
    }));

    for (const [action, child] of root.children) {
      stats[action].visits = child.visits;
      stats[action].meanValue = child.visits ? child.value / child.visits : 0;
    }

    let bestAction = 0;
    let bestVisits = -1;
    for (const row of stats) {
      if (row.visits > bestVisits) {
        bestVisits = row.visits;
        bestAction = row.action;
      }
    }

    const totalVisits = stats.reduce((s, r) => s + r.visits, 0) || 1;
    const policy = stats.map((r) => r.visits / totalVisits);
    const confidence = clamp(bestVisits / totalIters, 0, 1);

    return {
      action: bestAction,
      policy,
      stats,
      iterations: totalIters,
      confidence,
      qPrior: baseQ.slice(),
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  return { search, MCTSNode };
}));
