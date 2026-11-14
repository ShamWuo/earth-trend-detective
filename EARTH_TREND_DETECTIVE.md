# Earth Trend Detective — Architecture & Hackathon Plan

> **NASA Space Apps Challenge** · Communal, AI-Native Knowledge Graph for Global Earth Trend Awareness  
> Inspired by Blueprint's Knowledge Graph visualizer and UI design, tailored exclusively for **Earth trends**.

---

## 1. Dual-View Experience

1. **View 1 — Interactive Earth + Timeline Scrubber + Dataset Selector**
   - **3D Earth Visual**: Displays geo-pinned (`lat`, `lng`) observations, anomalies, and trend clusters. Clicking any coordinate pulls real multi-year time-series via **NASA POWER / MERRA-2** (plus **NASA FIRMS / EONET**).
   - **Timeline Scrubber**: Drag across timestamps (`observed_at`) to replay how Earth trends emerged, spread, or subsided over time.
   - **Dataset Selector**: Toggle layers such as NASA POWER (temp, precipitation, humidity, solar), NASA FIRMS (wildfire thermal), Air Quality (PM2.5), Ocean Temp Anomaly, and Canopy/NDVI.
   - **Statistical Trend Engine**: Automatically computes **Mann-Kendall significance (`p-value`)** and **Theil-Sen slope (rate of change)** so users immediately see whether a shift is a *statistically significant trend* or *normal environmental variability*.

2. **View 2 — Coalesced AI-Native Earth Trend Graph (ETG)**
   - **Earth-to-Graph Transition**: Switching views coalesces the active geo-pinned Earth signals into the **Earth Trend Graph (ETG)**, highlighting **cross-region teleconnections** (e.g., how one Earth process drives a variable *up* in one region and *down* in another).
   - **Earth-Native Ontology** *(no Variable, Logic, or Doc nodes)*:
     - `Concept`: Regions, Earth systems, satellites, and community hardware (cameras, sensors).
     - `Signal`: Timestamped observations from NASA APIs, cameras, or IoT devices.
     - `Insight`: Detected Earth trends and cross-region correlations.
     - `Rule`: Corroboration & verification gates (e.g., ≥2 independent sources).
   - **Epistemic Belief Revision**: New observations link via `supersedes` edges so the graph preserves *how* and *why* an Earth trend evolved.

---

## 2. Communal, Hardware-Agnostic & AI-Native Ingestion

| Producer | Protocol / Endpoint | Graph Effect |
| :--- | :--- | :--- |
| **Any AI Agent** (vision, forecasting, LLM) | MCP / SSE (`/api/mcp/sse`) & OpenAPI (`/api/mcp/openapi`) | Queries multi-hop context and creates/updates `Insight` or `Signal` nodes. |
| **Cameras & IoT Hardware** (ESP32, Pi, weather stations) | Node Webhooks (`/api/graph/nodes/[nodeId]/webhook`) | Pushes live readings with `lat`, `lng`, `device_id`, `dataset`, and `observed_at`. |
| **NASA & Open Earth APIs** (FIRMS, MODIS, Open-Meteo) | Scheduled / webhook adapter | Streams global satellite anomalies to corroborate local community sensors. |
