# Server Restore Priority Checklist

Now that the base packages are down, the next phase is configuring the local environment to get the predictive engines and analytics modules back online without bottlenecking. Here is the priority checklist to restore the infrastructure.

### Phase 1: Core System & Container Initialization

* **Hardware Optimization:** Verify the latest AMD Ryzen chipset drivers and TUF motherboard utilities are installed to ensure the server is fully optimized for heavy computational processing.
* **Windows 10 Pro N Requirements:** Install the Windows Media Feature Pack if you haven't already. The 'N' edition lacks native media dependencies that some backend visualization tools or dependencies might quietly require.
* **Docker Deployment:** Initialize Docker and rebuild the containers responsible for Google Cloud infrastructure provisioning.

### Phase 2: Database & Latency Management

* **Firebase Authentication:** Re-authenticate the local environment. Verify the decoupled schema is routing correctly, ensuring high-frequency event streams are strictly separated from deep-lane tensor batches.
* **TIDE Storage Integration:** Re-link TIDE for long-term archiving. Confirm the automated archival functions are routing structured JSON payloads into TIDE seamlessly so they do not interfere with the low-latency execution layer.

### Phase 3: WECRYPTO & Live Data Feeds

* **Orbital Coherence Logic:** Pull down the WECRYPTO repositories. Validate the scripts running the 15-minute prediction cycles and test the classification logic to ensure market signals are accurately categorizing into their s, p, d, and f orbitals.
* **WebSocket Aggregation:** Re-establish the live WebSocket feeds for canonical chain state. Ensure the routing pulls current prices from CoinGecko and correctly cross-references with Coinbase for validation to bypass third-party oracles.
* **Vertex AI & Execution:** Verify Vertex AI connections for tabular market data inference. Confirm that calculated orbital metrics (like the OEQ) are communicating properly with Kalshi for automated counter-trades, and monitor the EV-based capital allocation system during the initial sync.

### Phase 4: Analytics Modules & Portfolio Tracking

* **Project Charcuterie:** Initialize the core AGI architecture environment and ensure it has uninterrupted access to Vertex AI and the Firebase execution layer.
* **Poker Infrastructure:** Clone the Kronos Project repositories. Re-link the local databases handling tournament history and ensure **leak Snipe** and **D-Dossier** are fully operational.
* **Asset Tracking:** Verify the monitoring scripts for Render, Solana, and Polkadot are accurately fetching estimated network APYs and tracking prediction market contracts.
