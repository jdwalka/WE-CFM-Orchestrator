const crypto = require('crypto');

class UVIXReverseEngineer {
  constructor(config = {}) {
    this.config = config;
    this.antigravityEndpoint = config.antigravityEndpoint || 'https://antigravity.googleapis.com/v1/uvix/handover';
    this.SLUG_HEADER = 'UVIX::';
    this.SLUG_FOOTER = '::END';
  }

  decodeSlug(encodedSlug) {
    let slug = encodedSlug;
    if (slug.startsWith(this.SLUG_HEADER)) slug = slug.slice(this.SLUG_HEADER.length);
    if (slug.endsWith(this.SLUG_FOOTER)) slug = slug.slice(0, -this.SLUG_FOOTER.length);

    let decodedBytes, slugData;
    try {
      decodedBytes = Buffer.from(slug, 'base64').toString('utf-8');
      slugData = JSON.parse(decodedBytes);
    } catch (e) {
      throw new Error(\UVIX slug decode failure: \\);
    }

    function sortObjKeys(obj) {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortObjKeys);
      return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = sortObjKeys(obj[key]);
        return acc;
      }, {});
    }

    const sortedPayload = sortObjKeys(slugData.raw_payload || {});
    
    // Swift uses tight JSON by default. Python's default json.dumps uses spaces.
    // We compute both to ensure compatibility.
    const tightStr = JSON.stringify(sortedPayload);
    // Emulate Python's default spaced format:
    const spacedStr = tightStr.replace(/":/g, '": ').replace(/,"/g, ', "');
    
    const hashTight = crypto.createHash('sha256').update(tightStr).digest('hex');
    const hashSpaced = crypto.createHash('sha256').update(spacedStr).digest('hex');

    if (hashTight !== slugData.payload_hash && hashSpaced !== slugData.payload_hash) {
      throw new Error('UVIX slug integrity verification FAILED — payload hash mismatch');
    }

    return {
      protocolVersion: slugData.protocol_version || '1.0',
      sourcePlatform: slugData.source_platform || 'unknown',
      targetPlatform: slugData.target_platform || 'unknown',
      payloadHash: slugData.payload_hash || '',
      compatibilityLayer: slugData.compatibility_layer || 'default',
      rawPayload: slugData.raw_payload || {},
      signature: slugData.signature
    };
  }

  prepareHandover(slugObj) {
    return {
      handover_protocol: 'UVIX-RI-1.0',
      antigravity_target: slugObj.targetPlatform,
      slug_envelope: {
        protocol_version: slugObj.protocolVersion,
        source: slugObj.sourcePlatform,
        target: slugObj.targetPlatform,
        compatibility_layer: slugObj.compatibilityLayer,
        payload: slugObj.rawPayload,
        integrity_hash: slugObj.payloadHash,
        signature: slugObj.signature
      },
      handover_timestamp: new Date().toISOString(),
      reverse_engineered: true
    };
  }

  async executeHandover(slugObj, authToken) {
    const handoverPackage = this.prepareHandover(slugObj);
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': \Bearer \\,
      'X-UVIX-Protocol': slugObj.protocolVersion,
      'X-UVIX-Compatibility': slugObj.compatibilityLayer
    };

    const response = await fetch(this.antigravityEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(handoverPackage)
    });

    let respData;
    const respText = await response.text();
    try {
      respData = JSON.parse(respText);
    } catch {
      respData = respText;
    }

    return {
      statusCode: response.status,
      response: respData,
      handoverPackage
    };
  }
}

module.exports = { UVIXReverseEngineer };
