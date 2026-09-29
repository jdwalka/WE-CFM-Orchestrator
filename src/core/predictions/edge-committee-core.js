// Edge Committee core (browser) — shared vote logic for live + backtest
(function () {
  function committeeVote(signalVector, committee, opts) {
    const signalDeadband = opts?.signalDeadband ?? 0.15;
    const minAgree = opts?.minAgree ?? 3;
    const minStrength = opts?.minStrength ?? 0.22;

    if (!committee || !committee.length) return { action: 'abstain', reason: 'empty_committee' };

    const votes = [];
    for (const member of committee) {
      const sig = signalVector[member.key] ?? 0;
      if (Math.abs(sig) <= signalDeadband) continue;
      votes.push({ key: member.key, dir: sig > 0 ? 1 : -1, weight: member.winRate || 0.55 });
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

  window.EdgeCommitteeCore = { committeeVote };
})();
