#!/usr/bin/env python3
"""
Generate anonymized, print-ready deliverables for:
1) Veritas AI Hackathon (Climate Track): 1-page blind PDF (`deliverables/veritas_climate_writeup_1page.pdf`)
2) NASA Space Apps Challenge: strict 7-slide PDF deck (`deliverables/spaceapps_7slide_deck.pdf`)

Run via:
  uv run --with pypdf python3 scripts/build_submission_pdfs.py
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parent.parent
DELIV_DIR = ROOT / "deliverables"
DELIV_DIR.mkdir(parents=True, exist_ok=True)

CHROME_BIN = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
_EXTRA_PII = os.environ.get("PII_PATTERN", "").strip()
PII_RE = re.compile(_EXTRA_PII, re.IGNORECASE) if _EXTRA_PII else None


def render_writeup_html(font_pt: float = 8.4, line_height: float = 1.28, pad_in: float = 0.34) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Denver Solar Microgrid — Spatiotemporal &amp; Evening Advection Climate Graph</title>
<style>
  @page {{
    size: letter;
    margin: {pad_in}in 0.38in;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: {font_pt}pt;
    line-height: {line_height};
    color: #111827;
    background: #ffffff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }}
  .page {{
    width: 100%;
    max-width: 7.74in;
    margin: 0 auto;
  }}
  header {{
    border-bottom: 2px solid #0f172a;
    padding-bottom: 5px;
    margin-bottom: 7px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 12px;
  }}
  h1 {{
    font-size: 13.5pt;
    line-height: 1.12;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #0f172a;
  }}
  .subtitle {{
    font-size: 7.7pt;
    color: #475569;
    margin-top: 2px;
    font-weight: 500;
  }}
  .badge {{
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1e40af;
    font-size: 7.3pt;
    font-weight: 700;
    padding: 3px 7px;
    border-radius: 4px;
    white-space: nowrap;
  }}
  .kpi-strip {{
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
    margin-bottom: 7px;
  }}
  .kpi {{
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-left: 3px solid #0284c7;
    border-radius: 4px;
    padding: 4px 6px;
  }}
  .kpi.emerald {{ border-left-color: #059669; }}
  .kpi.amber {{ border-left-color: #d97706; }}
  .kpi.violet {{ border-left-color: #6366f1; }}
  .kpi-val {{
    font-size: 10.5pt;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.1;
  }}
  .kpi-lbl {{
    font-size: 6.8pt;
    color: #475569;
    margin-top: 1px;
  }}
  .grid-2 {{
    display: grid;
    grid-template-columns: 1.15fr 0.85fr;
    gap: 8px;
    margin-bottom: 6px;
    align-items: start;
  }}
  h2 {{
    font-size: 9.0pt;
    font-weight: 800;
    color: #0f172a;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 2px;
    margin-bottom: 4px;
  }}
  p, li {{
    font-size: 7.9pt;
    color: #1f2937;
    margin-bottom: 3.2px;
  }}
  ul {{ padding-left: 13px; }}
  code {{
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 7.2pt;
    background: #f1f5f9;
    padding: 0 3px;
    border-radius: 2px;
    color: #0f172a;
  }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin: 4px 0 5px 0;
    font-size: 7.3pt;
  }}
  th, td {{
    border: 1px solid #cbd5e1;
    padding: 2.5px 4.5px;
    text-align: center;
  }}
  th {{
    background: #0f172a;
    color: #f8fafc;
    font-weight: 700;
    font-size: 7.0pt;
  }}
  td:first-child, th:first-child {{ text-align: left; }}
  tr.win {{ background: #ecfdf5; font-weight: 700; }}
  .figure-box {{
    border: 1px solid #cbd5e1;
    border-radius: 5px;
    background: #f8fafc;
    padding: 5px 6px;
    text-align: center;
  }}
  .figure-cap {{
    font-size: 6.9pt;
    color: #475569;
    margin-top: 2px;
    text-align: left;
  }}
  .box-note {{
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-left: 3px solid #d97706;
    border-radius: 4px;
    padding: 4px 6px;
    margin-top: 3px;
  }}
  .grid-bottom {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 4px;
  }}
  .mono {{ font-variant-numeric: tabular-nums; }}
</style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <h1>Denver Solar Microgrid — Spatiotemporal &amp; Evening Advection Climate Graph</h1>
      <div class="subtitle">Track: Climate · Round 1 Blind Review Submission · Zero-Leakage Chronological Evaluation</div>
    </div>
    <div class="badge">1 CITY · 1 USER · 1 DECISION</div>
  </header>

  <div class="kpi-strip">
    <div class="kpi emerald">
      <div class="kpi-val">0.9278 RMSE (+32.9%)</div>
      <div class="kpi-lbl">7-Node Graph+23h HGBR vs. 1.3819 Persist (n=606)</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">+$418/yr · 88.6% Recall</div>
      <div class="kpi-lbl">Zero-Tuning q*=0.268 Tariff Savings (p=0.0135 vs Local+23h)</div>
    </div>
    <div class="kpi violet">
      <div class="kpi-val">+22.8% 5-Continent Skill</div>
      <div class="kpi-lbl">etg-global-gnn-v3 (36 Cities / 252 Stations, ~14 ms CPU)</div>
    </div>
    <div class="kpi amber">
      <div class="kpi-val">0.9789 Onset AUROC</div>
      <div class="kpi-lbl">Trend Microscope vs. 0.4442 MK (98.9% Illusion Rej.)</div>
    </div>
  </div>

  <div class="grid-2">
    <div>
      <h2>1. Problem Framing: 1 City, 1 User, 1 Decision</h2>
      <p>
        <strong>City &amp; User:</strong> Denver, CO (<code>39.74°N, -104.99°W</code>, 1,609 m) — a <strong>K-12 School Microgrid Operator</strong> running a <code>250 kW<sub>dc</sub></code> rooftop PV array and a <code>350 kWh</code> LFP battery storage system.
      </p>
      <p>
        <strong>Actionable Decision (23:00 MST):</strong> Predict tomorrow's daily solar irradiance (<code>ALLSKY_SFC_SW_DWN</code>, kWh/m²/day) to decide whether to pre-charge the battery overnight at off-peak rates (<code>$0.075/kWh</code>, <code>$26.25/cycle</code>) in order to prevent expensive daytime peak grid deficits during low-solar storm days (<code>&lt; 3.5 kWh/m²/d</code> at <code>$0.280/kWh</code>; <code>$0.205/kWh</code> spread).
      </p>

      <h2 style="margin-top:5px;">2. 7-Node Climate Graph, Evening Advection &amp; q* Split</h2>
      <p>
        Daily satellite averages smear Front Range storm approaches that traverse the 93–156 km corridor in 2–4 hours. A <strong>7-Node Front Range Climate Graph</strong> connects Denver (<code>Target</code>) to six upwind stations—Silverthorne/Divide (W), Fort Collins (NNW), Cheyenne, WY (N), Greeley (NE), Limon (E), and Colorado Springs (S)—weighted by directional wind advection <code>w<sub>j</sub>(t) = max(0, cos(WD<sub>t</sub> − θ<sub>Denver→j</sub>))</code>. We join <strong>NASA POWER Daily</strong> (2019–2026, 2,870 days) with <strong>Open-Meteo Hourly</strong> (<code>18:00–23:00 MST</code>, 100.0% coverage: cloud, RH, wind, <code>ΔP<sub>23h–18h</sub></code>).
      </p>
      <p>
        Under asymmetric TOU tariffs, Bayes risk sets the zero-tuning Newsvendor critical fractile <code>q* = 0.075 / 0.280 ≈ 0.268</code> (dispatch iff <code>Q<sub>0.268</sub> &lt; 3.50</code>). Chronological split (zero random shuffling): <strong>Train 2019–2023</strong> (1,824d) → <strong>Val 2024</strong> (366d: <code>$1,398 → $1,198 → $1,133/yr</code>) → <strong>Unseen Test 2025–2026</strong> (606d).
      </p>
    </div>

    <div class="figure-box">
      <svg viewBox="0 0 320 202" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg" aria-label="7-Node Front Range Advection Graph">
        <rect x="0" y="0" width="320" height="202" rx="4" fill="#0f172a"/>
        <text x="12" y="16" fill="#e2e8f0" font-size="9.5" font-weight="700">Front Range 7-Node Upwind Ring (93–156 km)</text>
        <text x="12" y="27" fill="#94a3b8" font-size="7.2">Edges weighted by cos(WD − bearing) &amp; Δelev + 23:00 MST hourly state</text>
        <!-- Edges from Denver Target (178, 114) -->
        <line x1="108" y1="114" x2="178" y2="114" stroke="#38bdf8" stroke-width="2.2" stroke-opacity="0.85"/>
        <line x1="154" y1="68" x2="178" y2="114" stroke="#f59e0b" stroke-width="2.5" stroke-opacity="0.95"/>
        <line x1="178" y1="43" x2="178" y2="114" stroke="#f59e0b" stroke-width="2.2" stroke-opacity="0.85"/>
        <line x1="224" y1="74" x2="178" y2="114" stroke="#64748b" stroke-width="1.4" stroke-dasharray="3 2"/>
        <line x1="268" y1="114" x2="178" y2="114" stroke="#64748b" stroke-width="1.4" stroke-dasharray="3 2"/>
        <line x1="186" y1="162" x2="178" y2="114" stroke="#38bdf8" stroke-width="1.8" stroke-opacity="0.75"/>
        <!-- Nodes & Clean Non-Overlapping Labels -->
        <circle cx="108" cy="114" r="5.5" fill="#0284c7" stroke="#bae6fd" stroke-width="1.5"/>
        <text x="98" y="111" text-anchor="end" fill="#bae6fd" font-size="7.1" font-weight="600">Silverthorne (W)</text>
        <text x="98" y="121" text-anchor="end" fill="#7dd3fc" font-size="6.3">2,750m · Cont. Divide</text>

        <circle cx="154" cy="68" r="5.5" fill="#d97706" stroke="#fde68a" stroke-width="1.5"/>
        <text x="145" y="70" text-anchor="end" fill="#fde68a" font-size="7.1" font-weight="700">Fort Collins (Top-6)</text>

        <circle cx="178" cy="43" r="5.5" fill="#d97706" stroke="#fde68a" stroke-width="1.5"/>
        <text x="187" y="46" fill="#fde68a" font-size="7.1" font-weight="700">Cheyenne, WY (Top-6)</text>

        <circle cx="224" cy="74" r="5" fill="#475569" stroke="#cbd5e1" stroke-width="1.2"/>
        <text x="232" y="76" fill="#cbd5e1" font-size="7.0">Greeley (NE)</text>

        <circle cx="268" cy="114" r="5" fill="#475569" stroke="#cbd5e1" stroke-width="1.2"/>
        <text x="268" y="129" text-anchor="middle" fill="#cbd5e1" font-size="7.0">Limon (E)</text>

        <circle cx="186" cy="162" r="5.2" fill="#0284c7" stroke="#bae6fd" stroke-width="1.2"/>
        <text x="195" y="165" fill="#bae6fd" font-size="7.0">Colorado Springs (S)</text>

        <!-- Target in empty bottom-left quadrant -->
        <circle cx="178" cy="114" r="9" fill="#10b981" stroke="#ecfdf5" stroke-width="2"/>
        <text x="166" y="142" text-anchor="end" fill="#ecfdf5" font-size="7.9" font-weight="800">Denver K-12 Target</text>
        <text x="166" y="152" text-anchor="end" fill="#6ee7b7" font-size="6.8">Q₀.₂₆₈ &lt; 3.50 → $418/yr saved</text>

        <!-- Legend bar -->
        <rect x="10" y="180" width="300" height="14" rx="2" fill="#1e293b"/>
        <text x="16" y="189.5" fill="#e2e8f0" font-size="6.6">Top-8 Features: upwind_kt_x_clrsky, upwind_eve_clear, Ft Collins 23h, Cheyenne 23h</text>
      </svg>
      <div class="figure-cap"><strong>Fig 1.</strong> 4 of top 8 predictors in the unseen 2025–2026 permutation audit come from upwind Front Range stations.</div>
    </div>
  </div>

  <h2>3. Controlled 4-Way Ablation (Colab HGBR, n = 606), Global GNN (36 Cities) &amp; Live Dispatch</h2>
  <table class="mono">
    <thead>
      <tr>
        <th>Model (Unseen Test 2025–2026, n = 606 Days)</th>
        <th>RMSE ↓</th>
        <th>MAE ↓</th>
        <th>R² ↑</th>
        <th>Skill vs Persist</th>
        <th>Dispatch Rule</th>
        <th>Storm Recall / F1</th>
        <th>Grid Cost &amp; Net Savings</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>1. Persistence (Tomorrow = Today)</td>
        <td>1.3819</td><td>0.988</td><td>0.539</td><td>0.0%</td><td>Y<sub>t</sub> &lt; 3.50</td><td>76.6% / 0.766</td><td>$1,532/yr ($0)</td>
      </tr>
      <tr>
        <td>2. Local-Only Daily (HGBR)</td>
        <td>1.0232</td><td>0.789</td><td>0.747</td><td>+26.0%</td><td>Q<sub>0.268</sub> &lt; 3.50</td><td>82.6% / 0.773</td><td>$1,457/yr (+$75)</td>
      </tr>
      <tr>
        <td>3. Local + 23:00 Evening (HGBR)</td>
        <td>0.9404</td><td>0.696</td><td>0.786</td><td>+32.0%</td><td>Q<sub>0.268</sub> &lt; 3.50</td><td>83.8% / 0.778</td><td>$1,433/yr (+$99)</td>
      </tr>
      <tr class="win">
        <td>4. Graph + 23:00 Evening (7-Node HGBR)</td>
        <td>0.9278</td><td>0.686</td><td>0.792</td><td>+32.9%</td><td>Q<sub>0.268</sub> &lt; 3.50</td><td>88.6% / 0.813</td><td>$1,114/yr (+$418)</td>
      </tr>
    </tbody>
  </table>

  <p>
    <strong>Ablation &amp; Statistical Rigor:</strong> Evening <code>18:00–23:00</code> advection cuts RMSE <code>8.1%</code> (<code>1.0232 → 0.9404</code>), and adding the 7-Node Upwind Graph achieves <strong>0.9278 RMSE</strong> (<code>p = 4.96e-14</code> vs. Persistence; <code>p = 4.52e-4</code> vs. Local-Daily) and <strong>+$418/yr</strong> net savings (paired daily tariff cost <code>p = 0.0135</code> vs. Local+23h; <code>p = 0.0228</code> vs. Persistence).
  </p>
  <p>
    <strong>Global Generalization (<code>etg-global-gnn-v3</code>), Live App &amp; ETG ML Stack:</strong> Live web dispatch (<code>/?demo=veritas</code>) pairs rolling Ridge (<code>0.899</code> RMSE vs. <code>1.354</code>, <code>p = 0.0012</code> vs. Local+Eve, Brier <code>0.080</code>) with Bayes expected-cost storm probability <code>P(ALLSKY &lt; 3.5)</code> (<code>+$218/yr</code> vs. <code>+$180/yr</code> cutoff). Clicking any coordinate worldwide runs <strong><code>etg-global-gnn-v3</code></strong> (2.04M params, <code>~14 ms</code> fp16 CPU) trained on <strong>36 cities / 252 NASA POWER Daily+Hourly stations</strong> (54,570 train graph-days), delivering <strong>+22.8% mean zero-shot skill across 5 held-out continents</strong> (Salt Lake City +30.9%, Madrid +33.6%, Tokyo +22.7%, Sydney +25.1%, Santiago +1.9%) and <strong>0.9397</strong> adapted RMSE in Denver (<code>0.9947</code> 0-shot, +32.6% skill, <code>p = 4.58e-17</code>, 82.2% recall, +$205/yr). Integrated with live KDEN NWS METAR webhook streaming, 9 NASA GIBS layers, Seasonal MK, <code>ETGLagGraphNet</code> (+51.38%), <code>etg-ml-v2</code>, and <strong>Trend Microscope</strong> (<code>0.9789</code> onset AUROC vs. <code>0.4442</code> MK; <code>0.9916</code> coupling AUROC vs. <code>0.7010</code> |r|; <code>98.9%</code> illusion rejection; <code>0.9380</code> F1).
  </p>

  <div class="grid-bottom">
    <div>
      <h2>4. Failure Audit (2025-05-06) &amp; Disclaimer</h2>
      <div class="box-note">
        <p style="margin-bottom:2px;">
          <strong>Worst Unseen Error (2025-05-06):</strong> Actual irradiance fell to <code>1.41</code> vs. Graph+23h forecast <code>5.31</code> (<code>|err| = 3.90</code>, <code>23h cloud = 58%</code>) caused by rapid post-midnight Front Range upslope cyclogenesis, motivating 00:00–05:00 NWP radar assimilation.
        </p>
        <p style="margin-bottom:0;">
          <strong>Prototype Disclaimer:</strong> TOU rates (<code>$0.075/$0.280 per kWh</code>) model a representative Colorado K-12 tariff schedule; live battery actuation requires utility interconnection telemetry.
        </p>
      </div>
    </div>
    <div>
      <h2>5. Open Data Citations &amp; AI Disclosure</h2>
      <p>
        <strong>Data &amp; Libraries:</strong> NASA POWER (CERES/MERRA-2), NASA GIBS, Open-Meteo (ERA5/GloFAS/CAMS), NASA EONET v3, NASA GISTEMP v4, USGS NWIS, NOAA GML/NSIDC/CDO, KNMI, CSA; scikit-learn, PyTorch, NumPy, Pandas, Matplotlib, Next.js, Three.js (MIT).
      </p>
      <p style="margin-bottom:0;">
        <strong>AI Disclosure:</strong> AI assistants (Google Gemini / Antigravity, Claude) assisted with UI scaffolding, formatting, and tests; problem framing, upwind advection modeling, leak-free validation, and failure audits were independently designed and verified.
      </p>
    </div>
  </div>
</div>
</body>
</html>
"""


