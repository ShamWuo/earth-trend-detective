# Earth Trend Detective (`ETG`)

> **Dual-Competition Submission:**
> - **NASA Space Apps Challenge 2026** — Official Challenge: **"Be An Earth System Trend Detective!"** (*Theme: "The Next Frontier"*)
> - **Veritas AI International High School Hackathon** — Selected Track: **Climate**
>
> A communal, AI-native **Earth Trend Graph (`ETG`)**, interactive Earth-timeline visualizer, and **Denver Solar Microgrid Local Climate Graph** for discovering, forecasting, and explaining statistically significant Earth trends.

## Judge Zero-Click Deep-Links

- **NASA Space Apps Mode:** Open `/?demo=spaceapps` to auto-activate **5K NASA GIBS `Ocean Anomaly`** in Full Daylight, frame & analyze the **`Walker / ENSO Warm Pool vs. Madagascar Drying`** dipole (`r = -0.65`, `p = 0.000034`), trigger live NASA/NOAA/CSA Earth discovery, and expose the **Guided Opposite-Trend Case Studies** and student `? Variable Guide`.
- **Veritas AI Climate Mode:** Open `/?demo=veritas` to auto-launch the **Denver 7-Node Solar Microgrid & Evening Advection** evaluation (`4-way` ablation, calibrated K-12 tariff savings, and failure audit).

## Key Capabilities

- **View 1 — Interactive 3D Earth Globe**: **9 progressive 5K/2.5K HD NASA EOSDIS GIBS satellite filters** (`Ocean Anomaly` [GHRSST L4 MUR SST], `Thermal` [MODIS Terra LST + MUR SST], `Water / Rain` [MERRA-2 Vapor + GPM IMERG], `Surface Winds` [MERRA-2], `Air Temp` [MERRA-2 2m T2M], `Aerosols` [MERRA-2 / MODIS AOD], `NDVI` [MODIS Terra 250m], `True Color` [MODIS Terra 250m + Clouds], `VIIRS Night` [Suomi NPP VIIRS], plus `Blue Marble` and a **NASA SVS 4-Slice Earth Composite**), optional live **astronomical day/night solar terminator**, geo-pinned (`lat`, `lng`) observations, cross-region `drives_opposite` teleconnection arcs, 1-click **Guided Opposite-Trend Case Studies**, sub-2s upstream fault resilience ([upstreamResilience.ts](src/lib/earth/upstreamResilience.ts)), and click-anywhere coordinate probing across direct physical open feeds (**NASA POWER MERRA-2**, **USGS NWIS**, **Copernicus GloFAS v4**, **Copernicus CAMS PM2.5**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML**).
- **View 2 — Coalesced Earth Trend Graph (`ETG`) & Trend Microscope**: Dual 3D WebGL & 2D Editorial Canvas force-directed graph built on a strict scientific ontology (`Concept`, `Signal`, `Insight`, `Rule`), surfacing opposite-trend dipoles, **Epistemic Belief Revision** (`supersedes` lineage), k-hop causal traversal, and **ETG Trend Microscope (`etg-trend-microscope-v1`)** perceptual radar badges.
- **Statistical Significance & Deseasonalization Engine (`src/lib/stats/trendEngine.ts`)**: Exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao autocorrelation adjustment), **Hirsch-Slack Seasonal Mann-Kendall (`computeSeasonalMannKendall`, $p_s$)** with an interactive **Raw Values vs. Seasonal Cycle Removed** chart toggle, **Benjamini-Hochberg FDR**, **Theil-Sen** slopes + 95% CI, Pettitt regime shifts, and plain-English student readouts (`? Variable Guide` + 3-line stat key).
- **Denver & Any-Coordinate Solar Microgrid (`Solar Graph`, `etg-global-gnn-v3`)**: Forecasts tomorrow's solar irradiance (`ALLSKY_SFC_SW_DWN`) for a Denver K-12 school microgrid (`250 kWdc` PV + `350 kWh` LFP battery) — or **any clicked coordinate worldwide** via dynamic 7-node upwind rings (`GET /api/earth/solar-graph?lat=&lng=`) — fusing **NASA POWER Daily** + **Open-Meteo `18:00–23:00` hourly advection** with zero-tuning Newsvendor critical-fractile quantile dispatch ($q^* = 0.075 / 0.280 \approx 0.268$) and calibrated Bayes storm dispatch.
  - **4-Way Unseen Ablation (Colab HGBR, `Q_0.268 < 3.50`, `n = 606`):** `1.3819` Persistence (`$1,532/yr`, `76.6%` recall) → `1.0232` Local-Daily (`$1,457/yr`, `+$75/yr`, `82.6%` recall) → `0.9404` Local+23h Eve (`$1,433/yr`, `+$99/yr`, `83.8%` recall) → **`0.9278` Graph+23h Eve** (`+32.9%` skill, `p = 4.96e-14` vs. Persistence, `p = 4.52e-4` vs. Local-Daily, `F1=0.813`, **`88.6%` storm recall**, `$1,114/yr`, **`+$418/yr`**; paired daily tariff cost `p = 0.0135` vs. Local+23h & `p = 0.0228` vs. Persistence).
  - **Global Spatiotemporal GNN (`etg-global-gnn-v3`, `~14 ms` fp16 CPU):** `2,043,212`-param GNN trained across **`36` global cities / `252` NASA POWER Daily+Hourly (`LST`) stations** (`54,570` train graph-days) delivering **`+22.8%` mean zero-shot skill across 5 held-out continents** (Salt Lake City `+30.86%`, Madrid `+33.62%`, Tokyo `+22.67%`, Sydney `+25.13%`, Santiago `+1.89%`) and unseen `2025–2026` Denver (`n = 678`) `0.9947` 0-shot / **`0.9397` adapted RMSE** (`+32.6%` skill, `p = 4.58e-17`, `82.2%` recall, `+$205/yr`).
  - **Live App Probabilistic Dispatch (`GET /api/earth/solar-graph`, `calibrateStormRiskModel`):** Rolling real-time Ridge + Open-Meteo bridge (`0.899` Graph+Eve RMSE vs. `1.354` Persistence, `+33.6%` skill, `p = 0.0012` vs. Local+Eve, Storm Brier `0.080`) paired with inner-validation calibrated `P(ALLSKY < 3.5 | forecast)` Bayes expected-cost dispatch (`$0.205/kWh` shortfall spread vs. `$26.25` false pre-charge cycle cost; `+$218/yr` Bayes vs. `+$180/yr` fixed threshold). *(Prototype tariff schedule estimate; live dispatch requires utility telemetry.)*
