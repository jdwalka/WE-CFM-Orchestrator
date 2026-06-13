'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CREDENTIAL_FILE_NAME = 'KALSHI-API-KEY.txt';
const CREDENTIAL_FILE_NAMES = [
  CREDENTIAL_FILE_NAME,
  'KALSHI_API_SHA256_WeCrypto.txt',
  'KALSHI_WEBSOCKETS and WORKER READ_ONLY.txt',
  'KALSHI_SHA_API.txt',
];

function parseCredentialFile(content) {
  const rawLines = String(content || '').split(/\r?\n/);
  const keys = [];
  let currentKeyId = null;
  let currentKeyPemLines = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) continue;

    if (line.includes('-----BEGIN')) {
      currentKeyPemLines.push(rawLines[i]);
    } else if (currentKeyPemLines.length > 0) {
      currentKeyPemLines.push(rawLines[i]);
      if (line.includes('-----END')) {
        if (currentKeyId) {
          keys.push({
            apiKeyId: currentKeyId,
            privateKeyPem: currentKeyPemLines.join('\n').trim()
          });
        }
        currentKeyId = null;
        currentKeyPemLines = [];
      }
    } else if (line.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      currentKeyId = line;
    }
  }

  if (keys.length > 0) {
    return keys[keys.length - 1];
  }

  // Fallback to original simple parsing if no structured keys found
  const nonEmpty = rawLines.map(line => line.trim()).filter(Boolean);
  const apiKeyId = nonEmpty[0] || null;
  const beginIdx = rawLines.findIndex(line => line.includes('-----BEGIN'));
  const endIdx = rawLines.findIndex(line => line.includes('-----END'));
  const privateKeyPem = beginIdx !== -1 && endIdx !== -1 && endIdx >= beginIdx
    ? rawLines.slice(beginIdx, endIdx + 1).join('\n').trim()
    : nonEmpty.slice(1).join('\n').trim();

  return { apiKeyId, privateKeyPem };
}

function addCandidate(candidates, candidate) {
  if (!candidate) return;
  const normalized = path.normalize(candidate);
  if (!candidates.includes(normalized)) candidates.push(normalized);
}

function addSecretCandidate(candidates, baseDir) {
  if (!baseDir) return;
  for (const fileName of CREDENTIAL_FILE_NAMES) {
    addCandidate(candidates, path.join(baseDir, 'secrets', fileName));
  }
}

function addDirectCandidate(candidates, baseDir) {
  if (!baseDir) return;
  addCandidate(candidates, path.join(baseDir, CREDENTIAL_FILE_NAME));
}

function resolveRelativeCredentialPath(value, baseDirs) {
  if (!value) return [];
  if (path.isAbsolute(value)) return [value];
  return baseDirs.filter(Boolean).map(baseDir => path.resolve(baseDir, value));
}

function getAppPath(app, name) {
  try {
    return app && typeof app.getPath === 'function' ? app.getPath(name) : null;
  } catch (_) {
    return null;
  }
}

function buildCredentialCandidates(options = {}) {
  const app = options.app || null;
  const runtimeBaseDir = options.runtimeBaseDir || null;
  const exeDir = process.execPath ? path.dirname(process.execPath) : null;
  const resourcesDir = process.resourcesPath || null;
  const appRoot = path.resolve(__dirname, '..');
  const cwd = process.cwd();
  const candidates = [];
  const baseDirs = [
    runtimeBaseDir,
    exeDir,
    resourcesDir,
    resourcesDir ? path.dirname(resourcesDir) : null,
    appRoot,
    cwd,
    getAppPath(app, 'userData'),
    getAppPath(app, 'documents'),
    getAppPath(app, 'home'),
    process.env.WECRYP_HOME,
    process.env.WECRYPTO_HOME,
  ];

  for (const envValue of [process.env.KALSHI_API_KEY_FILE, process.env.WECRYPTO_KALSHI_API_KEY_FILE]) {
    for (const candidate of resolveRelativeCredentialPath(envValue, baseDirs)) {
      addCandidate(candidates, candidate);
    }
  }

  for (const baseDir of baseDirs) {
    addSecretCandidate(candidates, baseDir);
    addDirectCandidate(candidates, baseDir);
    addSecretCandidate(candidates, baseDir ? path.join(baseDir, 'WECRYPTO') : null);
    addDirectCandidate(candidates, baseDir ? path.join(baseDir, 'WECRYPTO') : null);
  }

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const driveRoot = `${String.fromCharCode(code)}:\\`;
      addSecretCandidate(candidates, driveRoot);
      addDirectCandidate(candidates, driveRoot);
      addSecretCandidate(candidates, path.join(driveRoot, 'My Drive'));
      addDirectCandidate(candidates, path.join(driveRoot, 'My Drive'));
      addSecretCandidate(candidates, path.join(driveRoot, 'My Drive', 'WECRYPTO'));
      addDirectCandidate(candidates, path.join(driveRoot, 'My Drive', 'WECRYPTO'));
      addSecretCandidate(candidates, path.join(driveRoot, 'WECRYPTO'));
      addDirectCandidate(candidates, path.join(driveRoot, 'WECRYPTO'));
      addSecretCandidate(candidates, path.join(driveRoot, 'WECRYPTO', 'desktop-build'));
      addDirectCandidate(candidates, path.join(driveRoot, 'WECRYPTO', 'desktop-build'));
    }
  }

  return candidates;
}

function resolveKalshiCredentialFile(options = {}) {
  const candidates = buildCredentialCandidates(options);
  const found = candidates.find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch (_) {
      return false;
    }
  });

  return {
    path: found || candidates[0] || path.join(process.cwd(), 'secrets', CREDENTIAL_FILE_NAME),
    found: !!found,
    searched: candidates,
  };
}

function loadKalshiCredentials(options = {}) {
  const resolved = resolveKalshiCredentialFile(options);
  if (!resolved.found) {
    return {
      success: false,
      error: `${CREDENTIAL_FILE_NAME} not found`,
      searched: resolved.searched,
    };
  }

  try {
    const parsed = parseCredentialFile(fs.readFileSync(resolved.path, 'utf8'));
    if (!parsed.apiKeyId || !parsed.privateKeyPem || !parsed.privateKeyPem.includes('-----BEGIN')) {
      return {
        success: false,
        error: 'Invalid credential file format',
        path: resolved.path,
      };
    }
    return {
      success: true,
      apiKeyId: parsed.apiKeyId,
      privateKeyPem: parsed.privateKeyPem,
      path: resolved.path,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      path: resolved.path,
    };
  }
}

function buildKalshiWsAuthHeaders(options = {}) {
  const credentials = loadKalshiCredentials(options);
  if (!credentials.success) return credentials;

  try {
    const method = options.method || 'GET';
    const requestPath = options.path || '/trade-api/ws/v2';
    const timestamp = String(Date.now());
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${timestamp}${method}${requestPath}`)
      .sign({
        key: credentials.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');

    return {
      success: true,
      headers: {
        'KALSHI-ACCESS-KEY': credentials.apiKeyId,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
      },
      path: credentials.path,
    };
  } catch (error) {
    return {
      success: false,
      error: `Kalshi WSS signature generation failed: ${error.message}`,
      path: credentials.path,
    };
  }
}

module.exports = {
  CREDENTIAL_FILE_NAME,
  parseCredentialFile,
  resolveKalshiCredentialFile,
  loadKalshiCredentials,
  buildKalshiWsAuthHeaders,
};
