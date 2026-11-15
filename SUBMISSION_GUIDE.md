# Competition Submissions — NASA Space Apps Challenge & Veritas AI Challenge

This repository (**Earth Trend Detective** + **Denver Solar Microgrid Local Climate Graph**) is prepared for dual submission to:
1. **NASA Space Apps Challenge 2026** — Official Challenge: **"Be An Earth System Trend Detective!"** (*Theme: "The Next Frontier"*)
2. **Veritas AI International High School Hackathon** — Selected Track: **Climate**

---

## 1. NASA Space Apps Challenge

### Official Challenge & Requirements
- **Official Challenge Selected:** **"Be An Earth System Trend Detective!"** (*2026 Theme: "The Next Frontier"*).
- **Open NASA & Partner Data Integration:** Demonstrates live multi-agency NASA and partner data integration and full citations.
- **Zero-Click Judge Entrypoint:** Launch `/?demo=spaceapps` to auto-activate **5K NASA GIBS `Ocean Anomaly`** in Full Daylight, frame & analyze the **`ENSO Pacific Rainfall Seesaw`** dipole, and trigger live multi-agency global discovery, alongside `? Variable Guide` and the **Guided Opposite-Trend Case Studies** (`ENSO Pacific Rainfall Seesaw`, `Arctic Amplification vs. Subpolar Gyre`, `Western Fire Aridity vs. Midwest Discharge`).
- **Submission Deliverables:**
  - Project page in English targeting the challenge statement.
  - **Public Project Demo (Strict Format Limit):** Either a **video up to 30 seconds** (with English subtitles) **or** a **slide deck up to 7 slides** (including the title slide, in English), hosted on a public link (YouTube, Google Drive, GitHub, etc.). *See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 1A (30s video) and Part 1B (7-slide deck).*
  - Public open-source code repository ([LICENSE](LICENSE) — MIT).
  - Explicit **AI Usage Disclosure** on the submission form.
  - Platform opt-in: *"Confirm All Work is Original"* and *"I want my project to be considered for Judging"* checked before the Sunday 11:59 PM local deadline.

### Challenge Prompts & Official 5 Global Judging Pillars
| Challenge Prompt / Pillar | Implementation in EarthTrends |
| :--- | :--- |
| **Select Variables & Open NASA/Partner Data** | Live queries to **NASA EOSDIS GIBS (WMTS/WMS — GHRSST L4 MUR SST, GPM IMERG, MODIS Terra, MERRA-2, OMPS, VIIRS)**, **NASA POWER Daily & Monthly** (`T2M`, `VPD`, `GWETROOT`, `AOD_55`, `EVPTRNS`, CERES solar), **Open-Meteo (`18:00–23:00` hourly ERA5, GloFAS v4, CAMS PM2.5)**, **NASA EONET v3**, **NASA GISTEMP v4**, **NOAA GML/NSIDC/CDO**, **KNMI**, **CSA/Geo.ca**, and **USGS NWIS** via [datasets.ts](src/lib/datasets.ts), [nasaPowerClient.ts](src/lib/nasa/nasaPowerClient.ts), and [challengeSourcesClient.ts](src/lib/agencies/challengeSourcesClient.ts), paired with an accessible **? Variable Guide** popover in [DatasetSelector.tsx](src/components/DatasetSelector.tsx). |
| **Visualize Change Across Space & Time** | **View 1** ([EarthGlobe3D.tsx](src/components/EarthGlobe3D.tsx) + [TimelineScrubber.tsx](src/components/TimelineScrubber.tsx)) renders **5K HD NASA GIBS Earth Filters**, a **NASA SVS 4-Slice Earth Composite**, an accurate **astronomical day/night solar terminator**, and replays `observed_at` anomalies across coordinates; **View 2** ([EarthTrendGraphView.tsx](src/components/EarthTrendGraphView.tsx)) coalesces active signals into a 3D/2D Earth Trend Graph (`ETG`). Includes a **Raw Values vs. Seasonal Cycle Removed** toggle on [CompactSpotCard.tsx](src/components/CompactSpotCard.tsx). |
| **Quantify What/Where/How Much & Statistical Significance** | Exact tie-corrected **Mann-Kendall** (`p-value`, $Z_{MK}$, $\tau$, Hamed-Rao effective-$N$), **Hirsch-Slack Seasonal Mann-Kendall (`p_s`)**, **Benjamini-Hochberg FDR**, **Theil-Sen** median slope + 95% CI, and Pettitt regime-shift tests in [trendEngine.ts](src/lib/stats/trendEngine.ts), paired with a 3-line student plain-English key and [plainLanguage.ts](src/lib/plainLanguage.ts). |
| **1. Impact** | Bridges global teleconnection awareness with a concrete **Denver K-12 School Microgrid** (`250 kWdc` PV + `350 kWh` battery) overnight critical-fractile quantile charge policy calibrated on Colorado TOU tariffs (`+$418/yr` estimated penalty savings, `88.6%` storm recall). |
| **2. Creativity** | Coalesces observations into an Earth-native ontology (`Concept`, `Signal`, `Insight`, `Rule`) with 1-click **Guided Opposite-Trend Case Studies** (`drives_opposite`), `supersedes` belief revision, and a 7-node Front Range diurnal + upwind graph. |
| **3. Validity** | Zero-leakage chronological splits (`2019–2023` train → `2024` validation threshold calibration → `2025–2026` unseen test), negative-lift guardrails, prototype tariff disclaimer, WCAG keyboard/table accessibility (`<th scope="row">`, `<caption>`, `tabIndex={0}` region), and a **Prospective Verification Ledger** ([etgStore.ts](src/lib/graph/etgStore.ts)). |
| **4. Relevance** | Directly answers *"Be An Earth System Trend Detective!"* across variable onboarding, deseasonalized space-time visualizers, formal significance tests, and cross-region opposite dipoles. |
| **5. Presentation** | Zero-click judge deep-links (`/?demo=spaceapps` & `/?demo=veritas`), tailored ≤30s video / ≤7-slide Space Apps pack + 2-minute Veritas script in [DEMO_SCRIPT.md](DEMO_SCRIPT.md), and student-friendly explanations everywhere. |

