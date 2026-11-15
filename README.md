# Earth Trend Detective (`ETG`)

> **Dual-Competition Submission:**
> - **NASA Space Apps Challenge 2026** — Official Challenge: **"Be An Earth System Trend Detective!"** (*Theme: "The Next Frontier"*)
> - **Veritas AI International High School Hackathon** — Selected Track: **Climate**
>
> A communal, AI-native **Earth Trend Graph (`ETG`)**, interactive Earth-timeline visualizer, and **Denver Solar Microgrid Local Climate Graph** for discovering, forecasting, and explaining statistically significant Earth trends.

## Judge Zero-Click Deep-Links

- **NASA Space Apps Mode:** Open `/?demo=spaceapps` to auto-activate **5K NASA GIBS `Ocean Anomaly`** in Full Daylight, frame & analyze the **`ENSO Pacific Rainfall Seesaw`** dipole, trigger live NASA/NOAA/CSA Earth discovery, and expose the **Guided Opposite-Trend Case Studies** and student `? Variable Guide`.
- **Veritas AI Climate Mode:** Open `/?demo=veritas` to auto-launch the **Denver 7-Node Solar Microgrid & Evening Advection** evaluation (`4-way` ablation, calibrated K-12 tariff savings, and failure audit).

## Key Capabilities

- **View 1 — Interactive 3D Earth Globe**: **5K HD progressive NASA EOSDIS GIBS satellite filters** (`Ocean Anomaly`, `Thermal Band`, `Precip Rate`, `Surface Winds`, `Aerosols`, `NDVI`, `VIIRS Night Lights`, `Blue Marble`, plus a **NASA SVS 4-Slice Earth Composite**), optional live **astronomical day/night solar terminator**, geo-pinned (`lat`, `lng`) observations, cross-region `drives_opposite` teleconnection arcs, 1-click **Guided Opposite-Trend Case Studies**, and click-anywhere coordinate probing across direct physical open feeds (**NASA POWER MERRA-2**, **USGS NWIS**, **Copernicus GloFAS v4**, **Copernicus CAMS PM2.5**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML**).
- **View 2 — Coalesced Earth Trend Graph (`ETG`)**: Dual 3D WebGL & 2D Editorial Canvas force-directed graph built on a strict scientific ontology (`Concept`, `Signal`, `Insight`, `Rule`), surfacing opposite-trend dipoles and **Epistemic Belief Revision** (`supersedes` lineage).
- **Statistical Significance & Deseasonalization Engine (`src/lib/stats/trendEngine.ts`)**: Exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao autocorrelation adjustment), **Hirsch-Slack Seasonal Mann-Kendall (`computeSeasonalMannKendall`, $p_s$)** with an interactive **Raw Values vs. Seasonal Cycle Removed** chart toggle, **Benjamini-Hochberg FDR**, **Theil-Sen** slopes + 95% CI, Pettitt regime shifts, and plain-English student readouts (`? Variable Guide` + 3-line stat key).
- **Denver Solar Microgrid — 7-Node Local Climate Graph (`Solar Graph`)**: Forecasts tomorrow's solar irradiance (`ALLSKY_SFC_SW_DWN`) for a Denver K-12 school microgrid (`250 kWdc` PV + `350 kWh` LFP battery) fusing **NASA POWER Daily** + **Open-Meteo `18:00–23:00 MST` hourly advection** across 7 Front Range nodes (`2019–2026`, `n = 606` unseen `2025–2026` test days) with zero-tuning Newsvendor critical-fractile quantile dispatch ($q^* = 0.075 / 0.280 \approx 0.268$).
  - **4-Way Unseen Ablation (Colab HGBR, `Q_0.268 < 3.50`):** `1.3819` Persistence (`$1,532/yr`, `76.6%` recall) → `1.0232` Local-Daily (`$1,457/yr`, `+$75/yr`, `82.6%` recall) → `0.9404` Local+23h Eve (`$1,433/yr`, `+$99/yr`, `83.8%` recall) → **`0.9278` Graph+23h Eve** (`+32.9%` skill, `p = 4.96e-14` vs. Persistence, `p = 4.52e-4` vs. Local-Daily, `F1=0.813`, **`88.6%` storm recall**, `$1,114/yr`, **`+$418/yr`**; paired daily tariff cost `p = 0.0135` vs. Local+23h & `p = 0.0228` vs. Persistence). *(Prototype tariff schedule estimate; live dispatch requires utility telemetry.)*
