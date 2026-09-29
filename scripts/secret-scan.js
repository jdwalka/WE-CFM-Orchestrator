#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const scanStaged = process.argv.includes('--staged');
const maxScanBytes = 5 * 1024 * 1024;

const ignoredPath = /(?:^|[\\/])(?:node_modules(?: \(1\))?|dist|build|coverage|\.git)(?:[\\/]|$)/i;
const documentationFile = /\.(?:md|markdown)$/i;
const sensitiveFilename = /(?:^|[\\/])(?:\.env(?:\..*)?|.*(?:api[-_ ]?key|apikey|secret|token|credential|service[-_ ]?account).*\.(?:txt|json|pem|key|p8|p12|env))$/i;
const contentRules = [
  {
    name: 'private key block',
    regex: /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----$/m,
  },
  {
    name: 'Google service account JSON',
    regex: /"type"\s*:\s*"service_account"/,
  },
  {
    name: 'AWS access key id',
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: 'GitHub token',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
  },
  {
    name: 'Google API key',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: 'Slack token',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  },
  {
    name: 'long private secret assignment',
    regex: /\b(?:client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key)\b\s*[:=]\s*['"](?!(?:example|placeholder|changeme|replace_me|redacted|dummy|test|your_?key)\b)[A-Za-z0-9+/_=.-]{40,}['"]/i,
  },
];

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'buffer',
  });

  if (result.status !== 0) {
    const stderr = result.stderr.toString('utf8').trim();
    console.error(`[secret-scan] git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
    process.exit(result.status || 1);
  }

  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function filesToScan() {
  if (scanStaged) {
    return runGit(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  }
  return runGit(['ls-files', '-z']);
}

function isBinary(buffer) {
  return buffer.includes(0);
}

const findings = [];

for (const file of filesToScan()) {
  if (ignoredPath.test(file)) continue;

  const absolutePath = path.join(rootDir, file);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch (_) {
    continue;
  }
  if (!stat.isFile()) continue;

  if (sensitiveFilename.test(file)) {
    findings.push({ file, rule: 'sensitive filename' });
    continue;
  }

  if (documentationFile.test(file)) continue;

  if (stat.size > maxScanBytes) continue;

  const buffer = fs.readFileSync(absolutePath);
  if (isBinary(buffer)) continue;

  const content = buffer.toString('utf8');
  const match = contentRules.find(rule => rule.regex.test(content));
  if (match) {
    findings.push({ file, rule: match.name });
  }
}

if (findings.length) {
  console.error('[secret-scan] Potential secrets found. Remove them from git and rotate any exposed credentials:');
  for (const finding of findings) {
    console.error(`  - ${finding.file} (${finding.rule})`);
  }
  process.exit(1);
}

console.log(`[secret-scan] OK (${scanStaged ? 'staged files' : 'tracked files'})`);
