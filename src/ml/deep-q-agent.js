/**
 * Deep Q-Network agent with experience replay + target network.
 */
(function (root, factory) {
  const DeepQAgent = factory(root);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DeepQAgent };
  } else {
    root.DeepQAgent = DeepQAgent;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  const NeuralNet = typeof require !== 'undefined'
    ? require('./neural-net').NeuralNet
    : root.NeuralNet;

  class DeepQAgent {
    constructor(stateSize, actionSize = 3, options = {}) {
      this.stateSize = stateSize;
      this.actionSize = actionSize;
      this.gamma = options.gamma ?? 0.92;
      this.epsilon = options.epsilon ?? 1.0;
      this.epsilonMin = options.epsilonMin ?? 0.08;
      this.epsilonDecay = options.epsilonDecay ?? 0.995;
      this.batchSize = options.batchSize ?? 48;
      this.targetSyncEvery = options.targetSyncEvery ?? 200;
      this.lr = options.lr ?? 0.002;
      this.memory = [];
      this.memoryMax = options.memoryMax ?? 8000;
      this.trainSteps = 0;

      const hidden = options.hidden ?? [64, 32];
      const layers = [stateSize, ...hidden, actionSize];
      this.policyNet = new NeuralNet(layers);
      this.targetNet = this.policyNet.clone();
    }

    remember(state, action, reward, nextState, done) {
      this.memory.push({ state, action, reward, nextState, done });
      if (this.memory.length > this.memoryMax) this.memory.shift();
    }

    qValues(state) {
      return this.policyNet.forward(state);
    }

    act(state, explore = true) {
      if (explore && Math.random() < this.epsilon) {
        return Math.floor(Math.random() * this.actionSize);
      }
      const q = this.qValues(state);
      let best = 0;
      for (let i = 1; i < q.length; i++) if (q[i] > q[best]) best = i;
      return best;
    }

    replay() {
      if (this.memory.length < this.batchSize) return { loss: 0, trained: false };
      let totalLoss = 0;
      for (let n = 0; n < this.batchSize; n++) {
        const idx = Math.floor(Math.random() * this.memory.length);
        const { state, action, reward, nextState, done } = this.memory[idx];
        const qNext = done ? Array(this.actionSize).fill(0) : this.targetNet.forward(nextState);
        const maxNext = Math.max(...qNext);
        const target = this.policyNet.forward(state).slice();
        const td = reward + this.gamma * maxNext;
        totalLoss += Math.abs(target[action] - td);
        target[action] = td;
        this.policyNet.trainSample(state, target, this.lr);
      }
      this.trainSteps++;
      if (this.trainSteps % this.targetSyncEvery === 0) {
        this.targetNet.syncFrom(this.policyNet, 1);
      }
      if (this.epsilon > this.epsilonMin) {
        this.epsilon = Math.max(this.epsilonMin, this.epsilon * this.epsilonDecay);
      }
      return { loss: totalLoss / this.batchSize, trained: true };
    }

    toJSON() {
      return {
        stateSize: this.stateSize,
        actionSize: this.actionSize,
        gamma: this.gamma,
        epsilon: this.epsilon,
        trainSteps: this.trainSteps,
        policyNet: this.policyNet.toJSON(),
        targetNet: this.targetNet.toJSON(),
      };
    }

    static fromJSON(obj) {
      const agent = new DeepQAgent(obj.stateSize, obj.actionSize, {
        gamma: obj.gamma,
        epsilon: obj.epsilon,
      });
      agent.policyNet = NeuralNet.fromJSON(obj.policyNet);
      agent.targetNet = NeuralNet.fromJSON(obj.targetNet);
      agent.trainSteps = obj.trainSteps ?? 0;
      return agent;
    }
  }

  return DeepQAgent;
}));