### Copy-Pasteable Space Apps AI Usage Disclosure & Data Citations
- **AI Usage Disclosure (Paste into Space Apps Form):**
  > *AI coding assistants (Google Gemini / Antigravity and Claude) were used to assist with Next.js UI scaffolding, Tailwind styling, accessibility markup, test boilerplate, and documentation formatting. All challenge problem framing, scientific ontology design (`Concept`/`Signal`/`Insight`/`Rule`), statistical significance mathematics (tie-corrected Mann-Kendall, Hamed-Rao autocorrelation adjustment, Hirsch-Slack Seasonal MK, Benjamini-Hochberg FDR, Theil-Sen), upwind cosine + 23:00 evening advection modeling, leak-free validation calibration, and failure audits were designed and verified against live NASA and partner agency datasets.*
- **Full Dataset & Resource Citations (Paste into Space Apps Form):**
  - NASA EOSDIS GIBS / Worldview (WMTS/WMS — GHRSST L4 MUR SST Anomaly, GPM IMERG, MODIS Terra, MERRA-2 / GEOS-5, OMPS Aerosol Index, Suomi NPP VIIRS): https://gibs.earthdata.nasa.gov/
  - NASA POWER Project (CERES SYN1deg & MERRA-2): https://power.larc.nasa.gov/
  - NASA EONET v3 (Earth Observatory Natural Event Tracker): https://eonet.gsfc.nasa.gov/
  - NASA GISTEMP v4 (GISS Surface Temperature Analysis): https://data.giss.nasa.gov/gistemp/
  - NOAA Global Monitoring Laboratory / NSIDC / CDO: https://gml.noaa.gov/
  - USGS National Water Information System (NWIS): https://waterservices.usgs.gov/
  - Open-Meteo (ERA5 Archive Hourly, Copernicus GloFAS v4 & CAMS): https://open-meteo.com/
  - Canadian Space Agency (CSA) / Geo.ca Open Data & KNMI Climate Explorer: https://open.canada.ca/ & https://climexp.knmi.nl/
  - Open-source libraries: Next.js, React, Three.js, Zod, Vitest, scikit-learn, NumPy, Pandas, Matplotlib (MIT / BSD licenses).

