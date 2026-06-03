# System Architecture & Data Clusters

WE-CRYPTO is designed around a resilient, multi-process architecture. It uses Electron for the desktop orchestrator and a robust **Dockerized Orbital Matrix** to handle extreme data ingestion volumes.

## Docker Containerization & Data Clusters

To manage the high throughput of ticks, order book imbalances, and on-chain telemetry, the system relies on isolated Docker containers. This ensures that the primary UI and prediction engines are never starved of resources.

### The Orbital Matrix (Redpanda)

```mermaid
graph TD
    subgraph Docker Containerization
        R[Redpanda Broker] -->|Topics| T1(wecrypto.orbital.ticks)
        R -->|Topics| T2(wecrypto.orbital.mempool)
        R -->|Topics| T3(wecrypto.orbital.dex)
        I[Orbital Ingestor Daemon] -->|Publishes| R
    end

    subgraph Electron Main Process
        P[Proxy Orchestrator] -->|Routes| I
        IPC[IPC Bridge] <--> P
    end

    subgraph Renderer (UI)
        UI[Network Health Dashboard] -.->|Probes :9644| R
    end

    I -->|Consumes from| External[External APIs]
```

### Key Components

1. **Redpanda Kafka Cluster (Docker):**
   - Provides an ultra-low latency event bus for the application.
   - Hosted in a lightweight Docker container, it streams pricing and blockchain data asynchronously.
   - The UI probes `localhost:9644` to verify the health of the data cluster.

2. **Proxy Orchestrator (`main.js` & `proxy-orchestrator.js`):**
   - Manages traffic routing across local Tor nodes and standard fetch limits.
   - Prevents IP bans by distributing requests across available clusters.

3. **Electron IPC Bridge:**
   - The boundary between the Node.js backend (which accesses the filesystem and Docker instances) and the frontend React/Vanilla UI.
   - Handles heavy computations like **Contract Cache Discovery** without freezing the main UI thread by utilizing `fs.promises` and asynchronous candidate gathering.
