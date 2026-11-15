# Earth Trend Detective — Architecture & Hackathon Plan

> **NASA Space Apps Challenge 2026 & Veritas AI Challenge** · Communal, AI-Native Knowledge Graph for Global Earth Trend Awareness & Denver Solar Microgrid Dispatch  
> Inspired by Obsidian Dark editorial graphing UIs, engineered exclusively for **Earth trends**.

---

## 1. Dual-View Experience & Local Microgrid

1. **View 1 — Interactive 3D Earth + Timeline Scrubber + 5K NASA GIBS Satellite Filters**
   - **3D Earth Visual ([EarthGlobe3D.tsx](src/components/EarthGlobe3D.tsx))**: Displays geo-pinned (`lat`, `lng`) observations, anomalies, `drives_opposite` teleconnection arcs, an astronomical solar day/night terminator, a **NASA SVS 4-Slice Earth Composite**, and **9 progressive 5K/2.5K HD NASA EOSDIS GIBS layers** (`Ocean Anomaly` [GHRSST L4 MUR SST], `Thermal` [MODIS Terra LST + MUR SST], `Water / Rain` [MERRA-2 Vapor + GPM IMERG], `Surface Winds` [MERRA-2], `Air Temp` [MERRA-2 2m T2M], `Aerosols` [MERRA-2 / MODIS AOD], `NDVI` [MODIS Terra 250m], `True Color` [MODIS Terra 250m + Clouds], `VIIRS Night` [Suomi NPP VIIRS], plus `Blue Marble`).
   - **Multi-Agency Coordinate Probing & Resilience**: Clicking any coordinate queries **NASA POWER (CERES SYN1deg / MERRA-2)**, **Open-Meteo (ERA5 hourly, Copernicus GloFAS v4, CAMS PM2.5)**, **USGS NWIS**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML/NSIDC/CDO**, **KNMI**, and **CSA/Geo.ca** within a sub-2s fault-isolated budget ([upstreamResilience.ts](src/lib/earth/upstreamResilience.ts)).
   - **Timeline Scrubber & Dataset Selector**: Replay `observed_at` anomalies across `nasa_power`, `wildfire`, `ocean_temp`, `air_quality`, `deforestation`, `hydrology`, and `community` layers, with an accessible **? Variable Guide** popover and **Raw Values vs. Seasonal Cycle Removed** chart toggle.
   - **Statistical Trend Engine ([trendEngine.ts](src/lib/stats/trendEngine.ts))**: Computes exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao effective-$N$), **Hirsch-Slack Seasonal Mann-Kendall (`p_s`)**, **Benjamini-Hochberg FDR**, **Theil-Sen** slopes + 95% CI, and Pettitt regime shifts.

2. **View 2 — Coalesced AI-Native Earth Trend Graph (`ETG`), Trend Microscope & Multi-Scale ML**
   - **Earth-to-Graph Transition**: Switching views coalesces active geo-pinned Earth signals into the 3D/2D **Earth Trend Graph (`ETG`)**, explicitly mapping cross-region teleconnections and 1-click **Guided Opposite-Trend Case Studies**.
   - **Earth-Native Ontology** *(no Variable, Logic, or Doc nodes)*:
     - `Concept`: Regions, Earth systems, satellites, and community hardware (cameras, IoT sensors).
     - `Signal`: Timestamped observations from NASA APIs, open physical feeds, cameras, or IoT devices.
     - `Insight`: Detected Earth trends and cross-region correlations (`drives_opposite`, `teleconnects`, `correlates_with`).
     - `Rule`: Corroboration & verification gates (e.g., ≥2 independent sources).
   - **Epistemic Belief Revision & Prospective Verification Ledger**: New observations link via `supersedes` edges to preserve scientific lineage, while forecasts reconcile ex-ante against newly arrived observations.
   - **ETG Trend Microscope (`etg-trend-microscope-v1`) & Inductive GNN (`etg-ml-v2`)**: 3-head AI sensory organ ([ml/etg_trend_microscope.py](ml/etg_trend_microscope.py), [trendMicroscope.ts](src/lib/graph/trendMicroscope.ts)) achieves `0.9706` pre-Mann-Kendall inflection AUROC, `0.9827` directional coupling AUROC (`100%` illusion rejection), and `0.9442` false-trend F1; paired with parameter-shared **Inductive ETG Transformer (`etg-ml-v2`, `P10–P50–P90`)** ([ml/etg_inductive_gnn.py](ml/etg_inductive_gnn.py)) and Python **`ETGLagGraphNet`** (`+51.38%` RMSE lift: `1.8166` vs. `3.7362`).

3. **Denver Solar Microgrid (`SolarGraph`, `/?demo=veritas`)**
   - 7-node Front Range upwind graph (`2019–2026`) fusing NASA POWER Daily + Open-Meteo `18:00–23:00 MST` hourly advection.
   - Colab HGBR (`n = 606` unseen `2025–2026` days, `Q_0.268 < 3.50`): `0.9278` RMSE (`+32.9%` skill vs. Persistence `1.3819`, `p = 4.96e-14`), `88.6%` storm recall, `+$418/yr` prototype tariff savings (`p = 0.0135` vs. Local+23h).
   - Live Web App (`GET /api/earth/solar-graph`): Rolling Ridge + Open-Meteo bridge (`0.899` Graph+Eve RMSE, Storm Brier `0.080`) + inner-validation **calibrated probabilistic `P(ALLSKY < 3.5 | forecast)` Bayes dispatch** (`+$218/yr` vs. `+$180/yr` fixed threshold).

---

## 2. Communal, Hardware-Agnostic & AI-Native Ingestion

| Producer | Protocol / Endpoint | Graph Effect |
| :--- | :--- | :--- |
| **Any AI Agent** (vision, forecasting, LLM) | **16-Tool MCP Streamable HTTP & SSE** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`), **OpenAPI 3.1.0** (`/api/mcp/openapi`), & `/api/ai/detective` | Queries k-hop context, runs Trend Microscope scans (`/api/graph/microscope`) & inductive `etg-ml-v2` forecasts (`/api/graph/predict`), logs/revises `Insight` or `Signal` nodes (`/api/graph/revise`). |
| **Cameras & IoT Hardware** (ESP32, Pi, weather stations) | Node Webhooks (`/api/graph/nodes/[nodeId]/webhook`) | Pushes live readings with `lat`, `lng`, `device_id`, `dataset`, and `observed_at` with zero-shot `etg-ml-v2` trust gating. |
| **NASA & Open Earth APIs** (GIBS, POWER, EONET, GISTEMP, NOAA, USGS, GloFAS, CAMS) | `/api/earth/gibs`, `/api/earth/timeseries`, `/api/earth/open-feeds`, `/api/earth/discover`, `/api/earth/eonet`, `/api/earth/dataset-import`, `/api/earth/solar-graph` | Streams global satellite imagery, multi-agency anomalies, and local physical gauges to corroborate community sensors. |
