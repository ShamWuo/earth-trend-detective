# Denver Solar Microgrid — Spatiotemporal & Evening Advection Climate Graph
> **Selected Track:** Climate · **Veritas AI International High School Hackathon** *(Round 1 Blind Review Copy — Anonymized)*

## 1. Problem Framing: 1 City, 1 User, 1 Decision
- **City & User:** Denver, CO (`39.74° N, -104.99° W`, 1,609 m) — **K-12 School Microgrid Operator** (`250 kWdc` rooftop PV + `350 kWh` LFP battery).
- **Decision:** At `23:00 MST`, predict tomorrow's daily irradiance (`ALLSKY_SFC_SW_DWN`, kWh/m²/day) and decide whether to pre-charge the battery overnight from off-peak grid power (`$0.075/kWh`, `$26.25/cycle`) to avoid peak-rate shortfalls during `< 3.5 kWh/m²/d` storm days (`$0.280/kWh`, `$0.205/kWh` penalty spread).

## 2. 7-Node Climate Graph, Evening Advection & Critical-Fractile Quantile Split
We build a **7-node Front Range Climate Graph** linking Denver (`Target`) to 6 upwind neighbors (`93–156 km`): **Silverthorne/Divide (W)**, **Fort Collins (NNW)**, **Cheyenne, WY (N)**, **Greeley (NE)**, **Limon (E)**, and **Colorado Springs (S)** via directional cosine alignment $w_j(t) = \max(0, \cos(\text{WD}_{t} - \theta_{\text{Denver}\to j}))$. To fix the 24-hour NASA daily blurring window, we join **NASA POWER Daily** (`2019-01-01`–`2026-11-09`, `2,870` days) with **Open-Meteo Archive Hourly (`18:00–23:00 MST`, 100.0% coverage)** (evening cloud cover, humidity, wind, pressure tendency $\Delta P_{23\text{h}-18\text{h}}$). Under asymmetric TOU tariffs, overnight pre-charging follows the zero-tuning Newsvendor critical fractile $q^* = p_{\text{off}}/p_{\text{peak}} = 0.075/0.280 \approx 0.268$ (`Q_{0.268}(ALLSKY) < 3.50`).
- **Zero-Leakage Chronological Split:** Train = `2019–2023` (**1,824 days**) | Validation (`q*` check) = `2024` (**366 days**: Local-Daily `$1,398/yr` → Local+23h `$1,198/yr` → Graph+23h `$1,133/yr`) | Held-Out Unseen Test = `2025–2026` (**606 days**). No random shuffling and zero free threshold tuning on validation or test.

## 3. 4-Way Controlled Ablation & K-12 Microgrid Savings (`2025–2026`, `n = 606`)
| Model | RMSE | MAE | $R^2$ | Skill | Dispatch Rule | Low-Solar F1 | Storm Recall | Tariff Cost | Net Savings |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1. Persistence** (`Tomorrow = Today`) | 1.3819 | 0.988 | 0.539 | 0.0% | `Y_t < 3.50` | 0.766 | 76.6% | \$1,532/yr | \$0/yr |
| **2. Local-Only Daily** (`Denver HGBR`) | 1.0232 | 0.789 | 0.747 | +26.0% | `Q_0.268 < 3.50` | 0.773 | 82.6% | \$1,457/yr | +\$75/yr |
| **3. Local + 23:00 Evening** (`HGBR`) | 0.9404 | 0.696 | 0.786 | +32.0% | `Q_0.268 < 3.50` | 0.778 | 83.8% | \$1,433/yr | +\$99/yr |
| **4. Graph + 23:00 Evening** (`7-Node HGBR`) | **0.9278** | **0.686** | **0.792** | **+32.9%** | **`Q_0.268 < 3.50`** | **0.813** | **88.6%** | **\$1,114/yr** | **+\$418/yr** |

**Scientific & Economic Findings:** Adding `18:00–23:00` local telemetry cuts RMSE by `8.1%` (`1.0232 → 0.9404`), and adding the **7-Node Upwind Graph** wins monotonically across every metric: lowest continuous error (**`0.9278` RMSE**, squared-error `p = 4.96e-14` vs. Persistence and `p = 4.52e-4` vs. Local-Daily), highest storm recall (**`88.6%`**, `F1 = 0.813`), and **highest K-12 microgrid savings (`+$418/yr` vs. Persistence; paired daily tariff cost `p = 0.0135` vs. Local+23h and `p = 0.0228` vs. Persistence)**. **Four of the Top-8 permutation features** are spatial/upwind graph signals (`upwind_kt_x_clrsky` `0.0323`, `upwind_eve_clear_x_clrsky` `0.0277`, `fort_collins_eve_cloud23` `0.0256`, `cheyenne_eve_cloud23` `0.0247`) that sharpen conditional lower-tail storm risk. Across broader Earth systems, our web workbench pairs 5K **NASA EOSDIS GIBS** globe filters, **Hirsch-Slack Seasonal Mann-Kendall**, an interactive **Earth Trend Graph (`ETG`)**, a **Prospective Verification Ledger**, and a standalone Python ST-GNN (`ETGLagGraphNet`, **`+51.38%` RMSE lift**: `1.8166` vs. `3.7362`).

## 4. Failure Audit (`2025-05-06`) & Operational Prototype Scope
- **Worst Unseen Test Miss:** On `2025-05-06`, actual irradiance dropped to `1.41 kWh/m²/d` while `Graph+23h` predicted `5.31` (`|err| = 3.90`, `23h cloud = 58%`) due to rapid post-midnight Front Range upslope cloud intensification—highlighting why 00:00–05:00 NWP humidity/radar assimilation is needed for real-time overnight dispatch.
- **Operational Prototype Disclaimer:** Tariff penalties (`$0.075/$0.280 per kWh`) model a representative Colorado commercial TOU schedule for research evaluation; live building deployment requires utility interconnection and site hardware telemetry.

## 5. Citations, Credits & AI Disclosure
- **Datasets:** [NASA POWER (CERES/MERRA-2)](https://power.larc.nasa.gov/), [NASA EOSDIS GIBS](https://gibs.earthdata.nasa.gov/), [Open-Meteo ERA5 Archive](https://open-meteo.com/), [NASA EONET v3](https://eonet.gsfc.nasa.gov/), [NASA GISTEMP v4](https://data.giss.nasa.gov/gistemp/), [USGS NWIS](https://waterservices.usgs.gov/), [NOAA GML](https://gml.noaa.gov/).
- **Code & Stack:** [scikit-learn](https://scikit-learn.org/), [NumPy](https://numpy.org/), [Pandas](https://pandas.pydata.org/), [Matplotlib](https://matplotlib.org/), [Next.js](https://nextjs.org/), [Three.js](https://threejs.org/) · Files: [`notebooks/denver_solar_climate_graph.ipynb`](notebooks/denver_solar_climate_graph.ipynb), [`src/lib/solar/denverClimateGraph.ts`](src/lib/solar/denverClimateGraph.ts), [`ml/etg_stgnn.py`](ml/etg_stgnn.py).
- **AI Disclosure:** AI coding assistants (Google Gemini / Antigravity, Claude) assisted with UI scaffolding, documentation formatting, and unit tests; problem framing, upwind graph + evening advection modeling, leak-free calibration, and failure audit were author-designed and verified on live API data.
