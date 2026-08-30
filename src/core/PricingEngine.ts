import { eventBus } from './EventBus';
import { OrderbookTick } from './EventTypes';
import { getProbability } from '../math-wasm/distributions';

export class PricingEngine {
  private impliedVolCache: Map<string, number> = new Map();

  public start() {
    eventBus.on('TICK_UPDATE', (tick: OrderbookTick) => this.processTick(tick));
    console.log('[PricingEngine] Subscribed to TICK_UPDATE events.');
  }

  public setImpliedVol(marketId: string, vol: number) {
    this.impliedVolCache.set(marketId, vol);
  }

  private processTick(tick: OrderbookTick) {
    const midPrice = (tick.bid + tick.ask) / 2;
    if (!midPrice || isNaN(midPrice)) return;

    // Use dynamic volatility or fallback to default
    const impliedVolatility = this.impliedVolCache.get(tick.marketId) || 0.45;
    const timeToExpiryDays = 7; // Configurable session horizon
    
    // Normalized Z-Score calculation
    const zScore = (midPrice - 0.5) / (impliedVolatility * Math.sqrt(timeToExpiryDays / 365.0));
    
    // Fast math / WASM computation
    const trueProbability = getProbability(zScore);
    const theoreticalEdge = trueProbability - midPrice;

    // Broadcast enriched event
    eventBus.emit('FAIR_VALUE_UPDATED', {
      marketId: tick.marketId,
      trueProbability,
      theoreticalEdge,
      timestamp: Date.now()
    });
  }
}
