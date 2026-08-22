// research-agent-init.js
// ════════════════════════════════════════════════════════════════════════════
// Initialize and manage research agent lifecycle
// Wire cutting-edge insights into core prediction engine
// ════════════════════════════════════════════════════════════════════════════

const ResearchAgent = require('./research-agent');

class ResearchAgentManager {
  constructor() {
    this.agent = null;
    this.lastInsights = null;
    this.feedConsumers = [];
  }

  async init() {
    console.log('[ResearchAgentManager] Initializing...');
    
    try {
      this.agent = new ResearchAgent();
      
      // Register insight consumers
      this.registerConsumer('predictions.js', (insights) => this.feedPredictionEngine(insights));
      this.registerConsumer('feeds', (insights) => this.feedMarketData(insights));
      this.registerConsumer('orchestrator', (insights) => this.updateOrchestrator(insights));
      
      console.log('[ResearchAgentManager] ✓ Initialized with', this.feedConsumers.length, 'consumers');
      return true;
    } catch (e) {
      console.error('[ResearchAgentManager] ❌ Init failed:', e.message);
      return false;
    }
  }

  registerConsumer(name, callback) {
    this.feedConsumers.push({ name, callback });
    console.log(`[ResearchAgentManager] Registered consumer: ${name}`);
  }

  async feedPredictionEngine(insights) {
    console.log('[ResearchAgentManager] 📊 Feeding predictions engine...');
    
    // Extract model improvement suggestions
    const modelInsights = insights.filter(i => i.category === 'prediction-models');
    
    if (modelInsights.length > 0 && window.PredictionEngine) {
      try {
        // Signal prediction engine that new research is available
        window._predictionEngineResearchReady = {
          timestamp: Date.now(),
          insights: modelInsights,
          needsRetuning: modelInsights.some(i => i.findings.some(f => f.actionable)),
        };
        console.log('[ResearchAgentManager] ✓ Prediction engine updated');
      } catch (e) {
        console.warn('[ResearchAgentManager] ⚠️  Prediction engine update failed:', e.message);
      }
    }
  }

  async feedMarketData(insights) {
    console.log('[ResearchAgentManager] 📈 Feeding market data feeds...');
    
    // Extract on-chain and market microstructure insights
    const marketInsights = insights.filter(i => 
      ['on-chain-data', 'market-microstructure', 'blockchain-infrastructure'].includes(i.category)
    );

    if (marketInsights.length > 0) {
      try {
        // Make available to all feed consumers
        window._researchMarketInsights = {
          timestamp: Date.now(),
          insights: marketInsights,
          sources: marketInsights.flatMap(i => i.sources),
        };
        console.log('[ResearchAgentManager] ✓ Market feeds updated');
      } catch (e) {
        console.warn('[ResearchAgentManager] ⚠️  Market feed update failed:', e.message);
      }
    }
  }

  async updateOrchestrator(insights) {
    console.log('[ResearchAgentManager] 🔄 Updating orchestrator...');
    
    // Extract Polymarket-contract-specific insights
    const polymarketInsights = insights.filter(i => i.category === 'polymarket-contracts');

    if (polymarketInsights.length > 0 && window.PolymarketOrchestrator) {
      try {
        window.PolymarketOrchestrator.researchInsights = {
          timestamp: Date.now(),
          insights: polymarketInsights,
        };
        console.log('[ResearchAgentManager] ✓ Orchestrator updated');
      } catch (e) {
        console.warn('[ResearchAgentManager] ⚠️  Orchestrator update failed:', e.message);
      }
    }
  }

  async start() {
    console.log('[ResearchAgentManager] 🚀 Starting research agent...');
    
    if (!this.agent) {
      await this.init();
    }

    // Start the research agent background loop
    try {
      await this.agent.run();
      console.log('[ResearchAgentManager] ✓ Research agent running');
    } catch (e) {
      console.error('[ResearchAgentManager] ❌ Failed to start agent:', e.message);
    }
  }

  getStatus() {
    return {
      manager: 'research-agent-manager',
      initialized: !!this.agent,
      consumers: this.feedConsumers.length,
      lastInsights: this.lastInsights ? new Date(this.lastInsights.timestamp).toISOString() : null,
      agentStatus: this.agent?.getStatus() || null,
    };
  }
}

module.exports = ResearchAgentManager;
