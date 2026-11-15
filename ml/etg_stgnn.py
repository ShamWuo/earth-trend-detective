"""Pure-Python Spatio-Temporal Lag-Aware Graph Neural Network for Earth Trend Graph (`etg-ml-v1`).

Runs with zero third-party dependencies on Python 3.9+ (stdlib `math`, `random`, `json`),
and optionally exposes a PyTorch / PyTorch Geometric module when `torch` is installed.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    import torch  # type: ignore
    import torch.nn as nn  # type: ignore

    HAS_TORCH = True
except ImportError:  # pragma: no cover - optional dependency
    torch = None
    nn = None
    HAS_TORCH = False

try:
    from torch_geometric.nn import MessagePassing  # type: ignore

    HAS_PYG = True
except ImportError:  # pragma: no cover - optional dependency
    MessagePassing = None
    HAS_PYG = False


@dataclass
class EtgMlDataset:
    bucket: str
    node_ids: List[str]
    node_metadata: List[Dict[str, Any]]
    edge_index: Tuple[List[int], List[int]]
    edge_types: List[str]
    edge_attr_names: List[str]
    edge_attr: List[List[float]]
    time_index: List[str]
    feature_names: List[str]
    feature_tensor: List[List[List[float]]]  # [T, N, F]
    mask_tensor: List[List[float]]  # [T, N]


@dataclass
class NeighborEdgeSpec:
    edge_pos: int
    src_idx: int
    src_uuid: str
    src_name: str
    edge_type: str
    optimal_lag: int
    edge_attr: List[float]


@dataclass
class SupervisedSample:
    origin_t: int
    target_date: str
    last_actual: float
    target_actual: float
    target_lags_z: List[float]
    neighbor_lags_z: List[List[float]]  # [E_in, window_lags]
    neighbor_shifted_z: List[float]  # [E_in] at optimal lag


def load_etg_ml_dataset(source: Any) -> EtgMlDataset:
    """Loads and validates an `etg-ml-v1` tensor bundle from dict or JSON path."""
    if isinstance(source, (str, Path)):
        raw = json.loads(Path(source).read_text(encoding="utf-8"))
    elif isinstance(source, dict):
        raw = source
    else:
        raise TypeError("source must be a dict, str, or pathlib.Path")

    if raw.get("schema_version") != "etg-ml-v1":
        raise ValueError(
            f"Unsupported schema_version: {raw.get('schema_version')!r} (expected 'etg-ml-v1')"
        )

    node_ids = list(raw.get("node_ids", []))
    edge_index_raw = raw.get("edge_index", [[], []])
    src_list = [int(x) for x in edge_index_raw[0]]
    dst_list = [int(x) for x in edge_index_raw[1]]
    feature_tensor = raw.get("feature_tensor", [])
    mask_tensor = raw.get("mask_tensor", [])
    time_index = list(raw.get("time_index", []))

    if not node_ids or not feature_tensor or not time_index:
        raise ValueError("Empty ETG ML bundle: require >= 1 node and >= 1 time step.")

    t_len = len(time_index)
    n_len = len(node_ids)
    if len(feature_tensor) != t_len or len(mask_tensor) != t_len:
        raise ValueError(
            f"Tensor length mismatch: T={t_len}, feature_tensor={len(feature_tensor)}, mask_tensor={len(mask_tensor)}"
        )
    if any(len(row) != n_len for row in feature_tensor):
        raise ValueError("Each feature_tensor time slice must match len(node_ids).")

    return EtgMlDataset(
        bucket=str(raw.get("bucket", "year")),
        node_ids=node_ids,
        node_metadata=list(raw.get("node_metadata", [])),
        edge_index=(src_list, dst_list),
        edge_types=list(raw.get("edge_types", [])),
        edge_attr_names=list(raw.get("edge_attr_names", [])),
        edge_attr=[[float(v) for v in row] for row in raw.get("edge_attr", [])],
        time_index=time_index,
        feature_names=list(raw.get("feature_names", ["value", "z_score", "diff_1"])),
        feature_tensor=[
            [[float(c) for c in feat] for feat in step] for step in feature_tensor
        ],
        mask_tensor=[[float(m) for m in step] for step in mask_tensor],
    )


def select_target_index(
    dataset: EtgMlDataset,
    target_uuid: Optional[str] = None,
    target_idx: Optional[int] = None,
) -> int:
    if target_uuid:
        try:
            return dataset.node_ids.index(target_uuid)
        except ValueError as exc:
            raise ValueError(f"target_uuid {target_uuid!r} not found in node_ids") from exc
    if target_idx is not None:
        if 0 <= target_idx < len(dataset.node_ids):
            return target_idx
        raise ValueError(f"target_idx {target_idx} out of range")

    in_deg = [0] * len(dataset.node_ids)
    for dst in dataset.edge_index[1]:
        if 0 <= dst < len(in_deg):
            in_deg[dst] += 1
    # Tie-break by highest valid sample count
    best_idx = 0
    best_key = (-1, -1)
    for idx in range(len(dataset.node_ids)):
        valid_steps = sum(1 for t in range(len(dataset.time_index)) if dataset.mask_tensor[t][idx] > 0.5)
        key = (in_deg[idx], valid_steps)
        if key > best_key:
            best_key = key
            best_idx = idx
    return best_idx


def _mean_std(vals: Sequence[float]) -> Tuple[float, float]:
    if not vals:
        return 0.0, 1.0
    mu = sum(vals) / len(vals)
    var = sum((v - mu) ** 2 for v in vals) / max(1, len(vals) - 1)
    return mu, max(1e-6, math.sqrt(var))


def build_supervised_windows(
    dataset: EtgMlDataset,
    target_idx: int,
    horizon_steps: int = 1,
    window_lags: int = 3,
    train_ratio: float = 0.72,
) -> Dict[str, Any]:
    """Extracts chronologically split supervised windows with leak-free normalization."""
    t_len = len(dataset.time_index)
    src_list, dst_list = dataset.edge_index

    incoming_edges: List[NeighborEdgeSpec] = []
    seen_src = set()
    for e_pos, (src, dst) in enumerate(zip(src_list, dst_list)):
        if dst == target_idx and src != target_idx and src not in seen_src:
            seen_src.add(src)
            meta = dataset.node_metadata[src] if src < len(dataset.node_metadata) else {}
            attrs = (
                dataset.edge_attr[e_pos]
                if e_pos < len(dataset.edge_attr)
                else [0.0] * 8
            )
            opt_lag = int(round(attrs[2])) if len(attrs) > 2 else horizon_steps
            edge_type = (
                dataset.edge_types[e_pos]
                if e_pos < len(dataset.edge_types)
                else "correlates_with"
            )
            incoming_edges.append(
                NeighborEdgeSpec(
                    edge_pos=e_pos,
                    src_idx=src,
                    src_uuid=dataset.node_ids[src],
                    src_name=str(meta.get("name") or dataset.node_ids[src]),
                    edge_type=edge_type,
                    optimal_lag=max(horizon_steps, min(window_lags + horizon_steps - 1, opt_lag)),
                    edge_attr=attrs,
                )
            )

    valid_origins: List[int] = []
    min_origin = max(window_lags - 1, max([e.optimal_lag - horizon_steps for e in incoming_edges] or [0]))
    for t in range(min_origin, t_len - horizon_steps):
        if dataset.mask_tensor[t][target_idx] > 0.5 and dataset.mask_tensor[t + horizon_steps][target_idx] > 0.5:
            valid_origins.append(t)

    if len(valid_origins) < 10:
        raise ValueError(
            f"Need >= 10 valid supervised windows for target node {dataset.node_ids[target_idx]}, got {len(valid_origins)}."
        )

    n_train = max(6, min(len(valid_origins) - 3, int(round(len(valid_origins) * train_ratio))))
    train_max_t = valid_origins[n_train - 1]

    # Strict leak-free normalization using observations up to `train_max_t + horizon_steps` for target
    # and up to `train_max_t` for incoming drivers.
    train_target_vals = [
        dataset.feature_tensor[t][target_idx][0]
        for t in range(0, train_max_t + horizon_steps + 1)
        if dataset.mask_tensor[t][target_idx] > 0.5
    ]
    target_mean, target_std = _mean_std(train_target_vals)

    node_stats: Dict[int, Tuple[float, float]] = {target_idx: (target_mean, target_std)}
    for nb in incoming_edges:
        nb_vals = [
            dataset.feature_tensor[t][nb.src_idx][0]
            for t in range(0, train_max_t + 1)
            if dataset.mask_tensor[t][nb.src_idx] > 0.5
        ]
        node_stats[nb.src_idx] = _mean_std(nb_vals)

    def get_z(t: int, node_idx: int) -> float:
        if t < 0 or t >= t_len:
            return 0.0
        if dataset.mask_tensor[t][node_idx] <= 0.5:
            return 0.0
        mu, sd = node_stats[node_idx]
        return (dataset.feature_tensor[t][node_idx][0] - mu) / sd

    samples: List[SupervisedSample] = []
    for t in valid_origins:
        t_lags = [get_z(t - k, target_idx) for k in range(window_lags)]
        nb_lags = [
            [get_z(t - k, nb.src_idx) for k in range(window_lags)]
            for nb in incoming_edges
        ]
        nb_shifted = [
            get_z(t - max(0, nb.optimal_lag - horizon_steps), nb.src_idx)
            for nb in incoming_edges
        ]
        samples.append(
            SupervisedSample(
                origin_t=t,
                target_date=dataset.time_index[t + horizon_steps],
                last_actual=dataset.feature_tensor[t][target_idx][0],
                target_actual=dataset.feature_tensor[t + horizon_steps][target_idx][0],
                target_lags_z=t_lags,
                neighbor_lags_z=nb_lags,
                neighbor_shifted_z=nb_shifted,
            )
        )

    # Build latest forecast origin sample at last valid time step with observed target
    latest_origin = t_len - 1
    while latest_origin >= min_origin and dataset.mask_tensor[latest_origin][target_idx] <= 0.5:
        latest_origin -= 1
    latest_sample = SupervisedSample(
        origin_t=latest_origin,
        target_date=f"+{horizon_steps} step",
        last_actual=dataset.feature_tensor[latest_origin][target_idx][0],
        target_actual=dataset.feature_tensor[latest_origin][target_idx][0],
        target_lags_z=[get_z(latest_origin - k, target_idx) for k in range(window_lags)],
        neighbor_lags_z=[
            [get_z(latest_origin - k, nb.src_idx) for k in range(window_lags)]
            for nb in incoming_edges
        ],
        neighbor_shifted_z=[
            get_z(latest_origin - max(0, nb.optimal_lag - horizon_steps), nb.src_idx)
            for nb in incoming_edges
        ],
    )

    return {
        "target_idx": target_idx,
        "target_uuid": dataset.node_ids[target_idx],
        "target_name": (
            dataset.node_metadata[target_idx].get("name")
            if target_idx < len(dataset.node_metadata)
            else dataset.node_ids[target_idx]
        ),
        "target_mean": target_mean,
        "target_std": target_std,
        "incoming_edges": incoming_edges,
        "train_samples": samples[:n_train],
        "test_samples": samples[n_train:],
        "latest_sample": latest_sample,
        "window_lags": window_lags,
    }


def _solve_ridge(x_rows: List[List[float]], y_vals: List[float], reg_lambda: float) -> List[float]:
    n = len(x_rows)
    if n == 0 or not x_rows[0]:
        return []
    d = len(x_rows[0])
    # Normal equations (X^T X + lambda * I) w = X^T y (skip bias term at col 0 from penalty)
    mat = [[0.0] * (d + 1) for _ in range(d)]
    for i in range(d):
        if i > 0:
            mat[i][i] = reg_lambda
    for row, y in zip(x_rows, y_vals):
        for i in range(d):
            xi = row[i]
            mat[i][d] += xi * y
            for j in range(d):
                mat[i][j] += xi * row[j]

    # Partial pivoting Gaussian elimination
    for col in range(d):
        piv = max(range(col, d), key=lambda r: abs(mat[r][col]))
        mat[col], mat[piv] = mat[piv], mat[col]
        diag = mat[col][col]
        if abs(diag) < 1e-12:
            diag = 1e-12
        for j in range(col, d + 1):
            mat[col][j] /= diag
        for r in range(d):
            if r == col:
                continue
            factor = mat[r][col]
            if factor == 0.0:
                continue
            for j in range(col, d + 1):
                mat[r][j] -= factor * mat[col][j]

    return [mat[i][d] for i in range(d)]


def _eval_preds(
    actuals: Sequence[float],
    preds: Sequence[float],
    persistence_rmse: Optional[float] = None,
) -> Dict[str, float]:
    n = len(actuals)
    if n == 0:
        return {"rmse": 0.0, "mae": 0.0, "r2": 0.0, "skill_vs_persistence_pct": 0.0}
    sq = sum((p - a) ** 2 for a, p in zip(actuals, preds))
    abs_err = sum(abs(p - a) for a, p in zip(actuals, preds))
    rmse = math.sqrt(sq / n)
    mae = abs_err / n
    mean_y = sum(actuals) / n
    ss_tot = sum((a - mean_y) ** 2 for a in actuals)
    r2 = 1.0 - (sq / ss_tot) if ss_tot > 1e-12 else 0.0
    skill = (
        ((persistence_rmse - rmse) / persistence_rmse) * 100.0
        if persistence_rmse and persistence_rmse > 1e-9
        else 0.0
    )
    return {
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "r2": round(max(-5.0, min(1.0, r2)), 4),
        "skill_vs_persistence_pct": round(skill, 2),
    }


def evaluate_baselines(windowed: Dict[str, Any]) -> Dict[str, Any]:
    train: List[SupervisedSample] = windowed["train_samples"]
    test: List[SupervisedSample] = windowed["test_samples"]
    mu: float = windowed["target_mean"]
    sd: float = windowed["target_std"]
    edges: List[NeighborEdgeSpec] = windowed["incoming_edges"]

    def self_vec(s: SupervisedSample) -> List[float]:
        y0 = s.target_lags_z[0]
        dy = y0 - (s.target_lags_z[1] if len(s.target_lags_z) > 1 else y0)
        return [1.0, y0, dy, *s.target_lags_z[1:]]

    def graph_vec(s: SupervisedSample) -> List[float]:
        nb_terms: List[float] = []
        for idx, nb in enumerate(edges):
            weight = max(0.25, abs(nb.edge_attr[3])) if len(nb.edge_attr) > 3 else 0.75
            z_shift = s.neighbor_shifted_z[idx]
            z0 = s.neighbor_lags_z[idx][0]
            z1 = s.neighbor_lags_z[idx][1] if len(s.neighbor_lags_z[idx]) > 1 else z0
            nb_terms.extend([z_shift * weight, (z0 - z1) * weight])
        return [*self_vec(s), *nb_terms]

    y_train_z = [(s.target_actual - mu) / sd for s in train]
    w_self = _solve_ridge([self_vec(s) for s in train], y_train_z, reg_lambda=2.0)
    w_graph = (
        _solve_ridge([graph_vec(s) for s in train], y_train_z, reg_lambda=max(3.0, len(edges) * 1.5))
        if edges
        else w_self
    )

    test_actuals = [s.target_actual for s in test]
    test_persist = [s.last_actual for s in test]
    test_self = [mu + sd * sum(wi * xi for wi, xi in zip(w_self, self_vec(s))) for s in test]
    test_graph = (
        [mu + sd * sum(wi * xi for wi, xi in zip(w_graph, graph_vec(s))) for s in test]
        if edges
        else test_self
    )

    persist_metrics = _eval_preds(test_actuals, test_persist)
    p_rmse = max(1e-9, persist_metrics["rmse"])
    persist_metrics = _eval_preds(test_actuals, test_persist, p_rmse)
    self_metrics = _eval_preds(test_actuals, test_self, p_rmse)
    linear_graph_metrics = _eval_preds(test_actuals, test_graph, p_rmse)

    return {
        "persistence": persist_metrics,
        "self_ar": self_metrics,
        "linear_graph_ridge": linear_graph_metrics,
        "test_actuals": test_actuals,
        "test_self_preds": test_self,
        "test_linear_graph_preds": test_graph,
    }


class ETGLagGraphNet:
    """Pure-Python Spatio-Temporal Lag-Aware Graph Neural Network with Adam & early stopping."""

    def __init__(
        self,
        target_lag_dim: int,
        edge_attr_dim: int,
        neighbor_lag_dim: int,
        hidden_dim: int = 12,
        seed: int = 42,
    ) -> None:
        self.rng = random.Random(seed)
        self.target_lag_dim = target_lag_dim
        self.edge_attr_dim = edge_attr_dim
        self.neighbor_lag_dim = neighbor_lag_dim
        self.hidden_dim = hidden_dim

        # Edge message input: [neighbor_lags_z, shifted_z, pos_hinge, neg_hinge, z_shift*y0, edge_attr]
        self.msg_in_dim = neighbor_lag_dim + 4 + edge_attr_dim
        self.self_in_dim = target_lag_dim + 1  # y0, diff_1, rest lags

        def init_mat(rows: int, cols: int, scale: float) -> List[List[float]]:
            return [
                [self.rng.gauss(0.0, scale) for _ in range(cols)]
                for _ in range(rows)
            ]

        s_self = math.sqrt(2.0 / max(1, self.self_in_dim + hidden_dim))
        s_msg = math.sqrt(2.0 / max(1, self.msg_in_dim + hidden_dim))
        s_gate = math.sqrt(2.0 / max(1, self.msg_in_dim + 1))

        self.params: Dict[str, Any] = {
            "W_self": init_mat(hidden_dim, self.self_in_dim, s_self),
            "b_self": [0.0] * hidden_dim,
            "W_msg": init_mat(hidden_dim, self.msg_in_dim, s_msg),
            "b_msg": [0.0] * hidden_dim,
            "W_gate": init_mat(1, self.msg_in_dim, s_gate),
            "b_gate": [0.0],
            "W_head": [self.rng.gauss(0.0, 0.05) for _ in range(hidden_dim * 2 + 1)],
            "b_head": [0.0],
            "res_y0": [0.95],
        }

    def _make_self_vec(self, sample: SupervisedSample) -> List[float]:
        y0 = sample.target_lags_z[0]
        dy = y0 - (sample.target_lags_z[1] if len(sample.target_lags_z) > 1 else y0)
        return [y0, dy, *sample.target_lags_z[1:]]

    def _make_msg_vec(
        self,
        sample: SupervisedSample,
        nb_pos: int,
        edge_spec: NeighborEdgeSpec,
    ) -> List[float]:
        y0 = sample.target_lags_z[0]
        z_shift = sample.neighbor_shifted_z[nb_pos]
        pos_hinge = max(0.0, z_shift - 0.5)
        neg_hinge = max(0.0, -0.5 - z_shift)
        inter = max(-4.0, min(4.0, y0 * z_shift))
        padded_attr = (edge_spec.edge_attr + [0.0] * self.edge_attr_dim)[: self.edge_attr_dim]
        return [*sample.neighbor_lags_z[nb_pos], z_shift, pos_hinge, neg_hinge, inter, *padded_attr]

    def forward_single(
        self,
        sample: SupervisedSample,
        edges: Sequence[NeighborEdgeSpec],
    ) -> Tuple[float, Dict[str, Any]]:
        x_self = self._make_self_vec(sample)
        h_self = []
        for h in range(self.hidden_dim):
            z = self.params["b_self"][h] + sum(
                self.params["W_self"][h][j] * x_self[j]
                for j in range(len(x_self))
            )
            h_self.append(math.tanh(z))

        h_agg = [0.0] * self.hidden_dim
        gates: List[float] = []
        msg_vecs: List[List[float]] = []
        msg_hiddens: List[List[float]] = []

        if edges:
            raw_logits: List[float] = []
            for nb_pos, edge_spec in enumerate(edges):
                m_vec = self._make_msg_vec(sample, nb_pos, edge_spec)
                msg_vecs.append(m_vec)
                m_hid = []
                for h in range(self.hidden_dim):
                    mz = self.params["b_msg"][h] + sum(
                        self.params["W_msg"][h][j] * m_vec[j]
                        for j in range(len(m_vec))
                    )
                    m_hid.append(math.tanh(mz))
                msg_hiddens.append(m_hid)

                logit = self.params["b_gate"][0] + sum(
                    self.params["W_gate"][0][j] * m_vec[j]
                    for j in range(len(m_vec))
                )
                raw_logits.append(max(-15.0, min(15.0, logit)))

            # Softmax attention over incoming edges scaled by sqrt(len(edges))
            max_l = max(raw_logits)
            exps = [math.exp(l - max_l) for l in raw_logits]
            denom = sum(exps) + 1e-12
            gates = [e / denom for e in exps]

            for g, m_hid in zip(gates, msg_hiddens):
                for h in range(self.hidden_dim):
                    h_agg[h] += g * m_hid[h]

        concat = [*h_self, *h_agg, x_self[0]]
        pred_z = (
            self.params["b_head"][0]
            + self.params["res_y0"][0] * x_self[0]
            + sum(self.params["W_head"][j] * concat[j] for j in range(len(concat)))
        )

        cache = {
            "x_self": x_self,
            "h_self": h_self,
            "h_agg": h_agg,
            "concat": concat,
            "gates": gates,
            "msg_vecs": msg_vecs,
            "msg_hiddens": msg_hiddens,
        }
        return pred_z, cache

    def fit(
        self,
        train_samples: List[SupervisedSample],
        edges: Sequence[NeighborEdgeSpec],
        target_mean: float,
        target_std: float,
        epochs: int = 180,
        lr: float = 0.025,
        weight_decay: float = 1e-2,
    ) -> Dict[str, Any]:
        # Hold out inner tail for early stopping (zero test leakage)
        n = len(train_samples)
        if n >= 12:
            val_size = max(3, int(round(n * 0.22)))
            inner_train = train_samples[: n - val_size]
            inner_val = train_samples[n - val_size :]
        else:
            inner_train = train_samples
            inner_val = train_samples

        # Initialize Adam state
        m_state: Dict[str, Any] = {}
        v_state: Dict[str, Any] = {}
        for k, val in self.params.items():
            if isinstance(val[0], list):
                m_state[k] = [[0.0] * len(r) for r in val]
                v_state[k] = [[0.0] * len(r) for r in val]
            else:
                m_state[k] = [0.0] * len(val)
                v_state[k] = [0.0] * len(val)

        def snapshot_params() -> Dict[str, Any]:
            return {
                k: ([r[:] for r in v] if isinstance(v[0], list) else v[:])
                for k, v in self.params.items()
            }

        best_val_loss = float("inf")
        best_params = snapshot_params()
        beta1, beta2, eps = 0.9, 0.999, 1e-8

        for step in range(1, epochs + 1):
            grads: Dict[str, Any] = {
                k: ([[0.0] * len(r) for r in v] if isinstance(v[0], list) else [0.0] * len(v))
                for k, v in self.params.items()
            }

            inv_m = 1.0 / max(1, len(inner_train))
            for sample in inner_train:
                y_true_z = (sample.target_actual - target_mean) / target_std
                pred_z, cache = self.forward_single(sample, edges)
                err = pred_z - y_true_z
                # Smooth Huber derivative (delta=2.0 sigma) * 2
                d_out = 2.0 * max(-2.0, min(2.0, err)) * inv_m

                grads["b_head"][0] += d_out
                grads["res_y0"][0] += d_out * cache["x_self"][0]
                concat = cache["concat"]
                for j, val in enumerate(concat):
                    grads["W_head"][j] += d_out * val

                d_h_self = [
                    d_out * self.params["W_head"][h] * (1.0 - cache["h_self"][h] ** 2)
                    for h in range(self.hidden_dim)
                ]
                for h in range(self.hidden_dim):
                    grads["b_self"][h] += d_h_self[h]
                    for j, xv in enumerate(cache["x_self"]):
                        grads["W_self"][h][j] += d_h_self[h] * xv

                if edges:
                    d_h_agg = [
                        d_out * self.params["W_head"][self.hidden_dim + h]
                        for h in range(self.hidden_dim)
                    ]
                    gates = cache["gates"]
                    d_gates = []
                    for nb_pos, g in enumerate(gates):
                        m_hid = cache["msg_hiddens"][nb_pos]
                        m_vec = cache["msg_vecs"][nb_pos]
                        d_gates.append(sum(d_h_agg[h] * m_hid[h] for h in range(self.hidden_dim)))
                        for h in range(self.hidden_dim):
                            d_mz = d_h_agg[h] * g * (1.0 - m_hid[h] ** 2)
                            grads["b_msg"][h] += d_mz
                            for j, mv in enumerate(m_vec):
                                grads["W_msg"][h][j] += d_mz * mv

                    weighted_dgate = sum(g * dg for g, dg in zip(gates, d_gates))
                    for nb_pos, (g, dg) in enumerate(zip(gates, d_gates)):
                        d_logit = g * (dg - weighted_dgate)
                        grads["b_gate"][0] += d_logit
                        for j, mv in enumerate(cache["msg_vecs"][nb_pos]):
                            grads["W_gate"][0][j] += d_logit * mv

            # Clip global gradient norm and apply Adam step with L2 weight decay
            grad_sq = 0.0
            for param_grad in grads.values():
                if isinstance(param_grad[0], list):
                    for r in param_grad:
                        grad_sq += sum(g * g for g in r)
                else:
                    grad_sq += sum(g * g for g in param_grad)
            grad_norm = math.sqrt(grad_sq)
            grad_scale = min(1.0, 5.0 / grad_norm) if grad_norm > 1e-12 else 1.0

            bc1 = 1.0 - beta1**step
            bc2 = 1.0 - beta2**step
            for k, param in self.params.items():
                if isinstance(param[0], list):
                    for r in range(len(param)):
                        for c in range(len(param[r])):
                            g = grads[k][r][c] * grad_scale + weight_decay * param[r][c]
                            m_state[k][r][c] = beta1 * m_state[k][r][c] + (1.0 - beta1) * g
                            v_state[k][r][c] = beta2 * v_state[k][r][c] + (1.0 - beta2) * (g * g)
                            m_hat = m_state[k][r][c] / bc1
                            v_hat = v_state[k][r][c] / bc2
                            param[r][c] -= lr * m_hat / (math.sqrt(v_hat) + eps)
                else:
                    is_bias = k.startswith("b_")
                    for idx in range(len(param)):
                        g = grads[k][idx] * grad_scale + (
                            0.0 if is_bias else weight_decay * param[idx]
                        )
                        m_state[k][idx] = beta1 * m_state[k][idx] + (1.0 - beta1) * g
                        v_state[k][idx] = beta2 * v_state[k][idx] + (1.0 - beta2) * (g * g)
                        m_hat = m_state[k][idx] / bc1
                        v_hat = v_state[k][idx] / bc2
                        param[idx] -= lr * m_hat / (math.sqrt(v_hat) + eps)

            val_sq = 0.0
            for vs in inner_val:
                vp_z, _ = self.forward_single(vs, edges)
                vy_z = (vs.target_actual - target_mean) / target_std
                val_sq += (vp_z - vy_z) ** 2
            val_loss = val_sq / max(1, len(inner_val))
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_params = snapshot_params()

        self.params = best_params
        return {"best_val_mse_z": round(best_val_loss, 5), "epochs": epochs}

    def predict_batch(
        self,
        samples: Sequence[SupervisedSample],
        edges: Sequence[NeighborEdgeSpec],
        target_mean: float,
        target_std: float,
    ) -> Tuple[List[float], List[float]]:
        preds: List[float] = []
        avg_gates = [0.0] * len(edges)
        for sample in samples:
            pred_z, cache = self.forward_single(sample, edges)
            preds.append(target_mean + target_std * pred_z)
            for i, g in enumerate(cache["gates"]):
                avg_gates[i] += g / max(1, len(samples))
        return preds, avg_gates


if HAS_TORCH:  # pragma: no cover - optional PyTorch path

    class PyTorchETGLagGNN(nn.Module):
        """Optional PyTorch reference implementation mirroring ETGLagGraphNet."""

        def __init__(self, target_dim: int, edge_msg_dim: int, hidden_dim: int = 16) -> None:
            super().__init__()
            self.self_enc = nn.Sequential(nn.Linear(target_dim, hidden_dim), nn.Tanh())
            self.msg_enc = nn.Sequential(nn.Linear(edge_msg_dim, hidden_dim), nn.Tanh())
            self.gate_net = nn.Linear(edge_msg_dim, 1)
            self.head = nn.Linear(hidden_dim * 2 + 1, 1)

        def forward(
            self,
            x_self: "torch.Tensor",
            edge_msgs: Optional["torch.Tensor"] = None,
        ) -> "torch.Tensor":
            h_self = self.self_enc(x_self)
            if edge_msgs is not None and edge_msgs.shape[1] > 0:
                m_hid = self.msg_enc(edge_msgs)
                gates = torch.softmax(self.gate_net(edge_msgs), dim=1)
                h_agg = (gates * m_hid).sum(dim=1)
            else:
                h_agg = torch.zeros_like(h_self)
            concat = torch.cat([h_self, h_agg, x_self[:, :1]], dim=-1)
            return self.head(concat).squeeze(-1)


def train_and_evaluate_etg_stgnn(
    source: Any,
    target_uuid: Optional[str] = None,
    target_idx: Optional[int] = None,
    horizon_steps: int = 1,
    window_lags: int = 3,
    hidden_dim: int = 12,
    epochs: int = 180,
    lr: float = 0.025,
    seed: int = 42,
) -> Dict[str, Any]:
    """Full benchmark comparing Persistence, Self-AR Ridge, Linear Graph Ridge, and ETGLagGraphNet."""
    dataset = load_etg_ml_dataset(source)
    chosen_idx = select_target_index(dataset, target_uuid=target_uuid, target_idx=target_idx)
    windowed = build_supervised_windows(
        dataset,
        target_idx=chosen_idx,
        horizon_steps=horizon_steps,
        window_lags=window_lags,
    )
    baselines = evaluate_baselines(windowed)

    edges: List[NeighborEdgeSpec] = windowed["incoming_edges"]
    mu: float = windowed["target_mean"]
    sd: float = windowed["target_std"]
    train: List[SupervisedSample] = windowed["train_samples"]
    test: List[SupervisedSample] = windowed["test_samples"]
    latest_sample: SupervisedSample = windowed["latest_sample"]

    model = ETGLagGraphNet(
        target_lag_dim=window_lags,
        edge_attr_dim=max(8, len(dataset.edge_attr_names)),
        neighbor_lag_dim=window_lags,
        hidden_dim=hidden_dim,
        seed=seed,
    )
    fit_info = model.fit(train, edges, mu, sd, epochs=epochs, lr=lr)

    test_gnn_preds, avg_gates = model.predict_batch(test, edges, mu, sd)
    latest_pred, _ = model.predict_batch([latest_sample], edges, mu, sd)

    p_rmse = max(1e-9, baselines["persistence"]["rmse"])
    gnn_metrics = _eval_preds(baselines["test_actuals"], test_gnn_preds, p_rmse)
    self_rmse = baselines["self_ar"]["rmse"]
    skill_lift_vs_self = (
        round(((self_rmse - gnn_metrics["rmse"]) / self_rmse) * 100.0, 2)
        if self_rmse > 1e-9
        else 0.0
    )

    attributions = sorted(
        [
            {
                "node_uuid": spec.src_uuid,
                "node_name": spec.src_name,
                "edge_type": spec.edge_type,
                "optimal_lag_steps": spec.optimal_lag,
                "learned_attention_weight": round(avg_gates[idx], 4)
                if idx < len(avg_gates)
                else 0.0,
            }
            for idx, spec in enumerate(edges)
        ],
        key=lambda row: row["learned_attention_weight"],
        reverse=True,
    )

    return {
        "schema_version": "etg-stgnn-eval-v1",
        "backend": "torch" if HAS_TORCH else "python-stdlib",
        "target_uuid": windowed["target_uuid"],
        "target_name": windowed["target_name"],
        "bucket": dataset.bucket,
        "train_count": len(train),
        "test_count": len(test),
        "horizon_steps": horizon_steps,
        "window_lags": window_lags,
        "neighbor_count": len(edges),
        "training": fit_info,
        "metrics": {
            "persistence": baselines["persistence"],
            "self_ar": baselines["self_ar"],
            "linear_graph_ridge": baselines["linear_graph_ridge"],
            "etg_lag_gnn": gnn_metrics,
        },
        "skill_lift_vs_self_pct": skill_lift_vs_self,
        "next_forecast": round(latest_pred[0], 4),
        "last_actual": round(latest_sample.last_actual, 4),
        "edge_attributions": attributions,
    }
