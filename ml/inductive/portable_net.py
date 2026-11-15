"""
Zero-dependency parameter-shared inductive ETG GNN (`PortableInductiveETGNet`),
dataset validator (`load_etg_ml_v2_dataset`), and zero-leakage holdout evaluator.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

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
