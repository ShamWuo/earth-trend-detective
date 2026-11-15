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
"""

from __future__ import annotations

import copy
import json
import math
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover - local CPU stdlib fallback
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    TORCH_AVAILABLE = False


SCHEMA_VERSION_V2 = "etg-ml-v2"
WEIGHTS_SCHEMA_V2 = "etg-inductive-weights-v2"


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-min(50.0, x))
        return 1.0 / (1.0 + z)
    z = math.exp(max(-50.0, x))
    return z / (1.0 + z)


def _tanh(x: float) -> float:
    return math.tanh(max(-20.0, min(20.0, x)))


def _softmax3(logits: Sequence[float]) -> List[float]:
    m = max(logits)
    exps = [math.exp(max(-30.0, v - m)) for v in logits]
    s = sum(exps) or 1.0
    return [v / s for v in exps]


def load_etg_ml_v2_dataset(source: Union[str, Path, Dict[str, Any]]) -> Dict[str, Any]:
    """Load and validate an `etg-ml-v2` zero-leakage multi-scale ETG bundle."""
    if isinstance(source, (str, Path)):
        raw_text = Path(source).read_text(encoding="utf-8")
        data = json.loads(raw_text)
    elif isinstance(source, dict):
        data = source
    else:
        raise ValueError("Expected file path or dict for etg-ml-v2 dataset.")

    if not isinstance(data, dict) or data.get("schema_version") != SCHEMA_VERSION_V2:
        raise ValueError(
            f"Expected schema_version '{SCHEMA_VERSION_V2}', got '{data.get('schema_version') if isinstance(data, dict) else type(data)}'."
        )

    node_ids = data.get("node_ids")
    feature_tensor = data.get("feature_tensor")
    mask_tensor = data.get("mask_tensor")
    static_feats = data.get("node_static_features")
    edge_index = data.get("edge_index")
    edge_attr = data.get("edge_attr")

    if not isinstance(node_ids, list) or len(node_ids) == 0:
        raise ValueError("Invalid etg-ml-v2 dataset: node_ids must be non-empty.")
    num_nodes = len(node_ids)

    if not isinstance(feature_tensor, list) or len(feature_tensor) < 4:
        raise ValueError("Invalid etg-ml-v2 dataset: feature_tensor requires >= 4 timesteps.")
    num_steps = len(feature_tensor)

    if not isinstance(mask_tensor, list) or len(mask_tensor) != num_steps:
        raise ValueError("Invalid etg-ml-v2 dataset: mask_tensor length mismatch.")
    if not isinstance(static_feats, list) or len(static_feats) != num_nodes:
        raise ValueError("Invalid etg-ml-v2 dataset: node_static_features count mismatch.")
    if not isinstance(edge_index, list) or len(edge_index) != 2:
        raise ValueError("Invalid etg-ml-v2 dataset: edge_index must have [src, dst].")
    if not isinstance(edge_attr, list) or len(edge_attr) != len(edge_index[0]):
        raise ValueError("Invalid etg-ml-v2 dataset: edge_attr length mismatch.")

    cutoff = int(data.get("train_cutoff_index", max(2, int(num_steps * 0.75))))
    if cutoff < 2 or cutoff > num_steps:
        raise ValueError(f"Invalid train_cutoff_index={cutoff} for T={num_steps}.")

    return data


def _extract_in_edges(bundle: Dict[str, Any]) -> Dict[int, List[Tuple[int, int]]]:
    srcs, dsts = bundle["edge_index"]
    in_edges: Dict[int, List[Tuple[int, int]]] = {}
    for e_idx, (s, d) in enumerate(zip(srcs, dsts)):
        in_edges.setdefault(int(d), []).append((int(s), e_idx))
    return in_edges


class PortableInductiveETGNet:
    """
    Zero-dependency parameter-shared inductive GNN.

    Reads continuous `node_static_features` (16), causal `feature_tensor` (8),
    and `edge_attr` (8) with learned sigmoid trust-gating so brand-new unseen
    community sensors or regional anchors work zero-shot without retraining.
    """

    def __init__(self, hidden_dim: int = 16, seed: int = 42) -> None:
        self.hidden_dim = hidden_dim
        rng = random.Random(seed)
        scale_s = 0.25 / math.sqrt(16)
        scale_t = 0.30 / math.sqrt(8)
        scale_m = 0.25 / math.sqrt(16)
        scale_h = 0.30 / math.sqrt(hidden_dim)

        self.static_proj_w: List[List[float]] = [
            [rng.gauss(0.0, scale_s) for _ in range(16)] for _ in range(hidden_dim)
        ]
        self.static_proj_b: List[float] = [0.0 for _ in range(hidden_dim)]

        self.temp_proj_w: List[List[float]] = [
            [rng.gauss(0.0, scale_t) for _ in range(8)] for _ in range(hidden_dim)
        ]
        self.temp_proj_b: List[float] = [0.0 for _ in range(hidden_dim)]

        self.msg_proj_w: List[List[float]] = [
            [rng.gauss(0.0, scale_m) for _ in range(16)] for _ in range(hidden_dim)
        ]
        self.msg_proj_b: List[float] = [0.0 for _ in range(hidden_dim)]

        # Initialize trust gate steeply positive on trust_score >= 0.65 and suppressing <= 0.35
        self.trust_gate_w: float = 8.0
        self.trust_gate_b: float = -4.2

        self.head_w: List[float] = [rng.gauss(0.0, scale_h) for _ in range(hidden_dim)]
        self.head_b: float = 0.0
        # Seed slight persistence prior on z_score feature (index 1) via temp_proj/head alignment
        self.residual_z_weight: float = 0.72

        self.trend_w: List[List[float]] = [
            [rng.gauss(0.0, scale_h) for _ in range(hidden_dim)] for _ in range(3)
        ]
        self.trend_b: List[float] = [0.0, 0.2, 0.0]

        self.regime_w: List[float] = [rng.gauss(0.0, scale_h) for _ in range(hidden_dim)]
        self.regime_b: float = -1.5
        self.calibrated_z_spread: float = 1.0

    def clone(self) -> "PortableInductiveETGNet":
        return copy.deepcopy(self)

    def _compute_trust_gate(self, trust_score: float, corroborated: bool) -> float:
        base = _sigmoid(self.trust_gate_w * trust_score + self.trust_gate_b)
        if not corroborated and trust_score < 0.4:
            # Square penalty strongly suppresses uncorroborated noisy crowd injections
            return base * base
        return base

    def forward_node_step(
        self,
        bundle: Dict[str, Any],
        target_idx: int,
        t_idx: int,
        in_edges_map: Optional[Dict[int, List[Tuple[int, int]]]] = None,
    ) -> Dict[str, Any]:
        static_feats = bundle["node_static_features"][target_idx]
        temp_feats = bundle["feature_tensor"][t_idx][target_idx]
        mask_row = bundle["mask_tensor"][t_idx]
        edge_attrs = bundle["edge_attr"]
        node_meta = bundle.get("node_metadata", [])

        if in_edges_map is None:
            in_edges_map = _extract_in_edges(bundle)
        incoming = in_edges_map.get(target_idx, [])

        H = self.hidden_dim
        pre_hidden = [0.0] * H
        for h in range(H):
            acc = self.static_proj_b[h] + self.temp_proj_b[h]
            sw = self.static_proj_w[h]
            tw = self.temp_proj_w[h]
            for i in range(min(16, len(static_feats))):
                acc += sw[i] * static_feats[i]
            for i in range(min(8, len(temp_feats))):
                acc += tw[i] * temp_feats[i]
            pre_hidden[h] = acc

        msg_agg = [0.0] * H
        weight_sum = 0.0
        used_msgs: List[Tuple[float, List[float], List[float]]] = []

        for src_idx, e_idx in incoming:
            if src_idx >= len(mask_row) or mask_row[src_idx] != 1:
                continue
            src_temp = bundle["feature_tensor"][t_idx][src_idx]
            e_attr = edge_attrs[e_idx]
            meta = node_meta[src_idx] if src_idx < len(node_meta) else {}
            src_trust = float(meta.get("trust_score", bundle["node_static_features"][src_idx][5]))
            corroborated = bool(meta.get("corroborated", False))
            gate = self._compute_trust_gate(src_trust, corroborated)
            base_w = max(0.05, float(e_attr[2]) if len(e_attr) > 2 else 0.5)
            eff_w = base_w * gate
            weight_sum += eff_w

            vec16 = list(src_temp[:8]) + list(e_attr[:8])
            if len(vec16) < 16:
                vec16.extend([0.0] * (16 - len(vec16)))
            act_m = []
            mw_list = self.msg_proj_w
            for h in range(H):
                m_val = self.msg_proj_b[h]
                mw = mw_list[h]
                for k in range(16):
                    m_val += mw[k] * vec16[k]
                tm = _tanh(m_val)
                msg_agg[h] += eff_w * tm
                act_m.append(tm)
            used_msgs.append((eff_w, vec16, act_m))

        hidden = [0.0] * H
        denom = max(1e-6, weight_sum)
        for h in range(H):
            msg_term = (msg_agg[h] / denom) if weight_sum > 0 else 0.0
            hidden[h] = _tanh(pre_hidden[h] + msg_term)

        cur_z = float(temp_feats[1]) if len(temp_feats) > 1 else 0.0
        pred_z = self.head_b + self.residual_z_weight * cur_z
        for h in range(H):
            pred_z += self.head_w[h] * hidden[h]

        trend_logits = []
        for c in range(3):
            logit = self.trend_b[c]
            tw_c = self.trend_w[c]
            for h in range(H):
                logit += tw_c[h] * hidden[h]
            # Smooth coupling from predicted step change
            delta_z = pred_z - cur_z
            if c == 0:
                logit += -0.6 * delta_z
            elif c == 2:
                logit += 0.6 * delta_z
            trend_logits.append(logit)
        trend_probs = _softmax3(trend_logits)

        reg_logit = self.regime_b
        for h in range(H):
            reg_logit += self.regime_w[h] * hidden[h]
        regime_prob = _sigmoid(reg_logit)

        spread = max(0.25, 1.2816 * self.calibrated_z_spread)
        return {
            "pred_z": pred_z,
            "p10_z": pred_z - spread,
            "p50_z": pred_z,
            "p90_z": pred_z + spread,
            "trend_probs": trend_probs,
            "regime_shift_prob": regime_prob,
            "hidden": hidden,
            "used_msgs": used_msgs,
            "weight_sum": weight_sum,
            "cur_z": cur_z,
        }

    def predict_bundle(
        self,
        bundle: Dict[str, Any],
        t_idx: Optional[int] = None,
        node_indices: Optional[Sequence[int]] = None,
    ) -> Dict[int, Dict[str, Any]]:
        """Predict values, calibrated quantiles, trend probabilities, and regime shifts."""
        T = len(bundle["feature_tensor"])
        step = (T - 1) if t_idx is None else int(t_idx)
        indices = (
            list(node_indices)
            if node_indices is not None
            else list(range(len(bundle["node_ids"])))
        )
        in_edges = _extract_in_edges(bundle)
        norms = bundle.get("normalization", [])
        results: Dict[int, Dict[str, Any]] = {}
        for idx in indices:
            if bundle["mask_tensor"][step][idx] != 1:
                continue
            out = self.forward_node_step(bundle, idx, step, in_edges)
            norm = norms[idx] if idx < len(norms) else {"mean": 0.0, "std": 1.0}
            mean = float(norm.get("mean", 0.0))
            std = max(1e-6, float(norm.get("std", 1.0)))
            pred_val = out["pred_z"] * std + mean
            p10 = out["p10_z"] * std + mean
            p90 = out["p90_z"] * std + mean
            probs = out["trend_probs"]
            direction = (
                "increasing"
                if probs[2] >= probs[0] and probs[2] >= probs[1]
                else "decreasing"
                if probs[0] >= probs[1]
                else "stable"
            )
            results[idx] = {
                "node_uuid": bundle["node_ids"][idx],
                "pred_z": out["pred_z"],
                "predicted_value": pred_val,
                "quantiles": {"p10": p10, "p50": pred_val, "p90": p90},
                "trendForecast": {
                    "direction": direction,
                    "probabilities": {
                        "decreasing": round(probs[0], 4),
                        "stable": round(probs[1], 4),
                        "increasing": round(probs[2], 4),
                    },
                    "regimeShiftProb": round(out["regime_shift_prob"], 4),
                },
            }
        return results

    def fit(
        self,
        bundle: Dict[str, Any],
        epochs: int = 80,
        lr: float = 0.025,
        l2_reg: float = 1e-3,
        seed: int = 42,
        target_indices: Optional[Sequence[int]] = None,
    ) -> Dict[str, Any]:
        """Train strictly on `t < train_cutoff_index - horizon_steps` with Adam."""
        load_etg_ml_v2_dataset(bundle)
        cutoff = int(bundle["train_cutoff_index"])
        labels = bundle["labels"]
        horizon = int(labels.get("horizon_steps", 1))
        next_targets = labels["next_value_targets"]
        trend_targets = labels.get("trend_class_targets")
        regime_targets = labels.get("regime_shift_targets")
        mask_tensor = bundle["mask_tensor"]
        in_edges = _extract_in_edges(bundle)
        N = len(bundle["node_ids"])
        nodes_to_train = list(target_indices) if target_indices is not None else list(range(N))

        train_pairs: List[Tuple[int, int]] = []
        # Strictly exclude any origin whose target timestamp t + horizon >= cutoff!
        max_train_t = max(0, cutoff - horizon)
        for t in range(max_train_t):
            for j in nodes_to_train:
                if mask_tensor[t][j] == 1 and next_targets[t][j] is not None:
                    train_pairs.append((t, j))

        if not train_pairs:
            return {"train_rmse_z": 0.0, "train_samples": 0, "loss_history": []}

        val_split = max(1, int(len(train_pairs) * 0.8)) if len(train_pairs) >= 10 else len(train_pairs)
        tr_pairs = train_pairs[:val_split]
        va_pairs = train_pairs[val_split:]

        rng = random.Random(seed)
        H = self.hidden_dim

        # Adam state buffers for parameter groups
        adam_m: Dict[str, Any] = {
            "head_w": [0.0] * H,
            "head_b": 0.0,
            "res_z": 0.0,
            "static_w": [[0.0] * 16 for _ in range(H)],
            "temp_w": [[0.0] * 8 for _ in range(H)],
            "msg_w": [[0.0] * 16 for _ in range(H)],
            "trend_w": [[0.0] * H for _ in range(3)],
            "trend_b": [0.0] * 3,
            "regime_w": [0.0] * H,
            "regime_b": 0.0,
        }
        adam_v = copy.deepcopy(adam_m)
        b1, b2, eps = 0.9, 0.999, 1e-8

        def adam_step_scalar(val: float, g: float, m_val: float, v_val: float, step_i: int) -> Tuple[float, float, float]:
            m_val = b1 * m_val + (1.0 - b1) * g
            v_val = b2 * v_val + (1.0 - b2) * (g * g)
            m_hat = m_val / (1.0 - b1 ** step_i)
            v_hat = v_val / (1.0 - b2 ** step_i)
            val -= lr * m_hat / (math.sqrt(v_hat) + eps)
            return val, m_val, v_val

        best_val = float("inf")
        best_state = self.clone()
        loss_history: List[float] = []

        for epoch in range(1, epochs + 1):
            rng.shuffle(tr_pairs)
            g_head_w = [0.0] * H
            g_head_b = 0.0
            g_res_z = 0.0
            g_static_w = [[0.0] * 16 for _ in range(H)]
            g_temp_w = [[0.0] * 8 for _ in range(H)]
            g_msg_w = [[0.0] * 16 for _ in range(H)]
            g_trend_w = [[0.0] * H for _ in range(3)]
            g_trend_b = [0.0] * 3
            g_regime_w = [0.0] * H
            g_regime_b = 0.0

            sq_err = 0.0
            for t, j in tr_pairs:
                tgt_z = float(next_targets[t][j])
                out = self.forward_node_step(bundle, j, t, in_edges)
                err = out["pred_z"] - tgt_z
                sq_err += err * err
                d_pred = 2.0 * err / len(tr_pairs)

                hidden = out["hidden"]
                g_head_b += d_pred
                g_res_z += d_pred * out["cur_z"]

                d_hidden = [0.0] * H
                for h in range(H):
                    g_head_w[h] += d_pred * hidden[h]
                    d_hidden[h] += d_pred * self.head_w[h]

                # Auxiliary trend & regime classification losses
                if trend_targets and trend_targets[t][j] is not None:
                    tc = int(trend_targets[t][j])
                    probs = out["trend_probs"]
                    for c in range(3):
                        dl = (probs[c] - (1.0 if c == tc else 0.0)) * 0.25 / len(tr_pairs)
                        g_trend_b[c] += dl
                        for h in range(H):
                            g_trend_w[c][h] += dl * hidden[h]
                            d_hidden[h] += dl * self.trend_w[c][h]

                if regime_targets and regime_targets[t][j] is not None:
                    rt = float(regime_targets[t][j])
                    dr = (out["regime_shift_prob"] - rt) * 0.2 / len(tr_pairs)
                    g_regime_b += dr
                    for h in range(H):
                        g_regime_w[h] += dr * hidden[h]
                        d_hidden[h] += dr * self.regime_w[h]

                static_f = bundle["node_static_features"][j]
                temp_f = bundle["feature_tensor"][t][j]
                denom = max(1e-6, out["weight_sum"])
                for h in range(H):
                    dtanh = d_hidden[h] * (1.0 - hidden[h] * hidden[h])
                    for k in range(16):
                        g_static_w[h][k] += dtanh * static_f[k]
                    for k in range(8):
                        g_temp_w[h][k] += dtanh * temp_f[k]
                    if out["weight_sum"] > 0:
                        for eff_w, vec16, act_m in out["used_msgs"]:
                            dm = (dtanh * eff_w / denom) * (1.0 - act_m[h] * act_m[h])
                            for k in range(16):
                                g_msg_w[h][k] += dm * vec16[k]

            loss_history.append(round(math.sqrt(sq_err / len(tr_pairs)), 6))

            # Update weights with L2 decay + Adam
            self.head_b, adam_m["head_b"], adam_v["head_b"] = adam_step_scalar(
                self.head_b, g_head_b, adam_m["head_b"], adam_v["head_b"], epoch
            )
            self.residual_z_weight, adam_m["res_z"], adam_v["res_z"] = adam_step_scalar(
                self.residual_z_weight, g_res_z + l2_reg * (self.residual_z_weight - 0.5),
                adam_m["res_z"], adam_v["res_z"], epoch
            )
            self.regime_b, adam_m["regime_b"], adam_v["regime_b"] = adam_step_scalar(
                self.regime_b, g_regime_b, adam_m["regime_b"], adam_v["regime_b"], epoch
            )
            for h in range(H):
                self.head_w[h], adam_m["head_w"][h], adam_v["head_w"][h] = adam_step_scalar(
                    self.head_w[h], g_head_w[h] + l2_reg * self.head_w[h],
                    adam_m["head_w"][h], adam_v["head_w"][h], epoch
                )
                self.regime_w[h], adam_m["regime_w"][h], adam_v["regime_w"][h] = adam_step_scalar(
                    self.regime_w[h], g_regime_w[h] + l2_reg * self.regime_w[h],
                    adam_m["regime_w"][h], adam_v["regime_w"][h], epoch
                )
                for k in range(16):
                    self.static_proj_w[h][k], adam_m["static_w"][h][k], adam_v["static_w"][h][k] = adam_step_scalar(
                        self.static_proj_w[h][k], g_static_w[h][k] + l2_reg * self.static_proj_w[h][k],
                        adam_m["static_w"][h][k], adam_v["static_w"][h][k], epoch
                    )
                    self.msg_proj_w[h][k], adam_m["msg_w"][h][k], adam_v["msg_w"][h][k] = adam_step_scalar(
                        self.msg_proj_w[h][k], g_msg_w[h][k] + l2_reg * self.msg_proj_w[h][k],
                        adam_m["msg_w"][h][k], adam_v["msg_w"][h][k], epoch
                    )
                for k in range(8):
                    self.temp_proj_w[h][k], adam_m["temp_w"][h][k], adam_v["temp_w"][h][k] = adam_step_scalar(
                        self.temp_proj_w[h][k], g_temp_w[h][k] + l2_reg * self.temp_proj_w[h][k],
                        adam_m["temp_w"][h][k], adam_v["temp_w"][h][k], epoch
                    )
            for c in range(3):
                self.trend_b[c], adam_m["trend_b"][c], adam_v["trend_b"][c] = adam_step_scalar(
                    self.trend_b[c], g_trend_b[c], adam_m["trend_b"][c], adam_v["trend_b"][c], epoch
                )
                for h in range(H):
                    self.trend_w[c][h], adam_m["trend_w"][c][h], adam_v["trend_w"][c][h] = adam_step_scalar(
                        self.trend_w[c][h], g_trend_w[c][h] + l2_reg * self.trend_w[c][h],
                        adam_m["trend_w"][c][h], adam_v["trend_w"][c][h], epoch
                    )

            if va_pairs:
                val_sq = 0.0
                for t, j in va_pairs:
                    pred_z = self.forward_node_step(bundle, j, t, in_edges)["pred_z"]
                    val_sq += (pred_z - float(next_targets[t][j])) ** 2
                val_rmse = math.sqrt(val_sq / len(va_pairs))
                if val_rmse < best_val:
                    best_val = val_rmse
                    best_state = self.clone()

        if va_pairs:
            self.__dict__.update(best_state.__dict__)
            res_list = [
                abs(self.forward_node_step(bundle, j, t, in_edges)["pred_z"] - float(next_targets[t][j]))
                for t, j in va_pairs
            ]
            if res_list:
                self.calibrated_z_spread = max(0.15, sum(res_list) / len(res_list) * 1.25)

        return {
            "train_rmse_z": loss_history[-1] if loss_history else 0.0,
            "train_samples": len(tr_pairs),
            "loss_history": loss_history,
        }

    def to_portable_weights_dict(self) -> Dict[str, Any]:
        """Serialize portable inductive weights matching `graphPredictor.ts`."""
        temp_w_copy = [list(row) for row in self.temp_proj_w]
        return {
            "schema_version": WEIGHTS_SCHEMA_V2,
            "hidden_dim": self.hidden_dim,
            "static_proj_w": [list(r) for r in self.static_proj_w],
            "static_proj_b": list(self.static_proj_b),
            "temp_proj_w": temp_w_copy,
            "temp_proj_b": list(self.temp_proj_b),
            "msg_proj_w": [list(r) for r in self.msg_proj_w],
            "msg_proj_b": list(self.msg_proj_b),
            "trust_gate_w": float(self.trust_gate_w),
            "trust_gate_b": float(self.trust_gate_b),
            "head_w": list(self.head_w),
            "head_b": float(self.head_b),
            "residual_z_weight": float(self.residual_z_weight),
            "trend_w": [list(r) for r in self.trend_w],
            "trend_b": list(self.trend_b),
            "regime_w": list(self.regime_w),
            "regime_b": float(self.regime_b),
            "calibrated_z_spread": float(self.calibrated_z_spread),
        }

    @classmethod
    def from_portable_weights_dict(cls, data: Dict[str, Any]) -> "PortableInductiveETGNet":
        if data.get("schema_version") != WEIGHTS_SCHEMA_V2:
            raise ValueError(f"Expected {WEIGHTS_SCHEMA_V2} weights dict.")
        hidden_dim = int(data.get("hidden_dim", len(data["head_w"])))
        net = cls(hidden_dim=hidden_dim)
        net.static_proj_w = [list(r) for r in data["static_proj_w"]]
        net.static_proj_b = list(data["static_proj_b"])
        net.temp_proj_w = [list(r) for r in data["temp_proj_w"]]
        net.temp_proj_b = list(data["temp_proj_b"])
        net.msg_proj_w = [list(r) for r in data["msg_proj_w"]]
        net.msg_proj_b = list(data["msg_proj_b"])
        net.trust_gate_w = float(data["trust_gate_w"])
        net.trust_gate_b = float(data["trust_gate_b"])
        net.head_w = list(data["head_w"])
        net.head_b = float(data["head_b"])
        net.residual_z_weight = float(data.get("residual_z_weight", 0.72))
        if "trend_w" in data:
            net.trend_w = [list(r) for r in data["trend_w"]]
            net.trend_b = list(data["trend_b"])
        if "regime_w" in data:
            net.regime_w = list(data["regime_w"])
            net.regime_b = float(data["regime_b"])
        net.calibrated_z_spread = float(data.get("calibrated_z_spread", 1.0))
        return net


def evaluate_model_on_holdout(
    model: PortableInductiveETGNet,
    bundle: Dict[str, Any],
    target_indices: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """Evaluate zero-leakage holdout RMSE (`t >= train_cutoff_index - horizon`)."""
    cutoff = int(bundle["train_cutoff_index"])
    labels = bundle["labels"]
    horizon = int(labels.get("horizon_steps", 1))
    next_targets = labels["next_value_targets"]
    trend_targets = labels.get("trend_class_targets")
    mask_tensor = bundle["mask_tensor"]
    feat_tensor = bundle["feature_tensor"]
    in_edges = _extract_in_edges(bundle)
    T = len(feat_tensor)
    N = len(bundle["node_ids"])
    indices = list(target_indices) if target_indices is not None else list(range(N))

    start_eval_t = max(0, cutoff - horizon)
    sq_model = 0.0
    sq_persist = 0.0
    trend_hits = 0
    trend_total = 0
    count = 0

    for t in range(start_eval_t, T):
        for j in indices:
            if mask_tensor[t][j] != 1 or next_targets[t][j] is None:
                continue
            tgt_z = float(next_targets[t][j])
            cur_z = float(feat_tensor[t][j][1])
            out = model.forward_node_step(bundle, j, t, in_edges)
            sq_model += (out["pred_z"] - tgt_z) ** 2
            sq_persist += (cur_z - tgt_z) ** 2
            count += 1
            if trend_targets and trend_targets[t][j] is not None:
                pred_cls = max(range(3), key=lambda c: out["trend_probs"][c])
                if pred_cls == int(trend_targets[t][j]):
                    trend_hits += 1
                trend_total += 1

    if count == 0:
        return {
            "model_rmse": 0.0,
            "persistence_rmse": 0.0,
            "skill_vs_persistence_pct": 0.0,
            "trend_accuracy": 0.0,
            "eval_count": 0,
        }

    m_rmse = math.sqrt(sq_model / count)
    p_rmse = math.sqrt(sq_persist / count)
    skill = ((p_rmse - m_rmse) / p_rmse * 100.0) if p_rmse > 1e-9 else 0.0
    return {
        "model_rmse": round(m_rmse, 6),
        "persistence_rmse": round(p_rmse, 6),
        "skill_vs_persistence_pct": round(skill, 2),
        "trend_accuracy": round((trend_hits / trend_total) if trend_total > 0 else 0.0, 4),
        "eval_count": count,
    }


def train_and_evaluate_inductive_v2(
    source: Union[str, Path, Dict[str, Any]],
    epochs: int = 80,
    seed: int = 42,
    train_node_indices: Optional[Sequence[int]] = None,
    eval_node_indices: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """Train `PortableInductiveETGNet` on `etg-ml-v2` and evaluate unseen holdout steps."""
    bundle = load_etg_ml_v2_dataset(source)
    model = PortableInductiveETGNet(hidden_dim=16, seed=seed)
    train_info = model.fit(bundle, epochs=epochs, seed=seed, target_indices=train_node_indices)
    eval_metrics = evaluate_model_on_holdout(bundle=bundle, model=model, target_indices=eval_node_indices)
    return {
        "model": model,
        "train_info": train_info,
        "eval_metrics": eval_metrics,
        "portable_weights": model.to_portable_weights_dict(),
    }


if TORCH_AVAILABLE:

    class TrustGatedGATLayer(nn.Module):  # type: ignore[misc]
        """Heterogeneous lag-aware GATv2 layer with learned community trust-gating."""

        def __init__(self, d_model: int, edge_dim: int = 8, num_heads: int = 4) -> None:
            super().__init__()
            self.d_model = d_model
            self.num_heads = num_heads
            self.head_dim = d_model // num_heads
            self.q_proj = nn.Linear(d_model, d_model)
            self.k_proj = nn.Linear(d_model + edge_dim, d_model)
            self.v_proj = nn.Linear(d_model + edge_dim, d_model)
            self.attn_vec = nn.Parameter(torch.randn(num_heads, self.head_dim) * 0.05)
            self.trust_mlp = nn.Sequential(
                nn.Linear(2, 16),
                nn.GELU(),
                nn.Linear(16, 1),
            )
            self.out_proj = nn.Linear(d_model, d_model)
            self.norm = nn.LayerNorm(d_model)
            self.ffn = nn.Sequential(
                nn.Linear(d_model, d_model * 2),
                nn.GELU(),
                nn.Linear(d_model * 2, d_model),
            )
            self.norm_ffn = nn.LayerNorm(d_model)

        def forward(
            self,
            h: "torch.Tensor",
            edge_index: "torch.Tensor",
            edge_attr: "torch.Tensor",
            node_trust: "torch.Tensor",
            node_corroborated: "torch.Tensor",
            active_mask: Optional["torch.Tensor"] = None,
        ) -> "torch.Tensor":
            # h: [B, N, D], edge_index: [2, E], edge_attr: [E, 8]
            B, N, D = h.shape
            if edge_index.numel() == 0:
                return self.norm_ffn(h + self.ffn(h))

            src_idx = edge_index[0]
            dst_idx = edge_index[1]
            E = src_idx.shape[0]

            h_src = h[:, src_idx, :]  # [B, E, D]
            h_dst = h[:, dst_idx, :]  # [B, E, D]
            ea = edge_attr.unsqueeze(0).expand(B, -1, -1)
            src_edge = torch.cat([h_src, ea], dim=-1)

            q = self.q_proj(h_dst).view(B, E, self.num_heads, self.head_dim)
            k = self.k_proj(src_edge).view(B, E, self.num_heads, self.head_dim)
            v = self.v_proj(src_edge).view(B, E, self.num_heads, self.head_dim)

            raw_score = (F.leaky_relu(q + k, 0.2) * self.attn_vec.view(1, 1, self.num_heads, self.head_dim)).sum(-1)
            trust_in = torch.stack([node_trust[src_idx], node_corroborated[src_idx]], dim=-1)
            gate = torch.sigmoid(self.trust_mlp(trust_in)).view(1, E, 1)  # [1, E, 1]

            if active_mask is not None:
                src_vis = active_mask[:, src_idx].unsqueeze(-1)
                gate = gate * src_vis

            attn_weights = torch.sigmoid(raw_score) * gate
            weighted_v = (v * attn_weights.unsqueeze(-1)).view(B, E, D)

            agg = torch.zeros_like(h)
            dst_expand = dst_idx.view(1, E, 1).expand(B, E, D)
            agg.scatter_add_(1, dst_expand, weighted_v)

            deg = torch.zeros(B, N, 1, device=h.device, dtype=h.dtype)
            deg.scatter_add_(1, dst_idx.view(1, E, 1).expand(B, E, 1), attn_weights.mean(dim=-1, keepdim=True))
            agg = agg / deg.clamp(min=1.0)

            h_mid = self.norm(h + self.out_proj(agg))
            return self.norm_ffn(h_mid + self.ffn(h_mid))

    class PyTorchInductiveETGTransformer(nn.Module):  # type: ignore[misc]
        """
        Inductive Multi-Scale Spatio-Temporal Earth Trend Graph Transformer
        designed for Google Colab Blackwell (`B200`, `bf16` + `torch.compile`) training
        and hosted GCP `L4` inference + online replay-regularized adaptation.
        """

        def __init__(
            self,
            static_dim: int = 16,
            temp_dim: int = 8,
            edge_dim: int = 8,
            d_model: int = 96,
            num_layers: int = 2,
        ) -> None:
            super().__init__()
            self.d_model = d_model
            self.static_encoder = nn.Sequential(
                nn.Linear(static_dim, d_model),
                nn.GELU(),
                nn.LayerNorm(d_model),
            )
            self.temp_proj = nn.Linear(temp_dim, d_model)
            self.temp_gru = nn.GRU(d_model, d_model, batch_first=True)
            self.scale_embed = nn.Embedding(4, d_model)  # day, month, year, impulse

            self.gnn_layers = nn.ModuleList(
                [TrustGatedGATLayer(d_model, edge_dim=edge_dim, num_heads=4) for _ in range(num_layers)]
            )

            # Lightweight residual adapter for validation-gated GCP L4 incremental fine-tuning
            self.adapter_down = nn.Linear(d_model, d_model // 4)
            self.adapter_up = nn.Linear(d_model // 4, d_model)
            nn.init.zeros_(self.adapter_up.weight)
            nn.init.zeros_(self.adapter_up.bias)

            self.quantile_head = nn.Linear(d_model, 3)  # p10, p50, p90 (deltas around p50)
            self.trend_head = nn.Linear(d_model, 3)     # decreasing, stable, increasing
            self.regime_head = nn.Linear(d_model, 1)    # regime-shift logit

        def forward(
            self,
            temp_window: "torch.Tensor",       # [B, W, N, 8]
            static_feats: "torch.Tensor",      # [N, 16]
            edge_index: "torch.Tensor",        # [2, E]
            edge_attr: "torch.Tensor",         # [E, 8]
            window_mask: Optional["torch.Tensor"] = None,  # [B, W, N]
            scale_id: int = 1,
        ) -> Dict[str, "torch.Tensor"]:
            B, W, N, _ = temp_window.shape
            flat_t = temp_window.permute(0, 2, 1, 3).reshape(B * N, W, -1)
            t_emb = F.gelu(self.temp_proj(flat_t))
            gru_out, _ = self.temp_gru(t_emb)
            last_t = gru_out[:, -1, :].view(B, N, self.d_model)

            s_emb = self.static_encoder(static_feats).unsqueeze(0).expand(B, -1, -1)
            sc = self.scale_embed(
                torch.tensor(scale_id, device=temp_window.device, dtype=torch.long)
            ).view(1, 1, self.d_model)
            h = last_t + s_emb + sc

            node_trust = static_feats[:, 5]
            node_corr = static_feats[:, 7]
            active_m = window_mask[:, -1, :] if window_mask is not None else None

            for layer in self.gnn_layers:
                h = layer(h, edge_index, edge_attr, node_trust, node_corr, active_m)

            adapter_delta = self.adapter_up(F.gelu(self.adapter_down(h)))
            h_out = h + adapter_delta

            cur_z = temp_window[:, -1, :, 1]  # current step z_score
            q_raw = self.quantile_head(h_out)
            p50 = cur_z + q_raw[..., 1]
            lower = F.softplus(q_raw[..., 0]) + 0.1
            upper = F.softplus(q_raw[..., 2]) + 0.1
            quantiles = torch.stack([p50 - lower, p50, p50 + upper], dim=-1)

            trend_logits = self.trend_head(h_out)
            regime_logits = self.regime_head(h_out).squeeze(-1)
            return {
                "p50": p50,
                "quantiles": quantiles,
                "trend_logits": trend_logits,
                "regime_logits": regime_logits,
            }

    def _pinball_loss(preds_q: "torch.Tensor", target: "torch.Tensor", mask: "torch.Tensor") -> "torch.Tensor":
        taus = [0.1, 0.5, 0.9]
        total = torch.tensor(0.0, device=preds_q.device, dtype=preds_q.dtype)
        denom = mask.sum().clamp(min=1.0)
        for idx, tau in enumerate(taus):
            diff = target - preds_q[..., idx]
            loss = torch.maximum(tau * diff, (tau - 1.0) * diff)
            total = total + (loss * mask).sum() / denom
        return total / 3.0

    def _bundle_to_torch_tensors(bundle: Dict[str, Any], device: "torch.device") -> Dict[str, "torch.Tensor"]:
        feat = torch.tensor(bundle["feature_tensor"], dtype=torch.float32, device=device)
        mask = torch.tensor(bundle["mask_tensor"], dtype=torch.float32, device=device)
        static = torch.tensor(bundle["node_static_features"], dtype=torch.float32, device=device)
        edge_index = torch.tensor(bundle["edge_index"], dtype=torch.long, device=device)
        edge_attr = torch.tensor(bundle["edge_attr"], dtype=torch.float32, device=device)

        T, N, _ = feat.shape
        nv_raw = bundle["labels"]["next_value_targets"]
        tc_raw = bundle["labels"]["trend_class_targets"]
        rs_raw = bundle["labels"]["regime_shift_targets"]

        nv = torch.zeros((T, N), dtype=torch.float32, device=device)
        nv_mask = torch.zeros((T, N), dtype=torch.float32, device=device)
        tc = torch.zeros((T, N), dtype=torch.long, device=device)
        tc_mask = torch.zeros((T, N), dtype=torch.float32, device=device)
        rs = torch.zeros((T, N), dtype=torch.float32, device=device)

        for t in range(T):
            for j in range(N):
                if nv_raw[t][j] is not None:
                    nv[t, j] = float(nv_raw[t][j])
                    nv_mask[t, j] = 1.0
                if tc_raw and tc_raw[t][j] is not None:
                    tc[t, j] = int(tc_raw[t][j])
                    tc_mask[t, j] = 1.0
                if rs_raw and rs_raw[t][j] is not None:
                    rs[t, j] = float(rs_raw[t][j])

        return {
            "feat": feat,
            "mask": mask,
            "static": static,
            "edge_index": edge_index,
            "edge_attr": edge_attr,
            "nv": nv,
            "nv_mask": nv_mask,
            "tc": tc,
            "tc_mask": tc_mask,
            "rs": rs,
        }

    def train_pytorch_blackwell(
        source: Union[str, Path, Dict[str, Any]],
        epochs: int = 80,
        window_size: int = 8,
        d_model: int = 96,
        lr: float = 1.5e-3,
        compile_model: bool = True,
        device_str: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Train `PyTorchInductiveETGTransformer` optimized for Blackwell/L4 CUDA GPUs."""
        bundle = load_etg_ml_v2_dataset(source)
        if device_str:
            device = torch.device(device_str)
        elif torch.cuda.is_available():
            device = torch.device("cuda")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")

        if device.type == "cuda":
            torch.set_float32_matmul_precision("high")

        tensors = _bundle_to_torch_tensors(bundle, device)
        T = tensors["feat"].shape[0]
        cutoff = int(bundle["train_cutoff_index"])
        horizon = int(bundle["labels"].get("horizon_steps", 1))
        W = min(window_size, max(2, cutoff - horizon - 1))

        scale_map = {"day": 0, "month": 1, "year": 2}
        scale_id = scale_map.get(str(bundle.get("primary_bucket", "month")), 1)

        model = PyTorchInductiveETGTransformer(d_model=d_model).to(device)
        train_model: Any = model
        if compile_model and device.type == "cuda":
            major, _ = torch.cuda.get_device_capability(device)
            if major >= 8 and hasattr(torch, "compile"):
                train_model = torch.compile(model)

        optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
        use_bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()

        tr_origins = list(range(W - 1, max(W - 1, cutoff - horizon)))
        loss_history: List[float] = []

        def _forward_and_loss(active_mod: Any) -> "torch.Tensor":
            out = active_mod(
                windows, tensors["static"], tensors["edge_index"], tensors["edge_attr"], w_masks, scale_id
            )
            loss_p50 = ((out["p50"] - tgt_nv) ** 2 * tgt_mask).sum() / tgt_mask.sum().clamp(min=1.0)
            loss_q = _pinball_loss(out["quantiles"], tgt_nv, tgt_mask)
            loss_tc = (
                F.cross_entropy(out["trend_logits"].reshape(-1, 3), tgt_tc.reshape(-1), reduction="none")
                * tgt_tc_mask.reshape(-1)
            ).sum() / tgt_tc_mask.sum().clamp(min=1.0)
            loss_rs = (
                F.binary_cross_entropy_with_logits(out["regime_logits"], tgt_rs, reduction="none") * tgt_mask
            ).sum() / tgt_mask.sum().clamp(min=1.0)
            return loss_p50 + 0.5 * loss_q + 0.2 * loss_tc + 0.15 * loss_rs

        for _ in range(epochs):
            train_model.train()
            optimizer.zero_grad(set_to_none=True)

            windows = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in tr_origins], dim=0)
            w_masks = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in tr_origins], dim=0)
            tgt_nv = tensors["nv"][tr_origins]
            tgt_mask = tensors["nv_mask"][tr_origins]
            tgt_tc = tensors["tc"][tr_origins]
            tgt_tc_mask = tensors["tc_mask"][tr_origins]
            tgt_rs = tensors["rs"][tr_origins]

            try:
                if use_bf16:
                    with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                        loss = _forward_and_loss(train_model)
                else:
                    loss = _forward_and_loss(train_model)
            except Exception:
                if train_model is not model:
                    train_model = model
                    train_model.train()
                    if use_bf16:
                        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                            loss = _forward_and_loss(train_model)
                    else:
                        loss = _forward_and_loss(train_model)
                else:
                    raise

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            loss_history.append(float(loss.detach().cpu().item()))

        model.eval()
        eval_origins = [t for t in range(max(W - 1, cutoff - horizon), T) if tensors["nv_mask"][t].sum() > 0]
        eval_rmse = 0.0
        persist_rmse = 0.0
        if eval_origins:
            with torch.no_grad():
                ewin = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in eval_origins], dim=0)
                em = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in eval_origins], dim=0)
                eout = model(ewin, tensors["static"], tensors["edge_index"], tensors["edge_attr"], em, scale_id)
                t_nv = tensors["nv"][eval_origins]
                t_m = tensors["nv_mask"][eval_origins]
                c_z = ewin[:, -1, :, 1]
                eval_rmse = float(torch.sqrt(((eout["p50"] - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())
                persist_rmse = float(torch.sqrt(((c_z - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())

        skill = ((persist_rmse - eval_rmse) / persist_rmse * 100.0) if persist_rmse > 1e-9 else 0.0
        return {
            "model": model,
            "device": str(device),
            "bf16": use_bf16,
            "loss_history": loss_history,
            "eval_metrics": {
                "model_rmse": round(eval_rmse, 6),
                "persistence_rmse": round(persist_rmse, 6),
                "skill_vs_persistence_pct": round(skill, 2),
                "eval_steps": len(eval_origins),
            },
        }

    def finetune_incremental_adapter(
        model: PyTorchInductiveETGTransformer,
        bundle: Dict[str, Any],
        steps: int = 25,
        lr: float = 5e-4,
        replay_anchor_weight: float = 0.05,
        window_size: int = 8,
    ) -> Dict[str, Any]:
        """
        GCP L4 replay-regularized online adaptation with validation rollback guard.
        Freezes trunk parameters and only updates residual adapter + trust gate.
        """
        load_etg_ml_v2_dataset(bundle)
        device = next(model.parameters()).device
        tensors = _bundle_to_torch_tensors(bundle, device)
        cutoff = int(bundle["train_cutoff_index"])
        horizon = int(bundle["labels"].get("horizon_steps", 1))
        T = tensors["feat"].shape[0]
        W = min(window_size, max(2, cutoff - horizon - 1))

        valid_origins = [t for t in range(W - 1, T) if tensors["nv_mask"][t].sum() > 0]
        if len(valid_origins) < 4:
            return {"accepted": False, "reason": "Insufficient valid windows for validation-gated finetune."}

        split = max(2, int(len(valid_origins) * 0.75))
        tr_idx = valid_origins[:split]
        va_idx = valid_origins[split:]
        scale_map = {"day": 0, "month": 1, "year": 2}
        scale_id = scale_map.get(str(bundle.get("primary_bucket", "month")), 1)

        def eval_split(origins: List[int]) -> float:
            model.eval()
            with torch.no_grad():
                w_t = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in origins], dim=0)
                m_t = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in origins], dim=0)
                out = model(w_t, tensors["static"], tensors["edge_index"], tensors["edge_attr"], m_t, scale_id)
                t_nv = tensors["nv"][origins]
                t_m = tensors["nv_mask"][origins]
                return float(torch.sqrt(((out["p50"] - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())

        val_before = eval_split(va_idx)
        prior_state = copy.deepcopy(model.state_dict())
        adapter_params = [
            p for name, p in model.named_parameters()
            if "adapter" in name or "trust_mlp" in name or "quantile_head" in name
        ]
        anchor_copies = [p.detach().clone() for p in adapter_params]
        opt = torch.optim.AdamW(adapter_params, lr=lr, weight_decay=1e-4)

        w_tr = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in tr_idx], dim=0)
        m_tr = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in tr_idx], dim=0)
        tgt_nv = tensors["nv"][tr_idx]
        tgt_m = tensors["nv_mask"][tr_idx]

        model.train()
        for _ in range(steps):
            opt.zero_grad(set_to_none=True)
            out = model(w_tr, tensors["static"], tensors["edge_index"], tensors["edge_attr"], m_tr, scale_id)
            mse = ((out["p50"] - tgt_nv) ** 2 * tgt_m).sum() / tgt_m.sum().clamp(min=1.0)
            anchor_pen = sum(((p - a) ** 2).mean() for p, a in zip(adapter_params, anchor_copies))
            loss = mse + replay_anchor_weight * anchor_pen
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapter_params, 1.0)
            opt.step()

        val_after = eval_split(va_idx)
        if not math.isfinite(val_after) or val_after > val_before * 1.01:
            model.load_state_dict(prior_state)
            return {
                "accepted": False,
                "val_rmse_before": round(val_before, 6),
                "val_rmse_after": round(val_after, 6) if math.isfinite(val_after) else None,
                "rollback_reason": "Validation RMSE degraded or became non-finite; rolled back.",
            }

        return {
            "accepted": True,
            "val_rmse_before": round(val_before, 6),
            "val_rmse_after": round(val_after, 6),
        }

    def export_pytorch_onnx(
        model: PyTorchInductiveETGTransformer,
        bundle: Dict[str, Any],
        out_path: Union[str, Path],
        window_size: int = 8,
    ) -> Path:
        """Export trained PyTorch Inductive ETG Transformer to ONNX on CPU cleanly."""
        out_file = Path(out_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        cpu_device = torch.device("cpu")
        cpu_model = copy.deepcopy(model).to(cpu_device).eval()
        tensors = _bundle_to_torch_tensors(bundle, cpu_device)
        W = min(window_size, tensors["feat"].shape[0])
        dummy_win = tensors["feat"][:W].unsqueeze(0)
        dummy_mask = tensors["mask"][:W].unsqueeze(0)

        class _OnnxWrapper(nn.Module):
            def __init__(self, inner: PyTorchInductiveETGTransformer) -> None:
                super().__init__()
                self.inner = inner

            def forward(self, win: "torch.Tensor", st: "torch.Tensor", ei: "torch.Tensor", ea: "torch.Tensor", mk: "torch.Tensor") -> Tuple["torch.Tensor", "torch.Tensor", "torch.Tensor"]:
                o = self.inner(win, st, ei, ea, mk, 1)
                return o["quantiles"], o["trend_logits"], o["regime_logits"]

        wrapper = _OnnxWrapper(cpu_model).eval()
        export_kwargs: Dict[str, Any] = {
            "input_names": ["temp_window", "static_feats", "edge_index", "edge_attr", "window_mask"],
            "output_names": ["quantiles", "trend_logits", "regime_logits"],
            "dynamic_axes": {"temp_window": {0: "batch", 2: "num_nodes"}, "static_feats": {0: "num_nodes"}},
            "opset_version": 17,
        }
        try:
            torch.onnx.export(
                wrapper,
                (dummy_win, tensors["static"], tensors["edge_index"], tensors["edge_attr"], dummy_mask),
                str(out_file),
                dynamo=False,
                **export_kwargs,
            )
        except TypeError:
            torch.onnx.export(
                wrapper,
                (dummy_win, tensors["static"], tensors["edge_index"], tensors["edge_attr"], dummy_mask),
                str(out_file),
                **export_kwargs,
            )
        return out_file
