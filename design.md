# Earth Trend Detective (`ETG`) — Design System & Technical Specification

> **NASA Space Apps Challenge 2026 & Veritas AI Challenge** · Communal, AI-Native **Earth Trend Graph (`ETG`)**, 5K NASA GIBS Earth Visualizer & Denver Solar Microgrid Dispatch

---

## 1. Dual-View Architecture & Local Decision Workbench

1. **View 1 — Interactive 3D Earth + Timeline Scrubber + 5K NASA GIBS Satellite Filters**
   - Textured Three.js Earth globe ([EarthGlobe3D.tsx](src/components/EarthGlobe3D.tsx), modular `src/components/globe/`) displaying geo-pinned (`lat`, `lng`) observations, anomalies, cross-region `drives_opposite` teleconnection arcs, an accurate astronomical solar day/night terminator (`src/lib/earth/solarPosition.ts`), a **NASA SVS 4-Slice Earth Composite**, and **9 progressive 5K/2.5K HD NASA EOSDIS GIBS WMTS/WMS layers** (`Ocean Anomaly`, `Thermal`, `Water / Rain`, `Surface Winds`, `Air Temp`, `Aerosols` [MERRA-2 / MODIS AOD], `NDVI`, `True Color`, `VIIRS Night`, plus `Blue Marble`) proxied via `/api/earth/gibs`.
   - Clicking any coordinate queries **NASA POWER (CERES SYN1deg / MERRA-2)**, **USGS NWIS**, **Copernicus GloFAS v4 & CAMS PM2.5**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML/NSIDC/CDO**, **KNMI**, and **CSA/Geo.ca** inside a sub-2s fault-isolated budget ([upstreamResilience.ts](src/lib/earth/upstreamResilience.ts)) with deterministic climatological fallback when offline, running the **Statistical Trend Engine ([trendEngine.ts](src/lib/stats/trendEngine.ts))**:
     - **Mann-Kendall (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao effective-$N$)** & **Hirsch-Slack Seasonal Mann-Kendall (`p_s`)** with interactive **Raw Values vs. Seasonal Cycle Removed** chart toggling and **Benjamini-Hochberg FDR**.
     - **Theil-Sen Robust Slope** ($\hat{\beta}$ with 95% CI) and **Pettitt** change-point regime shift tests, paired with plain-English student readouts (`? Variable Guide` + [plainLanguage.ts](src/lib/plainLanguage.ts)).
   - Timeline scrubber (`observed_at`) replays how trends emerged, corroborated across independent sources, and evolved over time across `nasa_power`, `wildfire`, `ocean_temp`, `air_quality`, `deforestation`, `hydrology`, and `community` layers.

