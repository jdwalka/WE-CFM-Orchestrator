'use strict';

/**
 * Edge Committee — selective indicator voting engine.
 *
 * Instead of blending 25+ indicators into one noisy composite, only trade when
 * a walk-forward-selected committee of top performers agrees.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function gradeIndicators(observations, signalDeadband = 0.15) {
  const stats = {};
  for (const obs of observations) {
    const target = obs.actualDirection === 'UP' ? 1 : -1;
    for (const [key, val] of Object.entries(obs.signalVector || {})) {
      if (typeof val !== 'number') continue;
      if (!stats[key]) stats[key] = { hits: 0, total: 0 };
      if (Math.abs(val) <= signalDeadband) continue;
      stats[key].total++;
      if (Math.sign(val) === target) stats[key].hits++;
    }
  }
  return Object.entries(stats).map(([key, s]) => ({
    key,
    winRate: s.total > 0 ? s.hits / s.total : 0.5,
    total: s.total,
  }));
}

function selectCommittee(graded, opts = {}) {
  const {
    minWinRate = 0.54,
    minSamples = 40,
    topK = 8,
  } = opts;

  return graded
    .filter((g) => g.total >= minSamples && g.winRate >= minWinRate)
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, topK)
    .map((g) => ({ key: g.key, winRate: g.winRate, samples: g.total }));
}

function committeeVote(signalVector, committee, opts = {}) {
  const {
    signalDeadband = 0.15,
    minAgree = 3,
    minStrength = 0.22,
  } = opts;

  if (!committee.length) return { action: 'abstain', reason: 'empty_committee' };

  const votes = [];
  for (const member of committee) {
    const sig = signalVector[member.key] ?? 0;
    if (Math.abs(sig) <= signalDeadband) continue;
    votes.push({
      key: member.key,
      dir: sig > 0 ? 1 : -1,
      weight: member.winRate,
    });
  }

  if (votes.length < minAgree) {
    return { action: 'abstain', reason: 'insufficient_votes', votes: votes.length };
  }

  let bullW = 0;
  let bearW = 0;
  for (const v of votes) {
    if (v.dir > 0) bullW += v.weight;
    else bearW += v.weight;
  }

  const direction = bullW >= bearW ? 'UP' : 'DOWN';
  const agreeCount = votes.filter((v) => (direction === 'UP' ? v.dir > 0 : v.dir < 0)).length;
  if (agreeCount < minAgree) {
    return { action: 'abstain', reason: 'split_committee', agreeCount, votes: votes.length };
  }

  const strength = Math.abs(bullW - bearW) / (bullW + bearW + 1e-9);
  if (strength < minStrength) {
    return { action: 'abstain', reason: 'weak_strength', strength };
  }

  return {
    action: 'trade',
    direction,
    strength,
    agreeCount,
    voteCount: votes.length,
    committeeSize: committee.length,
  };
}

function evaluateConfig(observations, committee, config) {
  let trades = 0;
  let wins = 0;
  let abstains = 0;

  for (const obs of observations) {
    const vote = committeeVote(obs.signalVector, committee, config);
    if (vote.action !== 'trade') {
      abstains++;
      continue;
    }
    trades++;
    if (vote.direction === obs.actualDirection) wins++;
  }

  return {
    trades,
    wins,
    abstains,
    coverage: observations.length ? trades / observations.length : 0,
    winRate: trades ? wins / trades : 0,
  };
}

function gridSearchConfig(trainObs, committee, grid = {}) {
  const minWinRates = grid.minWinRates || [0.52, 0.54, 0.56];
  const minAgrees = grid.minAgrees || [2, 3, 4];
  const minStrengths = grid.minStrengths || [0.18, 0.22, 0.28];
  const topKs = grid.topKs || [6, 8];

  let best = null;
  const graded = gradeIndicators(trainObs);

  for (const topK of topKs) {
    const baseCommittee = selectCommittee(graded, {
      minWinRate: 0.52,
      minSamples: 30,
      topK,
    });
    if (!baseCommittee.length) continue;

    for (const minAgree of minAgrees) {
      for (const minStrength of minStrengths) {
        const stats = evaluateConfig(trainObs, baseCommittee, { minAgree, minStrength });
        if (stats.trades < 12) continue;
        const score = stats.winRate * 0.75 + stats.coverage * 0.25;
        if (!best || score > best.score) {
          best = {
            score,
            topK,
            minAgree,
            minStrength,
            committee: baseCommittee,
            train: stats,
          };
        }
      }
    }
  }

  for (const minWinRate of minWinRates) {
    const tunedCommittee = selectCommittee(graded, { minWinRate, minSamples: 40, topK: best?.topK || 8 });
    if (!tunedCommittee.length) continue;
    const stats = evaluateConfig(trainObs, tunedCommittee, {
      minAgree: best?.minAgree || 3,
      minStrength: best?.minStrength || 0.22,
    });
    if (stats.trades < 12) continue;
    const score = stats.winRate * 0.75 + stats.coverage * 0.25;
    if (!best || score > best.score) {
      best = {
        score,
        topK: tunedCommittee.length,
        minWinRate,
        minAgree: best?.minAgree || 3,
        minStrength: best?.minStrength || 0.22,
        committee: tunedCommittee,
        train: stats,
      };
    }
  }

  return best;
}

function walkForwardValidate(observations, opts = {}) {
  const trainRatio = opts.trainRatio ?? 0.65;
  const split = Math.max(20, Math.floor(observations.length * trainRatio));
  const train = observations.slice(0, split);
  const test = observations.slice(split);
  if (train.length < 30 || test.length < 15) return null;

  const best = gridSearchConfig(train, [], opts.grid);
  if (!best) return null;

  const graded = gradeIndicators(train);
  const committee = selectCommittee(graded, {
    minWinRate: best.minWinRate || 0.54,
    minSamples: 40,
    topK: best.topK || 8,
  });

  const testStats = evaluateConfig(test, committee, {
    minAgree: best.minAgree,
    minStrength: best.minStrength,
  });

  return {
    committee,
    config: {
      minWinRate: best.minWinRate || 0.54,
      topK: best.topK || committee.length,
      minAgree: best.minAgree,
      minStrength: best.minStrength,
    },
    train: best.train,
    test: testStats,
  };
}

function buildCoinConfig(wfResult) {
  if (!wfResult || !wfResult.committee.length) return null;
  const testWinRate = wfResult.test.winRate;
  const enabled = testWinRate >= 0.52 && wfResult.test.trades >= 30;
  return {
    enabled,
    committee: wfResult.committee.map((m) => m.key),
    memberWinRates: Object.fromEntries(wfResult.committee.map((m) => [m.key, +m.winRate.toFixed(3)])),
    minAgree: wfResult.config.minAgree,
    minStrength: wfResult.config.minStrength,
    minWinRate: wfResult.config.minWinRate,
    topK: wfResult.config.topK,
    backtest: {
      trainWinRate: +(wfResult.train.winRate * 100).toFixed(1),
      trainCoverage: +(wfResult.train.coverage * 100).toFixed(1),
      testWinRate: +(wfResult.test.winRate * 100).toFixed(1),
      testCoverage: +(wfResult.test.coverage * 100).toFixed(1),
      testTrades: wfResult.test.trades,
    },
  };
}

module.exports = {
  gradeIndicators,
  selectCommittee,
  committeeVote,
  evaluateConfig,
  gridSearchConfig,
  walkForwardValidate,
  buildCoinConfig,
  clamp,
};
