import requests
r = requests.get("https://benchmarks.pyth.network/v1/shims/tradingview/search?query=BTC")
print(r.status_code, r.text[:200])
