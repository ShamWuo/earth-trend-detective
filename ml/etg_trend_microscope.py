"""
Earth Trend Detective — ETG Trend Microscope (`etg-trend-microscope-v1`)

Hyper-specific 3-in-1 AI sensory organ built to assist LLMs & Earth scientists
rather than replace generalist climate/LLM models:
  1. Early Pre-Mann-Kendall Inflection & Onset Radar (`inflection_head`)
  2. True Directional Lead-Lag & Dipole Link Scorer (`coupling_head`)
  3. Secular vs. Oscillation Cycle vs. Sensor-Drift De-Aliaser (`dealias_head`)

Zero external dependencies required for portable training/inference (Python 3.9+ stdlib),
with full PyTorch Blackwell (`bf16`) Transformer teacher + GPU knowledge distillation
into portable `etg-trend-microscope-v1` weights (1:1 parity with TypeScript).

Facade re-exporting cohesive submodules from `ml/microscope/`.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

from microscope.corpus_and_benchmarks import (
    _compute_roc_auc,
    _generate_ar1_red_noise,
    _slice_live_hindsight_snapshots,
    _snapshot_from_series,
    _synthesize_curriculum_graph,
    build_microscope_training_corpus,
    evaluate_microscope_benchmarks,
    evaluate_real_historical_microscope,
    train_and_export_microscope,
)
from microscope.features import (
    NODE_FEATURE_DIM,
    NODE_FEATURE_NAMES,
    PAIR_FEATURE_DIM,
    PAIR_FEATURE_NAMES,
    WEIGHTS_SCHEMA_V1,
    _clamp,
    _fit_harmonic_r2,
    _fit_ridge_basis,
    _haversine_km,
    _lag_corr,
    _mann_kendall_abs_z,
    _ols_line,
    _ols_slope,
    _pearson,
    _pop_std,
    _sigmoid,
    _softmax,
    _softplus,
    _solve_linear_system,
    _strip_linear_and_season,
    extract_node_microscope_features,
    extract_pair_microscope_features,
)
from microscope.portable_model import (
    PortableTrendMicroscope,
    _classify_radar_badge,
    _init_linear,
    _matvec,
    _tanh_vec,
)
from microscope.torch_distill import F, TORCH_AVAILABLE, nn, torch

if TORCH_AVAILABLE:  # pragma: no cover - optional Colab / GPU path
    from microscope.torch_distill import (
        DistillablePortableMicroscope,
        PyTorchTrendMicroscope,
        _compute_multitask_loss,
        _pack_graph_torch,
        export_microscope_onnx,
        train_blackwell_microscope_and_distill,
    )


if __name__ == "__main__":  # pragma: no cover
    parser = argparse.ArgumentParser(description="Train & export ETG Trend Microscope v1 weights.")
    parser.add_argument(
        "--train-export",
        default=".data/etg-trend-microscope-v1.json",
        help="Destination path for exported etg-trend-microscope-v1 JSON weights.",
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    res = train_and_export_microscope(args.train_export, seed=args.seed)
    print(f"Exported {WEIGHTS_SCHEMA_V1} -> {res['path']}")
    print("Holdout Benchmarks:", json.dumps(res["benchmarks"], indent=2))
