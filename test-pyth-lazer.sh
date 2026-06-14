#!/bin/bash

# Install wscat if not already installed
# npm install -g wscat

# Export your API key so it never ends up in shell history or version control
# export LAZER_TOKEN="your-api-key-here"

# Connect to Pyth Lazer WebSocket with authentication
wscat -c "wss://pyth-lazer-0.dourolabs.app/v1/stream" \
  -H "Authorization: Bearer $LAZER_TOKEN"

# Once connected, send this subscription message:
# {"channel":"fixed_rate@200ms","deliveryFormat":"json","formats":["solana"],"jsonBinaryEncoding":"hex","parsed":true,"priceFeedIds":[1,2,6,13,15,14],"properties":["price","bestBidPrice","bestAskPrice","confidence","fundingRate","fundingRateInterval","marketSession","feedUpdateTimestamp","fundingTimestamp","publisherCount","exponent"],"subscriptionId":1,"type":"subscribe"}

# To ignore invalid feed IDs instead of failing, add "ignoreInvalidFeeds": true to the message

# Alternative: Using curl for one-shot requests (HTTP API)
# curl -X POST "https://pyth-lazer-0.dourolabs.app/v1/latest_price" \
#   -H "Authorization: Bearer $LAZER_TOKEN" \
#   -H "Content-Type: application/json" \
#   -d '{"formats":["solana"],"parsed":true,"priceFeedIds":[1,2,6,13,15,14],"properties":["price","bestBidPrice","bestAskPrice","confidence","fundingRate","fundingRateInterval","marketSession","feedUpdateTimestamp","fundingTimestamp","publisherCount","exponent"]}'