- **Multi-Tier Graph ML Stack (`ml/` & `src/lib/graph/`)**:
  - **ETG Trend Microscope (`etg-trend-microscope-v1`)**: 3-in-1 AI perceptual engine detecting pre-Mann-Kendall trend inflections (**`0.9789` AUROC** vs. `0.4442` classical MK, `79.6%` fresh-break recall), true directional lead-lag & opposite-trend couplings (**`0.9916` AUROC** vs. `0.7010` raw Pearson $|r|$, `98.9%` (`0.9894`) seasonal/drift illusion rejection), and secular vs. oscillation/artifact de-aliasing (`0.0570` simplex MAE, `0.9380` false-trend F1). Zero-dependency weights tracked in [ml/weights/etg-trend-microscope-v1.json](ml/weights/etg-trend-microscope-v1.json) and served via `/api/graph/microscope`, `POST /api/ai/detective`, and GCP L4 `POST /microscope/scan`.
  - **Global Spatiotemporal Solar GNN (`etg-global-gnn-v3`)**: Parameter-shared spatial-temporal GNN + fp16 weight export ([ml/weights/etg-global-gnn-v3.bin](ml/weights/etg-global-gnn-v3.bin), [ml/global_gnn/](ml/global_gnn/)) serving global `P10 / Q0.268 / P50 / P90` quantiles + calibrated storm risk on CPU inside `/api/earth/solar-graph`.
  - **Global Multi-Scale Inductive ETG Transformer (`etg-ml-v2`)**: Parameter-shared inductive GNN (`PortableInductiveETGNet` + `PyTorchInductiveETGTransformer` with `TrustGatedGATLayer`) outputting calibrated `P10–P50–P90` intervals, zero-shot unseen community sensor support, and regional coordinate forecasts (`GET/POST /api/graph/predict`), backed by tracked weights [ml/weights/etg-inductive-weights-v2.json](ml/weights/etg-inductive-weights-v2.json) and validation-gated L4 incremental fine-tuning (`ml/l4_service/`).
  - **Prospective Ledger & Python ST-GNN (`etg-ml-v1`)**: Leak-free graph Ridge & state-interaction predictors (`src/lib/graph/graphPredictor.ts`), disk-backed ex-ante verification ledger, and zero-dependency `ETGLagGraphNet` (**`+51.38%` RMSE lift**: `1.8166` vs. `3.7362` Self-AR; [ml/etg_stgnn.py](ml/etg_stgnn.py)).
