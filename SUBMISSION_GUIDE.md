# Competition Submissions — NASA Space Apps Challenge & Veritas AI Challenge

This repository (**Earth Trend Detective** + **Denver Solar Microgrid Local Climate Graph**) is prepared for dual submission to:
1. **NASA Space Apps Challenge 2026** — Official Challenge: **"Be An Earth System Trend Detective!"** (*Theme: "The Next Frontier"*)
2. **Veritas AI International High School Hackathon** — Selected Track: **Climate**

---

## 1. NASA Space Apps Challenge

### Official Challenge & Requirements
- **Official Challenge Selected:** **"Be An Earth System Trend Detective!"** (*2026 Theme: "The Next Frontier"*).
- **Open NASA & Partner Data Integration:** Demonstrates live multi-agency NASA and partner data integration and full citations.
- **Zero-Click Judge Entrypoint:** Launch `/?demo=spaceapps` to auto-activate **5K NASA GIBS `Ocean Anomaly`** in Full Daylight, frame & analyze the **`Walker / ENSO Warm Pool vs. Madagascar Drying`** dipole (`r = -0.65`, `p = 0.000034`), and trigger live multi-agency global discovery, alongside `? Variable Guide`, in-app `Agency Hub (12)` Citations & AI Disclosure, and the **Guided Opposite-Trend Case Studies** (`Walker / ENSO Warm Pool vs. Madagascar Drying`, `Arctic Amplification vs. Subpolar Gyre`, `Western Fire Aridity vs. Northern Plains Discharge`, `Boulder Front Range Aridity vs. Continental Divide Moisture`).
- **Submission Deliverables:**
  - Project page in English targeting the challenge statement.
  - **Public Project Demo (Strict Format Limit):** Either a **video up to 30 seconds** (with English subtitles) **or** a **slide deck up to 7 slides** including the title slide in English ([deliverables/spaceapps_7slide_deck.pdf](deliverables/spaceapps_7slide_deck.pdf)), hosted on a public link (YouTube, Google Drive, GitHub, etc.). *See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 1A (30s video) and Part 1B (7-slide deck).*
  - Public open-source code repository ([LICENSE](LICENSE) — MIT).
  - Explicit **AI Usage Disclosure** on the submission form.
  - Platform opt-in: *"Confirm All Work is Original"* and *"I want my project to be considered for Judging"* checked before the Sunday 11:59 PM local deadline.

