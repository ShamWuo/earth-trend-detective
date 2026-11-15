"""Cohesive submodules for the `etg-ml-v1` Spatio-Temporal Lag-Aware Graph Neural Network."""

from .lag_graph_net import (
    HAS_PYG,
    HAS_TORCH,
    ETGLagGraphNet,
    train_and_evaluate_etg_stgnn,
)
from .windows_and_baselines import (
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
    from .lag_graph_net import PyTorchETGLagGNN

    __all__.append("PyTorchETGLagGNN")
