"""
Hosted GCP NVIDIA L4 Inference & Validation-Gated Incremental Fine-Tuning Service
for Earth Trend Detective (`etg-ml-v2`).

Supports:
- Pure-Python 3.9+ `L4InferenceEngine` (import-safe without `fastapi` or `torch` installed)
- Optional PyTorch CUDA (`L4`) acceleration + replay-regularized adapter fine-tuning when
  `torch` and an `etg_inductive_v2.pt` checkpoint are present
- FastAPI HTTP endpoints (`GET /health`, `POST /predict/region`, `POST /finetune/incremental`)
  matched to `src/app/api/graph/predict/route.ts` (`ETG_ML_SERVICE_URL`).
"""

from __future__ import annotations

import copy
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Union

_ML_ROOT = str(Path(__file__).resolve().parents[1])
if _ML_ROOT not in sys.path:
    sys.path.insert(0, _ML_ROOT)

from etg_inductive_gnn import (  # noqa: E402
    TORCH_AVAILABLE,
    WEIGHTS_SCHEMA_V2,
    PortableInductiveETGNet,
    evaluate_model_on_holdout,
    load_etg_ml_v2_dataset,
)
from etg_trend_microscope import (  # noqa: E402
    WEIGHTS_SCHEMA_V1 as MICROSCOPE_SCHEMA_V1,
    PortableTrendMicroscope,
    build_microscope_training_corpus,
)

if TORCH_AVAILABLE:  # pragma: no cover - optional CUDA runtime
    import torch
    from etg_inductive_gnn import (
        PyTorchInductiveETGTransformer,
        _bundle_to_torch_tensors,
        finetune_incremental_adapter,
    )
else:
    torch = None  # type: ignore[assignment]
    PyTorchInductiveETGTransformer = None  # type: ignore[assignment,misc]

try:  # pragma: no cover - optional FastAPI runtime
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel

    FASTAPI_AVAILABLE = True
except ImportError:
    FastAPI = None  # type: ignore[assignment,misc]
    HTTPException = None  # type: ignore[assignment,misc]
    BaseModel = object  # type: ignore[assignment,misc]
    FASTAPI_AVAILABLE = False


def _has_non_finite_numbers(obj: Any) -> bool:
    if isinstance(obj, bool):
        return False
    if isinstance(obj, (int, float)):
        return not math.isfinite(float(obj))
    if isinstance(obj, list) or isinstance(obj, tuple):
        return any(_has_non_finite_numbers(item) for item in obj)
    if isinstance(obj, dict):
        return any(_has_non_finite_numbers(v) for v in obj.values())
    return False


