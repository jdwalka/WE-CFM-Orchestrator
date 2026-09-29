import json
import hashlib
import base64
import requests
import os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
from dataclasses import dataclass, asdict
import uvicorn

app = FastAPI(title="UVIX AI Gateway Server", version="2.0")

@dataclass
class UVIXSlug:
    protocol_version: str
    source_platform: str
    target_platform: str
    payload_hash: str
    compatibility_layer: str
    raw_payload: Dict[str, Any]
    signature: Optional[str] = None

    def verify_integrity(self) -> bool:
        payload_str = json.dumps(self.raw_payload, sort_keys=True)
        computed_hash = hashlib.sha256(payload_str.encode()).hexdigest()
        return computed_hash == self.payload_hash

class GatewayReverseEngineer:
    def __init__(self):
        # Point directly to your Cloudflare AI Gateway proxy
        self.gateway_url = "https://wecrypto.leaksnipe.win/v1"
        
        # Pull tokens securely from the server environment
        self.gateway_token = os.environ.get("AI_GATEWAY_TOKEN")
        self.cf_client_id = os.environ.get("CF_ACCESS_CLIENT_ID", "")
        self.cf_client_secret = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")

    def decode_slug(self, encoded_slug: str) -> UVIXSlug:
        # Strip header/footer
        clean_slug = encoded_slug.replace("UVIX::", "").replace("::END", "")
        decoded_bytes = base64.b64decode(clean_slug)
        slug_data = json.loads(decoded_bytes)

        slug = UVIXSlug(**slug_data)
        if not slug.verify_integrity():
            raise ValueError("Integrity verification FAILED — payload hash mismatch")
        return slug

    def execute_gateway_handover(self, slug: UVIXSlug) -> Dict[str, Any]:
        """Routes the Antigravity handover through Cloudflare AI Gateway"""
        
        # Wrap the decoded payload into the Vertex AI/Antigravity structure
        handover_package = {
            "handover_protocol": "UVIX-RI-1.0",
            "antigravity_target": slug.target_platform,
            "slug_envelope": asdict(slug)
        }

        # Auth uses your Gateway token, plus CF Access headers to clear the WAF
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.gateway_token}",
            "CF-Access-Client-Id": self.cf_client_id,
            "CF-Access-Client-Secret": self.cf_client_secret,
            "X-UVIX-Protocol": slug.protocol_version
        }

        # The Gateway routes this specific path to your Google Vertex keys
        target_endpoint = f"{self.gateway_url}/google/antigravity/handover"
        
        response = requests.post(target_endpoint, json=handover_package, headers=headers, timeout=30)
        return {"status_code": response.status_code, "response": response.text}

class HandoverRequest(BaseModel):
    uvix_slug: str

@app.post("/uvix/gateway/handover")
async def handle_gateway_handover(request: HandoverRequest):
    engine = GatewayReverseEngineer()
    
    try:
        decoded_slug = engine.decode_slug(request.uvix_slug)
        result = engine.execute_gateway_handover(decoded_slug)
        
        return {
            "status": "success",
            "source": decoded_slug.source_platform,
            "gateway_response": result
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
