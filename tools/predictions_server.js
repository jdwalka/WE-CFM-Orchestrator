// predictions_server.js — lightweight endpoint to persist predictions as NDJSON
const express = require('express');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');
const app = express();
app.use(express.json());
app.use(morgan('combined'));

const OUT = path.resolve(__dirname, 'predictions.ndjson');

app.post('/api/predictions', (req, res) => {
  try {
    const p = req.body;
    // Minimal validation
    if (!p || !p.timestamp || !p.voteAction || !p.coin) {
      return res.status(400).json({ error: 'missing required fields' });
    }
    fs.appendFileSync(OUT, JSON.stringify(p) + '\n', 'utf8');
    res.status(204).end();
  } catch (e) {
    console.error('persistPrediction failed', e);
    res.status(500).json({ error: 'persist failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`predictions server listening on ${PORT}`));