### Challenge Prompts & Official 5 Global Judging Pillars
| Challenge Prompt / Pillar | Implementation in EarthTrends |
| :--- | :--- |
| **Select Variables & Open NASA/Partner Data** | Live queries to **NASA EOSDIS GIBS (WMTS/WMS — 9 progressive 5K/2.5K HD layers: GHRSST L4 MUR SST & Anomaly, GPM IMERG, MODIS Terra LST/NDVI/True Color, MERRA-2 Surface Winds/T2M/AOD, Suomi NPP VIIRS, plus Blue Marble & SVS 4-Slice Composite via `/api/earth/gibs`)**, **NASA POWER Daily & Monthly** (`T2M`, `VPD`, `GWETROOT`, `AOD_55`, `EVPTRNS`, CERES solar), **Open-Meteo (`18:00–23:00` hourly ERA5, GloFAS v4, CAMS PM2.5)**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML/NSIDC/CDO**, **KNMI**, **CSA/Geo.ca**, and **USGS NWIS** via [datasets.ts](src/lib/datasets.ts), [nasaPowerClient.ts](src/lib/nasa/nasaPowerClient.ts), and [challengeSourcesClient.ts](src/lib/agencies/challengeSourcesClient.ts), paired with sub-2s fault resilience ([upstreamResilience.ts](src/lib/earth/upstreamResilience.ts)) and an accessible **? Variable Guide** popover in [DatasetSelector.tsx](src/components/DatasetSelector.tsx). |
| **Visualize Change Across Space & Time** | **View 1** ([EarthGlobe3D.tsx](src/components/EarthGlobe3D.tsx) + [TimelineScrubber.tsx](src/components/TimelineScrubber.tsx)) renders **5K/2.5K HD NASA GIBS Earth Filters**, a **NASA SVS 4-Slice Earth Composite**, an accurate **astronomical day/night solar terminator**, and replays `observed_at` anomalies across coordinates; **View 2** ([EarthTrendGraphView.tsx](src/components/EarthTrendGraphView.tsx)) coalesces active signals into a 3D/2D Earth Trend Graph (`ETG`) with **ETG Trend Microscope (`etg-trend-microscope-v1`)** perceptual radar badges. Includes a **Raw Values vs. Seasonal Cycle Removed** toggle on [CompactSpotCard.tsx](src/components/CompactSpotCard.tsx). |
| **Quantify What/Where/How Much & Statistical Significance** | Exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao effective-$N$), **Hirsch-Slack Seasonal Mann-Kendall (`p_s`)**, **Benjamini-Hochberg FDR**, **Theil-Sen** median slope + 95% CI, and Pettitt regime-shift tests in [trendEngine.ts](src/lib/stats/trendEngine.ts), paired with **ETG Trend Microscope (`etg-trend-microscope-v1`)** (`0.9789` early onset AUROC vs. `0.4442` MK; `0.9916` directional coupling AUROC vs. `0.7010` raw Pearson $|r|$; `98.9%` illusion rejection; `0.9380` false-trend F1), **Global Multi-Scale Inductive ETG Transformer (`etg-ml-v2`, `P10–P50–P90`)**, a 3-line student plain-English key, and [plainLanguage.ts](src/lib/plainLanguage.ts). |
| **1. Impact** | Bridges global teleconnection awareness with a concrete **Denver K-12 School Microgrid** (`250 kWdc` PV + `350 kWh` battery) overnight battery policy plus **click-anywhere 7-node global solar forecasts** (`?lat=&lng=` + **`etg-global-gnn-v3`**: `+22.8%` 5-continent zero-shot skill across Salt Lake City, Madrid, Tokyo, Sydney, and Santiago; `0.9397` adapted Denver RMSE, `+$205/yr`) and live KDEN ground-station webhook streaming: Colab HGBR `Q_0.268 < 3.50` achieves `+$418/yr` (`88.6%` storm recall) on `n = 606` unseen days, while live `GET /api/earth/solar-graph` adds **calibrated probabilistic `P(ALLSKY < 3.5 | forecast)` Bayes dispatch** (`+$218/yr` vs. `+$180/yr` fixed threshold). |
| **2. Creativity** | Coalesces observations into an Earth-native ontology (`Concept`, `Signal`, `Insight`, `Rule`) with 1-click **Guided Opposite-Trend Case Studies** (`drives_opposite`), `supersedes` belief revision, **16-tool MCP / OpenAPI 3.1.0** AI-agent endpoints, **ETG Trend Microscope (`etg-trend-microscope-v1`)** 3-head perception, **Global Spatiotemporal GNN (`etg-global-gnn-v3`, `~14 ms` fp16 CPU)**, 1-click KDEN/NWS ground-station streaming, and a 7-node Front Range + global diurnal upwind ring. |
| **3. Validity** | Zero-leakage chronological splits (`2019–2023` train → `2024` validation threshold calibration → `2025–2026` unseen test), tracked portable weights (`ml/weights/etg-global-gnn-v3*.bin`, `etg-inductive-weights-v2.json`, `etg-trend-microscope-v1.json`) with PyTorch-to-TS fp16 parity tests (`< 0.001` diff vs `< 0.025` bound), negative-lift guardrails, sub-2s upstream chaos fault fallbacks, prototype tariff disclaimer, WCAG keyboard/table accessibility, and a **Prospective Verification Ledger** ([etgStore.ts](src/lib/graph/etgStore.ts)). |
| **4. Relevance** | Directly answers *"Be An Earth System Trend Detective!"* across variable onboarding, deseasonalized space-time visualizers, formal significance tests, early inflection & illusion filtering, and cross-region opposite dipoles. |
| **5. Presentation** | Zero-click judge deep-links (`/?demo=spaceapps` & `/?demo=veritas`), tailored ≤30s video / ≤7-slide Space Apps pack + 2-minute Veritas script in [DEMO_SCRIPT.md](DEMO_SCRIPT.md), and student-friendly explanations everywhere. |

### Copy-Pasteable Space Apps AI Usage Disclosure & Data Citations
- **AI Usage Disclosure (Paste into Space Apps Form):**
  > *AI coding assistants (Google Gemini / Antigravity and Claude) were used to assist with Next.js UI scaffolding, Tailwind styling, accessibility markup, test boilerplate, and documentation formatting. All challenge problem framing, scientific ontology design (`Concept`/`Signal`/`Insight`/`Rule`), statistical significance mathematics (tie-corrected Mann-Kendall, Hamed-Rao autocorrelation adjustment, Hirsch-Slack Seasonal MK, Benjamini-Hochberg FDR, Theil-Sen), ETG Trend Microscope (`etg-trend-microscope-v1`) & Inductive GNN (`etg-ml-v2`) architectures, upwind cosine + 23:00 evening advection modeling, calibrated `P(ALLSKY < 3.5)` Bayes dispatch, leak-free validation calibration, and failure audits were designed and verified against live NASA and partner agency datasets.*
