"""Modular submodules for the ETG Trend Microscope (`etg-trend-microscope-v1`)."""

from microscope.corpus_and_benchmarks import (
    _compute_roc_auc,
    _generate_ar1_red_noise,
    _slice_live_hindsight_snapshots,
    _snapshot_from_series,
    _synthesize_curriculum_graph,
    build_microscope_training_corpus,
    evaluate_microscope_benchmarks,
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

if TORCH_AVAILABLE:
    from microscope.torch_distill import (
        DistillablePortableMicroscope,
        PyTorchTrendMicroscope,
        _compute_multitask_loss,
        _pack_graph_torch,
        export_microscope_onnx,
        train_blackwell_microscope_and_distill,
    )

__all__ = [
    "TORCH_AVAILABLE",
    "WEIGHTS_SCHEMA_V1",
    "NODE_FEATURE_DIM",
    "PAIR_FEATURE_DIM",
    "NODE_FEATURE_NAMES",
    "PAIR_FEATURE_NAMES",
    "extract_node_microscope_features",
    "extract_pair_microscope_features",
    "PortableTrendMicroscope",
    "build_microscope_training_corpus",
    "evaluate_microscope_benchmarks",
    "train_and_export_microscope",
]
