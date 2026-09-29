function sortObjKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortObjKeys);
  }
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = sortObjKeys(obj[key]);
    return acc;
  }, {});
}
const crypto = require('crypto');
const sample_payload = {
    "inference_model": "asi1-mini",
    "request_type": "inference",
    "data": {"prompt": "Analyze market trends", "max_tokens": 500}
};

const payloadStr = JSON.stringify(sortObjKeys(sample_payload));
// Wait, python's json.dumps adds spaces: '{"data": {"max_tokens": 500, "prompt": "Analyze market trends"}, "inference_model": "asi1-mini", "request_type": "inference"}'
// We should check what the user's Python generated.
console.log('JS sorted str:', payloadStr);
