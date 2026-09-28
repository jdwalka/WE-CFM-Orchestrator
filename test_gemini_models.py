import urllib.request
import json
import os
import sys

# API key comes from environment (.env) — never hardcoded.
API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GEMINI_API_KEY_FALLBACK") or os.getenv("GOOGLE_API_KEY") or ""
BASE = "https://generativelanguage.googleapis.com/v1beta/models"
PROMPT = "Say OK if working"

# Full model line from API — cheapest/smallest first, largest/most capable last
MODELS = [
    # Flash Lite (cheapest)
    "gemini-flash-lite-latest",
    "gemini-2.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite-preview",
    "gemini-3.5-flash-lite",
    # Flash mid-tier
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-2.5-flash",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-lite-image",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    # Omni
    "gemini-omni-flash-preview",
    "gemini-omni-1.1-flash",
    # Image generation
    "gemini-2.5-flash-image",
    # Gemma open models
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
    # Pro tier
    "gemini-pro-latest",
    "gemini-2.5-pro",
    "gemini-3-pro-image-preview",
    "gemini-3-pro-image",
    "gemini-3.1-pro-preview",
    "gemini-3.1-pro-preview-customtools",
    # Exotic / research
    "nano-banana-pro-preview",
    "gemini-2.5-computer-use-preview-10-2025",
    "antigravity-preview-05-2026",
    "antigravity-preview-09-2026",
    "antigravity-preview-latest",
    "deep-research-preview-04-2026",
    "deep-research-pro-preview-12-2025",
    "deep-research-max-preview-04-2026",
]

payload = json.dumps({
    "contents": [{"parts": [{"text": PROMPT}]}]
}).encode("utf-8")

results = {"ok": [], "fail": [], "quota": [], "demand": []}

for model in MODELS:
    url = f"{BASE}/{model}:generateContent"
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-goog-api-key": API_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            print(f"[OK]    {model}: {text[:60]}")
            results["ok"].append(model)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        err_obj = json.loads(body).get("error", {})
        msg = err_obj.get("message", body)
        if "quota" in msg.lower() or "exceeded" in msg.lower():
            print(f"[QUOTA] {model}: quota exceeded")
            results["quota"].append(model)
        elif "high demand" in msg.lower() or "temporary" in msg.lower():
            print(f"[BUSY]  {model}: high demand / try later")
            results["demand"].append(model)
        elif "no longer available" in msg.lower() or "not found" in msg.lower():
            # extract suggested replacement if any
            hint = ""
            if "use models/" in msg:
                hint = " -> " + msg.split("use models/")[1].split(" ")[0]
            print(f"[GONE]  {model}{hint}")
            results["fail"].append(model)
        else:
            print(f"[FAIL]  {model}: {msg[:100]}")
            results["fail"].append(model)
    except Exception as e:
        print(f"[ERR]   {model}: {e}")
        results["fail"].append(model)

print()
print("=" * 60)
print(f"WORKING ({len(results['ok'])}): {', '.join(results['ok'])}")
print(f"QUOTA   ({len(results['quota'])}): {', '.join(results['quota'])}")
print(f"BUSY    ({len(results['demand'])}): {', '.join(results['demand'])}")
print(f"GONE    ({len(results['fail'])}): {', '.join(results['fail'])}")

# Write working models to a file so gemini_agent.py can pick the best one
with open("working_models.json", "w") as f:
    json.dump(results, f, indent=2)
print()
print("Results saved to working_models.json")
