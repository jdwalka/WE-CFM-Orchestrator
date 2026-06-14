# Agent Context: Albie Registration

This document provides context for the connected agent regarding its registration environment.

## Project Overview

This workspace handles the registration of the chat agent named **Albie** to the [Agentverse](https://agentverse.ai/) network.

## Key Files

- `register_agent.py`: A Python script that utilizes `uagents_core` to register the agent. It reads necessary authentication details from environment variables.
- `.env`: A local environment file that stores:
  - `AGENTVERSE_KEY`: The JWT token used to authenticate with Agentverse.
  - `AGENT_SEED_PHRASE`: A unique seed phrase used to derive the agent's cryptographic identity on the fetch.ai network.

## Agent Configuration Details

- **Name**: Albie
- **URL Endpoint**: `https://prairiedog-godzilla.ts.net`
- **Active**: `True`

## How it works

When `register_agent.py` is executed, it loads the `.env` file using the `python-dotenv` package, then calls `register_chat_agent(...)` with the provided credentials. This allows the agent to securely announce its endpoint and identity to the Agentverse platform.