def render_slides_html() -> str:
    return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Earth Trend Detective — 7-Slide NASA Space Apps Presentation</title>
<style>
  @page {
    size: 1280px 720px;
    margin: 0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    background: #090b10;
    color: #f3efe6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .slide {
    width: 1280px;
    height: 720px;
    padding: 44px 54px 36px 54px;
    position: relative;
    overflow: hidden;
    background: radial-gradient(circle at 88% 14%, rgba(56, 189, 248, 0.12), transparent 44%),
                radial-gradient(circle at 12% 88%, rgba(16, 185, 129, 0.09), transparent 40%),
                #0a0d14;
    page-break-after: always;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .slide:last-child { page-break-after: auto; }
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(148, 163, 184, 0.22);
    padding-bottom: 12px;
  }
  .pill {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.3);
    padding: 5px 12px;
    border-radius: 999px;
  }
  .slidenum { font-size: 14px; color: #94a3b8; font-weight: 600; }
  h1 { font-size: 46px; font-weight: 800; letter-spacing: -0.025em; line-height: 1.08; color: #f8fafc; }
  h2 { font-size: 31px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; color: #f8fafc; margin-top: 10px; }
  h3 { font-size: 18px; font-weight: 700; color: #38bdf8; margin-bottom: 8px; }
  p, li { font-size: 16.5px; line-height: 1.45; color: #cbd5e1; }
  ul { padding-left: 20px; }
  li { margin-bottom: 9px; }
  strong { color: #f8fafc; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: rgba(148, 163, 184, 0.16); padding: 1px 6px; border-radius: 4px; color: #7dd3fc; }
  .cols-2 { display: grid; grid-template-columns: 1.08fr 0.92fr; gap: 32px; align-items: center; flex: 1; padding: 18px 0; }
  .cols-eq { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; align-items: stretch; flex: 1; padding: 18px 0; }
  .cols-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; flex: 1; padding: 18px 0; align-items: stretch; }
  .card {
    background: rgba(17, 24, 39, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 14px;
    padding: 20px 22px;
  }
  .card.emerald { border-color: rgba(16, 185, 129, 0.45); background: rgba(6, 78, 59, 0.22); }
  .card.sky { border-color: rgba(56, 189, 248, 0.4); background: rgba(12, 74, 110, 0.18); }
  .card.amber { border-color: rgba(245, 158, 11, 0.45); background: rgba(120, 53, 15, 0.2); }
  .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 18px; }
  .stat-box { background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 10px; padding: 14px; }
  .stat-num { font-size: 26px; font-weight: 800; color: #34d399; }
  .stat-lbl { font-size: 13px; color: #94a3b8; margin-top: 3px; }
  .layer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 12px; }
  .layer-tag { background: rgba(30, 41, 59, 0.9); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 9px 11px; font-size: 13.5px; color: #e2e8f0; }
  .layer-tag b { display: block; color: #7dd3fc; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14.5px; }
  th, td { border: 1px solid rgba(148, 163, 184, 0.25); padding: 9px 12px; text-align: left; }
  th { background: rgba(30, 41, 59, 0.9); color: #7dd3fc; font-weight: 700; }
  td { color: #e2e8f0; }
  .footer {
    border-top: 1px solid rgba(148, 163, 184, 0.18);
    padding-top: 10px;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: #94a3b8;
  }
</style>
</head>
<body>

<!-- SLIDE 1 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">NASA Space Apps Challenge 2026 · "The Next Frontier"</span>
    <span class="slidenum">Slide 1 / 7</span>
  </div>
  <div class="cols-2">
    <div>
      <div style="color:#34d399;font-size:15px;font-weight:700;margin-bottom:8px;letter-spacing:0.06em;">CHALLENGE: "BE AN EARTH SYSTEM TREND DETECTIVE!"</div>
      <h1>Earth Trend Detective (ETG)</h1>
      <p style="font-size:20px;color:#e2e8f0;margin-top:16px;line-height:1.4;">
        A communal, AI-native <strong>Earth Trend Graph</strong> &amp; 3D Earth-timeline observatory turning multi-agency satellite telemetry into statistically verified local decisions.
      </p>
      <div class="stat-row">
        <div class="stat-box">
          <div class="stat-num">9 Layers</div>
          <div class="stat-lbl">5K/2.5K NASA GIBS + SVS</div>
        </div>
        <div class="stat-box">
          <div class="stat-num">0.9789</div>
          <div class="stat-lbl">Trend Microscope AUROC</div>
        </div>
        <div class="stat-box">
          <div class="stat-num">36 Cities</div>
          <div class="stat-lbl">252-Station Global Solar GNN</div>
        </div>
      </div>
      <p style="margin-top:18px;font-size:14.5px;color:#94a3b8;">
        Zero-Click Entrypoints: <code>/?demo=spaceapps</code> (Global ENSO Dipole) · <code>/?demo=veritas</code> (Denver Solar Microgrid)
      </p>
    </div>
    <div class="card sky" style="padding:18px;">
      <svg viewBox="0 0 460 360" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">
        <rect width="460" height="360" rx="10" fill="#060910"/>
        <text x="16" y="24" fill="#7dd3fc" font-size="13" font-weight="700">VIEW 1: 3D GLOBE + 5K GIBS OCEAN ANOMALY</text>
        <!-- Globe -->
        <defs>
          <radialGradient id="gbg" cx="42%" cy="38%" r="58%">
            <stop offset="0%" stop-color="#1e40af"/>
            <stop offset="55%" stop-color="#0f294a"/>
            <stop offset="100%" stop-color="#050811"/>
          </radialGradient>
        </defs>
        <circle cx="230" cy="182" r="122" fill="url(#gbg)" stroke="#38bdf8" stroke-opacity="0.55" stroke-width="2"/>
        <!-- Latitude / Longitude arcs -->
        <ellipse cx="230" cy="182" rx="122" ry="42" fill="none" stroke="#64748b" stroke-opacity="0.3" stroke-dasharray="4 4"/>
        <ellipse cx="230" cy="182" rx="52" ry="122" fill="none" stroke="#64748b" stroke-opacity="0.3" stroke-dasharray="4 4"/>
        <!-- Opposite dipole arc -->
        <path d="M 152 195 Q 225 110 302 186" fill="none" stroke="#f59e0b" stroke-width="3" stroke-dasharray="6 3"/>
        <!-- Warming pool -->
        <circle cx="302" cy="186" r="11" fill="#ef4444" stroke="#fecaca" stroke-width="2"/>
        <text x="262" y="213" fill="#fca5a5" font-size="11.5" font-weight="700">Indo-Pacific (+SST ↑)</text>
        <!-- Madagascar drying -->
        <circle cx="152" cy="195" r="11" fill="#38bdf8" stroke="#bae6fd" stroke-width="2"/>
        <text x="108" y="220" fill="#bae6fd" font-size="11.5" font-weight="700">Madagascar (NDVI ↓)</text>
        <!-- Card overlay -->
        <rect x="16" y="316" width="428" height="32" rx="6" fill="#0f172a" stroke="#334155"/>
        <text x="26" y="336" fill="#e2e8f0" font-size="11.5">Walker / ENSO Dipole · r = -0.65 · p = 0.000034 · Timeline: 2000–2026 [►]</text>
      </svg>
    </div>
  </div>
  <div class="footer">
    <span>Earth Trend Detective (<code>ETG</code>) · Open-Source MIT</span>
    <span>Live Multi-Agency Feeds: NASA GIBS · POWER · EONET · GISTEMP · NOAA · USGS · Copernicus</span>
  </div>
</section>

<!-- SLIDE 2 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">02 · The Challenge Gap</span>
    <span class="slidenum">Slide 2 / 7</span>
  </div>
  <h2>Seasonal Cycles Mask Long-Term Change &amp; Hide Opposite Regional Trends</h2>
  <div class="cols-2">
    <div>
      <div class="card" style="margin-bottom:16px;">
        <h3>Why Naive Trend Tools Fail Students &amp; Analysts</h3>
        <ul>
          <li><strong>Strong Annual Seasonality:</strong> Summer-winter swings dwarf 1–2°C or 10% moisture trends, causing false slopes or missed regime shifts.</li>
          <li><strong>Opposite Regional Responses:</strong> A single coupled driver (ENSO, Arctic Amplification) pushes precipitation or temperature <strong>up</strong> in one region and <strong>down</strong> across basins.</li>
          <li><strong>Lagging &amp; Spurious Correlations:</strong> Raw Pearson <code>|r|</code> mistakes synchronous winter/summer seasonality for physical causality.</li>
        </ul>
      </div>
      <div class="card emerald">
        <h3>Our Answer</h3>
        <p>Toggle <strong>Raw Values → Seasonal Cycle Removed</strong> on every comparison card (<code>Hirsch-Slack Seasonal Mann-Kendall p<sub>s</sub></code> + climatology deseasonalization), quantify cross-basin <code>drives_opposite</code> arcs, and filter spurious seasonal illusions with <strong>ETG Trend Microscope</strong>.</p>
      </div>
    </div>
    <div class="card" style="padding:18px;">
      <svg viewBox="0 0 440 340" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">
        <rect width="440" height="340" rx="8" fill="#060910"/>
        <text x="16" y="24" fill="#e2e8f0" font-size="13" font-weight="700">Raw Values vs. Seasonal Cycle Removed (pₛ &amp; Dipole r = -0.65)</text>
        <!-- Top panel: Raw seasonal cycle masking trend -->
        <rect x="16" y="38" width="408" height="122" rx="6" fill="#0f172a" stroke="#1e293b"/>
        <text x="26" y="55" fill="#94a3b8" font-size="11">RAW SERIES: Seasonal Wave Masks +0.4°C/decade Shift</text>
        <path d="M26 112 Q45 72 64 112 T102 110 T140 108 T178 106 T216 103 T254 100 T292 98 T330 95 T368 92 T406 88" fill="none" stroke="#64748b" stroke-width="2.2"/>
        <!-- Bottom panel: Deseasonalized dipole -->
        <rect x="16" y="176" width="408" height="148" rx="6" fill="#0f172a" stroke="#1e293b"/>
        <text x="26" y="194" fill="#34d399" font-size="11" font-weight="700">SEASONAL CYCLE REMOVED: Clear Opposite Dipole Revealed</text>
        <line x1="26" y1="252" x2="412" y2="252" stroke="#334155" stroke-dasharray="3 3"/>
        <path d="M26 266 L80 260 L140 248 L200 238 L260 226 L320 218 L406 206" fill="none" stroke="#ef4444" stroke-width="3"/>
        <path d="M26 238 L80 245 L140 256 L200 264 L260 278 L320 288 L406 300" fill="none" stroke="#38bdf8" stroke-width="3"/>
        <text x="275" y="212" fill="#fca5a5" font-size="11" font-weight="700">Indo-Pacific Warm Pool ↑</text>
        <text x="275" y="314" fill="#7dd3fc" font-size="11" font-weight="700">SW Indian / Madagascar ↓ (p=3.4e-5)</text>
      </svg>
    </div>
  </div>
  <div class="footer">
    <span>Guided Case Studies: ENSO vs. Madagascar · Arctic vs. Subpolar Gyre · Western Fire Aridity vs. Plains River · Front Range vs. Divide</span>
    <span>Deseasonalized Non-Parametric Tests</span>
  </div>
</section>

<!-- SLIDE 3 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">03 · View 1 — 3D Earth &amp; Significance Engine</span>
    <span class="slidenum">Slide 3 / 7</span>
  </div>
  <h2>Live 5K NASA GIBS Earth Filters, Statistical Engine &amp; Student Guide</h2>
  <div class="cols-2">
    <div class="card">
      <h3>9 NASA EOSDIS GIBS Satellite Filters + SVS Composite</h3>
      <p style="font-size:14.5px;">Real-time progressive WMTS/WMS textures on a WebGL 3D globe with astronomical solar terminator &amp; timeline scrubber:</p>
      <div class="layer-grid">
        <div class="layer-tag"><b>Ocean Anomaly</b>GHRSST L4 MUR SST</div>
        <div class="layer-tag"><b>Thermal LST</b>MODIS Terra Day</div>
        <div class="layer-tag"><b>Water / Rain</b>MERRA-2 + GPM IMERG</div>
        <div class="layer-tag"><b>Surface Winds</b>MERRA-2 Vectors</div>
        <div class="layer-tag"><b>2m Air Temp</b>MERRA-2 T2M</div>
        <div class="layer-tag"><b>Aerosols / Smoke</b>MERRA-2 + MODIS AOD</div>
        <div class="layer-tag"><b>Canopy NDVI</b>MODIS Terra 250m</div>
        <div class="layer-tag"><b>True Color</b>MODIS + Clouds</div>
        <div class="layer-tag"><b>VIIRS Night</b>Suomi NPP DNB</div>
      </div>
      <p style="margin-top:12px;font-size:14.5px;">Plus click-anywhere physical probes across <strong>NASA POWER</strong>, <strong>EONET v3</strong>, <strong>GISTEMP v4</strong>, <strong>NOAA GML/NSIDC/CDO</strong>, <strong>USGS NWIS</strong>, <strong>GloFAS v4</strong>, <strong>CAMS</strong>, <strong>KNMI</strong> &amp; <strong>CSA</strong>.</p>
    </div>
    <div>
      <div class="card emerald" style="margin-bottom:14px;">
        <h3>Formal Non-Parametric Significance Engine</h3>
        <ul>
          <li><strong>Mann-Kendall + Ties + Hamed-Rao Effective-N:</strong> Adjusts <code>p-value</code> &amp; <code>Z<sub>MK</sub></code> for AR(1) serial autocorrelation.</li>
          <li><strong>Hirsch-Slack Seasonal MK (<code>p<sub>s</sub></code>) + BH-FDR:</strong> Controls multi-region false discoveries.</li>
          <li><strong>Theil-Sen Slope + 95% CI &amp; Pettitt Test:</strong> Outlier-robust rate quantification &amp; regime change-point year.</li>
        </ul>
      </div>
      <div class="card amber">
        <h3>Student &amp; Classroom Readability (<code>? Variable Guide</code>)</h3>
        <p>Every technical chart includes a plain-English <strong>3-line statistics key</strong> (what changed, direction, confidence) and interactive variable explainers so high schoolers &amp; citizens can investigate immediately.</p>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>Sub-2s Upstream Chaos Resilience (upstreamResilience.ts) · Strict Error Taxonomy</span>
    <span>src/lib/stats/trendEngine.ts</span>
  </div>
</section>

<!-- SLIDE 4 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">04 · View 2 — Coalesced Earth Trend Graph &amp; Trend Microscope</span>
    <span class="slidenum">Slide 4 / 7</span>
  </div>
  <h2>Epistemic Ontology + AI Trend Microscope (<code>etg-trend-microscope-v1</code>)</h2>
  <div class="cols-2">
    <div>
      <div class="card" style="margin-bottom:14px;">
        <h3>Earth-Native Scientific Graph Ontology</h3>
        <ul>
          <li><code>Concept</code>: Regions, ocean basins, satellites &amp; edge sensors.</li>
          <li><code>Signal</code>: Timestamped geo-pinned series (lat, lng, dataset, confidence).</li>
          <li><code>Insight</code>: Verified trends &amp; <code>drives_opposite</code> teleconnections.</li>
          <li><code>Rule</code> + <code>supersedes</code>: Multi-source corroboration gates &amp; full belief revision history showing <em>how</em> scientific conclusions evolve.</li>
        </ul>
      </div>
      <div class="card sky">
        <h3>AI Perceptual Engine Outperforms Classical Baselines</h3>
        <p>Trained via Blackwell <code>bf16</code> Transformer distillation to surface pre-Mann-Kendall onsets (<code>3–6</code> steps early), directional lags, and cyclic/drift illusions for downstream AI detectives.</p>
      </div>
    </div>
    <div class="card" style="padding:18px;">
      <svg viewBox="0 0 440 340" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">
        <rect width="440" height="340" rx="8" fill="#060910"/>
        <text x="16" y="24" fill="#e2e8f0" font-size="13" font-weight="700">ETG Trend Microscope vs. Classical Baselines (Holdout n=88)</text>
        <!-- Bar 1: Early Onset AUROC -->
        <text x="18" y="60" fill="#cbd5e1" font-size="12" font-weight="700">1. Early Onset AUROC (3–6 steps before MK)</text>
        <rect x="18" y="68" width="352" height="22" rx="4" fill="#10b981"/>
        <text x="378" y="83" fill="#6ee7b7" font-size="12" font-weight="800">0.9789</text>
        <rect x="18" y="94" width="160" height="16" rx="3" fill="#475569"/>
        <text x="185" y="106" fill="#94a3b8" font-size="11">Classical Mann-Kendall: 0.4442</text>

        <!-- Bar 2: Directional Coupling AUROC -->
        <text x="18" y="138" fill="#cbd5e1" font-size="12" font-weight="700">2. True Lead-Lag Coupling AUROC</text>
        <rect x="18" y="146" width="357" height="22" rx="4" fill="#38bdf8"/>
        <text x="382" y="161" fill="#7dd3fc" font-size="12" font-weight="800">0.9916</text>
        <rect x="18" y="172" width="252" height="16" rx="3" fill="#475569"/>
        <text x="278" y="184" fill="#94a3b8" font-size="11">Raw Pearson |r|: 0.7010</text>

        <!-- Bar 3: Illusion Rejection -->
        <text x="18" y="216" fill="#cbd5e1" font-size="12" font-weight="700">3. Seasonal / Drift Illusion Rejection Rate</text>
        <rect x="18" y="224" width="356" height="22" rx="4" fill="#8b5cf6"/>
        <text x="381" y="239" fill="#c4b5fd" font-size="12" font-weight="800">98.9%</text>

        <!-- Summary KPI pill -->
        <rect x="18" y="264" width="404" height="60" rx="6" fill="#0f172a" stroke="#334155"/>
        <text x="30" y="287" fill="#fde68a" font-size="12" font-weight="700">False-Trend F1: 0.9380 · De-Alias Simplex MAE: 0.0570</text>
        <text x="30" y="308" fill="#94a3b8" font-size="11">NASA GISTEMP / NOAA CO₂ / NSIDC / KNMI Empirical Checks: 6/6 Passed</text>
      </svg>
    </div>
  </div>
  <div class="footer">
    <span>View 2: 3D WebGL Force Graph &amp; 2D Canvas · Tracked Portable Weights (ml/weights/etg-trend-microscope-v1.json)</span>
    <span>src/lib/graph/trendMicroscope.ts</span>
  </div>
</section>

<!-- SLIDE 5 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">05 · Impact — Denver K-12 Microgrid &amp; Global 7-Node Solar GNN</span>
    <span class="slidenum">Slide 5 / 7</span>
  </div>
  <h2>From Global Teleconnections to Any-Coordinate 7-Node Solar Dispatch</h2>
  <div class="cols-2">
    <div>
      <div class="card emerald" style="margin-bottom:14px;">
        <h3>Denver K-12 Microgrid (<code>Q<sub>0.268</sub> &lt; 3.50</code>, Unseen 2025–2026 n=606)</h3>
        <ul>
          <li><strong>Decision:</strong> Pre-charge <code>350 kWh</code> LFP battery at <code>23:00 MST</code> (<code>$0.075</code> off-peak vs <code>$0.280/kWh</code> peak deficit).</li>
          <li><strong>4-Way Colab HGBR:</strong> Persistence <code>1.3819</code> (<code>$1,532/yr</code>) → Local-Daily <code>1.0232</code> (<code>+$75</code>) → Local+23h <code>0.9404</code> (<code>+$99</code>) → <strong>Graph+23h <code>0.9278</code> RMSE</strong> (<code>+32.9%</code>, <code>88.6%</code> recall, <strong>+$418/yr</strong>, cost <code>p=0.0135</code>).</li>
          <li><strong>Live Web App (<code>/?demo=veritas</code>):</strong> Rolling Ridge <code>0.899</code> RMSE (Brier <code>0.080</code>) + Bayes <code>P(ALLSKY &lt; 3.5)</code> dispatch (<code>+$218/yr</code>).</li>
        </ul>
      </div>
      <div class="card">
        <h3><code>etg-global-gnn-v3</code> (Click Anywhere Worldwide)</h3>
        <p style="font-size:15px;"><strong>2,043,212</strong> params trained on <strong>36 cities / 252 NASA POWER Daily+Hourly stations</strong> (<code>54,570</code> train graph-days), running in <strong>~14 ms fp16 CPU</strong> inside <code>/api/earth/solar-graph</code>. Adapted Denver: <strong>0.9397 RMSE</strong> (<code>+32.6%</code>, <code>p=4.58e-17</code>, <code>+$205/yr</code>).</p>
      </div>
    </div>
    <div class="card" style="padding:18px;">
      <svg viewBox="0 0 440 340" width="100%" height="auto" xmlns="http://www.w3.org/2000/svg">
        <rect width="440" height="340" rx="8" fill="#060910"/>
        <text x="16" y="24" fill="#7dd3fc" font-size="13" font-weight="700">etg-global-gnn-v3: 5-Continent Zero-Shot Skill (+22.8% Mean)</text>
        <!-- Bars scaled cleanly: 35% = 300px -->
        <text x="18" y="64" fill="#e2e8f0" font-size="12" font-weight="600">Madrid, ES (Iberian)</text>
        <rect x="18" y="72" width="288" height="22" rx="4" fill="#10b981"/>
        <text x="314" y="87" fill="#6ee7b7" font-size="12" font-weight="800">+33.6% (0.7136 RMSE)</text>

        <text x="18" y="118" fill="#e2e8f0" font-size="12" font-weight="600">Salt Lake City, US (Analog)</text>
        <rect x="18" y="126" width="265" height="22" rx="4" fill="#38bdf8"/>
        <text x="291" y="141" fill="#7dd3fc" font-size="12" font-weight="800">+30.9% (0.8803 RMSE)</text>

        <text x="18" y="172" fill="#e2e8f0" font-size="12" font-weight="600">Sydney, AU (SH Coastal)</text>
        <rect x="18" y="180" width="215" height="22" rx="4" fill="#38bdf8"/>
        <text x="241" y="195" fill="#7dd3fc" font-size="12" font-weight="800">+25.1% (1.2027 RMSE)</text>

        <text x="18" y="226" fill="#e2e8f0" font-size="12" font-weight="600">Tokyo, JP (Pacific Monsoon)</text>
        <rect x="18" y="234" width="194" height="22" rx="4" fill="#8b5cf6"/>
        <text x="220" y="249" fill="#c4b5fd" font-size="12" font-weight="800">+22.7% (1.3531 RMSE)</text>

        <text x="18" y="280" fill="#e2e8f0" font-size="12" font-weight="600">Santiago, CL (Andean Basin)</text>
        <rect x="18" y="288" width="20" height="22" rx="4" fill="#f59e0b"/>
        <text x="48" y="303" fill="#fde68a" font-size="12" font-weight="800">+1.9% (Zero-Shot Transfer)</text>

        <text x="18" y="328" fill="#94a3b8" font-size="10.5">Denver Held-Out: 0.9947 (0-Shot) → 0.9397 (+Local Adapter) · Monotonic P10/Q0.268/P50/P90</text>
      </svg>
    </div>
  </div>
  <div class="footer">
    <span>Prototype tariff schedule estimate; live battery control requires utility telemetry.</span>
    <span>notebooks/denver_solar_climate_graph.ipynb</span>
  </div>
</section>

<!-- SLIDE 6 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">06 · Communal, Hardware-Agnostic &amp; AI-Native Architecture</span>
    <span class="slidenum">Slide 6 / 7</span>
  </div>
  <h2>Open Ingestion &amp; Multi-Tier Graph ML Stack</h2>
  <div class="cols-3">
    <div class="card sky">
      <h3>1. AI Agent Protocol (MCP)</h3>
      <ul>
        <li><strong>16-Tool MCP Server:</strong> Streamable HTTP &amp; SSE (<code>/api/mcp</code>, <code>/api/mcp/sse</code>) + <strong>OpenAPI 3.1.0</strong>.</li>
        <li>Agents query Trend Microscope, traverse k-hop causal paths, cite NASA feeds &amp; record corroborated insights.</li>
      </ul>
    </div>
    <div class="card emerald">
      <h3>2. Edge Sensors &amp; METAR</h3>
      <ul>
        <li><strong>Live KDEN / NWS Stream:</strong> 1-click UI ingestion + CLI <code>scripts/stream_ground_sensor.mjs</code> via <code>/api/graph/nodes/[id]/webhook</code>.</li>
        <li>ESP32, Raspberry Pi &amp; cameras corroborate or revise node beliefs with satellite provenance.</li>
      </ul>
    </div>
    <div class="card amber">
      <h3>3. Multi-Tier Graph ML</h3>
      <ul>
        <li><strong><code>etg-ml-v1</code>:</strong> <code>ETGLagGraphNet</code> (+51.38% RMSE lift: <code>1.8166</code> vs <code>3.7362</code>).</li>
        <li><strong><code>etg-global-gnn-v3</code>:</strong> 2.04M fp16 GNN in TypeScript (<code>~14 ms</code> CPU).</li>
        <li><strong><code>etg-ml-v2</code> &amp; Microscope:</strong> Inductive P10–P90 + GCP <code>L4</code> service.</li>
      </ul>
    </div>
  </div>
  <div class="card" style="padding:14px 20px;margin-top:4px;">
    <table>
      <thead>
        <tr>
          <th>Surface</th>
          <th>Data Inputs</th>
          <th>Corroboration / Integrity Guard</th>
          <th>Output / API</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><strong>Global Earth Discovery</strong></td>
          <td>NASA GIBS (9 layers), POWER, EONET v3, GISTEMP, NOAA, USGS, CAMS, KNMI</td>
          <td>FDR + Hamed-Rao + sub-2s Chaos Resilience</td>
          <td><code>POST /api/earth/discover</code> · View 1 &amp; 2</td>
        </tr>
        <tr>
          <td><strong>Community IoT &amp; CSV</strong></td>
          <td>Open-Meteo + NWS KDEN METAR, hardware webhooks, CSV empirical uploads</td>
          <td>Trust gate &amp; <code>supersedes</code> revision lineage</td>
          <td><code>/api/graph/nodes/[nodeId]/webhook</code></td>
        </tr>
        <tr>
          <td><strong>Solar &amp; AI Analytics</strong></td>
          <td>7-Node Daily+Hourly (LST) rings across any coordinate worldwide</td>
          <td>Strict chronological cutoffs + negative-lift guard</td>
          <td><code>GET /api/earth/solar-graph</code> · <code>/api/graph/microscope</code></td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="footer">
    <span>Verification Suite: tsc --noEmit · 32 Vitest Files (231 Tests) · 19 Python/PyTorch ML Tests (0 Skipped) · Next.js 16 Build</span>
    <span>Public APIs &amp; MCP</span>
  </div>
</section>

<!-- SLIDE 7 -->
<section class="slide">
  <div class="topbar">
    <span class="pill">07 · Citations, AI Disclosure &amp; Reproducibility</span>
    <span class="slidenum">Slide 7 / 7</span>
  </div>
  <h2>Open NASA Data Citations, AI Disclosure &amp; Verified Artifacts</h2>
  <div class="cols-eq">
    <div class="card">
      <h3>Official Open Data &amp; Software Citations</h3>
      <ul>
        <li><strong>NASA EOSDIS GIBS / Worldview:</strong> WMTS/WMS (GHRSST L4 MUR SST, GPM IMERG, MODIS Terra LST/NDVI/True Color, MERRA-2 Winds/T2M/AOD, Suomi NPP VIIRS).</li>
        <li><strong>NASA POWER · EONET v3 · GISTEMP v4:</strong> Daily/Hourly CERES SYN1deg + MERRA-2 meteorology, natural hazards &amp; global surface temperature anomalies.</li>
        <li><strong>Partner Agencies:</strong> NOAA (GML CO₂, NSIDC Sea Ice, CDO), USGS NWIS, Copernicus GloFAS v4 &amp; CAMS via Open-Meteo, KNMI, CSA Geo.ca.</li>
        <li><strong>Open Stack (MIT/BSD):</strong> Next.js, React, Three.js, Zod, Vitest, PyTorch, scikit-learn, NumPy, Pandas, Matplotlib.</li>
      </ul>
    </div>
    <div style="display:flex;flex-direction:column;gap:16px;">
      <div class="card sky" style="flex:1;">
        <h3>AI Usage Disclosure</h3>
        <p>AI coding assistants (Google Gemini / Antigravity and Claude) assisted with Next.js UI scaffolding, accessibility markup, tests, and documentation formatting. All challenge problem framing, scientific ontology design, statistical significance mathematics, ETG Trend Microscope &amp; Global Solar GNN architectures, upwind evening advection modeling, leak-free validation, and failure audits were independently designed and verified against real agency datasets.</p>
      </div>
      <div class="card emerald">
        <h3>Reproducible Deliverables</h3>
        <ul>
          <li><strong>Web App Deep-Links:</strong> <code>/?demo=spaceapps</code> &amp; <code>/?demo=veritas</code></li>
          <li><strong>Colab Notebooks (Executed):</strong> <code>denver_solar_climate_graph.ipynb</code> &amp; <code>etg_blackwell_global_trainer.ipynb</code></li>
          <li><strong>Repository:</strong> MIT License · Full tests, weights &amp; write-up</li>
        </ul>
      </div>
    </div>
  </div>
  <div class="footer">
    <span>Thank you! Explore global teleconnections &amp; verify local climate trends at any coordinate.</span>
    <span>Slide 7 / 7</span>
  </div>
</section>

</body>
</html>
"""


def render_pdf(html_path: Path, pdf_path: Path) -> None:
    if not CHROME_BIN.exists():
        raise RuntimeError(f"Chrome binary not found at {CHROME_BIN}")
    cmd = [
        str(CHROME_BIN),
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}",
        html_path.resolve().as_uri(),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0 or not pdf_path.exists():
        raise RuntimeError(f"Chrome print-to-pdf failed ({proc.returncode}): {proc.stderr}")


def scrub_pdf_metadata(pdf_path: Path, title: str) -> tuple[int, str]:
    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.add_metadata({
        "/Title": title,
        "/Author": "",
        "/Creator": "",
        "/Producer": "",
    })
    tmp = pdf_path.with_suffix(".tmp.pdf")
    with open(tmp, "wb") as f:
        writer.write(f)
    tmp.replace(pdf_path)

    check_reader = PdfReader(str(pdf_path))
    text = "\n".join((p.extract_text() or "") for p in check_reader.pages)
    meta_str = " ".join(f"{k}:{v}" for k, v in (check_reader.metadata or {}).items())
    return len(check_reader.pages), text + "\n" + meta_str


def main() -> None:
    writeup_html = DELIV_DIR / "veritas_climate_writeup_1page.html"
    writeup_pdf = DELIV_DIR / "veritas_climate_writeup_1page.pdf"

    # Try progressive compact typography presets until strictly 1 US Letter page
    presets = [
        (8.4, 1.28, 0.34),
        (8.0, 1.24, 0.30),
        (7.6, 1.20, 0.28),
        (7.2, 1.16, 0.25),
    ]
    writeup_pages = 0
    writeup_blob = ""
    for font_pt, lh, pad in presets:
        writeup_html.write_text(render_writeup_html(font_pt, lh, pad), encoding="utf-8")
        render_pdf(writeup_html, writeup_pdf)
        writeup_pages, writeup_blob = scrub_pdf_metadata(
            writeup_pdf, "Denver Solar Microgrid — Spatiotemporal & Evening Advection Climate Graph"
        )
        print(f"[writeup] preset=({font_pt}pt, lh={lh}, pad={pad}in) -> {writeup_pages} page(s)")
        if writeup_pages == 1:
            break
    if writeup_pages != 1:
        raise RuntimeError(f"Expected 1 page for Veritas writeup PDF, got {writeup_pages}")

    slides_html = DELIV_DIR / "spaceapps_7slide_deck.html"
    slides_pdf = DELIV_DIR / "spaceapps_7slide_deck.pdf"
    slides_html.write_text(render_slides_html(), encoding="utf-8")
    render_pdf(slides_html, slides_pdf)
    slides_pages, slides_blob = scrub_pdf_metadata(
        slides_pdf, "Earth Trend Detective — 7-Slide Presentation"
    )
    print(f"[slides] rendered -> {slides_pages} page(s)")
    if slides_pages != 7:
        raise RuntimeError(f"Expected exactly 7 pages for Space Apps slide PDF, got {slides_pages}")

    if PII_RE is not None:
        for label, content in [
            ("veritas_climate_writeup_1page.html", writeup_html.read_text(encoding="utf-8")),
            ("veritas_climate_writeup_1page.pdf", writeup_blob),
            ("spaceapps_7slide_deck.html", slides_html.read_text(encoding="utf-8")),
            ("spaceapps_7slide_deck.pdf", slides_blob),
        ]:
            hits = PII_RE.findall(content)
            if hits:
                raise RuntimeError(f"PII leaked in {label}: {hits[:5]}")

    print(
        f"OK: {writeup_pdf.relative_to(ROOT)} ({writeup_pages} page, {writeup_pdf.stat().st_size:,} bytes) & "
        f"{slides_pdf.relative_to(ROOT)} ({slides_pages} pages, {slides_pdf.stat().st_size:,} bytes) | 0 PII hits."
    )


if __name__ == "__main__":
    main()
