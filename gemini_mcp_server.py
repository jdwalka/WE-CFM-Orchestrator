#!/usr/bin/env python3
import asyncio
import os
import uvicorn
import requests
from mcp.server.mcpserver import MCPServer

# Create an MCP server instance
mcp = MCPServer("WeCrypto-Gemini-Bridge")

BRIDGE_TOKEN = "6cd0f0761cd8a89e22cce37dbccaa2ce5d83a9a4d5940eb75ba71b3cbb21a7fa"

# We hit our existing backend (the wecrypto-bridge we made via google.leaksnipe.win)
@mcp.tool()
def get_kalshi_ladder(symbol: str = "BTC") -> str:
    """Fetch the live Kalshi strike ladder and market odds for a given symbol (e.g. BTC)"""
    res = requests.get(
        f"https://google.leaksnipe.win/gemini/ladder?symbol={symbol}",
        headers={"x-bridge-token": BRIDGE_TOKEN},
        timeout=10
    )
    if res.status_code == 200:
        return res.text
    return f"Error: {res.status_code} - {res.text}"

@mcp.tool()
def get_market_snapshot() -> str:
    """Fetch the full live market snapshot including spots and regimes."""
    res = requests.get(
        "https://google.leaksnipe.win/gemini/snapshot",
        headers={"x-bridge-token": BRIDGE_TOKEN},
        timeout=10
    )
    if res.status_code == 200:
        return res.text
    return f"Error: {res.status_code} - {res.text}"

@mcp.tool()
def query_jdwalkaz_agent(query: str) -> str:
    """Send a complex trading query to the jdwalkaz expert ASI1 agent."""
    res = requests.post(
        "https://google.leaksnipe.win/gemini/query",
        headers={"x-bridge-token": BRIDGE_TOKEN, "Content-Type": "application/json"},
        json={"query": query},
        timeout=15
    )
    if res.status_code == 200:
        return res.json().get("content", str(res.json()))
    return f"Error: {res.status_code} - {res.text}"

if __name__ == "__main__":
    print("Starting WeCryp MCP Server on http://127.0.0.1:8005/sse")
    # MCPServer automatically exposes an SSE endpoint on /sse when run with starlette
    mcp.run("sse", port=8005, host="127.0.0.1")