- **Nonlinear Graph Predictor, Prospective Ledger & Python ST-GNN (`ml/`)**: Leak-free graph Ridge & state-interaction predictors (`src/lib/graph/graphPredictor.ts`), disk-backed ex-ante verification ledger, and zero-dependency Python `ETGLagGraphNet` (`+51.38%` RMSE lift: `1.8166` vs. `3.7362` Self-AR; [ml/etg_stgnn.py](ml/etg_stgnn.py)).
- **Communal & AI-Native Ingestion**: **MCP Streamable HTTP & SSE (12 tools)** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`), **OpenAPI 3.1.0** (`/api/mcp/openapi`), direct open feeds (`POST /api/earth/open-feeds`), hardware webhooks (`/api/graph/nodes/[nodeId]/webhook`), and live discovery (`POST /api/earth/discover`, `POST /api/earth/eonet`).

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or `http://localhost:3000/?demo=spaceapps` / `http://localhost:3000/?demo=veritas`). Graph nodes, series, and the prospective forecast ledger persist automatically under `.data/` (deploy on a stateful container/VM with writable disk in production).

## Verification

```bash
npm run typecheck
npm test
python3 -m unittest discover -s ml -p "test_*.py" -v
npm run build
```

To train the standalone Python ST-GNN on a live graph export:

```bash
python3 ml/train_etg_gnn.py --server http://localhost:3000
```

See [AGENTS.md](AGENTS.md), [EARTH_TREND_DETECTIVE.md](EARTH_TREND_DETECTIVE.md), [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md), [WRITEUP.md](WRITEUP.md), and [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) for architecture, competition alignment, and experiment details.

## Submission Deliverables & Live Demo

- **Live Deployed App URL:** `<ADD_DEPLOYED_PRODUCTION_URL>` *(supports `/?demo=spaceapps` & `/?demo=veritas`)*
- **1-Page Blind-Review Write-Up (Veritas AI — Climate Track):** [WRITEUP.md](WRITEUP.md)
- **Executed Colab Notebook (with saved outputs & plots):** [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb)
- **Demo Scripts & Slide Copy (Space Apps ≤30s / ≤7 Slides + Veritas AI 2m):** [DEMO_SCRIPT.md](DEMO_SCRIPT.md)
- **Full Competition Checklists & Judge Q&A:** [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md)

## Open Data Citations, AI Disclosure & License

- **NASA & Space Agency Partner Datasets:**
  - [NASA EOSDIS GIBS / Worldview](https://gibs.earthdata.nasa.gov/) (WMTS/WMS — GHRSST L4 MUR SST Anomaly, GPM IMERG, MODIS Terra, MERRA-2 / GEOS-5, OMPS Aerosol Index, Suomi NPP VIIRS)
  - [NASA POWER Project](https://power.larc.nasa.gov/) (CERES SYN1deg solar irradiance & MERRA-2 meteorological variables)
  - [Open-Meteo](https://open-meteo.com/) (ERA5 Archive `18:00–23:00` hourly, Copernicus GloFAS v4 & CAMS)
  - [NASA EONET v3](https://eonet.gsfc.nasa.gov/) · [NASA GISTEMP v4](https://data.giss.nasa.gov/gistemp/) · [NOAA GML/NSIDC/CDO](https://gml.noaa.gov/) · [USGS NWIS](https://waterservices.usgs.gov/) · [CSA / Geo.ca](https://open.canada.ca/) · [KNMI Climate Explorer](https://climexp.knmi.nl/)
- **AI Disclosure:** AI coding assistants (Google Gemini / Antigravity, Claude) assisted with Next.js UI scaffolding, test boilerplate, and documentation formatting; challenge framing, statistical significance pipelines, upwind cosine + evening advection modeling, and empirical validation were designed and verified against real agency observations.
- **License:** Released under the [MIT License](LICENSE).
