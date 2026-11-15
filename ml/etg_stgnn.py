"""Pure-Python Spatio-Temporal Lag-Aware Graph Neural Network for Earth Trend Graph (`etg-ml-v1`).

Runs with zero third-party dependencies on Python 3.9+ (stdlib `math`, `random`, `json`),
and optionally exposes a PyTorch / PyTorch Geometric module when `torch` is installed.

Facade re-exporting cohesive submodules from `ml/stgnn/`.
"""

from __future__ import annotations

from pathlib import Path
import sys

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

from stgnn.lag_graph_net import (
    HAS_PYG,
    HAS_TORCH,
    ETGLagGraphNet,
    MessagePassing,
    nn,
    torch,
    train_and_evaluate_etg_stgnn,
)
from stgnn.windows_and_baselines import (
    EtgMlDataset,
    NeighborEdgeSpec,
    SupervisedSample,
    _eval_preds,
    _mean_std,
    _solve_ridge,
    build_supervised_windows,
    evaluate_baselines,
    load_etg_ml_dataset,
    select_target_index,
)

__all__ = [
    "HAS_TORCH",
    "HAS_PYG",
    "torch",
    "nn",
    "MessagePassing",
    "EtgMlDataset",
    "NeighborEdgeSpec",
    "SupervisedSample",
    "load_etg_ml_dataset",
    "select_target_index",
    "_mean_std",
    "build_supervised_windows",
    "_solve_ridge",
    "_eval_preds",
    "evaluate_baselines",
    "ETGLagGraphNet",
    "train_and_evaluate_etg_stgnn",
]

if HAS_TORCH:  # pragma: no cover - optional PyTorch path
    from stgnn.lag_graph_net import PyTorchETGLagGNN

    __all__.append("PyTorchETGLagGNN")
