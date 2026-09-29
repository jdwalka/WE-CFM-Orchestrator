/**
 * ================================================================
 * SECURE FETCH LAYER (ESM)
 * ================================================================
 * Manages Cloudflare Zero Trust, Tailscale, and Mullvad SOCKS5
 * routing to guarantee geo-compliance and latency management
 * for WECRYPTO and Polycool.
 */

// SOCKS5 bridge typically bound locally
const SOCKS_PROXY_URL = process.env.WECRYPTO_SWEDEN_SOCKS || 'socks5://127.0.0.1:18090';
// Local Nginx CORS proxy
const CORS_PROXY_URL = 'http://127.0.0.1:8080';

const LANE_FAST = 'fast';
const LANE_SWEDEN = 'sweden';

let currentLane = LANE_SWEDEN;

export function setLane(lane) {
  if (lane === LANE_FAST || lane === LANE_SWEDEN) {
    currentLane = lane;
  }
}

export function getActiveLane() {
  return currentLane;
}

/**
 * Core fetch wrapper that automatically routes through the appropriate proxy layer.
 */
export async function secureFetch(url, options = {}) {
  // Determine if this request needs the Mullvad SOCKS5 proxy (e.g. Kalshi/Polymarket execution)
  const isExecutionRoute = options.isExecution || false;
  
  let fetchOptions = { ...options };
  let targetUrl = url;

  if (currentLane === LANE_SWEDEN && isExecutionRoute) {
    // Rewrite the URL to hit our local proxy orchestrator which handles the hop.
    targetUrl = `${CORS_PROXY_URL}/proxy?target=${encodeURIComponent(url)}&proxy=socks`;
  } else if (options.useCorsProxy) {
    targetUrl = `${CORS_PROXY_URL}/proxy?target=${encodeURIComponent(url)}`;
  }

  try {
    const response = await fetch(targetUrl, fetchOptions);
    if (!response.ok) {
      throw new Error(`[SecureFetch] HTTP ${response.status} on ${targetUrl}`);
    }
    return response;
  } catch (error) {
    console.error(`[SecureFetch] Failed to fetch ${url} via ${targetUrl}`, error);
    throw error;
  }
}
