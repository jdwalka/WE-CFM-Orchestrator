#!/usr/bin/env node
// scripts/firebase-precheck.js
// Runs the Firebase Admin startup check with dotenv loaded first.
// Used by npm run firebase:precheck so the preflight sees all env vars.
'use strict';
const path = require('path');
const fs   = require('fs');

// Load .env from repo root before requiring any app modules
try {
  const dotenv = require('dotenv');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
  const localPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(localPath)) dotenv.config({ path: localPath, override: false });
} catch (_) {}

const fb = require('../src/cloud/firebase-admin-firestore');
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const target = targetArg ? targetArg.split('=').slice(1).join('=').trim() : null;

fb.startupCheck({ required: false, probe: true, ...(target ? { target } : {}) })
  .then(r => {
    console.log('[firebase-precheck]', JSON.stringify(r, null, 2));
    if (r.success) process.exit(0);
    // Non-fatal when required=false — just warn
    process.exit(0);
  })
  .catch(err => {
    console.log('[firebase-precheck]', JSON.stringify({ success: false, error: err?.message || String(err) }, null, 2));
    process.exit(0); // non-fatal
  });
