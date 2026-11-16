# Earth Trend Detective (`ETG`)

**Earth Trend Detective** is an open-source observatory and knowledge graph for spotting, verifying, and explaining Earth-system trends. It pairs a 3D satellite globe with a statistical trend engine, an evolving Earth Trend Graph (`ETG`), and a 7-node solar microgrid forecaster.

Built for two competitions:
- **NASA Space Apps Challenge 2026** — *"Be An Earth System Trend Detective!"* (*Theme: "The Next Frontier"*)
- **Veritas AI International High School Hackathon** — **Climate** track

Live demo: [terravex.vercel.app](https://terravex.vercel.app) ([Space Apps mode](https://terravex.vercel.app/?demo=spaceapps) | [Veritas Climate mode](https://terravex.vercel.app/?demo=veritas))

---

## Judge Entrypoints

- **NASA Space Apps (`/?demo=spaceapps`):** Opens the 3D globe with the 5K NASA GIBS `Ocean Anomaly` layer in full daylight, frames the **Walker / ENSO Warm Pool vs. Madagascar Drying** opposite-trend dipole (`r = -0.65`, `p = 0.000034`), pulls live NASA/NOAA/CSA anomalies, and opens the guided case studies and student `? Variable Guide`.
- **Veritas AI Climate (`/?demo=veritas`):** Opens the **Denver 7-Node Solar Microgrid & Evening Advection** panel with the 4-way model ablation, K-12 battery tariff savings, and failure audit.

---

## What It Does

### 1. Interactive 3D Earth Globe (View 1)
- **Satellite Imagery:** 9 progressive 5K/2.5K NASA EOSDIS GIBS layers (`Ocean Anomaly` via GHRSST L4 MUR SST, `Thermal`, `Water / Rain` via MERRA-2 & GPM IMERG, `Surface Winds`, `Air Temp`, `Aerosols`, `NDVI`, `True Color`, `VIIRS Night`), `Blue Marble`, a NASA SVS 4-Slice Earth Composite, and an astronomical day/night solar terminator.
- **Click-Anywhere Coordinate Probing:** Click any point on Earth to query **NASA POWER (MERRA-2 / CERES)**, **USGS NWIS**, **Copernicus GloFAS v4 & CAMS PM2.5**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML**, **KNMI**, and **CSA/Geo.ca** inside a 2-second fault-isolated budget ([upstreamResilience.ts](src/lib/earth/upstreamResilience.ts)).
- **Timeline Scrubber & Opposite-Trend Arcs:** Replay `observed_at` observations over time, inspect `drives_opposite` teleconnection arcs, and open 1-click guided case studies.

### 2. Statistical Significance & Deseasonalization ([trendEngine.ts](src/lib/stats/trendEngine.ts))
- Exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao effective-$N$).
- **Hirsch-Slack Seasonal Mann-Kendall** (`computeSeasonalMannKendall`, $p_s$) with an interactive **Raw Values vs. Seasonal Cycle Removed** toggle so annual cycles do not masquerade as trends.
- **Benjamini-Hochberg FDR**, **Theil-Sen** slopes with 95% confidence intervals, Pettitt change-point tests, and a plain-English `? Variable Guide` with a 3-line stat key.

### 3. Coalesced Earth Trend Graph (`ETG`) & Trend Microscope (View 2)
- Switching views coalesces geo-pinned observations into a 3D WebGL or 2D force-directed graph built on four node types: `Concept` (regions, Earth systems, satellites, sensors), `Signal` (timestamped observations), `Insight` (verified trends and teleconnections), and `Rule` (multi-source corroboration gates).
- **Belief Revision:** New evidence links via `supersedes` edges so the graph records how and why a conclusion changed over time.
- **ETG Trend Microscope (`etg-trend-microscope-v1`):** A 3-head perceptual model that flags pre-Mann-Kendall trend inflections (`0.9789` AUROC vs. `0.4442` classical MK, `79.6%` fresh-break recall), directional lead-lag and opposite-trend couplings (`0.9916` AUROC vs. `0.7010` raw Pearson $|r|$, `98.9%` (`0.9894`) seasonal/drift illusion rejection), and secular vs. oscillation/artifact splits (`0.0570` simplex MAE, `0.9380` false-trend F1). Weights live in [ml/weights/etg-trend-microscope-v1.json](ml/weights/etg-trend-microscope-v1.json) and run via `/api/graph/microscope`, `POST /api/ai/detective`, and GCP L4 `POST /microscope/scan`.

### 4. Denver & Global Solar Microgrid (`Solar Graph`, `etg-global-gnn-v3`)
At `23:00 MST`, a Denver K-12 school microgrid (`250 kWdc` PV + `350 kWh` LFP battery) must decide whether to pre-charge overnight at off-peak rates (`$0.075/kWh`) to avoid daytime grid deficits (`$0.280/kWh`) during `< 3.5 kWh/m²/d` storm days.

- **4-Way Unseen Ablation (Colab HGBR, `Q_0.268 < 3.50`, `n = 606`):**
  - Persistence (`Tomorrow = Today`): `1.3819` RMSE (`$1,532/yr`, `76.6%` recall)
  - Local-Daily: `1.0232` RMSE (`$1,457/yr`, `+$75/yr`, `82.6%` recall)
  - Local + 23h Eve: `0.9404` RMSE (`$1,433/yr`, `+$99/yr`, `83.8%` recall)
  - **7-Node Graph + 23h Eve:** **`0.9278` RMSE** (`+32.9%` skill, `p = 4.96e-14` vs. Persistence, `p = 4.52e-4` vs. Local-Daily, `F1 = 0.813`, **`88.6%` storm recall**, `$1,114/yr`, **`+$418/yr`**; paired daily tariff cost `p = 0.0135` vs. Local+23h and `p = 0.0228` vs. Persistence).
