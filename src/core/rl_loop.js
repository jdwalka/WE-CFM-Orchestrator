/**
 * Reinforcement Learning (RL) Loop for WECRYPTO
 * Dynamically adjusts indicator weights based on real-world contract resolution PnL.
 * Adaptive Alpha prevents catastrophic forgetting during low-confidence trades.
 */

function update_indicator_weights(trade_result, current_weights, features_used) {
  // Base learning rate (conservative)
  const BASE_ALPHA = 0.025; 

  const actual_profit = Number(trade_result.profit) || 0;
  const expected_profit = Number(trade_result.expected_value) || 0;
  const snapshot_confidence = Number(trade_result.confidence) || 0.5;

  let performance_delta = 0;

  if (actual_profit > 0) {
    // If it won, reward it.
    performance_delta = 1.0;
  } else {
    // If it lost, penalize proportionally to how badly it missed the expected EV
    const profitDelta = Math.abs(expected_profit - actual_profit);
    const deviationPenalty = Math.min(profitDelta / Math.max(0.01, Math.abs(expected_profit)), 2.0);
    
    // Scale penalty by confidence. 
    // High confidence + big loss = huge penalty. Low confidence + loss = small penalty.
    performance_delta = -1.0 * deviationPenalty * snapshot_confidence;
  }

  // Calculate dynamic alpha
  const alpha = BASE_ALPHA * Math.abs(performance_delta);
  const sign = performance_delta > 0 ? 1 : -1;

  const updated_weights = { ...current_weights };

  // Apply the penalty or reward only to the indicators that triggered the trade
  for (const feature of features_used) {
    if (updated_weights[feature] !== undefined) {
      const old_weight = Number(updated_weights[feature]);
      
      // The RL Formula: new = old * (1 + (alpha * sign))
      let new_weight = old_weight * (1 + (alpha * sign));
      
      // Hard floors and ceilings
      new_weight = Math.max(0.1, Math.min(new_weight, 3.0));
      
      updated_weights[feature] = Math.round(new_weight * 1000) / 1000;
    }
  }

  return {
    status: "WEIGHTS_UPDATED",
    old_weights: current_weights,
    new_weights: updated_weights,
    meta: {
      alpha,
      performance_delta,
      actual_profit,
      expected_profit,
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { update_indicator_weights };
} else if (typeof window !== 'undefined') {
  window.update_indicator_weights = update_indicator_weights;
}
