/**
 * Gated Switch Router
 * 
 * Unified wrapper for Kalshi, Polymarket, Coinbase SDKs, and Telegram.
 * Handles rate limits mathematically, provides fallback switches, and manages 
 * Telegram authentication sessions dynamically.
 */

const fs = require('fs');
const path = require('path');
const { Coinbase } = require('@coinbase/coinbase-sdk');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { ipcMain } = require('electron');

// Local imports / State
let coinbaseClient = null;
let telegramClient = null;
let telegramSessionString = process.env.TELEGRAM_SESSION || '';
const pendingRequests = {};

// Rate-limiting and Gate thresholds
const gateStates = {
  Kalshi: { errors: 0, lastFailure: 0, backoffMs: 0, status: 'healthy' },
  Polymarket: { errors: 0, lastFailure: 0, backoffMs: 0, status: 'healthy' },
  Coinbase: { errors: 0, lastFailure: 0, backoffMs: 0, status: 'healthy' },
};

/**
 * Configure Coinbase CDP SDK
 */
function initCoinbase() {
  const name = process.env.COINBASE_API_KEY_NAME;
  const privateKey = process.env.COINBASE_PRIVATE_KEY;
  if (name && privateKey) {
    try {
      coinbaseClient = new Coinbase({ apiKeyName: name, privateKey: privateKey });
      console.log('[GatedRouter] Coinbase CDP SDK initialized.');
    } catch (err) {
      console.error('[GatedRouter] Failed to initialize Coinbase SDK:', err.message);
    }
  }
}

/**
 * Math-based rate limiting gate for execution
 */
async function executeGated(provider, actionFn, fallbackFn = null) {
  const gate = gateStates[provider];
  const now = Date.now();

  if (gate.status === 'blocked' && now < gate.lastFailure + gate.backoffMs) {
    const waitTime = Math.round((gate.lastFailure + gate.backoffMs - now) / 1000);
    console.warn(`[GatedRouter] ${provider} is gated. Throttling request. (wait ${waitTime}s)`);
    if (fallbackFn) return await fallbackFn();
    throw new Error(`${provider} rate limit/error gate active. Try again later.`);
  }

  try {
    const result = await actionFn();
    // Reset gates on success
    gate.errors = 0;
    gate.backoffMs = 0;
    gate.status = 'healthy';
    return result;
  } catch (err) {
    gate.errors++;
    gate.lastFailure = now;
    // Exponential backoff math: 2s, 4s, 8s, 16s... up to 5 mins
    gate.backoffMs = Math.min(300000, Math.pow(2, gate.errors) * 1000);
    gate.status = gate.errors >= 3 ? 'blocked' : 'degraded';
    
    console.error(`[GatedRouter] Error on ${provider} (Failure #${gate.errors}):`, err.message);
    if (fallbackFn) {
      console.log(`[GatedRouter] Executing fallback for ${provider}`);
      return await fallbackFn();
    }
    throw err;
  }
}

/**
 * Initialize Telegram Client using StringSession
 */
async function initTelegram(apiId, apiHash, onCodeRequest = null) {
  if (!apiId || !apiHash) {
    console.log('[GatedRouter] Telegram API ID/Hash missing. Telegram integration deferred.');
    return;
  }

  const stringSession = new StringSession(telegramSessionString);
  telegramClient = new TelegramClient(stringSession, Number(apiId), apiHash, {
    connectionRetries: 5,
  });

  try {
    await telegramClient.start({
      phoneNumber: async () => {
        if (onCodeRequest) {
          const res = await onCodeRequest('phone');
          return res;
        }
        throw new Error('Telegram phone number required but no handler provided.');
      },
      phoneCode: async () => {
        if (onCodeRequest) {
          const res = await onCodeRequest('code');
          return res;
        }
        throw new Error('Telegram verification code required but no handler provided.');
      },
      password: async () => {
        if (onCodeRequest) {
          const res = await onCodeRequest('password');
          return res;
        }
        return '';
      },
      onError: (err) => console.error('[TelegramClient] Error:', err.message),
    });

    // Save session string back to .env to avoid future verification prompts
    const newSession = telegramClient.session.save();
    if (newSession !== telegramSessionString) {
      telegramSessionString = newSession;
      updateEnvFile('TELEGRAM_SESSION', newSession);
      console.log('[GatedRouter] Telegram session string updated and saved to .env');
    }

    console.log('[GatedRouter] Telegram integration fully connected.');
    setupTelegramListeners();
  } catch (err) {
    console.error('[GatedRouter] Telegram connection failed:', err.message);
  }
}

