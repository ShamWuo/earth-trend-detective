# Earth Trend Graph Machine Learning (`ml/`)

Earth Trend Detective includes both **v1 transductive subgraph modeling** and **v2 Global Multi-Scale Inductive Graph Transformers** built for Colab Blackwell (`B200`) training and hosted GCP `L4` serving with zero-dependency local fallback.

## Architecture Overview

### v1 — Transductive Subgraph ST-GNN (`etg-ml-v1`)
- **`ml/etg_stgnn.py`** (`ETGLagGraphNet`): zero-dependency pure-Python ST-GNN with lag-aware temporal attention.
- **`ml/train_etg_gnn.py`**: CLI evaluator comparing Persistence, Self-AR Ridge, Linear Graph Ridge, and `ETGLagGraphNet` on bundles exported via `/api/graph/predict?format=ml_export`.
- **`ml/test_etg_gnn.py`**: unit tests for `etg-ml-v1` schema and nonlinear driver skill.

### v2 — Global Multi-Scale Inductive ETG Transformer (`etg-ml-v2`)
- **`ml/etg_inductive_gnn.py`**: dual stdlib + PyTorch (`if TORCH_AVAILABLE:`) inductive engine:
  - `PortableInductiveETGNet`: parameter-shared across all nodes (no node-ID lookup embeddings), supporting zero-shot unseen community sensors, calibrated `P10–P50–P90` quantiles, trend direction & regime-shift probabilities, and `etg-inductive-weights-v2.json` export for Next.js local inference.
  - `PyTorchInductiveETGTransformer`: multi-scale GRU + `TrustGatedGATLayer` attention + residual L4 adapter, with `train_pytorch_blackwell` (`bf16` + `torch.compile`), `finetune_incremental_adapter`, and `export_pytorch_onnx`.
- **`ml/harvest_global_multiscale.py`**: offline synthetic multi-scale generator (`build_synthetic_global_multiscale_bundle`), zero-shot community injector (`inject_synthetic_community_node`), and live HTTP feed harvester (`harvest_live_global_multiscale` for NOAA CO2, KNMI Nino 3.4, NASA POWER, NASA EONET).
- **`notebooks/etg_blackwell_global_trainer.ipynb`**: Google Colab Blackwell (`B200`) notebook running end-to-end `bf16` training, 5-way holdout benchmarking, unseen community trust-gate stress tests, and `.pt` / `.onnx` / `.data/etg-inductive-weights-v2.json` export.
- **`ml/l4_service/`** (`app.py`, `requirements.txt`, `Dockerfile`): FastAPI service for hosted GCP `L4` inference (`GET /health`, `POST /predict/region`, `POST /microscope/scan`) and validation-gated incremental fine-tuning (`POST /finetune/incremental` with automatic rollback if holdout RMSE degrades >1% or produces non-finite values).

### v3 — ETG Trend Microscope (`etg-trend-microscope-v1`, 3-in-1 AI Sensory Organ)
- **`ml/etg_trend_microscope.py`**: specialized 3-head perceptual engine built to help AI agents and scientists see hidden trend structure in ETG graphs rather than replace frontier reasoning:
  - **Head 1 (`inflection_head`)**: Early pre-Mann-Kendall trend-onset & inflection radar (3–6 steps ahead of classical `p < 0.05` while ignoring red-noise wander).
  - **Head 2 (`coupling_head`)**: True directional lead-lag (`tau = 0..5`) & `drives_opposite` / `co_trending` scorer that suppresses seasonal hemisphere illusions and shared-drift confounders.
  - **Head 3 (`dealias_head`)**: 3-simplex trend attribution (`[secularShare, oscillationShare, artifactShare]`) + `falseTrendProb` to catch multi-year cycle aliasing and uncorroborated sensor glitches.
  - Includes `PyTorchTrendMicroscope` Blackwell `bf16` teacher, GPU distillation (`train_blackwell_microscope_and_distill`), ONNX export, and portable weight checkpoint **`.data/etg-trend-microscope-v1.json`**.
- **Serving & UI Bridges**: Exposed via Next.js `/api/graph/microscope` (`GET`/`POST`), MCP tool `etg_scan_trend_microscope` (structured cue cards + compact `aiPerceptionBrief`), L4 FastAPI `POST /microscope/scan`, and AI Detective (`/api/ai/detective`) context enrichment.
- **`ml/test_etg_trend_microscope.py`**: unit & holdout benchmark tests verifying early onset AUROC > Mann-Kendall, true coupling AUROC > Pearson, illusion rejection, cycle de-aliasing, trust-gate separation, and L4 scan parity.

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
