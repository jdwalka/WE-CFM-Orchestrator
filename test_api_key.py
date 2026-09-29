import os
import requests

API_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""

endpoints = {
    "Google Gemini API": {
        "url": "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        "headers": {
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY,
        },
        "post_data": {
            "contents": [{
                "parts": [{"text": "Explain how AI works in a few words"}]
            }]
        }
    }
}

for name, config in endpoints.items():
    print(f"\nTesting {name}...")
    try:
        resp = requests.post(config["url"], headers=config["headers"], json=config["post_data"], timeout=10)
        print(f"Status Code: {resp.status_code}")
        print(f"Response received ({len(resp.text)} chars)")
    except Exception as e:
        print(f"Error: {e}")
