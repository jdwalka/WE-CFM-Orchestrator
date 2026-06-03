  function getSessionInfo() {
    const now = new Date();
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const t = utcH + utcM / 60;

    // Session windows (UTC)
    const sessions = {
      asia_open: { start: 0, end: 2, label: 'Asia Open', scalp: true, desc: 'Tokyo/Seoul open — high volatility spike, scalp-friendly' },
      asia_mid: { start: 2, end: 6, label: 'Asia Session', scalp: false, desc: 'Mid-session Asia — liquidity thinning' },
      london_open: { start: 7, end: 9, label: 'London Open', scalp: true, desc: 'London/EU open — biggest volume surge, prime scalp window' },
      london_mid: { start: 9, end: 12, label: 'London Session', scalp: false, desc: 'EU active — steady directional flow' },
      ny_open: { start: 13, end: 15.5, label: 'NY Open', scalp: true, desc: 'NYSE open overlap — maximum liquidity, sharpest moves' },
      ny_mid: { start: 15.5, end: 18, label: 'NY Session', scalp: false, desc: 'US afternoon — momentum continuation or reversal' },
      ny_close: { start: 18, end: 21, label: 'NY Close', scalp: true, desc: 'NYSE close — position squaring, mean-reversion scalps' },
      dead_zone: { start: 21, end: 24, label: 'Dead Zone', scalp: false, desc: 'Low liquidity — avoid scalping, wide spreads' },
    };

    let current = sessions.dead_zone;
    for (const [, s] of Object.entries(sessions)) {
      if (t >= s.start && t < s.end) { current = s; break; }
    }

    // Next scalp window
    const scalpWindows = Object.values(sessions).filter(s => s.scalp);
    let nextScalp = null;
    for (const sw of scalpWindows) {
      if (sw.start > t) { nextScalp = sw; break; }
    }
    if (!nextScalp) nextScalp = scalpWindows[0]; // wrap to next day

    const minsToNext = nextScalp.start > t
      ? Math.round((nextScalp.start - t) * 60)
      : Math.round((24 - t + nextScalp.start) * 60);

    return { current, nextScalp, minsToNext, utcHour: utcH, localHour: now.getHours() };
  }
