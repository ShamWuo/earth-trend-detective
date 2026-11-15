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
   - **ETG Trend Microscope (`etg-trend-microscope-v1`) & Inductive GNN (`etg-ml-v2`)**: 3-head AI sensory organ ([ml/etg_trend_microscope.py](ml/etg_trend_microscope.py), [trendMicroscope.ts](src/lib/graph/trendMicroscope.ts)) achieves `0.9789` pre-Mann-Kendall inflection AUROC (vs. `0.4442` MK; `79.6%` fresh-break recall), `0.9916` directional coupling AUROC (vs. `0.7010` Pearson $|r|$; `98.9%` illusion rejection), `0.0570` simplex MAE, and `0.9380` false-trend F1; paired with parameter-shared **Inductive ETG Transformer (`etg-ml-v2`, `P10–P50–P90`)** ([ml/etg_inductive_gnn.py](ml/etg_inductive_gnn.py)) and Python **`ETGLagGraphNet`** (`+51.38%` RMSE lift: `1.8166` vs. `3.7362`).

3. **Global & Denver Solar Microgrid (`SolarGraph` + `etg-global-gnn-v3`, `/?demo=veritas`)**
   - Canonical 7-node Front Range upwind graph + **click-anywhere 7-node global upwind ring (`GET /api/earth/solar-graph?lat=&lng=`)** (`2019–2026`) fusing NASA POWER Daily + Open-Meteo `18:00–23:00` evening hourly advection.
   - Colab HGBR (`n = 606` unseen `2025–2026` days, `Q_0.268 < 3.50`): `0.9278` RMSE (`+32.9%` skill vs. Persistence `1.3819`, `p = 4.96e-14`), `88.6%` storm recall, `+$418/yr` prototype tariff savings (`p = 0.0135` vs. Local+23h).
   - **`etg-global-gnn-v3` (`2,043,212` params, `~14 ms` fp16 CPU)**: Trained across `36` global cities / `252` NASA POWER Daily+Hourly (`LST`) stations (`54,570` train graph-days), achieving `+22.8%` 5-continent zero-shot skill (Salt Lake City `+30.86%`, Madrid `+33.62%`, Tokyo `+22.67%`, Sydney `+25.13%`, Santiago `+1.89%`) and unseen `2025–2026` Denver (`n=678`) `0.9947` 0-shot / `0.9397` adapted RMSE (`+32.6%`, `p = 4.58e-17`, `+$205/yr`).
   - Live Web App (`GET /api/earth/solar-graph`): Rolling Ridge (`0.899` Graph+Eve RMSE, Storm Brier `0.080`) + inner-validation **calibrated probabilistic `P(ALLSKY < 3.5 | forecast)` Bayes dispatch** (`+$218/yr` vs. `+$180/yr` fixed threshold).

---

## 2. Communal, Hardware-Agnostic & AI-Native Ingestion

| Producer | Protocol / Endpoint | Graph Effect |
| :--- | :--- | :--- |
| **Any AI Agent** (vision, forecasting, LLM) | **16-Tool MCP Streamable HTTP & SSE** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`), **OpenAPI 3.1.0** (`/api/mcp/openapi`), & `/api/ai/detective` | Queries k-hop context, runs Trend Microscope scans (`/api/graph/microscope`) & inductive `etg-ml-v2` forecasts (`/api/graph/predict`), logs/revises `Insight` or `Signal` nodes (`/api/graph/revise`). |
| **Cameras & IoT Hardware** (ESP32, Pi, weather stations, KDEN) | Node Webhooks (`/api/graph/nodes/[nodeId]/webhook`), CLI (`scripts/stream_ground_sensor.mjs`), & 1-click KDEN/NWS UI ingest | Pushes live readings with `lat`, `lng`, `device_id`, `dataset`, and `observed_at` with zero-shot `etg-ml-v2` trust gating. |
| **NASA & Open Earth APIs** (GIBS, POWER, EONET, GISTEMP, NOAA, USGS, GloFAS, CAMS) | `/api/earth/gibs`, `/api/earth/timeseries`, `/api/earth/open-feeds`, `/api/earth/discover`, `/api/earth/eonet`, `/api/earth/dataset-import`, `/api/earth/solar-graph` | Streams global satellite imagery, multi-agency anomalies, and local physical gauges to corroborate community sensors. |
