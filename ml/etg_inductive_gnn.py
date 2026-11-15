"""
Inductive Multi-Scale Spatio-Temporal Earth Trend Graph (ETG) GNN.

Dual runtime design:
1. Pure-Python `PortableInductiveETGNet`: zero external dependencies (runs on Python 3.9+),
   parameter-shared across nodes (zero node-ID embeddings), supports zero-shot inductive
   inference on brand-new unseen nodes/edges, trust-gates noisy community sensors, and
   exports `etg-inductive-weights-v2.json` for zero-dependency Next.js fallback.
2. PyTorch `PyTorchInductiveETGTransformer` (active when `torch` is installed):
   multi-scale causal Conv1D+GRU encoder + Trust-Gated Heterogeneous Lag-Aware GATv2
   message passing + Quantile/Trend/Regime-Shift heads, with `bf16`/`torch.compile`
   Colab Blackwell (`B200`) training and validation-gated GCP `L4` incremental fine-tuning.

Facade re-exporting cohesive submodules from `ml/inductive/`.
"""

from __future__ import annotations

from pathlib import Path
import sys

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

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
