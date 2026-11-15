# Earth Trend Graph Machine Learning (`ml/`)

Earth Trend Detective includes both **v1 transductive subgraph modeling** and **v2 Global Multi-Scale Inductive Graph Transformers** built for Colab Blackwell (`B200`) training and hosted GCP `L4` serving with zero-dependency local fallback.

## Architecture Overview

### v1 — Transductive Subgraph ST-GNN (`etg-ml-v1`)
- **`ml/etg_stgnn.py`** & **`ml/stgnn/`**: zero-dependency pure-Python `ETGLagGraphNet` with lag-aware temporal attention (`+51.38%` RMSE lift: `1.8166` vs. `3.7362` Self-AR Ridge).
- **`ml/train_etg_gnn.py`**: CLI evaluator comparing Persistence, Self-AR Ridge, Linear Graph Ridge, and `ETGLagGraphNet` on bundles exported via `/api/graph/predict?format=ml_export`.
- **`ml/test_etg_gnn.py`**: unit tests for `etg-ml-v1` schema and nonlinear driver skill.

### v2 — Global Multi-Scale Inductive ETG Transformer (`etg-ml-v2`)
- **`ml/etg_inductive_gnn.py`** & **`ml/inductive/`**: dual stdlib + PyTorch (`if TORCH_AVAILABLE:`) inductive engine:
  - `PortableInductiveETGNet`: parameter-shared across all nodes (no node-ID lookup embeddings), supporting zero-shot unseen community sensors, calibrated `P10–P50–P90` quantiles, trend direction & regime-shift probabilities, and `etg-inductive-weights-v2.json` export (git-tracked default at **`ml/weights/etg-inductive-weights-v2.json`**, overridable by `.data/etg-inductive-weights-v2.json`).
  - `PyTorchInductiveETGTransformer`: multi-scale GRU + `TrustGatedGATLayer` attention + residual L4 adapter, with `train_pytorch_blackwell` (`bf16` + `torch.compile`), `finetune_incremental_adapter`, and `export_pytorch_onnx`.
- **`ml/harvest_global_multiscale.py`** & **`ml/harvest/`**: offline synthetic multi-scale generator (`build_synthetic_global_multiscale_bundle`), zero-shot community injector (`inject_synthetic_community_node`), and live HTTP feed harvester (`harvest_live_global_multiscale` for NOAA CO2, KNMI Nino 3.4, NASA POWER, NASA EONET).
- **`ml/l4_service/`** (`app.py`, `requirements.txt`, `Dockerfile`): FastAPI service for hosted GCP `L4` inference (`GET /health`, `POST /predict/region`, `POST /microscope/scan`) and validation-gated incremental fine-tuning (`POST /finetune/incremental` with automatic rollback if holdout RMSE degrades >1% or produces non-finite values).

### v3 — ETG Trend Microscope (`etg-trend-microscope-v1`, 3-in-1 AI Sensory Organ)
- **`ml/etg_trend_microscope.py`** & **`ml/microscope/`**: specialized 3-head perceptual engine built to help AI agents and scientists see hidden trend structure in ETG graphs rather than replace frontier reasoning:
  - **Head 1 (`inflection_head`)**: Early pre-Mann-Kendall trend-onset & inflection radar (3–6 steps ahead of classical `p < 0.05` while ignoring red-noise wander; `n = 88` holdout **`0.9789` AUROC** vs. `0.4442` classical MK, `79.6%` (`0.7959`) pre-MK break recall vs. `0.0000`).
  - **Head 2 (`coupling_head`)**: True directional lead-lag (`tau = 0..5`) & `drives_opposite` / `co_trending` scorer that suppresses seasonal hemisphere illusions and shared-drift confounders (`n = 88` holdout **`0.9916` AUROC** vs. `0.7010` raw Pearson $|r|$, **`98.9%` (`0.9894`) illusion rejection**).
  - **Head 3 (`dealias_head`)**: 3-simplex trend attribution (`[secularShare, oscillationShare, artifactShare]`) + `falseTrendProb` to catch multi-year cycle aliasing and uncorroborated sensor glitches (`0.0570` simplex MAE, **`0.9380` false-trend detect F1**).
  - Includes `PyTorchTrendMicroscope` Blackwell `bf16` teacher, GPU distillation (`train_blackwell_microscope_and_distill`), ONNX export, and git-tracked portable checkpoint **`ml/weights/etg-trend-microscope-v1.json`** (runtime overrides read `.data/etg-trend-microscope-v1.json` first).
