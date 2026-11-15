"""Dataset loading, leak-free supervised window extraction, Ridge solver, and linear baselines for `etg-ml-v1`."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


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
