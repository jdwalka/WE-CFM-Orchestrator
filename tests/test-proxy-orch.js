const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('src/infra/proxy-orchestrator.js', 'utf8');

const context = {
  window: {},
  console: console,
  setTimeout: setTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  clearTimeout: clearTimeout,
  Math: Math,
  Object: Object,
  Array: Array,
  String: String,
  Error: Error,
  Date: Date,
  Promise: Promise,
  require: require,
  process: process,
  Buffer: Buffer
};
context.window.console = console;

vm.createContext(context);
try {
  vm.runInContext(code, context);
  console.log("Success. window.ProxyOrchestrator:", typeof context.window.ProxyOrchestrator);
} catch (e) {
  console.error("Error executing proxy-orchestrator.js:", e);
}