- **Global Spatiotemporal GNN (`etg-global-gnn-v3`, `~14 ms` fp16 CPU):** A `2,043,212`-parameter GNN trained on **36 global cities / 252 NASA POWER Daily+Hourly (`LST`) stations** (`54,570` train graph-days). It reaches **`+22.8%` mean zero-shot skill across 5 held-out continents** (Salt Lake City `+30.86%`, Madrid `+33.62%`, Tokyo `+22.67%`, Sydney `+25.13%`, Santiago `+1.89%`) and **`0.9397` adapted RMSE** (`0.9947` 0-shot, `+32.6%` skill, `p = 4.58e-17`, `82.2%` recall, `+$205/yr`) on unseen `2025–2026` Denver (`n = 678`). Runs anywhere on Earth via `GET /api/earth/solar-graph?lat=&lng=`.
- **Live App Probabilistic Dispatch (`calibrateStormRiskModel`):** Rolling real-time Ridge + Open-Meteo bridge (`0.899` Graph+Eve RMSE vs. `1.354` Persistence, `+33.6%` skill, `p = 0.0012` vs. Local+Eve, Storm Brier `0.080`) paired with calibrated `P(ALLSKY < 3.5 | forecast)` Bayes dispatch (`$0.205/kWh` shortfall spread vs. `$26.25` false pre-charge cycle cost; `+$218/yr` Bayes vs. `+$180/yr` fixed threshold). *(Prototype tariff schedule estimate; live dispatch requires utility telemetry.)*

### 5. Multi-Tier Graph ML & Open Ingestion
- **Inductive ETG Transformer (`etg-ml-v2`):** Parameter-shared GNN (`PortableInductiveETGNet` + `PyTorchInductiveETGTransformer` with `TrustGatedGATLayer`) outputting calibrated `P10–P50–P90` intervals and zero-shot community sensor scoring (`GET/POST /api/graph/predict`), backed by [ml/weights/etg-inductive-weights-v2.json](ml/weights/etg-inductive-weights-v2.json) and validation-gated L4 fine-tuning (`ml/l4_service/`).
- **Prospective Ledger & Python ST-GNN (`etg-ml-v1`):** Leak-free graph Ridge predictors ([src/lib/graph/graphPredictor.ts](src/lib/graph/graphPredictor.ts)), disk-backed ex-ante verification ledger, and zero-dependency `ETGLagGraphNet` (`+51.38%` RMSE lift: `1.8166` vs. `3.7362` Self-AR; [ml/etg_stgnn.py](ml/etg_stgnn.py)).
- **APIs, MCP & Sensor Webhooks:** 16-tool MCP Streamable HTTP & SSE (`/api/mcp`, `/api/mcp/sse`, `/api/mcp/messages`), OpenAPI 3.1.0 (`/api/mcp/openapi`), GIBS WMS Proxy (`/api/earth/gibs`), open physical feeds (`POST /api/earth/open-feeds`, `POST /api/earth/dataset-import`), live KDEN/Open-Meteo ground-station streaming (`scripts/stream_ground_sensor.mjs` & `/api/graph/nodes/[nodeId]/webhook`), and discovery endpoints (`POST /api/earth/discover`, `POST /api/earth/eonet`, `POST /api/ai/detective`).

---

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or `/?demo=spaceapps` / `/?demo=veritas`). Graph nodes, series, and the forecast ledger save automatically under `.data/` locally or `/tmp/etg-data` on Vercel Serverless (all `ml/weights/*` files and the Denver empirical seed bundle automatically via `outputFileTracingIncludes`). Use `Dockerfile` or `railway.json` if you need a persistent volume across restarts.

### Verification

```bash
npm run typecheck
npm test
python3 -m unittest discover -s ml -p "test_*.py" -v
npm run build
```

Optional local ML & sensor scripts:

```bash
python3 ml/train_etg_gnn.py --server http://localhost:3000
node scripts/stream_ground_sensor.mjs --dry-run
```

---

## Notebooks & Docs

- **Colab Notebooks (with saved outputs & plots):** [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) | [notebooks/etg_blackwell_global_trainer.ipynb](notebooks/etg_blackwell_global_trainer.ipynb)
- **Architecture & Guides:** [AGENTS.md](AGENTS.md) | [EARTH_TREND_DETECTIVE.md](EARTH_TREND_DETECTIVE.md) | [ml/README.md](ml/README.md)

---

## Data Citations, AI Disclosure & License

- **NASA & Partner Datasets:** [NASA EOSDIS GIBS / Worldview](https://gibs.earthdata.nasa.gov/), [NASA POWER](https://power.larc.nasa.gov/), [Open-Meteo](https://open-meteo.com/) (ERA5 Archive `18:00–23:00` hourly, Copernicus GloFAS v4 & CAMS), [NASA EONET v3](https://eonet.gsfc.nasa.gov/), [NASA GISTEMP v4](https://data.giss.nasa.gov/gistemp/), [NOAA GML/NSIDC/CDO](https://gml.noaa.gov/), [USGS NWIS](https://waterservices.usgs.gov/), [CSA / Geo.ca](https://open.canada.ca/), and [KNMI Climate Explorer](https://climexp.knmi.nl/).
- **AI Disclosure:** AI coding assistants (Google Gemini / Antigravity, Claude) helped with Next.js UI scaffolding, test boilerplate, and formatting. Problem framing, statistical significance pipelines, upwind cosine + evening advection modeling, and empirical validation were designed and verified against real agency observations.
- **License:** [MIT License](LICENSE)
