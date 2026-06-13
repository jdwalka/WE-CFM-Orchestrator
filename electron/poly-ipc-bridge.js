const { ipcMain } = require('electron');
const { ClobClient } = require('@polymarket/clob-client');
require('dotenv').config();

let polyClient = null;

async function initPolyClient() {
  if (polyClient) return polyClient;

  // ClobClient can be initialized without credentials for public reads
  // If the user has a wallet private key in .env, we can pass it, but it's optional for getMarkets
  const chainId = 137; // Polygon Mainnet
  
  polyClient = new ClobClient(
    "https://clob.polymarket.com",
    chainId,
    process.env.POLY_WALLET_PK ? require('ethers').Wallet.createRandom() /* dummy if not provided */ : undefined
  );

  if (process.env.POLY_WALLET_PK) {
    try {
      const ethers = require('ethers');
      const wallet = new ethers.Wallet(process.env.POLY_WALLET_PK);
      // Wait, clob-client expects a different signature or initialization for auth
      // For just fetching markets, we don't need credentials.
      polyClient = new ClobClient("https://clob.polymarket.com", chainId, wallet);
      console.log('[PolyBridge] Initialized ClobClient WITH Wallet');
    } catch (err) {
      console.error('[PolyBridge] Failed to init wallet from POLY_WALLET_PK:', err.message);
    }
  } else {
    console.log('[PolyBridge] Initialized ClobClient for public reads');
  }

  return polyClient;
}

function registerPolyIpcHandlers() {
  ipcMain.handle('poly:fetchMarkets', async (event, options = {}) => {
    try {
      const client = await initPolyClient();
      // Using the getMarkets method from CLOB client
      // The CLOB API getMarkets accepts { next_cursor } for pagination
      const cursor = options.cursor || "";
      const limit = options.limit || 500;
      
      const response = await client.getMarkets(cursor);
      
      return {
        success: true,
        data: response.data || [],
        next_cursor: response.next_cursor || ""
      };
    } catch (error) {
      console.error('[PolyBridge] Error fetching markets:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('poly:status', async () => {
    return {
      connected: !!polyClient,
      hasKeys: !!process.env.POLY_WALLET_PK
    };
  });
}

module.exports = {
  initPolyClient,
  registerPolyIpcHandlers
};
