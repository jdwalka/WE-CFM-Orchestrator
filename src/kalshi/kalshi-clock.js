/**
 * Shared Kalshi clock-skew calibration.
 *
 * Kalshi rejects requests whose KALSHI-ACCESS-TIMESTAMP drifts too far from
 * its own clock (401 "header_timestamp_expired"). Every place that signs a
 * Kalshi request (REST client, WSS handshake) needs the same measured
 * offset applied to Date.now(). This module is the single source of truth
 * for that offset so it only needs to be measured once per process.
 */
'use strict';

const https = require('https');

let offsetMs = 0;
let calibrated = false;
let calibrationPromise = null;

function fetchServerTimeMs(baseUrl) {
  return new Promise((resolve) => {
    try {
      const target = new URL(`${baseUrl}/exchange/status`);
      const req = https.request(
        { hostname: target.hostname, path: target.pathname, method: 'GET', timeout: 5000 },
        (res) => {
          res.resume();
          const dateHeader = res.headers['date'];
          resolve(dateHeader ? Date.parse(dateHeader) : null);
        }
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

function calibrateKalshiClock(baseUrl) {
  if (calibrationPromise) return calibrationPromise;
  calibrationPromise = (async () => {
    const sentAt = Date.now();
    const serverMs = await fetchServerTimeMs(baseUrl);
    if (serverMs) {
      const rttMs = Date.now() - sentAt;
      offsetMs = serverMs + Math.round(rttMs / 2) - Date.now();
      calibrated = true;
      console.log(`[Kalshi Clock] Offset calibrated: ${offsetMs}ms (local vs Kalshi server)`);
    }
    return offsetMs;
  })();
  return calibrationPromise;
}

function getKalshiClockOffsetMs() {
  return offsetMs;
}

function isKalshiClockCalibrated() {
  return calibrated;
}

function resetKalshiClockCalibration() {
  calibrationPromise = null;
}

module.exports = {
  calibrateKalshiClock,
  getKalshiClockOffsetMs,
  isKalshiClockCalibrated,
  resetKalshiClockCalibration,
};
