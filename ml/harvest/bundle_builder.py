"""Feature schema constants, geodesic/statistical helpers, and leak-free `etg-ml-v2` bundle assembly."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Sequence, Tuple


NODE_STATIC_FEATURE_NAMES: List[str] = [
    "lat_sin",
    "lat_cos",
    "lng_sin",
    "lng_cos",
    "elevation_norm",
    "trust_score",
    "is_community",
    "corroborated",
    "scale_day",
    "scale_month",
    "scale_year",
    "scale_impulse",
    "sphere_atmosphere",
    "sphere_ocean",
    "sphere_hydrosphere",
    "sphere_biosphere_cryo",
]

EDGE_ATTR_NAMES: List[str] = [
    "causal_corr_r",
    "causal_optimal_lag_norm",
    "weight",
    "distance_km_norm",
    "sin_bearing",
    "cos_bearing",
    "is_opposite",
    "is_cross_scale",
]

TEMPORAL_FEATURE_NAMES: List[str] = [
    "value",
    "z_score",
    "diff_1",
    "rolling_mean_4",
    "rolling_std_4",
    "seasonal_anom",
    "event_impulse",
    "covar_primary",
]


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return r * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def _bearing_rad(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.atan2(y, x)


def _month_keys(start_year: int, num_months: int) -> List[str]:
    keys: List[str] = []
    y = start_year
    m = 1
    for _ in range(num_months):
        keys.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return keys


def _compute_train_stats(values: Sequence[Optional[float]], cutoff: int) -> Tuple[float, float, Dict[int, float]]:
    train_vals = [float(v) for v in values[:cutoff] if v is not None and math.isfinite(float(v))]
    if not train_vals:
        return 0.0, 1.0, {}
    mean = sum(train_vals) / len(train_vals)
    var = sum((v - mean) ** 2 for v in train_vals) / max(1, len(train_vals))
    std = max(1e-6, math.sqrt(var))

    by_month: Dict[int, List[float]] = {}
    for idx in range(min(cutoff, len(values))):
        v = values[idx]
        if v is not None and math.isfinite(float(v)):
            by_month.setdefault((idx % 12) + 1, []).append(float(v))
    clim: Dict[int, float] = {m: sum(vs) / len(vs) for m, vs in by_month.items() if vs}
    return mean, std, clim


def _causal_corr_and_lag(
    src_vals: Sequence[Optional[float]],
    dst_vals: Sequence[Optional[float]],
    cutoff: int,
    max_lag: int = 3,
) -> Tuple[float, int]:
    """Compute Pearson correlation and best causal lag strictly within `[0, cutoff)`."""
    best_r = 0.0
    best_lag = 0
    for lag in range(0, max_lag + 1):
        xs: List[float] = []
        ys: List[float] = []
        for t in range(lag, min(cutoff, len(src_vals), len(dst_vals))):
            sv = src_vals[t - lag]
            dv = dst_vals[t]
            if sv is not None and dv is not None and math.isfinite(sv) and math.isfinite(dv):
                xs.append(float(sv))
                ys.append(float(dv))
        if len(xs) < 6:
            continue
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
        dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
        dy = math.sqrt(sum((y - my) ** 2 for y in ys))
        r = num / (dx * dy) if dx > 1e-9 and dy > 1e-9 else 0.0
        if abs(r) > abs(best_r):
            best_r = r
            best_lag = lag
    return round(best_r, 4), best_lag


def _build_node_static_vec(meta: Dict[str, Any]) -> List[float]:
    lat_r = math.radians(float(meta.get("lat", 0.0)))
    lng_r = math.radians(float(meta.get("lng", 0.0)))
    elev_norm = max(-1.0, min(1.0, float(meta.get("elevation_m", 0.0)) / 5000.0))
    trust = max(0.05, min(1.0, float(meta.get("trust_score", 0.8))))
    is_comm = 1.0 if meta.get("is_community") else 0.0
    corr = 1.0 if meta.get("corroborated") else 0.0
    scale = str(meta.get("temporal_scale", "month"))
    avail = set(meta.get("available_scales", [scale]))
    sphere = str(meta.get("sphere", "Atmosphere"))
    return [
        round(math.sin(lat_r), 4),
        round(math.cos(lat_r), 4),
        round(math.sin(lng_r), 4),
        round(math.cos(lng_r), 4),
        round(elev_norm, 4),
        round(trust, 4),
        is_comm,
        corr,
        1.0 if ("day" in avail or scale == "day") else 0.0,
        1.0 if ("month" in avail or scale == "month") else 0.0,
        1.0 if ("year" in avail or scale == "year") else 0.0,
        1.0 if scale == "impulse" else 0.0,
        1.0 if sphere == "Atmosphere" else 0.0,
        1.0 if sphere == "Ocean" else 0.0,
        1.0 if sphere == "Hydrosphere" else 0.0,
        1.0 if sphere in ("Biosphere", "Cryosphere") else 0.0,
    ]


def _assemble_v2_bundle(
    time_index: List[str],
    nodes: List[Dict[str, Any]],
    raw_series_by_node: List[List[Optional[float]]],
    covar_by_node: List[List[float]],
    impulse_by_node: List[List[float]],
    edges: List[Dict[str, Any]],
    horizon_steps: int = 1,
    train_fraction: float = 0.75,
) -> Dict[str, Any]:
    T = len(time_index)
    N = len(nodes)
    cutoff = max(8, min(T - horizon_steps - 1, int(round(T * train_fraction))))

    normalization: List[Dict[str, float]] = []
    clims: List[Dict[int, float]] = []
    for j in range(N):
        m, s, clim = _compute_train_stats(raw_series_by_node[j], cutoff)
        normalization.append({"mean": round(m, 6), "std": round(s, 6)})
        clims.append(clim)

    feature_tensor: List[List[List[float]]] = []
    mask_tensor: List[List[int]] = []

    for t in range(T):
        f_row: List[List[float]] = []
        m_row: List[int] = []
        month_num = ((int(time_index[t].split("-")[1]) if "-" in time_index[t] else (t % 12) + 1) - 1) % 12 + 1
        for j in range(N):
            val = raw_series_by_node[j][t]
            if val is None or not math.isfinite(float(val)):
                f_row.append([0.0] * 8)
                m_row.append(0)
                continue
            v = float(val)
            mean = normalization[j]["mean"]
            std = normalization[j]["std"]
            z = (v - mean) / std
            prev_z = feature_tensor[t - 1][j][1] if t > 0 and mask_tensor[t - 1][j] == 1 else z
            diff_1 = z - prev_z

            hist_z: List[float] = []
            for k in range(max(0, t - 3), t + 1):
                if k == t:
                    hist_z.append(z)
                elif mask_tensor[k][j] == 1:
                    hist_z.append(feature_tensor[k][j][1])
            rm4 = sum(hist_z) / len(hist_z) if hist_z else z
            rs4 = math.sqrt(sum((x - rm4) ** 2 for x in hist_z) / max(1, len(hist_z)))

            clim_val = clims[j].get(month_num, mean)
            seasonal_anom = (v - clim_val) / std
            imp = float(impulse_by_node[j][t])
            cov = float(covar_by_node[j][t])
            f_row.append([
                round(v, 5),
                round(z, 5),
                round(diff_1, 5),
                round(rm4, 5),
                round(rs4, 5),
                round(seasonal_anom, 5),
                round(imp, 5),
                round(cov, 5),
            ])
            m_row.append(1)
        feature_tensor.append(f_row)
        mask_tensor.append(m_row)

    # Edge construction using ONLY pre-cutoff correlations/lags
    src_idx: List[int] = []
    dst_idx: List[int] = []
    edge_types: List[str] = []
    edge_attr: List[List[float]] = []
    for e in edges:
        s = int(e["src"])
        d = int(e["dst"])
        src_idx.append(s)
        dst_idx.append(d)
        etype = str(e.get("type", "correlates_with"))
        edge_types.append(etype)

        corr_r, opt_lag = _causal_corr_and_lag(raw_series_by_node[s], raw_series_by_node[d], cutoff)
        sn = nodes[s]
        dn = nodes[d]
        dist_km = _haversine_km(float(sn["lat"]), float(sn["lng"]), float(dn["lat"]), float(dn["lng"]))
        brg = _bearing_rad(float(sn["lat"]), float(sn["lng"]), float(dn["lat"]), float(dn["lng"]))
        weight = float(e.get("weight", max(0.35, abs(corr_r))))
        edge_attr.append([
            corr_r,
            round(max(-1.0, min(1.0, opt_lag / 6.0)), 4),
            round(weight, 4),
            round(min(1.0, dist_km / 20000.0), 4),
            round(math.sin(brg), 4),
            round(math.cos(brg), 4),
            1.0 if etype == "drives_opposite" else 0.0,
            1.0 if e.get("cross_scale") else 0.0,
        ])

    # Targets
    next_value_targets: List[List[Optional[float]]] = []
    trend_class_targets: List[List[Optional[int]]] = []
    regime_shift_targets: List[List[Optional[int]]] = []
    for t in range(T):
        nv_row: List[Optional[float]] = []
        tc_row: List[Optional[int]] = []
        rs_row: List[Optional[int]] = []
        f_idx = t + horizon_steps
        for j in range(N):
            if f_idx < T and mask_tensor[f_idx][j] == 1:
                fut_z = feature_tensor[f_idx][j][1]
                nv_row.append(fut_z)
                if mask_tensor[t][j] == 1:
                    cur_z = feature_tensor[t][j][1]
                    dz = fut_z - cur_z
                    tc_row.append(0 if dz <= -0.35 else 2 if dz >= 0.35 else 1)
                    rm4 = feature_tensor[t][j][3]
                    jump = abs(fut_z - rm4) >= 1.5
                    flip = (fut_z * rm4 < -0.5) and abs(fut_z) >= 1.1
                    rs_row.append(1 if (jump or flip) else 0)
                else:
                    tc_row.append(None)
                    rs_row.append(None)
            else:
                nv_row.append(None)
                tc_row.append(None)
                rs_row.append(None)
        next_value_targets.append(nv_row)
        trend_class_targets.append(tc_row)
        regime_shift_targets.append(rs_row)

    # Annual down-aggregation multi_scale_block for coarse hierarchy
    years_seen: List[str] = []
    year_to_ts: Dict[str, List[int]] = {}
    for t, label in enumerate(time_index):
        yr = label[:4]
        if yr not in year_to_ts:
            years_seen.append(yr)
            year_to_ts[yr] = []
        year_to_ts[yr].append(t)

    year_feat: List[List[List[float]]] = []
    year_mask: List[List[int]] = []
    for yr in years_seen:
        ts = year_to_ts[yr]
        y_f: List[List[float]] = []
        y_m: List[int] = []
        for j in range(N):
            valid_ts = [k for k in ts if mask_tensor[k][j] == 1]
            if not valid_ts:
                y_f.append([0.0] * 8)
                y_m.append(0)
            else:
                avg_vec = [
                    round(sum(feature_tensor[k][j][dim] for k in valid_ts) / len(valid_ts), 5)
                    for dim in range(8)
                ]
                y_f.append(avg_vec)
                y_m.append(1)
        year_feat.append(y_f)
        year_mask.append(y_m)

    node_static = [_build_node_static_vec(meta) for meta in nodes]
    node_metadata = [
        {
            "index": idx,
            "uuid": meta["uuid"],
            "label": meta.get("label", "Signal"),
            "name": meta["name"],
            "dataset": meta.get("dataset"),
            "sphere": meta.get("sphere", "Atmosphere"),
            "temporal_scale": meta.get("temporal_scale", "month"),
            "phenomenon_type": meta.get("phenomenon_type", meta["name"]),
            "lat": meta["lat"],
            "lng": meta["lng"],
            "elevation_m": meta.get("elevation_m", 0.0),
            "trust_score": meta.get("trust_score", 0.8),
            "is_community": bool(meta.get("is_community", False)),
            "corroborated": bool(meta.get("corroborated", False)),
        }
        for idx, meta in enumerate(nodes)
    ]

    return {
        "schema_version": "etg-ml-v2",
        "primary_bucket": "month",
        "train_cutoff_index": cutoff,
        "node_ids": [m["uuid"] for m in nodes],
        "node_metadata": node_metadata,
        "node_static_feature_names": list(NODE_STATIC_FEATURE_NAMES),
        "node_static_features": node_static,
        "edge_index": [src_idx, dst_idx],
        "edge_types": edge_types,
        "edge_attr_names": list(EDGE_ATTR_NAMES),
        "edge_attr": edge_attr,
        "time_index": time_index,
        "feature_names": list(TEMPORAL_FEATURE_NAMES),
        "feature_tensor": feature_tensor,
        "mask_tensor": mask_tensor,
        "multi_scale_blocks": {
            "month": {
                "time_index": time_index,
                "node_indices": list(range(N)),
                "feature_tensor": feature_tensor,
                "mask_tensor": mask_tensor,
            },
            "year": {
                "time_index": years_seen,
                "node_indices": list(range(N)),
                "feature_tensor": year_feat,
                "mask_tensor": year_mask,
            },
        },
        "labels": {
            "horizon_steps": horizon_steps,
            "next_value_targets": next_value_targets,
            "trend_class_targets": trend_class_targets,
            "regime_shift_targets": regime_shift_targets,
        },
        "normalization": normalization,
    }