### Space Apps Portal Checklist
- [ ] **1–6 registered members** linked on the official NASA Space Apps team page.
- [ ] Official challenge **"Be An Earth System Trend Detective!"** selected.
- [ ] Public GitHub repo (`<PUBLIC_GITHUB_REPO_URL>`) pushed with [LICENSE](LICENSE) (MIT) and verified public.
- [ ] Demo created as **either** ≤30s video (with English subtitles) **or** ≤7-slide English deck, tested in an incognito browser tab (`Anyone with the link can view`).
- [ ] AI Disclosure & Dataset Citations pasted into submission form.
- [ ] **"Confirm All Work is Original"** and **"I want my project to be considered for Judging"** checked before Sunday 11:59 PM local time.

---

## 2. Veritas AI International High School Hackathon

### Official Requirements & Judging Criteria
- **Selected Track:** **Climate**
- **Zero-Click Judge Entrypoint:** Open `/?demo=veritas` to auto-open `SolarMicrogridPanel` with the 4-way evaluation, 7-node Front Range graph, and K-12 microgrid tariff impact card.
- **3 Required Deliverables:**
  1. **Working Code:** Public GitHub repository and saved Google Colab notebook with executed cell outputs ([notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb), set to *"Anyone with the link can view"*).
  2. **1-Page Project Write-Up:** Concise anonymized summary ([WRITEUP.md](WRITEUP.md) exported to PDF or public Google Doc — zero personal or school names).
  3. **2-Minute Demo Video (Recommended):** Walkthrough (`<= 2:00`) via unlisted YouTube or public Google Drive link ([DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 2).
- **Judging Process:**
  - **Round 1 (Blind Review Warning):** Keep [WRITEUP.md](WRITEUP.md), [README.md](README.md), [LICENSE](LICENSE), and [denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) completely free of personal names, handles, emails, or school names. For Round 1 blind safety, host/mirror the public repository under a neutral GitHub organization URL (`<PUBLIC_GITHUB_REPO_URL>`), check git commit author metadata, ensure Colab sharing shows no personal owner profile, and strip `Author` metadata from the exported 1-page PDF.
  - **Round 2 (Live Finals):** 5-minute live demo + technical Q&A.

### Deliverable & Alignment Status
| Deliverable / Criterion | Status & Location |
| :--- | :--- |
| **Selected Track** | **Climate** — **1 City, 1 User, 1 Decision:** Denver, CO → K-12 School Microgrid (`250 kWdc` PV + `350 kWh` LFP battery) → `23:00 MST` Overnight Battery Pre-Charge (`< 3.5 kWh/m²/day`). |
| **Working Code (Executed Notebook + Web App + ST-GNN)** | [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) *(executed with saved outputs, zero stderr, & PNG plots)* + [denverClimateGraph.ts](src/lib/solar/denverClimateGraph.ts) + [graphPredictor.ts](src/lib/graph/graphPredictor.ts) + [ml/etg_stgnn.py](ml/etg_stgnn.py) + [SolarMicrogridPanel.tsx](src/components/SolarMicrogridPanel.tsx). |
| **4-Way Ablation (Strict Temporal Split, `n = 606` Unseen `2025–2026` Days)** | **Persistence:** `1.3819` RMSE (`$1,532/yr` penalty, `76.6%` recall) → **Local-Daily HGBR (`Q27 < 3.50`):** `1.0232` (`$1,457/yr`, `+$75/yr`, `82.6%` recall) → **Local+23h Eve HGBR (`Q27 < 3.50`):** `0.9404` (`$1,433/yr`, `+$99/yr`, `83.8%` recall) → **Graph+23h Eve HGBR (`Q27 < 3.50`):** **`0.9278` RMSE** (`MAE=0.686`, `R²=0.792`, `+32.9%` skill, `F1=0.813`, **`88.6%` storm recall**, **`$1,114/yr` penalty**, **`+$418/yr` savings**; squared-error `p = 4.96e-14` vs. Persistence & `p = 4.52e-4` vs. Local-Daily; paired daily tariff cost `p = 0.0135` vs. Local+23h & `p = 0.0228` vs. Persistence). **4/8 Top Permutation Importances** are spatial/upwind graph features (`upwind_kt_x_clrsky`, `upwind_eve_clear_x_clrsky`, `fort_collins_eve_cloud23`, `cheyenne_eve_cloud23`). **Python ST-GNN:** `ETGLagGraphNet` reaches `1.8166` RMSE vs. `3.7362` Self-AR (`+51.38%` lift). |
| **Concrete Failure Analysis & Prototype Disclaimer** | Audited `2025-05-06` (`Actual = 1.41`, `Graph+Eve = 5.31`, `|err| = 3.90`, `23h cloud = 58%`) due to rapid post-midnight upslope storm deepening, plus explicit operational prototype disclaimer on TOU tariffs and live **Prospective Verification Ledger**. |
| **1-Page Blind-Safe Write-Up** | [WRITEUP.md](WRITEUP.md) *(anonymized — zero personal or school names; includes clickable dataset, library & AI credits).* |
| **2-Minute Demo Video** | Script ready in [DEMO_SCRIPT.md](DEMO_SCRIPT.md) Part 2 *(pending recording & upload).* |

---

## 3. Judge Q&A & Hosting Notes

- **Q: How did sub-daily evening data solve the 24-hour NASA daily blurring bottleneck?**
  - Daily NASA POWER averages arrive too late to distinguish evening clearing from an approaching front (`1.0232` RMSE). Joining `18:00–23:00 MST` Open-Meteo hourly cloud cover, humidity, wind, and pressure tendency (`2,870` days, `100.0%` coverage) cuts RMSE to `0.9404` locally and **`0.9278` with the 7-Node Upwind Graph** (`p = 4.52e-4` vs. Local-Daily), with `fort_collins_eve_cloud23` and `cheyenne_eve_cloud23` jumping into the Top-6 features.
- **Q: Why use the Newsvendor critical-fractile quantile rule (`Q_{0.268} < 3.50`) instead of a single mean cutoff?**
  - Under Colorado K-12 TOU tariffs (`$0.075/kWh` off-peak pre-charge vs. `$0.280/kWh` on-peak shortfall), storm dispatch is inherently asymmetric: Bayes-optimal risk sets the decision fractile directly from the tariff ratio $q^* = p_{\text{off}} / p_{\text{peak}} \approx 0.268$ with zero free tuning parameters. Because multi-node spatial features sharpen conditional tail uncertainty around borderline storms, `Graph+23h` achieves monotonic economic dominance across both `2024` validation (`$1,398 -> $1,198 -> $1,133/yr`) and unseen `2025–2026` test (`+$75 -> +$99 -> +$418/yr`, `88.6%` storm recall, paired cost `p = 0.0135` vs. `Local+23h`).
- **Q: How do you prevent data leakage & post-hoc curve fitting?**
  - Strict chronological train (`2019–2023`) → val (`2024` validation) → held-out test (`2025–2026`), zero shuffling, zero free threshold fitting (`q^* = 0.268` fixed by TOU tariff ratio), negative-lift guardrails, and an ex-ante **Prospective Verification Ledger** persisted under `.data/`.
- **Deployment Tip:** Host on a stateful container/VM with persistent disk (Railway, Render disk, Fly.io) rather than stateless read-only serverless functions so `.data/` survives restarts.

---

## 4. Remaining Human-Only Actions Before Submitting
1. **Deploy Live App URL:** Deploy to Railway / Render / Fly.io (with persistent `.data/` disk) and paste the URL (including `/?demo=spaceapps` and `/?demo=veritas`) into [README.md](README.md).
2. **Push Latest Repo State to GitHub:** Run `git push` and verify `<PUBLIC_GITHUB_REPO_URL>` is public (use an anonymized org/repo URL for Veritas AI Round 1 blind review).
3. **Host Colab & 1-Page Write-Up:** Open [notebooks/denver_solar_climate_graph.ipynb](notebooks/denver_solar_climate_graph.ipynb) in Google Colab (with outputs preserved) + export [WRITEUP.md](WRITEUP.md) to a 1-page PDF/Google Doc (`Anyone with the link can view`).