/**
 * Helper to dispatch events to Electron frontend
 */
function broadcastToRenderer(channel, data) {
  if (global.WECRYPTO_MAIN_WINDOW) {
    try {
      global.WECRYPTO_MAIN_WINDOW.webContents.send(channel, data);
    } catch (err) {
      // ignore
    }
  }
}

/**
 * Configure Telegram event handlers
 */
function setupTelegramListeners() {
  if (!telegramClient) return;

  telegramClient.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || !message.message) return;

    try {
      const peer = await message.getPeerId();
      const chat = await message.getChat();
      const chatTitle = chat ? chat.title || chat.username : 'Private Chat';
      
      console.log(`[Telegram] Broadcast message from ${chatTitle}:`, message.message);
      
      broadcastToRenderer('telegram:message', {
        id: message.id,
        date: message.date,
        text: message.message,
        chatTitle,
        peerId: peer?.toString()
      });
    } catch (err) {
      console.error('[Telegram] Error parsing event message:', err.message);
    }
  }, new NewMessage({}));
}

/**
 * Utility to save key/values back to the project .env
 */
function updateEnvFile(key, value) {
  const envPath = path.join(process.cwd(), '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    let content = fs.readFileSync(envPath, 'utf8');
    const regex = new RegExp(`^${key}=.*$`, 'm');
    
    if (content.match(regex)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    console.error(`[GatedRouter] Failed to write ${key} to .env:`, err.message);
  }
}

/**
 * Set up Electron IPC channel handlers for client-side control
 */
function setupIpcHandlers() {
  if (!ipcMain) {
    console.log('[GatedRouter] Running outside Electron. IPC handlers bypassed.');
    return;
  }

  // Handle code responses from frontend UI (registered once)
  ipcMain.on('telegram:auth-response', (ev, { type, value }) => {
    if (pendingRequests[type]) {
      pendingRequests[type](value);
      delete pendingRequests[type];
    }
  });

  // Telegram Status Handler
  ipcMain.handle('telegram:status', async () => {
    return {
      connected: !!(telegramClient && telegramClient.connected),
      session: telegramSessionString || null,
      apiId: process.env.TELEGRAM_API_ID || '',
      apiHash: process.env.TELEGRAM_API_HASH || '',
      channelToListen: process.env.TELEGRAM_CHANNEL_TO_LISTEN || 'polycool_copytrade_channel'
    };
  });

  // Telegram Login Handler
  ipcMain.handle('telegram:login', async (event, { apiId, apiHash }) => {
    // Save these to env file
    if (apiId) updateEnvFile('TELEGRAM_API_ID', apiId);
    if (apiHash) updateEnvFile('TELEGRAM_API_HASH', apiHash);
    
    const onCodeRequest = (type) => new Promise((resolve) => {
      pendingRequests[type] = resolve;
      event.sender.send('telegram:auth-request', { type });
    });

    await initTelegram(apiId, apiHash, onCodeRequest);
    return { success: !!telegramClient?.connected, session: telegramSessionString };
  });

  // Fetch Polycool channel copytrades
  ipcMain.handle('telegram:get-channel-history', async (event, { channelName, limit = 20 }) => {
    if (!telegramClient || !telegramClient.connected) {
      return { success: false, error: 'Telegram not connected' };
    }
    try {
      const messages = await telegramClient.getMessages(channelName, { limit });
      return {
        success: true,
        messages: messages.map(m => ({
          id: m.id,
          date: m.date,
          text: m.message,
          senderId: m.senderId?.toString()
        }))
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

// Initialise on load
initCoinbase();
setupIpcHandlers();

// Automatic startup if session exists in env
if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION) {
  initTelegram(process.env.TELEGRAM_API_ID, process.env.TELEGRAM_API_HASH).catch(() => {});
}

module.exports = {
  executeGated,
  getCoinbase: () => coinbaseClient,
  getTelegram: () => telegramClient,
  getGateStatus: () => gateStates,
};
