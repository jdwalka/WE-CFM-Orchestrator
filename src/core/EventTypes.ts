export interface OrderbookTick {
  exchange: 'kalshi' | 'polymarket';
  marketId: string;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
}

export interface FairValueUpdate {
  marketId: string;
  trueProbability: number;
  theoreticalEdge: number;
  timestamp: number;
}

export interface PortfolioUpdate {
  totalBalance: number;
  unrealizedPnL: number;
  timestamp: number;
}

export interface TradeSignal {
  marketId: string;
  direction: 'YES' | 'NO';
  size: number;
  targetPrice: number;
}

export interface EventRegistry {
  'TICK_UPDATE': OrderbookTick;
  'FAIR_VALUE_UPDATED': FairValueUpdate;
  'PORTFOLIO_UPDATE': PortfolioUpdate;
  'EXECUTE_TRADE': TradeSignal;
  'RISK_LIMIT_BREACH': { reason: string; threshold: number };
  'GA_PARAMETERS_UPDATED': { generation: number; mutationRate: number };
}
