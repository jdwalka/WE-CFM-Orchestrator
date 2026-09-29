const crypto = require('crypto');
const sample_payload = {
    "inference_model": "asi1-mini",
    "request_type": "inference",
    "data": {"prompt": "Analyze market trends", "max_tokens": 500}
};

const payloadStr = JSON.stringify(sample_payload, Object.keys(sample_payload).sort());
const computedHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
console.log('JS payloadStr:', payloadStr);
console.log('JS hash:', computedHash);

// Also use Python to get Python's hash:
