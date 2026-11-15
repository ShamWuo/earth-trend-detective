# Denver Solar Microgrid — Spatiotemporal & Evening Advection Climate Graph
> **Track:** Climate · **Veritas AI International High School Hackathon** *(Round 1 Blind Review Copy — Anonymized)*

## 1. Problem Framing: 1 City, 1 User, 1 Decision
- **City & User:** Denver, CO (`39.74° N, -104.99° W`, 1,609 m) — **K-12 School Microgrid Operator** (`250 kWdc` rooftop PV + `350 kWh` LFP battery).
- **Decision:** At `23:00 MST`, predict tomorrow's daily solar irradiance (`ALLSKY_SFC_SW_DWN`, kWh/m²/day) and decide whether to pre-charge overnight at off-peak rates (`$0.075/kWh`, `$26.25/cycle`) to avoid daytime grid deficits during `< 3.5 kWh/m²/d` storm days (`$0.280/kWh`, `$0.205/kWh` spread).

## 2. 7-Node Climate Graph, Evening Advection & Critical-Fractile Split
A **7-node Front Range Climate Graph** links Denver (`Target`) to 6 upwind stations (`93–156 km`): **Silverthorne/Divide (W)**, **Fort Collins (NNW)**, **Cheyenne, WY (N)**, **Greeley (NE)**, **Limon (E)**, and **Colorado Springs (S)** via directional wind alignment $w_j(t) = \max(0, \cos(\text{WD}_t - \theta_{\text{Denver}\to j}))$. To resolve the 24-hour daily averaging lag, we join **NASA POWER Daily** (`2019-01-01`–`2026-11-09`, `2,870` days) with **Open-Meteo Hourly (`18:00–23:00 MST`, 100.0% coverage)** (cloud cover, humidity, wind, $\Delta P_{23\text{h}-18\text{h}}$). Under asymmetric TOU tariffs, dispatch follows the zero-tuning Newsvendor critical fractile $q^* = 0.075/0.280 \approx 0.268$ (`Q_{0.268} < 3.50`).
- **Zero-Leakage Chronological Split:** Train = `2019–2023` (**1,824 days**) | Validation (`q*` check) = `2024` (**366 days**: `$1,398 → $1,198 → $1,133/yr`) | Unseen Test = `2025–2026` (**606 days**). Zero random shuffling and zero threshold tuning on test data.

## 3. 4-Way Controlled Ablation & Impact (`2025–2026`, `n = 606`)
| Model | RMSE | MAE | $R^2$ | Skill | Rule | Recall / F1 | Cost & Savings |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Persistence** (`Tomorrow=Today`) | 1.3819 | 0.988 | 0.539 | 0.0% | `Y_t < 3.50` | 76.6% / 0.766 | \$1,532/yr (\$0) |
| **2. Local-Only Daily** (`HGBR`) | 1.0232 | 0.789 | 0.747 | +26.0% | `Q_0.268 < 3.50` | 82.6% / 0.773 | \$1,457/yr (+\$75) |
| **3. Local + 23:00 Eve** (`HGBR`) | 0.9404 | 0.696 | 0.786 | +32.0% | `Q_0.268 < 3.50` | 83.8% / 0.778 | \$1,433/yr (+\$99) |
| **4. Graph + 23:00 Eve** (`7-Node HGBR`) | **0.9278** | **0.686** | **0.792** | **+32.9%** | **`Q_0.268 < 3.50`** | **88.6% / 0.813** | **\$1,114/yr (+\$418)** |

- **Ablation & Permutation Findings:** Evening advection cuts RMSE `8.1%` (`1.0232 → 0.9404`), while the **7-Node Graph** wins monotonically (`0.9278` RMSE, `p = 4.96e-14` vs. Persistence, `p = 4.52e-4` vs. Local-Daily; **`+$418/yr`**, paired cost `p = 0.0135` vs. Local+23h). **4 of Top-8 features** are upwind signals (`upwind_kt_x_clrsky`, `upwind_eve_clear_x_clrsky`, `fort_collins_eve_cloud23`, `cheyenne_eve_cloud23`).
- **Live Web App & Global ETG Stack (`/?demo=veritas`):** Rolling Ridge (`0.899` Graph+Eve RMSE vs. `1.354`, `+33.6%` skill, `p = 0.0012` vs. Local+Eve, Brier `0.080`) runs **calibrated `P(ALLSKY < 3.5)` Bayes dispatch** (`+$218/yr` vs. `+$180/yr` threshold). The broader platform pairs **9 NASA GIBS** layers, **Seasonal Mann-Kendall**, an **ETG** with **Prospective Ledger**, 16-tool MCP/OpenAPI, `ETGLagGraphNet` (`+51.38%` lift), **Inductive ETG Transformer (`etg-ml-v2`)**, and **ETG Trend Microscope** (`0.9706` onset AUROC, `0.9827` coupling AUROC, `100%` illusion rejection).

## 4. Failure Audit (`2025-05-06`) & Operational Disclaimer
- **Worst Unseen Miss (`2025-05-06`):** Actual irradiance dropped to `1.41` vs. `Graph+23h` `5.31` (`|err| = 3.90`, `23h cloud = 58%`) due to rapid post-midnight Front Range upslope storm deepening, motivating 00:00–05:00 NWP radar assimilation.
- **Prototype Disclaimer:** TOU rates (`$0.075/$0.280 per kWh`) model a representative Colorado schedule; live deployment requires utility interconnection telemetry.

## 5. Citations & AI Disclosure
- **Data & Stack:** [NASA POWER](https://power.larc.nasa.gov/), [NASA GIBS](https://gibs.earthdata.nasa.gov/), [Open-Meteo ERA5/GloFAS/CAMS](https://open-meteo.com/), [NASA EONET v3](https://eonet.gsfc.nasa.gov/), [GISTEMP v4](https://data.giss.nasa.gov/gistemp/), [USGS NWIS](https://waterservices.usgs.gov/), [NOAA GML](https://gml.noaa.gov/); scikit-learn, NumPy, Pandas, Matplotlib, Next.js, Three.js.
- **AI Disclosure:** AI assistants (Google Gemini / Antigravity, Claude) aided UI scaffolding, formatting, and tests; problem framing, upwind advection modeling, leak-free validation, and failure analysis were independently designed and verified.