- **Communal & AI-Native Ingestion**: **MCP Streamable HTTP & SSE (16 tools)** (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`), **OpenAPI 3.1.0** (`/api/mcp/openapi`), **GIBS WMS Proxy** (`/api/earth/gibs`), open physical feeds (`POST /api/earth/open-feeds`, `POST /api/earth/dataset-import`), **live KDEN/Open-Meteo ground-station webhook streaming** (`scripts/stream_ground_sensor.mjs` & 1-click UI trigger via `/api/graph/nodes/[nodeId]/webhook`), graph APIs (`/api/graph`, `/api/graph/traverse`, `/api/graph/predict`, `/api/graph/microscope`, `/api/graph/revise`, `/api/graph/stream`), and live discovery (`POST /api/earth/discover`, `POST /api/earth/eonet`, `GET /api/earth/solar-graph`, `POST /api/ai/detective`).

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or `http://localhost:3000/?demo=spaceapps` / `http://localhost:3000/?demo=veritas`). Graph nodes, series, and the prospective forecast ledger persist automatically under `.data/` locally or `/tmp/etg-data` on **Vercel Serverless** (all `ml/weights/*` neural weights and the Denver empirical seed trace directly into API bundles via `outputFileTracingIncludes`); use `Dockerfile` / `railway.json` when you want a persistent volume across restarts.

## Verification

```bash
npm run typecheck
npm test
python3 -m unittest discover -s ml -p "test_*.py" -v
npm run build
```

To train or test the Python ML & live sensor pipeline locally:

```bash
python3 ml/train_etg_gnn.py --server http://localhost:3000
node scripts/stream_ground_sensor.mjs --dry-run
```

See [AGENTS.md](AGENTS.md), [EARTH_TREND_DETECTIVE.md](EARTH_TREND_DETECTIVE.md), [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md), [WRITEUP.md](WRITEUP.md), and [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) for architecture, competition alignment, and experiment details.

## Submission Deliverables & Live Demo

- **Live Deployed App URL:** [https://terravex.vercel.app](https://terravex.vercel.app) ([Space Apps Mode](https://terravex.vercel.app/?demo=spaceapps) · [Veritas Climate Mode](https://terravex.vercel.app/?demo=veritas))
- **1-Page Blind-Review Write-Up (Veritas AI — Climate Track):** [WRITEUP.md](WRITEUP.md) · Ready-to-upload blind PDF: [veritas_climate_writeup_1page.pdf](deliverables/veritas_climate_writeup_1page.pdf)
- **7-Slide NASA Space Apps Presentation Deck:** [spaceapps_7slide_deck.pdf](deliverables/spaceapps_7slide_deck.pdf) ([HTML source](deliverables/spaceapps_7slide_deck.html))
- **Executed Solar Microgrid Colab Notebook (with saved outputs & plots):** [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb)
- **Executed ETG Trend Microscope Blackwell Trainer Notebook:** [notebooks/etg_blackwell_global_trainer.ipynb](notebooks/etg_blackwell_global_trainer.ipynb)
- **ML Architecture & L4 Deployment Guide:** [ml/README.md](ml/README.md)
- **Demo Scripts & Slide Copy (Space Apps ≤30s / ≤7 Slides + Veritas AI 2m):** [DEMO_SCRIPT.md](DEMO_SCRIPT.md)
- **Full Competition Checklists & Judge Q&A:** [SUBMISSION_GUIDE.md](SUBMISSION_GUIDE.md)

## Open Data Citations, AI Disclosure & License

- **NASA & Space Agency Partner Datasets:**
  - [NASA EOSDIS GIBS / Worldview](https://gibs.earthdata.nasa.gov/) (WMTS/WMS — GHRSST L4 MUR SST & Anomaly, GPM IMERG, MODIS Terra LST/NDVI/True Color, MERRA-2 Surface Winds/T2M/AOD, Suomi NPP VIIRS)
  - [NASA POWER Project](https://power.larc.nasa.gov/) (CERES SYN1deg solar irradiance & MERRA-2 meteorological variables)
  - [Open-Meteo](https://open-meteo.com/) (ERA5 Archive `18:00–23:00` hourly, Copernicus GloFAS v4 & CAMS)
  - [NASA EONET v3](https://eonet.gsfc.nasa.gov/) · [NASA GISTEMP v4](https://data.giss.nasa.gov/gistemp/) · [NOAA GML/NSIDC/CDO](https://gml.noaa.gov/) · [USGS NWIS](https://waterservices.usgs.gov/) · [CSA / Geo.ca](https://open.canada.ca/) · [KNMI Climate Explorer](https://climexp.knmi.nl/)
- **AI Disclosure:** AI coding assistants (Google Gemini / Antigravity, Claude) assisted with Next.js UI scaffolding, test boilerplate, and documentation formatting; challenge framing, statistical significance pipelines, upwind cosine + evening advection modeling, and empirical validation were designed and verified against real agency observations.
- **License:** Released under the [MIT License](LICENSE).
