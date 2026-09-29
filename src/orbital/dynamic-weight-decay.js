/**
 * dynamic-weight-decay.js
 * 
 * Objective: Continuously calibrate predictive logic by automatically penalizing 
 * internal model features that lead to false positives during a trading session.
 */

class DynamicWeightDecay {
    constructor(config = {}) {
        this.learningRate = config.learningRate || 0.01; // alpha
        this.windowSize = config.windowSize || 10; // Rolling window for variance calculation
        this.predictions = [];
        this.actuals = [];
        
        // Internal model features and their weights
        this.featureWeights = config.initialWeights || {
            volumeSpikes: 1.0,
            momentum: 1.0,
            sentiment: 1.0,
            volatility: 1.0
        };
    }

    /**
     * Record a prediction and its corresponding actual market movement over the rolling window.
     * @param {Object} predictedVector { volumeSpikes, momentum, sentiment, volatility }
     * @param {Number} actualMovement Target variable actual result
     */
    recordSessionData(predictedVector, actualMovement) {
        this.predictions.push(predictedVector);
        this.actuals.push(actualMovement);

        if (this.predictions.length > this.windowSize) {
            this.predictions.shift();
            this.actuals.shift();
        }

        this.calibrateWeights();
    }

    /**
     * The Learning Feedback Loop
     * Calculates variance and applies gradient descent to penalize/reward feature weights.
     */
    calibrateWeights() {
        if (this.predictions.length < this.windowSize) return; // Wait for sufficient data

        console.log('[WeightDecay] Calibrating predictive logic weights...');

        let gradients = {
            volumeSpikes: 0,
            momentum: 0,
            sentiment: 0,
            volatility: 0
        };

        let totalLoss = 0;

        // Calculate the variance (Error) over the rolling window
        for (let i = 0; i < this.predictions.length; i++) {
            let predictionScore = 0;
            const pred = this.predictions[i];

            // Linear combination of features
            for (const feature in this.featureWeights) {
                predictionScore += this.featureWeights[feature] * pred[feature];
            }

            const actual = this.actuals[i];
            const error = predictionScore - actual;
            totalLoss += Math.pow(error, 2);

            // Calculate gradient of the loss function w.r.t each weight: dL/dw = 2 * error * x
            for (const feature in gradients) {
                gradients[feature] += 2 * error * pred[feature];
            }
        }

        const mse = totalLoss / this.predictions.length;
        console.log(`[WeightDecay] Mean Squared Error over window: ${mse.toFixed(4)}`);

        // Decay Execution: Mathematical Calibration
        // w_{t+1} = w_t - alpha * gradient
        for (const feature in this.featureWeights) {
            const avgGradient = gradients[feature] / this.predictions.length;
            const previousWeight = this.featureWeights[feature];
            
            // Apply decay/update
            this.featureWeights[feature] = previousWeight - (this.learningRate * avgGradient);
            
            // Prevent weights from going negative if non-negativity is required
            this.featureWeights[feature] = Math.max(0.001, this.featureWeights[feature]); 

            if (Math.abs(previousWeight - this.featureWeights[feature]) > 0.05) {
                console.log(`[WeightDecay] Heavy decay applied to [${feature}]: ${previousWeight.toFixed(4)} -> ${this.featureWeights[feature].toFixed(4)}`);
            }
        }

        console.log('[WeightDecay] Current Weights:', this.featureWeights);
    }
    
    getWeights() {
        return this.featureWeights;
    }
}

module.exports = DynamicWeightDecay;
