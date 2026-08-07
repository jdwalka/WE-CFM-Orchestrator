# Multi-stage Dockerfile for WE-CFM-Orchestrator
# Stage 1: Build dependencies and application
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ ca-certificates git

# Copy package files
COPY package*.json ./

# Install dependencies with production flag
RUN npm install --omit=dev --legacy-peer-deps && npm cache clean --force

# Stage 2: Runtime
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache \
    ca-certificates \
    curl

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# Create non-root user for security
RUN addgroup -S wecryp && \
    adduser -S -D -H -u 1001 -G wecryp wecryp && \
    chown -R wecryp:wecryp /app

USER wecryp

# Environment variables
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=8192" \
    WECRYPTO_REQUIRE_CLOUD_READY=0

# Health check — web service exposes /api/status; proxy /health via curl
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -sf http://localhost:3443/api/status > /dev/null || exit 1

# Expose ports
EXPOSE 3443 3010 3000

# Runtime entry point (headless: orbital pipeline + web service)
CMD ["node", "scripts/start-runtime.js"]
