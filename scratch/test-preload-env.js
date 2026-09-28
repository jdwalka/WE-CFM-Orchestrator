const fs = require('fs');
const path = require('path');

function stripEnvValue(value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  const quote = v[0];
  if ((quote === '"' || quote === "'" || quote === '`') && v[v.length - 1] === quote) {
    v = v.slice(1, -1);
  } else {
    v = v.replace(/\s+#.*$/, '').trim();
  }
  return v.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readRawEnvValue(raw, name) {
  const re = new RegExp(`(?:^|\\r?\\n)\\s*${escapeRegExp(name)}\\s*=\\s*([^\\r\\n]*)`, 'i');
  const match = raw.match(re);
  return match ? stripEnvValue(match[1]) : '';
}

function envFileCandidates() {
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(path.dirname(process.execPath || __filename), '.env'),
    appData && path.join(appData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', '.env'),
    appData && path.join(appData, 'we-cfm-orchestrator', '.env'),
    appData && path.join(appData, 'WECRYPTO', '.env'),
    localAppData && path.join(localAppData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', '.env'),
    localAppData && path.join(localAppData, 'we-cfm-orchestrator', '.env'),
    localAppData && path.join(localAppData, 'WECRYPTO', '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(process.resourcesPath || '', '..', '.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    try {
      const normalized = path.resolve(candidate);
      const key = normalized.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(normalized);
    } catch (_) {
      return false;
    }
  });
}

function readEnvValue(names) {
  for (const name of names) {
    const value = process.env?.[name];
    if (value != null && String(value).trim()) return stripEnvValue(value);
  }
  for (const envPath of envFileCandidates()) {
    try {
      const raw = fs.readFileSync(envPath, 'utf8');
      for (const name of names) {
        const value = readRawEnvValue(raw, name);
        if (value) return value;
      }
    } catch (_) {
      // keep looking
    }
  }
  return '';
}

function decodeJsonStringFragment(value) {
  try {
    return JSON.parse(`"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch (_) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  }
}

function secretDirCandidates() {
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(path.dirname(process.execPath || __filename), 'secrets'),
    path.join(__dirname, '..', 'secrets'),
    path.join(process.resourcesPath || '', '..', 'secrets'),
    path.join(process.cwd(), 'secrets'),
    localAppData && path.join(localAppData, 'WE-CRYPTO', 'user-data', 'secrets'),
    appData && path.join(appData, 'WE-CRYPTO-Kalshi-15m-v2.15.5', 'secrets'),
    'G:\\WECRYPTO\\secrets',
    'F:\\WECRYPTO\\secrets',
    'E:\\WECRYPTO\\secrets',
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((candidate) => {
    try {
      const normalized = path.resolve(candidate);
      const key = normalized.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return fs.existsSync(normalized);
    } catch (_) {
      return false;
    }
  });
}

function readSecretScalar(raw, keyPattern = /coingecko|coin.?gecko|gecko|^cg_|^x[-_]?cg/i) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) return '';

  for (const line of lines) {
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (kv && keyPattern.test(kv[1])) {
      return stripEnvValue(kv[2]);
    }
  }

  const jsonKey = String(raw).match(/"(?:COINGECKO_API_KEY|COINGECKO_PRO_API_KEY|COINGECKO_DEMO_API_KEY|CMC_PRO_API_KEY|COINMARKETCAP_API_KEY|CMC_API_KEY|apiKey|key)"\s*:\s*"((?:\\.|[^"])*)"/i);
  if (jsonKey) return stripEnvValue(decodeJsonStringFragment(jsonKey[1]));

  return stripEnvValue(lines.reduce((longest, line) => line.length > longest.length ? line : longest, ''));
}

function readSecretFileValueFor(fileNames, keyPattern) {
  for (const dir of secretDirCandidates()) {
    for (const fileName of fileNames) {
      const p = path.join(dir, fileName);
      try {
        if (!fs.existsSync(p)) continue;
        const value = readSecretScalar(fs.readFileSync(p, 'utf8'), keyPattern);
        if (value) return { value, path: p };
      } catch (_) {
        // keep looking
      }
    }
  }
  return { value: '', path: '' };
}

function readCMCSecret() {
  return readSecretFileValueFor([
    'CoinMarketCapAPIKEY.txt',
    'CMC_API.txt',
    'CMC_API_KEY.txt',
    'COINMARKETCAP_API_KEY.txt'
  ], /coinmarketcap|coin.?market.?cap|^cmc/i);
}

function readPublicEnv() {
  const cmcSecret = readCMCSecret();
  console.log('Parsed cmcSecret:', cmcSecret);
  const cmcKey = readEnvValue(['CMC_PRO_API_KEY', 'COINMARKETCAP_API_KEY', 'CMC_API_KEY']) || cmcSecret.value;
  console.log('cmcKey:', cmcKey);
}

readPublicEnv();