- **`notebooks/etg_blackwell_global_trainer.ipynb`**: Executed Google Colab Blackwell (`B200`) / PyTorch trainer notebook distilling `etg-trend-microscope-v1` and exporting `.pt` / `.onnx` / portable JSON weights.
- **Serving & UI Bridges**: Exposed via Next.js `/api/graph/microscope` (`GET`/`POST`), MCP tool `etg_scan_trend_microscope` (structured cue cards + compact `aiPerceptionBrief`), L4 FastAPI `POST /microscope/scan`, View 1/2 radar badges, and AI Detective (`/api/ai/detective`) context enrichment.
- **`ml/test_etg_trend_microscope.py`** & **`ml/test_zero_leakage_adversarial.py`**: unit, holdout benchmark, real agency corpus validation, and adversarial zero-leakage tests (`19` total Python ML tests across all `5` `ml/test_*.py` modules).

### v4 — Global Spatiotemporal Solar GNN (`etg-global-gnn-v3`)
- **`ml/global_gnn/`** (`cities_and_harvest.py`, `features_and_model.py`, `train_and_export.py`) & **`ml/run_global_gnn.py`**: `ETGGlobalSpatiotemporalGNN` (`2,043,212` params: temporal GRU + stacked `PhysicsTrustGATv2` layers + target residual adapter + monotonic pinball quantiles `P10 / Q0.268 / P50 / P90` + calibrated storm-risk head).
- **100% Official NASA POWER Corpus:** Harvested `252` stations (`36` global cities × 7-node upwind rings) using **NASA POWER Daily + Hourly (`LST`, <=4-year chunks)** (`54,570` train graph-days, `10,980` val graph-days, `global_val_rmse = 0.7670`).
- **Held-Out `2025–2026` Generalization & fp16 Runtime:** Achieves **`+22.8%` mean zero-shot skill across 5 held-out continents** (Salt Lake City `+30.86%`, Madrid `+33.62%`, Tokyo `+22.67%`, Sydney `+25.13%`, Santiago `+1.89%`) and unseen Denver (`n=678`) **`0.9947` 0-shot** (`+28.6%`, `81.1%` recall) / **`0.9397` adapted RMSE** (`+32.6%`, `p = 4.58e-17` vs. Persistence, `82.2%` recall, `+$205/yr`). Exported to fp16 binaries (`ml/weights/etg-global-gnn-v3*.bin`, `.meta.json`, `-summary.json`) for `~14 ms` vectorized CPU inference in [src/lib/solar/globalGnnInference.ts](../src/lib/solar/globalGnnInference.ts).

## Quick Usage

Run all local ML tests (zero external dependencies required):

```bash
python3 -m unittest discover -s ml -p "test_*.py" -v
```

Generate a standalone `etg-ml-v2` global multi-scale dataset:

```bash
python3 ml/harvest_global_multiscale.py --offline-synthetic --output .data/etg-ml-v2-global.json
```

Evaluate a downloaded `format=ml_export` v1 file:

```bash
python3 ml/train_etg_gnn.py --input path/to/etg-ml-graph.json
```

Deploy the GCP `L4` service and wire Earth Trend Detective via `.env.local`:

```bash
docker build -f ml/l4_service/Dockerfile -t etg-l4-service .
docker run --gpus all -p 8080:8080 -e ETG_CHECKPOINT_PATH=/app/ml/artifacts/etg_inductive_v2.pt etg-l4-service
```

Then set in Next.js:

```bash
ETG_ML_SERVICE_URL=http://<your-l4-host>:8080
```
