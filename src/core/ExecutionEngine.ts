import { eventBus } from './EventBus';
import { PortfolioUpdate, TradeSignal } from './EventTypes';

export class ExecutionEngine {
  private isHalted: boolean = false;
  private startingBalance: number = 0;
  private peakBalance: number = 0;
  private readonly MAX_DRAWDOWN_PCT = 0.03; // 3% Max Drawdown Hard Limit

  public start(initialBalance: number) {
    this.startingBalance = initialBalance;
    this.peakBalance = initialBalance;
    
    // Listen for balance updates from your exchange connector
    eventBus.on('PORTFOLIO_UPDATE', (portfolio: PortfolioUpdate) => this.checkDrawdown(portfolio));
    
    // Listen for calculated trade signals from the Pricing Engine or GA Daemon
    eventBus.on('EXECUTE_TRADE', (tradeSignal: TradeSignal) => this.execute(tradeSignal));
    
    console.log(`[ExecutionEngine] Started with initial balance $${initialBalance}`);
  }

  private checkDrawdown(portfolio: PortfolioUpdate) {
    if (this.isHalted) return; // Prevent redundant triggers

    // Track high-water mark for trailing drawdown
    if (portfolio.totalBalance > this.peakBalance) {
      this.peakBalance = portfolio.totalBalance;
    }

    // Calculate absolute drawdown from the initial starting balance
    const currentDrawdown = (this.startingBalance - portfolio.totalBalance) / this.startingBalance;

    if (currentDrawdown >= this.MAX_DRAWDOWN_PCT) {
      this.triggerKillSwitch(currentDrawdown, portfolio.totalBalance);
    }
  }

  private triggerKillSwitch(drawdown: number, balance: number) {
    this.isHalted = true;
    
    // 1. Broadcast the breach so the UI or alert systems can react
    eventBus.emit('RISK_LIMIT_BREACH', {
      reason: `Max Drawdown Exceeded: ${(drawdown * 100).toFixed(2)}%`,
      threshold: this.MAX_DRAWDOWN_PCT
    });
    
    // 2. Dump open positions at market price to prevent further slippage
    this.liquidateAllOpenPositions();
    
    console.error(`🚨 TRADING HALTED. Balance: $${balance}. System locked until manual override.`);
  }

  private execute(tradeSignal: TradeSignal) {
    // The Guardrail: Hard reject any execution if the system is halted
    if (this.isHalted) {
      console.warn(`[ExecutionEngine] Execution rejected: Risk limits breached. Ignoring signal for ${tradeSignal.marketId}`);
      return;
    }
    
    // Proceed with routing the order to the Kalshi/Polymarket connector
    // In actual implementation, this will interface with PolymarketRouter or KalshiRouter
    console.log(`[ExecutionEngine] Routing order for ${tradeSignal.marketId} at ${tradeSignal.targetPrice}`);
  }

  private liquidateAllOpenPositions() {
    // Logic to fetch all active holdings and blast opposing market orders
    console.warn(`[ExecutionEngine] Liquidating all open positions via market execution!`);
  }
}
