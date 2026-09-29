#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const emulatorHost = process.env.WECRYPTO_FIRESTORE_EMULATOR_HOST
  || process.env.FIRESTORE_EMULATOR_HOST
  || '127.0.0.1:8080';

process.env.WECRYPTO_FIREBASE_ENABLED = process.env.WECRYPTO_FIREBASE_ENABLED || '1';
process.env.WECRYPTO_FIREBASE_REQUIRED = process.env.WECRYPTO_FIREBASE_REQUIRED || '0';
process.env.WECRYPTO_FIRESTORE_MODE = 'emulator';
process.env.WECRYPTO_FIRESTORE_EMULATOR_HOST = emulatorHost;
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

let electronPath = null;
try {
  electronPath = require('electron');
} catch (error) {
  console.error('[start-firestore-local] Electron is not installed. Run npm install first.');
  process.exit(1);
}

console.log(`[start-firestore-local] Firestore emulator target: ${emulatorHost}`);
console.log('[start-firestore-local] Start the emulator with: npm run firebase:emulator');

const child = spawn(electronPath, ['.'], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
  windowsHide: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code == null ? 0 : code);
});

child.on('error', (error) => {
  console.error('[start-firestore-local] Failed to start Electron:', error.message || error);
  process.exit(1);
});