2. **View 2 — Coalesced AI-Native Earth Trend Graph (`ETG`), Trend Microscope & Multi-Scale ML**
   - Smooth `document.startViewTransition` switch where active geo-pinned signals coalesce into a connected knowledge graph (both 3D WebGL force-directed space and 2D Editorial Hairline Canvas in `src/components/graph/`) with k-hop workbench traversal (`src/components/workbench/`) and real-time **ETG Trend Microscope** perceptual radar badges.
   - **Scientific Ontology** (4 core labels):
     - `Concept`: Regions, coupled Earth systems, satellites, and community hardware (edge cameras, IoT sensors).
     - `Signal`: Timestamped observations (`lat`, `lng`, `dataset`, `confidence`, `observed_at`).
     - `Insight`: Detected scientific trends and cross-region teleconnections (`drives_opposite`, `correlates_with`).
     - `Rule`: Scientific corroboration & statistical gates (e.g., $\ge 2$ independent producer classes).
   - **Epistemic Belief Revision & Prospective Verification**: New scientific evidence links via `supersedes` edges so the graph preserves *how* and *why* a conclusion evolved; forecasts log and reconcile ex-ante in `.data/`.
   - **3-Tier ML Stack**:
     - **ETG Trend Microscope (`etg-trend-microscope-v1`)**: `0.9706` pre-MK inflection AUROC, `0.9827` directional coupling AUROC (`100%` illusion rejection), `0.9442` false-trend F1 ([trendMicroscope.ts](src/lib/graph/trendMicroscope.ts), [ml/weights/etg-trend-microscope-v1.json](ml/weights/etg-trend-microscope-v1.json)).
     - **Global Multi-Scale Inductive ETG Transformer (`etg-ml-v2`)**: Parameter-shared `P10–P50–P90` quantile forecasting, zero-shot unseen community sensor trust gating, and regional inference ([graphPredictor.ts](src/lib/graph/graphPredictor.ts), [ml/weights/etg-inductive-weights-v2.json](ml/weights/etg-inductive-weights-v2.json), GCP `L4` FastAPI service `ml/l4_service/`).
     - **Python ST-GNN (`etg-ml-v1`)**: Zero-dependency `ETGLagGraphNet` (`+51.38%` RMSE lift: `1.8166` vs. `3.7362` Self-AR; [ml/etg_stgnn.py](ml/etg_stgnn.py)).
   - **Denver Solar Microgrid (`SolarMicrogridPanel.tsx`, `/?demo=veritas`)**: 7-node Front Range graph combining Colab HGBR `Q_0.268 < 3.50` (`0.9278` RMSE, `88.6%` storm recall, `+$418/yr` on `n=606` unseen days) with live `GET /api/earth/solar-graph` rolling Ridge + **calibrated probabilistic `P(ALLSKY < 3.5 | forecast)` Bayes dispatch** (`0.899` RMSE, Storm Brier `0.080`, `+$218/yr` Bayes vs. `+$180/yr` threshold).

3. **Communal, Hardware-Agnostic & AI-Native Ingestion**
   - **MCP Streamable HTTP & SSE (16 tools)** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`) + **OpenAPI 3.1.0** (`/api/mcp/openapi`) + AI Detective (`/api/ai/detective`).
   - **Graph & ML Endpoints**: `/api/graph`, `/api/graph/traverse`, `/api/graph/predict`, `/api/graph/microscope`, `/api/graph/revise`, `/api/graph/stream`, and **Hardware Webhooks** (`/api/graph/nodes/[nodeId]/webhook`).
   - **NASA & Open Earth APIs**: `/api/earth/gibs`, `/api/earth/timeseries`, `/api/earth/open-feeds`, `/api/earth/dataset-import`, `/api/earth/discover`, `/api/earth/eonet`, and `/api/earth/solar-graph`.

---

## 2. Visual Aesthetics: Editorial Broadsheet, Hairline Ledger & WCAG Accessibility

- **Obsidian Dark (`#161617` / `#1f1f21`) & Warm Ivory (`#fafafa` / `#f4f4f5`)** modular CSS layers (`src/styles/{properties,tokens,theme,base,animations,surfaces,premium,scrollbars,prose,print}.css` imported via [src/app/globals.css](src/app/globals.css)) synced with `<meta name="color-scheme" content="light dark">` and CSS `color-scheme`.
- **Crisp Hairline Rules**: `1px solid var(--border)` structural dividers, `tabular-nums` (`.ws-numeric`) on all p-values, slopes, and coordinates, and clean matte cards (`.ws-card`) without SaaS bloat.
- **Native Web Platform Primitives & Accessibility**: Native `<dialog>` with `closedby="any"` + bounding-box light-dismiss fallback ([dialogLightDismiss.ts](src/lib/a11y/dialogLightDismiss.ts)) + focus traps ([dialogFocusTrap.ts](src/lib/a11y/dialogFocusTrap.ts)), roving `focusgroup="toolbar wrap"`, native `<input type="range">` timeline scrubber, WCAG accessible comparison tables (`<th scope="row">`, `<caption>`, `tabIndex={0}` scroll regions), and `document.startViewTransition()` focus routing.
