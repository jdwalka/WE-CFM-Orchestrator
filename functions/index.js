const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { VertexAI } = require("@google-cloud/vertexai");

admin.initializeApp();

const vertex_ai = new VertexAI({
  project: process.env.GCLOUD_PROJECT,
  location: "us-central1",
});

const model = "gemini-1.5-flash";

const generativeModel = vertex_ai.preview.getGenerativeModel({
  model,
  systemInstruction: {
    parts: [
      {
        text: "You are the core logic engine of WECRYPTO's Orbital Coherence architecture. Analyze the provided market velocity, volume profiles, and contract data to determine probability metrics for short-term prediction market contracts.",
      },
    ],
  },
  generationConfig: {
    temperature: 0.2,
    responseMimeType: "application/json",
  },
});

exports.orbitalPrediction = onRequest(
  { maxInstances: 10, cors: true },
  async (req, res) => {
    try {
      const { asset, timeframe, currentPrice, sentimentScore } = req.body || {};

      if (!asset || currentPrice == null) {
        return res
          .status(400)
          .json({ error: "Missing required asset or price data payload." });
      }

      const prompt = `Analyze coherence for ${asset} on a ${timeframe} timeframe.
Current Price: $${currentPrice}.
Sentiment/On-Chain Score: ${sentimentScore}.
Calculate the probability of breaking the nearest resistance tier within the timeframe. Return the output as a JSON object with 'probability', 'confidence', and 'reasoning' keys.`;

      const request = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      };
      const streamingResp = await generativeModel.generateContentStream(request);
      const response = await streamingResp.response;
      const raw = response?.candidates?.[0]?.content?.parts?.[0]?.text;
      const predictionResult = JSON.parse(raw);

      await admin.firestore().collection("predictions").add({
        asset,
        timeframe: timeframe || null,
        currentPrice,
        sentimentScore: sentimentScore ?? null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        ...predictionResult,
      });

      return res.status(200).json({
        status: "success",
        engine: "Orbital Coherence",
        data: predictionResult,
      });
    } catch (error) {
      console.error("Vertex AI Execution Error:", error);
      return res.status(500).json({
        status: "error",
        message: "Failed to generate prediction coherence",
        details: error.message,
      });
    }
  }
);

const ROOT_DOC_ID = process.env.WECRYPTO_FIRESTORE_ROOT_DOC_ID || "root";
const TIDE_ARCHIVE_URL = process.env.TIDE_ARCHIVE_URL || "";

async function archiveStreamToTide(event, options = {}) {
  const mode = options.mode || "rooted";
  const marketId = event.params.marketId;
  const afterData = event.data?.after?.data();
  const beforeData = event.data?.before?.data();
  if (!afterData) return;

  if (
    afterData.stream_status === "completed" &&
    beforeData?.stream_status !== "completed"
  ) {
    logger.info(`Market ${marketId} settled. Preparing TIDE archive...`, { mode });

    const db = admin.firestore();
    const marketRef = mode === "rooted"
      ? db.collection("wecrypto_engine").doc(ROOT_DOC_ID).collection("event_streams").doc(marketId)
      : db.collection("event_streams").doc(marketId);
    const ticksRef = marketRef.collection("ticks");

    try {
      const ticksSnapshot = await ticksRef.get();
      const ticks = ticksSnapshot.docs.map((doc) => doc.data());

      const tidePayload = {
        market_id: marketId,
        settlement_timestamp: Date.now(),
        final_state: afterData,
        orbital_ticks: ticks,
      };

      if (!TIDE_ARCHIVE_URL) {
        throw new Error("TIDE_ARCHIVE_URL not configured");
      }
      const tideApiKey = process.env.TIDE_API_KEY || "";
      if (!tideApiKey) {
        throw new Error("TIDE_API_KEY not configured");
      }

      const archiveResp = await fetch(TIDE_ARCHIVE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tideApiKey}`,
        },
        body: JSON.stringify(tidePayload),
      });
      if (!archiveResp.ok) {
        const bodyText = await archiveResp.text().catch(() => "");
        throw new Error(`TIDE archive failed HTTP ${archiveResp.status}: ${bodyText.slice(0, 300)}`);
      }

      const bulkWriter = db.bulkWriter();
      ticksSnapshot.docs.forEach((doc) => {
        bulkWriter.delete(doc.ref);
      });
      bulkWriter.delete(event.data.after.ref);
      await bulkWriter.close();

      logger.info(`Market ${marketId} archived to TIDE and removed from Firestore.`, {
        mode,
        ticksArchived: ticks.length,
      });
    } catch (error) {
      logger.error(`Archiving failed for market ${marketId}`, {
        mode,
        error: error?.message || String(error),
      });
    }
  }
}

exports.archiveToTide = onDocumentUpdated(
  "event_streams/{marketId}",
  async (event) => archiveStreamToTide(event, { mode: "flat" })
);

exports.archiveToTideRooted = onDocumentUpdated(
  `wecrypto_engine/${ROOT_DOC_ID}/event_streams/{marketId}`,
  async (event) => archiveStreamToTide(event, { mode: "rooted" })
);
