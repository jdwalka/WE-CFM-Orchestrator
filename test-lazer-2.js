const { PythLazerClient } = require("@pythnetwork/pyth-lazer-sdk");
async function test() {
  const token = process.env.PYTH_LAZER_TOKEN;
  if (!token) throw new Error("PYTH_LAZER_TOKEN is required");
  const c = await PythLazerClient.create({
    token,
    webSocketPoolConfig: { urls: ["wss://pyth-lazer-0.dourolabs.app/v1/stream"] }
  });
  console.log("Connected");
  
  c.subscribe({
    type: "subscribe",
    subscriptionId: 1,
    priceFeedIds: [1,2,6,10,14,15,13,110],
    properties: ["price", "marketSession", "fundingRateInterval", "feedUpdateTimestamp", "confidence", "fundingRate", "bestAskPrice", "publisherCount", "bestBidPrice", "exponent", "fundingTimestamp"],
    formats: ["solana", "leUnsigned", "leEcdsa", "evm"],
    channel: "real_time",
    deliveryFormat: "json",
    jsonBinaryEncoding: "hex",
    parsed: true,
    ignoreInvalidFeeds: true,
  });

  c.addMessageListener((m) => {
     if (m.type === "error") { console.log("ErrorMsg:", m); }
     else if (m.type === "json") { console.log("Got Price", m.value.parsed.priceFeeds.length); }
  });
  c.addAllConnectionsDownListener((e) => console.log("Down", e));
}
test().catch(console.error);