class L4InferenceEngine:
    """
    Stateful inference and validation-gated incremental fine-tuning engine for `ETG_ML_SERVICE_URL`.
    """

    def __init__(
        self,
        checkpoint_path: Optional[Union[str, Path]] = None,
        microscope_checkpoint_path: Optional[Union[str, Path]] = None,
    ) -> None:
        resolved = checkpoint_path or os.environ.get("ETG_CHECKPOINT_PATH", "").strip() or None
        self.checkpoint_path = Path(resolved) if resolved else None
        resolved_micro = (
            microscope_checkpoint_path
            or os.environ.get("ETG_MICROSCOPE_CHECKPOINT_PATH", "").strip()
            or str(Path(_ML_ROOT).parent / ".data" / "etg-trend-microscope-v1.json")
        )
        self.microscope_checkpoint_path = Path(resolved_micro)
        self.portable_model = PortableInductiveETGNet(hidden_dim=16, seed=42)
        self.microscope_model = PortableTrendMicroscope(hidden_dim=32, seed=42)
        self.microscope_fitted = False
        self.torch_model: Any = None
        self.device_str = "cpu"
        self.fitted = False
        self.finetune_accepts = 0
        self.finetune_rollbacks = 0
        self._reference_val_bundle: Optional[Dict[str, Any]] = None

        if TORCH_AVAILABLE and torch is not None:
            if torch.cuda.is_available():
                self.device_str = f"cuda:{torch.cuda.current_device()}"
            elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                self.device_str = "mps"

        if self.checkpoint_path is not None and self.checkpoint_path.exists():
            self._load_checkpoint(self.checkpoint_path)

        if self.microscope_checkpoint_path.exists():
            try:
                raw_m = json.loads(self.microscope_checkpoint_path.read_text(encoding="utf-8"))
                if isinstance(raw_m, dict) and raw_m.get("schema_version") == MICROSCOPE_SCHEMA_V1:
                    self.microscope_model = PortableTrendMicroscope.from_weights_dict(raw_m)
                    self.microscope_fitted = True
            except Exception:
                self.microscope_fitted = False

    def _load_checkpoint(self, path: Path) -> None:
        if path.suffix.lower() == ".json":
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("schema_version") == WEIGHTS_SCHEMA_V2:
                self.portable_model = PortableInductiveETGNet.from_portable_weights_dict(raw)
                self.fitted = True
                return
        if TORCH_AVAILABLE and torch is not None and path.suffix.lower() in (".pt", ".pth"):
            state = torch.load(str(path), map_location=self.device_str)
            d_model = int(state.get("d_model", 96)) if isinstance(state, dict) else 96
            model = PyTorchInductiveETGTransformer(d_model=d_model)
            sd = state.get("state_dict", state) if isinstance(state, dict) else state
            model.load_state_dict(sd)
            model.to(torch.device(self.device_str)).eval()
            self.torch_model = model
            self.fitted = True

    def health(self) -> Dict[str, Any]:
        backend = "pytorch_inductive_v2" if self.torch_model is not None else "portable_inductive_v2"
        return {
            "status": "ok",
            "torch_available": bool(TORCH_AVAILABLE),
            "backend": backend,
            "device": self.device_str,
            "fitted": self.fitted,
            "microscope_fitted": self.microscope_fitted,
            "finetune_accepts": self.finetune_accepts,
            "finetune_rollbacks": self.finetune_rollbacks,
        }

    def scan_microscope(
        self,
        bundle: Dict[str, Any],
        focus_uuid: Optional[str] = None,
        top_k: int = 8,
    ) -> Dict[str, Any]:
        """Run the 3-in-1 ETG Trend Microscope sensory organ over an `etg-ml-v2` bundle."""
        if _has_non_finite_numbers(bundle):
            raise ValueError("Non-finite numbers detected in microscope scan bundle.")
        if not self.microscope_fitted:
            corpus = build_microscope_training_corpus(num_synthetic_graphs=60, seed=42)
            self.microscope_model.fit_portable(corpus["train"], epochs=20, lr=0.035, seed=42)
            self.microscope_fitted = True
        loaded = load_etg_ml_v2_dataset(bundle)
        return self.microscope_model.scan_v2_bundle(loaded, focus_uuid=focus_uuid, top_k=top_k)

    def predict_from_bundle(
        self,
        bundle: Dict[str, Any],
        target_uuid: Optional[str] = None,
        horizon_steps: int = 1,
    ) -> Dict[str, Any]:
        loaded = load_etg_ml_v2_dataset(bundle)
        if self._reference_val_bundle is None and not _has_non_finite_numbers(loaded):
            self._reference_val_bundle = copy.deepcopy(loaded)

        node_ids = loaded["node_ids"]
        if target_uuid and target_uuid in node_ids:
            target_idx = node_ids.index(target_uuid)
            resolved_uuid = target_uuid
        else:
            target_idx = 0
            resolved_uuid = node_ids[0]

        if self.torch_model is not None and TORCH_AVAILABLE and torch is not None:
            dev = next(self.torch_model.parameters()).device
            tensors = _bundle_to_torch_tensors(loaded, dev)
            W = min(8, tensors["feat"].shape[0])
            win = tensors["feat"][-W:].unsqueeze(0)
            w_mask = tensors["mask"][-W:].unsqueeze(0)
            scale_map = {"day": 0, "month": 1, "year": 2}
            scale_id = scale_map.get(str(loaded.get("primary_bucket", "month")), 1)
            with torch.no_grad():
                out = self.torch_model(win, tensors["static"], tensors["edge_index"], tensors["edge_attr"], w_mask, scale_id)
            q_z = out["quantiles"][0, target_idx].detach().cpu().tolist()
            t_logits = out["trend_logits"][0, target_idx].detach().cpu()
            t_probs = torch.softmax(t_logits, dim=-1).tolist()
            r_prob = float(torch.sigmoid(out["regime_logits"][0, target_idx]).detach().cpu().item())

            norms = loaded.get("normalization", [])
            norm = norms[target_idx] if target_idx < len(norms) else {"mean": 0.0, "std": 1.0}
            mean = float(norm.get("mean", 0.0))
            std = max(1e-6, float(norm.get("std", 1.0)))
            p10, p50, p90 = q_z[0] * std + mean, q_z[1] * std + mean, q_z[2] * std + mean
            direction = (
                "increasing"
                if t_probs[2] >= t_probs[0] and t_probs[2] >= t_probs[1]
                else "decreasing"
                if t_probs[0] >= t_probs[1]
                else "stable"
            )
            return {
                "engineUsed": "l4_inductive_gnn",
                "targetUuid": resolved_uuid,
                "horizonSteps": horizon_steps,
                "predicted_value": round(p50, 4),
                "recommendedForecastValue": round(p50, 4),
                "quantiles": {"p10": round(p10, 4), "p50": round(p50, 4), "p90": round(p90, 4)},
                "trendForecast": {
                    "direction": direction,
                    "probabilities": {
                        "decreasing": round(t_probs[0], 4),
                        "stable": round(t_probs[1], 4),
                        "increasing": round(t_probs[2], 4),
                    },
                    "regimeShiftProb": round(r_prob, 4),
                },
            }

        if not self.fitted:
            self.portable_model.fit(loaded, epochs=50, lr=0.025, seed=42)
            self.fitted = True

        preds = self.portable_model.predict_bundle(loaded, node_indices=[target_idx])
        pred = preds.get(target_idx)
        if pred is None:
            # Fallback to last masked observation if final step masked out
            for t in range(len(loaded["feature_tensor"]) - 1, -1, -1):
                if loaded["mask_tensor"][t][target_idx] == 1:
                    alt = self.portable_model.predict_bundle(loaded, t_idx=t, node_indices=[target_idx])
                    pred = alt.get(target_idx)
                    if pred is not None:
                        break
        if pred is None:
            raise ValueError(f"No valid observations available to predict node '{resolved_uuid}'.")

        val = round(float(pred["predicted_value"]), 4)
        q = pred["quantiles"]
        return {
            "engineUsed": "l4_inductive_gnn",
            "targetUuid": resolved_uuid,
            "horizonSteps": horizon_steps,
            "predicted_value": val,
            "recommendedForecastValue": val,
            "quantiles": {
                "p10": round(float(q["p10"]), 4),
                "p50": round(float(q["p50"]), 4),
                "p90": round(float(q["p90"]), 4),
            },
            "trendForecast": pred["trendForecast"],
        }

    def _combined_holdout_rmse(self, bundle: Dict[str, Any]) -> float:
        m_batch = evaluate_model_on_holdout(self.portable_model, bundle)
        batch_rmse = float(m_batch["model_rmse"])
        if self._reference_val_bundle is not None:
            m_ref = evaluate_model_on_holdout(self.portable_model, self._reference_val_bundle)
            return 0.5 * (batch_rmse + float(m_ref["model_rmse"]))
        return batch_rmse

    def finetune_incremental(
        self,
        bundle: Dict[str, Any],
        steps: int = 25,
        lr: float = 0.015,
    ) -> Dict[str, Any]:
        """
        Replay-regularized incremental fine-tuning with strict validation rollback guard.
        Rejects NaN/Inf batches or updates that degrade holdout RMSE by >1%.
        """
        if _has_non_finite_numbers(bundle):
            self.finetune_rollbacks += 1
            return {
                "accepted": False,
                "val_rmse_before": None,
                "val_rmse_after": None,
                "rollback_reason": "Non-finite values detected in fine-tune bundle; rejected cleanly.",
            }

        loaded = load_etg_ml_v2_dataset(bundle)
        if self._reference_val_bundle is None:
            self._reference_val_bundle = copy.deepcopy(loaded)

        if self.torch_model is not None and TORCH_AVAILABLE and torch is not None:
            res = finetune_incremental_adapter(self.torch_model, loaded, steps=steps, lr=min(1e-3, lr))
            if res.get("accepted"):
                self.finetune_accepts += 1
            else:
                self.finetune_rollbacks += 1
            return res

        prior_state = self.portable_model.clone()
        was_fitted = self.fitted
        if not self.fitted:
            self.portable_model.fit(self._reference_val_bundle, epochs=40, lr=0.025, seed=42)
            self.fitted = True
            prior_state = self.portable_model.clone()
            was_fitted = True

        val_before = self._combined_holdout_rmse(loaded)
        self.portable_model.fit(loaded, epochs=max(5, steps), lr=lr, seed=42)
        val_after = self._combined_holdout_rmse(loaded)

        if not math.isfinite(val_after) or val_after > max(1e-6, val_before) * 1.01:
            self.portable_model = prior_state
            self.fitted = was_fitted
            self.finetune_rollbacks += 1
            return {
                "accepted": False,
                "val_rmse_before": round(val_before, 6),
                "val_rmse_after": round(val_after, 6) if math.isfinite(val_after) else None,
                "rollback_reason": "Validation holdout RMSE degraded by >1%; restored prior weights.",
            }

        self.fitted = True
        self.finetune_accepts += 1
        return {
            "accepted": True,
            "val_rmse_before": round(val_before, 6),
            "val_rmse_after": round(val_after, 6),
        }


