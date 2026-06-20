/**
 * Lightweight feedforward neural network (ReLU hidden, linear output).
 * Browser + Node compatible — no external ML deps.
 */
(function (root, factory) {
  const NeuralNet = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NeuralNet };
  } else {
    root.NeuralNet = NeuralNet;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function randn(scale = 0.08) {
    let u = 0; let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return scale * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function relu(x) { return x > 0 ? x : 0; }
  function reluDeriv(x) { return x > 0 ? 1 : 0; }

  class NeuralNet {
    constructor(layerSizes, options = {}) {
      if (!Array.isArray(layerSizes) || layerSizes.length < 2) {
        throw new Error('NeuralNet requires layerSizes [input, ...hidden, output]');
      }
      this.layerSizes = layerSizes.slice();
      this.initScale = options.initScale ?? 0.08;
      this.weights = [];
      this.biases = [];
      for (let i = 0; i < layerSizes.length - 1; i++) {
        const rows = layerSizes[i + 1];
        const cols = layerSizes[i];
        const w = Array.from({ length: rows }, () =>
          Array.from({ length: cols }, () => randn(this.initScale)));
        this.weights.push(w);
        this.biases.push(Array.from({ length: rows }, () => 0));
      }
    }

    forward(input, storeActivations = false) {
      let activations = [input.slice()];
      let preActs = [];
      for (let l = 0; l < this.weights.length; l++) {
        const w = this.weights[l];
        const b = this.biases[l];
        const prev = activations[activations.length - 1];
        const z = w.map((row, i) =>
          row.reduce((s, v, j) => s + v * prev[j], 0) + b[i]);
        preActs.push(z);
        const isOutput = l === this.weights.length - 1;
        activations.push(isOutput ? z : z.map(relu));
      }
      if (storeActivations) return { output: activations[activations.length - 1], activations, preActs };
      return activations[activations.length - 1];
    }

    /** One SGD step on MSE target (used for DQN regression). */
    trainSample(input, target, lr = 0.001) {
      const { output, activations, preActs } = this.forward(input, true);
      const last = output.length;
      let delta = output.map((o, i) => o - (target[i] ?? 0));

      for (let l = this.weights.length - 1; l >= 0; l--) {
        const w = this.weights[l];
        const b = this.biases[l];
        const prev = activations[l];
        const nextDelta = Array(prev.length).fill(0);

        for (let i = 0; i < w.length; i++) {
          const grad = delta[i];
          b[i] -= lr * grad;
          for (let j = 0; j < w[i].length; j++) {
            nextDelta[j] += w[i][j] * grad;
            w[i][j] -= lr * grad * prev[j];
          }
        }

        if (l > 0) {
          const pre = preActs[l - 1];
          delta = nextDelta.map((d, j) => d * reluDeriv(pre[j]));
        }
      }
      return output;
    }

    clone() {
      const copy = new NeuralNet(this.layerSizes, { initScale: this.initScale });
      copy.weights = this.weights.map((layer) => layer.map((row) => row.slice()));
      copy.biases = this.biases.map((b) => b.slice());
      return copy;
    }

    syncFrom(other, tau = 1) {
      for (let l = 0; l < this.weights.length; l++) {
        for (let i = 0; i < this.weights[l].length; i++) {
          for (let j = 0; j < this.weights[l][i].length; j++) {
            this.weights[l][i][j] = tau * other.weights[l][i][j] + (1 - tau) * this.weights[l][i][j];
          }
          this.biases[l][i] = tau * other.biases[l][i] + (1 - tau) * this.biases[l][i];
        }
      }
    }

    toJSON() {
      return { layerSizes: this.layerSizes, weights: this.weights, biases: this.biases };
    }

    static fromJSON(obj) {
      const net = new NeuralNet(obj.layerSizes);
      net.weights = obj.weights;
      net.biases = obj.biases;
      return net;
    }
  }

  return NeuralNet;
}));
