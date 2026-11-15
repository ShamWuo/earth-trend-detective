"""Modular submodules for the Inductive Multi-Scale Spatio-Temporal ETG GNN."""

from inductive.portable_net import (
    SCHEMA_VERSION_V2,
    WEIGHTS_SCHEMA_V2,
    PortableInductiveETGNet,
    _extract_in_edges,
    _sigmoid,
    _softmax3,
    _tanh,
    evaluate_model_on_holdout,
    load_etg_ml_v2_dataset,
    train_and_evaluate_inductive_v2,
)
from inductive.torch_transformer import F, TORCH_AVAILABLE, nn, torch

if TORCH_AVAILABLE:
    from inductive.torch_transformer import (
        PyTorchInductiveETGTransformer,
        TrustGatedGATLayer,
        _bundle_to_torch_tensors,
        _pinball_loss,
        export_pytorch_onnx,
        finetune_incremental_adapter,
        train_pytorch_blackwell,
    )

__all__ = [
    "TORCH_AVAILABLE",
    "SCHEMA_VERSION_V2",
    "WEIGHTS_SCHEMA_V2",
    "load_etg_ml_v2_dataset",
    "PortableInductiveETGNet",
    "evaluate_model_on_holdout",
    "train_and_evaluate_inductive_v2",
]
