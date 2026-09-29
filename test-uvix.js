const crypto = require('crypto');
const sample_payload = {
    "inference_model": "asi1-mini",
    "request_type": "inference",
    "data": {"prompt": "Analyze market trends", "max_tokens": 500}
};

const payloadStr = JSON.stringify(sample_payload);
// Python-like spaced stringification for hash matching
const spacedStr = payloadStr.replace(/":/g, '": ').replace(/,"/g, ', "');
// Actually, I'll just use my tight hash because the script checks both.
const payloadHash = crypto.createHash('sha256').update(JSON.stringify({
  "data": {"max_tokens": 500, "prompt": "Analyze market trends"},
  "inference_model": "asi1-mini",
  "request_type": "inference"
})).digest('hex');

const slugData = {
    "protocol_version": "1.0",
    "source_platform": "ASI:One-iPhone",
    "target_platform": "Google-Antigravity",
    "payload_hash": payloadHash,
    "compatibility_layer": "uvix-universal-v1",
    "raw_payload": sample_payload
};

const slug = 'UVIX::' + Buffer.from(JSON.stringify(slugData)).toString('base64') + '::END';

fetch('http://localhost:3011/uvix/handover', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ uvix_slug: slug })
})
.then(res => res.json())
.then(data => console.log('Response:', JSON.stringify(data, null, 2)))
.catch(console.error);