_ENGINE: Optional[L4InferenceEngine] = None


def get_engine() -> L4InferenceEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = L4InferenceEngine()
    return _ENGINE


if FASTAPI_AVAILABLE:  # pragma: no cover - optional FastAPI HTTP wrapper

    class PredictRegionPayload(BaseModel):
        bundle: Dict[str, Any]
        targetUuid: Optional[str] = None
        lat: Optional[float] = None
        lng: Optional[float] = None
        dataset: Optional[str] = None
        horizonSteps: int = 1

    class FinetunePayload(BaseModel):
        bundle: Dict[str, Any]
        steps: int = 25
        lr: float = 0.015

    class MicroscopeScanPayload(BaseModel):
        bundle: Dict[str, Any]
        focusUuid: Optional[str] = None
        topK: int = 8

    app = FastAPI(title="Earth Trend Detective L4 Inductive GNN Service", version="2.0.0")

    @app.get("/health")
    def health_route() -> Dict[str, Any]:
        return get_engine().health()

    @app.post("/predict/region")
    def predict_region_route(payload: PredictRegionPayload) -> Dict[str, Any]:
        try:
            return get_engine().predict_from_bundle(
                payload.bundle,
                target_uuid=payload.targetUuid,
                horizon_steps=payload.horizonSteps,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/microscope/scan")
    def microscope_scan_route(payload: MicroscopeScanPayload) -> Dict[str, Any]:
        try:
            return get_engine().scan_microscope(
                payload.bundle,
                focus_uuid=payload.focusUuid,
                top_k=payload.topK,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/finetune/incremental")
    def finetune_route(payload: FinetunePayload) -> Dict[str, Any]:
        try:
            return get_engine().finetune_incremental(
                payload.bundle,
                steps=payload.steps,
                lr=payload.lr,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
else:
    app = None