- **Full Dataset & Resource Citations (Paste into Space Apps Form):**
  - NASA EOSDIS GIBS / Worldview (WMTS/WMS — GHRSST L4 MUR SST & Anomaly, GPM IMERG, MODIS Terra LST/NDVI/True Color, MERRA-2 Surface Winds/T2M/AOD, Suomi NPP VIIRS): https://gibs.earthdata.nasa.gov/
  - NASA POWER Project (CERES SYN1deg & MERRA-2): https://power.larc.nasa.gov/
  - NASA EONET v3 (Earth Observatory Natural Event Tracker): https://eonet.gsfc.nasa.gov/
  - NASA GISTEMP v4 (GISS Surface Temperature Analysis): https://data.giss.nasa.gov/gistemp/
  - NOAA Global Monitoring Laboratory / NSIDC / CDO: https://gml.noaa.gov/
  - USGS National Water Information System (NWIS): https://waterservices.usgs.gov/
  - Open-Meteo (ERA5 Archive Hourly, Copernicus GloFAS v4 & CAMS): https://open-meteo.com/
  - Canadian Space Agency (CSA) / Geo.ca Open Data & KNMI Climate Explorer: https://open.canada.ca/ & https://climexp.knmi.nl/
  - Open-source libraries: Next.js, React, Three.js, Zod, Vitest, scikit-learn, NumPy, Pandas, Matplotlib (MIT / BSD licenses).

### Space Apps Portal Checklist
- [ ] **Team size eligibility verified:** **Local Events** allow **1–6 registered members**, while **Universal Event / Global Judging** requires **2–6 registered members** linked on the official NASA Space Apps team page before Sunday 11:59 PM (solo entrants targeting Global Judging must add at least one teammate).
- [ ] Official challenge **"Be An Earth System Trend Detective!"** selected.
- [ ] Public GitHub repo (`<PUBLIC_GITHUB_REPO_URL>`) pushed with [LICENSE](LICENSE) (MIT) and verified public.
- [ ] Demo created as **either** a <=30s video (with English subtitles) **or** a <=7-slide English deck, tested in an incognito browser tab (`Anyone with the link can view`).
- [ ] AI Disclosure & Dataset Citations pasted into submission form.
- [ ] **"Confirm All Work is Original"** and **"I want my project to be considered for Judging"** checked before Sunday 11:59 PM local time.

---

## 2. Veritas AI International High School Hackathon

