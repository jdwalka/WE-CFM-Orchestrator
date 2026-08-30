const { PythLazerClient } = require("@pythnetwork/pyth-lazer-sdk");
async function test() {
  const c = await PythLazerClient.create({
    token: "9AowRQwEELKpsMosei146CTHcxeNoHuSUWuDhGfFxkXZ",
    webSocketPoolConfig: { urls: ["wss://pyth-lazer-0.dourolabs.app/v1/stream"] }
  });
  console.log("Connected");
  c.addMessageListener(console.log);
  c.addAllConnectionsDownListener((e) => console.log("Down", e));
}
test().catch(console.error);