### Official Requirements & Judging Criteria
- **Selected Track:** **Climate**
- **Zero-Click Judge Entrypoint:** Open `/?demo=veritas` to auto-open `SolarMicrogridPanel` with the 4-way evaluation, 7-node Front Range graph, and K-12 microgrid tariff impact card.
- **3 Required Deliverables:**
  1. **Working Code:** Public GitHub repository and saved Google Colab notebooks with executed cell outputs ([notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) & [notebooks/etg_blackwell_global_trainer.ipynb](notebooks/etg_blackwell_global_trainer.ipynb), set to *"Anyone with the link can view"*).
  2. **1-Page Project Write-Up:** Concise anonymized summary ([WRITEUP.md](WRITEUP.md) and metadata-scrubbed 1-page PDF [deliverables/veritas_climate_writeup_1page.pdf](deliverables/veritas_climate_writeup_1page.pdf) — zero personal or school names).
  3. **2-Minute Demo Video (Recommended):** Walkthrough (`<= 2:00`) via unlisted YouTube or public Google Drive link ([DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 2).
- **Judging Process:**
  - **Round 1 (Blind Review Warning):** Keep [WRITEUP.md](WRITEUP.md), [README.md](README.md), [LICENSE](LICENSE), [denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb), and [etg_blackwell_global_trainer.ipynb](notebooks/etg_blackwell_global_trainer.ipynb) completely free of personal names, handles, emails, or school names. For Round 1 blind safety, push `.blind-export/veritas-blind-repo` to a separate neutral GitHub repository (`<PUBLIC_GITHUB_REPO_URL>`), check git commit author metadata, ensure Colab sharing shows no personal owner profile, strip `Author` metadata from the exported 1-page PDF, and **verify your Vercel URL contains no personal slug**: Vercel auto-generated team/preview domains (`*-<account>-projects.vercel.app`) can expose a GitHub account handle, so set a clean neutral production alias (e.g., `https://earth-trend-detective.vercel.app/?demo=veritas` via Vercel **Settings -> Domains**) before sharing the live Veritas link.
  - **Round 2 (Live Finals):** 5-minute live demo + technical Q&A.

### Deliverable & Alignment Status
| Deliverable / Criterion | Status & Location |
| :--- | :--- |
| **Selected Track** | **Climate** — **1 City, 1 User, 1 Decision:** Denver, CO → K-12 School Microgrid (`250 kWdc` PV + `350 kWh` LFP battery) → `23:00 MST` Overnight Battery Pre-Charge (`< 3.5 kWh/m²/day`). |
| **Working Code (Executed Notebooks + Web App + Global Solar GNN + Trend Microscope)** | [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) *(executed with saved outputs, zero stderr, & PNG plots)* + [notebooks/etg_blackwell_global_trainer.ipynb](notebooks/etg_blackwell_global_trainer.ipynb) + [denverClimateGraph.ts](src/lib/solar/denverClimateGraph.ts) + [globalGnnInference.ts](src/lib/solar/globalGnnInference.ts) + [scripts/stream_ground_sensor.mjs](scripts/stream_ground_sensor.mjs) + [graphPredictor.ts](src/lib/graph/graphPredictor.ts) + [trendMicroscope.ts](src/lib/graph/trendMicroscope.ts) + [ml/global_gnn/](ml/global_gnn/) + [ml/etg_inductive_gnn.py](ml/etg_inductive_gnn.py) + [ml/etg_trend_microscope.py](ml/etg_trend_microscope.py) + [ml/etg_stgnn.py](ml/etg_stgnn.py) + [SolarMicrogridPanel.tsx](src/components/SolarMicrogridPanel.tsx). |
| **4-Way Ablation (Colab HGBR `n = 606` + `etg-global-gnn-v3` + Live App)** | **Colab HGBR (`2025–2026`, `n = 606`):** Persistence `1.3819` RMSE (`$1,532/yr`, `76.6%` recall) → Local-Daily `1.0232` (`$1,457/yr`, `+$75/yr`, `82.6%`) → Local+23h `0.9404` (`$1,433/yr`, `+$99/yr`, `83.8%`) → **Graph+23h `0.9278` RMSE** (`MAE=0.686`, `R²=0.792`, `+32.9%` skill, `F1=0.813`, **`88.6%` storm recall**, **`$1,114/yr`**, **`+$418/yr`**; squared-error `p = 4.96e-14` vs. Persistence & `p = 4.52e-4` vs. Local-Daily; paired daily tariff cost `p = 0.0135` vs. Local+23h & `p = 0.0228` vs. Persistence). **Global Spatiotemporal GNN (`etg-global-gnn-v3`, `2.04M` params, `36` cities / `252` NASA POWER Daily+Hourly LST stations, `~14 ms` fp16 CPU):** **`+22.8%` 5-continent zero-shot skill** (SLC `+30.86%`, Madrid `+33.62%`, Tokyo `+22.67%`, Sydney `+25.13%`, Santiago `+1.89%`) & unseen `2025–2026` Denver (`n=678`) `0.9947` 0-shot (`+28.6%`, `81.1%` recall) / **`0.9397` adapted RMSE** (`+32.6%`, `p = 4.58e-17`, `+$205/yr`). **Live Web App (`GET /api/earth/solar-graph`):** Rolling Ridge + Bayes `P(ALLSKY < 3.5)` (`0.899` RMSE, `+$218/yr`) + click-anywhere 7-node global ring. **Global ML (`ml/`):** `ETGLagGraphNet` (`+51.38%`), `etg-ml-v2`, and **ETG Trend Microscope** (`0.9789` onset AUROC vs. `0.4442` MK; `0.9916` coupling AUROC; `98.9%` illusion rejection; `0.9380` false-trend F1). |
| **Concrete Failure Analysis & Prototype Disclaimer** | Audited `2025-05-06` (`Actual = 1.41`, `Graph+Eve = 5.31`, `|err| = 3.90`, `23h cloud = 58%`) due to rapid post-midnight upslope storm deepening, plus explicit operational prototype disclaimer on TOU tariffs and live **Prospective Verification Ledger**. |
| **1-Page Blind-Safe Write-Up** | [WRITEUP.md](WRITEUP.md) *(anonymized, with no personal or school names; includes clickable dataset, library, and AI credits).* |
| **2-Minute Demo Video** | Script ready in [DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 2 *(pending recording & upload).* |

---

## 3. Judge Q&A & Hosting Notes

- **Q: How did sub-daily evening data solve the 24-hour NASA daily blurring bottleneck?**
  - Daily NASA POWER averages arrive too late to distinguish evening clearing from an approaching front (`1.0232` RMSE). Joining `18:00–23:00 MST` Open-Meteo hourly cloud cover, humidity, wind, and pressure tendency (`2,870` days, `100.0%` coverage) cuts RMSE to `0.9404` locally and **`0.9278` with the 7-Node Upwind Graph** (`p = 4.52e-4` vs. Local-Daily), with `fort_collins_eve_cloud23` and `cheyenne_eve_cloud23` jumping into the Top-6 features.
- **Q: Why use the Newsvendor critical-fractile quantile rule (`Q_{0.268} < 3.50`) instead of a single mean cutoff?**
  - Under Colorado K-12 TOU tariffs (`$0.075/kWh` off-peak pre-charge vs. `$0.280/kWh` on-peak shortfall), storm dispatch is inherently asymmetric: Bayes-optimal risk sets the decision fractile directly from the tariff ratio $q^* = p_{\text{off}} / p_{\text{peak}} \approx 0.268$ with zero free tuning parameters. Because multi-node spatial features sharpen conditional tail uncertainty around borderline storms, `Graph+23h` achieves monotonic economic dominance across both `2024` validation (`$1,398 -> $1,198 -> $1,133/yr`) and unseen `2025–2026` test (`+$75 -> +$99 -> +$418/yr`, `88.6%` storm recall, paired cost `p = 0.0135` vs. `Local+23h`).
- **Q: How do the Colab HGBR benchmark and the live web app's probabilistic dispatch work together?**
  - The Colab notebook evaluates frozen nonlinear `HistGradientBoostingRegressor` quantile models (`Q_0.268 < 3.50`) on a fixed `2019-01-01`–`2026-11-09` snapshot (`0.9278` RMSE, `+$418/yr`), whereas the live web app (`GET /api/earth/solar-graph`) continuously rolls forward through today via NASA POWER + Open-Meteo using zero-dependency Ridge regression (`0.899` Graph+Eve RMSE, Storm Brier `0.080`) plus inner-validation calibrated **Bayes expected-cost storm risk `P(ALLSKY < 3.5 | forecast)`** (`calibrateStormRiskModel`, comparing `$0.205/kWh` expected daytime shortfall against `$26.25` false-cycle cost for `+$218/yr` vs. `+$180/yr` threshold).
- **Q: How do you prevent data leakage & post-hoc curve fitting?**
  - Strict chronological train (`2019–2023`) → val (`2024` validation) → held-out test (`2025–2026`), zero shuffling, zero free threshold fitting (`q^* = 0.268` fixed by TOU tariff ratio), negative-lift guardrails, and an ex-ante **Prospective Verification Ledger** persisted under `.data/`.
- **Deployment Note (Vercel GitHub Auto-Deploy + Optional Persistent Disk):** **Vercel Serverless** deploys directly from GitHub out of the box (`next.config.ts` bundles all `ml/weights/*` weights and `denver-solar-seed-v4.json`, API routes configure `maxDuration = 60`, and `resolveRuntimeDataDir()` automatically routes writes to `/tmp/etg-data` on read-only serverless containers so `/?demo=spaceapps` and `/?demo=veritas` run with zero `EROFS` errors). For cross-restart disk persistence of live graph mutations, deploy using the included [Dockerfile](Dockerfile) / [railway.json](railway.json) on Railway, Render, or Fly.io with a mounted `.data/` volume.

---

## 4. Remaining Human-Only Actions Before Submitting
1. **Verify Live Vercel Deployment & Blind-Safe Alias:** Commit and push `main` to GitHub to trigger Vercel auto-deploy, verify `https://<your-clean-domain>/?demo=spaceapps` and `/?demo=veritas` load cleanly, and paste the neutral alias into [README.md](README.md) (check Vercel **Settings -> Domains** so the shared Veritas Round 1 URL contains no personal username).
2. **Push Latest Repo State to GitHub (Plus Blind Mirror for Veritas):** Push `main` for Space Apps, run `bash scripts/prepare_blind_submission.sh` (`0` PII matches), and push `.blind-export/veritas-blind-repo` to a separate neutral repository for Veritas AI Round 1 blind review.
3. **Host Colab & 1-Page Write-Up:** Open [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) in Google Colab (with outputs preserved) + export [WRITEUP.md](WRITEUP.md) to a 1-page PDF/Google Doc (`Anyone with the link can view`).
