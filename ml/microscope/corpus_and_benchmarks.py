"""
Mechanistic multi-regime + confounder + live hindsight training corpus generator
and holdout benchmark evaluation vs. classical Mann-Kendall and raw Pearson baselines.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

from microscope.features import (
    _mann_kendall_abs_z,
    _ols_slope,
    _pop_std,
    extract_node_microscope_features,
    extract_pair_microscope_features,
)
from microscope.portable_model import PortableTrendMicroscope


def _generate_ar1_red_noise(rng: random.Random, length: int, rho: float = 0.68, scale: float = 0.42) -> List[float]:
    xs: List[float] = []
    cur = rng.gauss(0.0, scale)
    for _ in range(length):
        cur = rho * cur + rng.gauss(0.0, scale)
        xs.append(cur)
    return xs


def _snapshot_from_series(
    series_by_node: List[List[float]],
    nodes_meta: List[Dict[str, Any]],
    t_cut: int,
    node_targets: List[Dict[str, Any]],
    pair_targets: Dict[Tuple[int, int], Dict[str, Any]],
    horizon_series: Optional[List[List[float]]] = None,
) -> Dict[str, Any]:
    n = len(nodes_meta)
    x_nodes = [
        extract_node_microscope_features(
            series_by_node[i][: t_cut + 1],
            scale=str(nodes_meta[i].get("temporal_scale", "month")),
            lat=float(nodes_meta[i].get("lat", 0.0)),
            lng=float(nodes_meta[i].get("lng", 0.0)),
            trust_score=float(nodes_meta[i].get("trust_score", 0.8)),
            is_community=bool(nodes_meta[i].get("is_community", False)),
            corroborated=bool(nodes_meta[i].get("corroborated", False)),
        )
        for i in range(n)
    ]
    x_pairs: Dict[Tuple[int, int], List[float]] = {}
    for u in range(n):
        for v in range(n):
            if u == v:
                continue
            su = series_by_node[u][: t_cut + 1]
            sv = series_by_node[v][: t_cut + 1]
            m = min(len(su), len(sv))
            x_pairs[(u, v)] = extract_pair_microscope_features(
                su[-m:],
                sv[-m:],
                u_lat=float(nodes_meta[u].get("lat", 0.0)),
                u_lng=float(nodes_meta[u].get("lng", 0.0)),
                v_lat=float(nodes_meta[v].get("lat", 0.0)),
                v_lng=float(nodes_meta[v].get("lng", 0.0)),
                u_trust=float(nodes_meta[u].get("trust_score", 0.8)),
                v_trust=float(nodes_meta[v].get("trust_score", 0.8)),
                scale=str(nodes_meta[v].get("temporal_scale", "month")),
            )
    return {
        "node_features": x_nodes,
        "pair_features": x_pairs,
        "node_targets": node_targets,
        "pair_targets": pair_targets,
        "meta": nodes_meta,
    }


def _synthesize_curriculum_graph(rng: random.Random, graph_idx: int) -> Dict[str, Any]:
    """
    Build a 7-node global graph containing all critical physical & statistical pitfalls:
      0: Lagged Teleconnection Driver (stochastic mode + fresh break in ~50% graphs)
      1: Lagged Opposite / Co-Trending Responder (driven by Node 0 at lag 1..4)
      2: NH Seasonal Cosine Illusion (zero true link to 3, strong seasonal amplitude)
      3: SH Seasonal Anti-Phase Illusion (180-deg inverted season -> high |r|, confounder!)
      4: Secular Drift vs Oscillation Cycle (50% clean early break pre-MK / 50% ENSO cycle alias)
      5: Independent Warming Drift (same secular slope -> shared-drift illusion)
      6: Community Node (50% verified corroborated early-break, 50% uncorroborated step glitch)
    Node positions in list are shuffled per graph to force permutation invariance.
    """
    T = 56
    t_cut = T - 1

    tau_true = rng.randint(1, 4)
    sign_1 = -1.0 if rng.random() < 0.5 else 1.0
    driver_breaks = rng.random() < 0.5
    driver_sign = 1.0 if rng.random() < 0.5 else -1.0
    drv_break_t = T - rng.randint(4, 6)

    drv_noise = _generate_ar1_red_noise(rng, T, rho=0.62, scale=0.38)
    s0 = []
    for t in range(T):
        seas = 0.55 * math.sin(2.0 * math.pi * t / 12.0 + rng.uniform(-0.1, 0.1))
        brk = driver_sign * 0.42 * (t - drv_break_t + 1) if (driver_breaks and t >= drv_break_t) else 0.0
        s0.append(seas + drv_noise[t] + brk)

    # Node 1: Driven by Node 0 anomaly at tau_true
    s1_noise = _generate_ar1_red_noise(rng, T, rho=0.35, scale=0.28)
    s1_phase = rng.uniform(0.0, 2.0 * math.pi)
    s1 = []
    for t in range(T):
        src_t = max(0, t - tau_true)
        drv_anom = drv_noise[src_t] + (
            driver_sign * 0.42 * (src_t - drv_break_t + 1) if (driver_breaks and src_t >= drv_break_t) else 0.0
        )
        seas = 0.45 * math.sin(2.0 * math.pi * t / 12.0 + s1_phase)
        s1.append(seas + sign_1 * 1.15 * drv_anom + s1_noise[t])

    # Nodes 2 & 3: Opposite-hemisphere seasonal illusion (zero coupled anomaly)
    s2_noise = _generate_ar1_red_noise(rng, T, rho=0.35, scale=0.22)
    s3_noise = _generate_ar1_red_noise(rng, T, rho=0.35, scale=0.22)
    ph23 = rng.uniform(0.0, 2.0 * math.pi)
    s2 = [2.4 * math.sin(2.0 * math.pi * t / 12.0 + ph23) + s2_noise[t] for t in range(T)]
    s3 = [-2.4 * math.sin(2.0 * math.pi * t / 12.0 + ph23) + s3_noise[t] for t in range(T)]

    # Node 4: Either Pre-MK Early Slope Break OR Multi-Year Cycle False Trend
    mode4 = graph_idx % 3
    s4_noise = _generate_ar1_red_noise(rng, T, rho=0.38, scale=0.24)
    if mode4 == 0:
        # Fresh structural slope break 4-5 steps ago (pre-Mann-Kendall)
        brk4 = T - rng.randint(4, 6)
        sgn4 = 1.0 if rng.random() < 0.5 else -1.0
        rng_slope4 = rng.uniform(0.34, 0.56)
        s4 = [
            0.35 * math.sin(2.0 * math.pi * t / 12.0)
            + s4_noise[t]
            + (sgn4 * rng_slope4 * (t - brk4 + 1) if t >= brk4 else 0.0)
            for t in range(T)
        ]
        t4 = {
            "onset": 1.0,
            "direction": 2 if sgn4 > 0 else 0,
            "lead_steps": float(T - brk4),
            "shares": [0.76, 0.12, 0.12],
            "false_trend": 0.0,
        }
    elif mode4 == 1:
        # Multi-year ENSO-like oscillation sampled on monotonic quarter-wave -> False Trend!
        p_cyc = rng.choice([26.0, 30.0, 34.0, 38.0])
        ph4 = rng.uniform(0.0, 2.0 * math.pi)
        s4 = [
            2.1 * math.sin(2.0 * math.pi * t / p_cyc + ph4)
            + 0.35 * math.sin(2.0 * math.pi * t / 12.0)
            + s4_noise[t] * 0.65
            for t in range(T)
        ]
        t4 = {
            "onset": 0.0,
            "direction": 1,
            "lead_steps": 0.0,
            "shares": [0.10, 0.78, 0.12],
            "false_trend": 1.0,
        }
    else:
        # Long-standing steady secular trend (already established, NOT a sudden break)
        sgn4 = 1.0 if rng.random() < 0.5 else -1.0
        s4 = [
            0.09 * sgn4 * t + 0.35 * math.sin(2.0 * math.pi * t / 12.0) + s4_noise[t]
            for t in range(T)
        ]
        t4 = {
            "onset": 0.0,
            "direction": 2 if sgn4 > 0 else 0,
            "lead_steps": 0.0,
            "shares": [0.80, 0.10, 0.10],
            "false_trend": 0.0,
        }

    # Node 5: Independent secular drift (shared warming illusion against other trends) OR Red Noise
    is_drift5 = rng.random() < 0.55
    s5_noise = _generate_ar1_red_noise(rng, T, rho=0.72, scale=0.35)
    if is_drift5:
        slope5 = 0.085 * (1.0 if rng.random() < 0.7 else -1.0)
        s5 = [slope5 * t + 0.4 * math.sin(2.0 * math.pi * t / 12.0 + 0.7) + s5_noise[t] * 0.7 for t in range(T)]
        t5 = {"onset": 0.0, "direction": 2 if slope5 > 0 else 0, "lead_steps": 0.0, "shares": [0.76, 0.12, 0.12], "false_trend": 0.0}
    else:
        s5 = [0.25 * math.sin(2.0 * math.pi * t / 12.0) + s5_noise[t] * 1.4 for t in range(T)]
        t5 = {"onset": 0.0, "direction": 1, "lead_steps": 0.0, "shares": [0.12, 0.18, 0.70], "false_trend": 1.0}

    # Node 6: Community sensor — either verified early onset or uncorroborated step-glitch artifact
    comm_good = (graph_idx % 2 == 0)
    s6_noise = _generate_ar1_red_noise(rng, T, rho=0.35, scale=0.25)
    if comm_good:
        # Tracks Node 0 with lag 1 + verified high trust
        s6 = [0.95 * (s0[max(0, t - 1)] - 0.55 * math.sin(2.0 * math.pi * max(0, t - 1) / 12.0)) + s6_noise[t] for t in range(T)]
        t6 = {
            "onset": 1.0 if driver_breaks else 0.0,
            "direction": (2 if driver_sign > 0 else 0) if driver_breaks else 1,
            "lead_steps": float(T - drv_break_t - 1) if driver_breaks else 0.0,
            "shares": [0.74, 0.14, 0.12],
            "false_trend": 0.0,
        }
        m6 = {
            "uuid": f"comm-verified-{graph_idx}",
            "name": "Community Flux Verified",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": round(rng.uniform(0.86, 0.96), 3),
            "is_community": True,
            "corroborated": True,
        }
    else:
        # Uncorroborated sensor drift/step glitch
        glitch_t = T - rng.randint(3, 5)
        sgn6 = 1.0 if rng.random() < 0.5 else -1.0
        s6 = [s6_noise[t] + (sgn6 * 2.6 if t >= glitch_t else 0.0) for t in range(T)]
        t6 = {
            "onset": 0.0,
            "direction": 1,
            "lead_steps": 0.0,
            "shares": [0.08, 0.10, 0.82],
            "false_trend": 1.0,
        }
        m6 = {
            "uuid": f"comm-glitch-{graph_idx}",
            "name": "Uncorroborated Sensor Glitch",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": round(rng.uniform(0.10, 0.24), 3),
            "is_community": True,
            "corroborated": False,
        }

    metas = [
        {
            "uuid": f"drv-{graph_idx}",
            "name": "Equatorial Mode",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.95,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": f"resp-{graph_idx}",
            "name": "Teleconnected Basin",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.90,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": f"nh-seas-{graph_idx}",
            "name": "Northern Seasonal Grid",
            "lat": rng.uniform(22, 68),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.88,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": f"sh-seas-{graph_idx}",
            "name": "Southern Seasonal Grid",
            "lat": rng.uniform(-68, -22),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.88,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": f"reg4-{graph_idx}",
            "name": "Sentinel Transition Zone",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.91,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": f"drift5-{graph_idx}",
            "name": "Continental Station",
            "lat": rng.uniform(-65, 65),
            "lng": rng.uniform(-180, 180),
            "temporal_scale": "month",
            "trust_score": 0.85,
            "is_community": False,
            "corroborated": True,
        },
        m6,
    ]

    tgt_drv = {
        "onset": 1.0 if driver_breaks else 0.0,
        "direction": (2 if driver_sign > 0 else 0) if driver_breaks else 1,
        "lead_steps": float(T - drv_break_t) if driver_breaks else 0.0,
        "shares": [0.68, 0.16, 0.16] if driver_breaks else [0.15, 0.25, 0.60],
        "false_trend": 0.0 if driver_breaks else 1.0,
    }
    tgt_resp = {
        "onset": 1.0 if (driver_breaks and (T - drv_break_t - tau_true) >= 2) else 0.0,
        "direction": (2 if driver_sign * sign_1 > 0 else 0) if driver_breaks else 1,
        "lead_steps": float(max(0, T - drv_break_t - tau_true)) if driver_breaks else 0.0,
        "shares": [0.70, 0.15, 0.15] if driver_breaks else [0.16, 0.24, 0.60],
        "false_trend": 0.0 if driver_breaks else 1.0,
    }
    tgt_seas = {"onset": 0.0, "direction": 1, "lead_steps": 0.0, "shares": [0.08, 0.80, 0.12], "false_trend": 1.0}
    raw_targets = [tgt_drv, tgt_resp, tgt_seas, dict(tgt_seas), t4, t5, t6]
    raw_series = [s0, s1, s2, s3, s4, s5, s6]

    # Pair targets in original indexing
    orig_pairs: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for u in range(7):
        for v in range(7):
            if u == v:
                continue
            if u == 0 and v == 1:
                orig_pairs[(u, v)] = {
                    "true_coupling": 1.0,
                    "polarity": 2 if sign_1 > 0 else 0,
                    "lag": tau_true,
                    "confounder": 0.0,
                }
            elif u == 0 and v == 6 and comm_good:
                orig_pairs[(u, v)] = {
                    "true_coupling": 1.0,
                    "polarity": 2,
                    "lag": 1,
                    "confounder": 0.0,
                }
            else:
                is_conf = (
                    (u in (2, 3) and v in (2, 3))
                    or (u in (1, 6) and v in (1, 6) and comm_good)
                    or (mode4 == 2 and is_drift5 and u in (4, 5) and v in (4, 5))
                )
                orig_pairs[(u, v)] = {
                    "true_coupling": 0.0,
                    "polarity": 1,
                    "lag": 0,
                    "confounder": 1.0 if is_conf else 0.0,
                }

    # Shuffle node permutation so node index carries zero signal
    perm = list(range(7))
    rng.shuffle(perm)
    shuf_series = [raw_series[p] for p in perm]
    shuf_metas = [metas[p] for p in perm]
    shuf_targets = [raw_targets[p] for p in perm]
    inv_perm = {orig_i: new_i for new_i, orig_i in enumerate(perm)}
    shuf_pairs = {
        (inv_perm[u], inv_perm[v]): pt for (u, v), pt in orig_pairs.items()
    }
    return _snapshot_from_series(shuf_series, shuf_metas, t_cut, shuf_targets, shuf_pairs)


def _slice_live_hindsight_snapshots(bundle: Dict[str, Any], max_snapshots: int = 32) -> List[Dict[str, Any]]:
    """Build hindsight labeled snapshots strictly before `train_cutoff_index` from `etg-ml-v2`."""
    node_ids = bundle.get("node_ids", [])
    metas = bundle.get("node_metadata", [])
    feat_t = bundle.get("feature_tensor", [])
    mask_t = bundle.get("mask_tensor", [])
    cutoff = int(bundle.get("train_cutoff_index", max(1, len(feat_t) - 12)))
    n = len(node_ids)
    if n < 2 or cutoff < 30:
        return []

    raw_series = [
        [float(feat_t[t][j][0]) if mask_t[t][j] == 1 else float("nan") for t in range(len(feat_t))]
        for j in range(n)
    ]

    snapshots: List[Dict[str, Any]] = []
    stride = max(2, (cutoff - 24) // max(1, max_snapshots))
    t_points = list(range(20, max(21, cutoff - 8), stride))[:max_snapshots]
    for t_cut in t_points:
        clean_prefixes: List[List[float]] = []
        node_targets: List[Dict[str, Any]] = []
        for j in range(n):
            pref = [x for x in raw_series[j][: t_cut + 1] if math.isfinite(x)]
            fut = [x for x in raw_series[j][t_cut + 1 : t_cut + 7] if math.isfinite(x)]
            if len(pref) < 6:
                pref = [0.0] * 6
            clean_prefixes.append(pref)
            past_w = pref[-12:]
            p_std = max(1e-4, _pop_std(past_w))
            slope_past = _ols_slope(past_w) / p_std
            slope_fut = (_ols_slope(pref[-3:] + fut) / p_std) if len(fut) >= 3 else slope_past
            mk_now = _mann_kendall_abs_z(pref[-24:])
            diff_slope = slope_fut - slope_past
            is_onset = 1.0 if (abs(slope_fut) >= 0.16 and abs(diff_slope) >= 0.10 and mk_now < 2.2) else 0.0
            dir_cls = 2 if slope_fut > 0.12 else 0 if slope_fut < -0.12 else 1
            seas_ratio = extract_node_microscope_features(pref, scale=str(metas[j].get("temporal_scale", "month")))[7]
            false_fl = 1.0 if (seas_ratio > 0.55 and abs(slope_fut) < 0.08) else 0.0
            sec_s = 0.70 if abs(slope_fut) >= 0.14 and false_fl < 0.5 else 0.15
            cyc_s = 0.70 if seas_ratio > 0.45 else 0.15
            art_s = max(0.05, 1.0 - sec_s - cyc_s)
            norm_sum = sec_s + cyc_s + art_s
            node_targets.append(
                {
                    "onset": is_onset,
                    "direction": dir_cls,
                    "lead_steps": 4.0 if is_onset > 0.5 else 0.0,
                    "shares": [sec_s / norm_sum, cyc_s / norm_sum, art_s / norm_sum],
                    "false_trend": false_fl,
                }
            )

        pair_targets: Dict[Tuple[int, int], Dict[str, Any]] = {}
        for u in range(n):
            for v in range(n):
                if u == v:
                    continue
                xp = extract_pair_microscope_features(
                    clean_prefixes[u][-min(len(clean_prefixes[u]), len(clean_prefixes[v])) :],
                    clean_prefixes[v][-min(len(clean_prefixes[u]), len(clean_prefixes[v])) :],
                    scale=str(metas[v].get("temporal_scale", "month")),
                )
                best_clean = max(xp[4:8], key=lambda c: abs(c))
                best_raw = max(xp[0:4], key=lambda c: abs(c))
                asym = abs(xp[8])
                lag = int(round(xp[9] * 5.0))
                is_true = 1.0 if (abs(best_clean) >= 0.42 and (lag >= 1 or asym >= 0.08)) else 0.0
                is_conf = 1.0 if (abs(best_raw) >= 0.50 and abs(best_clean) < 0.25) else 0.0
                pol = (2 if best_clean > 0 else 0) if is_true > 0.5 else 1
                pair_targets[(u, v)] = {
                    "true_coupling": is_true,
                    "polarity": pol,
                    "lag": lag if is_true > 0.5 else 0,
                    "confounder": is_conf,
                }

        snapshots.append(
            _snapshot_from_series(
                clean_prefixes,
                metas,
                max(len(p) for p in clean_prefixes) - 1,
                node_targets,
                pair_targets,
            )
        )
    return snapshots


def build_microscope_training_corpus(
    live_bundle: Optional[Dict[str, Any]] = None,
    num_synthetic_graphs: int = 240,
    seed: int = 42,
) -> Dict[str, List[Dict[str, Any]]]:
    """Build strictly partitioned train (75%) and holdout val (25%) microscope graph snapshots."""
    rng = random.Random(seed)
    synth_all = [_synthesize_curriculum_graph(rng, i) for i in range(num_synthetic_graphs)]
    split = max(1, int(round(0.75 * len(synth_all))))
    train_graphs = synth_all[:split]
    val_graphs = synth_all[split:]

    if live_bundle is not None:
        live_snaps = _slice_live_hindsight_snapshots(live_bundle, max_snapshots=32)
        if live_snaps:
            l_split = max(1, int(round(0.75 * len(live_snaps))))
            train_graphs = train_graphs + live_snaps[:l_split]
            val_graphs = val_graphs + live_snaps[l_split:]

    return {"train": train_graphs, "val": val_graphs}


def _compute_roc_auc(scores: Sequence[float], labels: Sequence[float]) -> float:
    pos = [s for s, y in zip(scores, labels) if y >= 0.5]
    neg = [s for s, y in zip(scores, labels) if y < 0.5]
    if not pos or not neg:
        return 0.5
    wins = 0.0
    for sp in pos:
        for sn in neg:
            if sp > sn + 1e-12:
                wins += 1.0
            elif abs(sp - sn) <= 1e-12:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def evaluate_microscope_benchmarks(
    model: PortableTrendMicroscope,
    val_graphs: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Compare microscope 3 heads vs. rolling Mann-Kendall and raw Pearson baselines."""
    onset_scores, onset_labels, mk_scores = [], [], []
    fresh_total, fresh_hits_model, fresh_hits_mk = 0, 0, 0

    link_scores, link_labels, raw_r_scores = [], [], []
    conf_total, conf_rejected = 0, 0

    simplex_errs: List[float] = []
    false_tp = false_fp = false_fn = 0

    for g in val_graphs:
        out = model.forward_graph(g["node_features"], g["pair_features"])
        for v, n_out in enumerate(out["nodes"]):
            nt = g["node_targets"][v]
            y_on = float(nt["onset"])
            mk_z_val = float(g["node_features"][v][10]) * 4.0
            onset_scores.append(float(n_out["onsetProb"]))
            onset_labels.append(y_on)
            mk_scores.append(mk_z_val)

            if y_on >= 0.5 and mk_z_val < 1.96:
                fresh_total += 1
                if n_out["onsetProb"] >= 0.5:
                    fresh_hits_model += 1
                if mk_z_val >= 1.96:
                    fresh_hits_mk += 1

            de = n_out["dealiasing"]
            pred_sh = [de["secularShare"], de["oscillationShare"], de["artifactShare"]]
            simplex_errs.extend(abs(pred_sh[k] - nt["shares"][k]) for k in range(3))

            pred_f = de["falseTrendProb"] >= 0.5
            true_f = float(nt["false_trend"]) >= 0.5
            if pred_f and true_f:
                false_tp += 1
            elif pred_f and not true_f:
                false_fp += 1
            elif not pred_f and true_f:
                false_fn += 1

        for uv, p_out in out["pairs"].items():
            pt = g["pair_targets"][uv]
            xp = g["pair_features"][uv]
            raw_peak_abs = max(abs(xp[k]) for k in range(4))
            y_coup = float(pt["true_coupling"])
            link_scores.append(float(p_out["trueCouplingProb"]))
            link_labels.append(y_coup)
            raw_r_scores.append(raw_peak_abs)

            if float(pt["confounder"]) >= 0.5 and raw_peak_abs >= 0.50 and y_coup < 0.5:
                conf_total += 1
                if p_out["confounderProb"] >= 0.50 or p_out["trueCouplingProb"] < 0.50:
                    conf_rejected += 1

    f1 = (2.0 * false_tp) / max(1, 2 * false_tp + false_fp + false_fn)
    return {
        "val_graphs": len(val_graphs),
        "early_onset_auroc": round(_compute_roc_auc(onset_scores, onset_labels), 4),
        "classical_mk_auroc": round(_compute_roc_auc(mk_scores, onset_labels), 4),
        "pre_mk_recall_on_fresh_breaks": round(fresh_hits_model / max(1, fresh_total), 4),
        "classical_mk_recall_on_fresh_breaks": round(fresh_hits_mk / max(1, fresh_total), 4),
        "true_link_auroc": round(_compute_roc_auc(link_scores, link_labels), 4),
        "raw_pearson_auroc": round(_compute_roc_auc(raw_r_scores, link_labels), 4),
        "illusion_rejection_rate": round(conf_rejected / max(1, conf_total), 4),
        "dealias_simplex_mae": round(sum(simplex_errs) / max(1, len(simplex_errs)), 4),
        "false_trend_f1": round(f1, 4),
    }


def train_and_export_microscope(
    output_path: Union[str, Path],
    live_bundle: Optional[Dict[str, Any]] = None,
    seed: int = 42,
) -> Dict[str, Any]:
    corpus = build_microscope_training_corpus(live_bundle=live_bundle, num_synthetic_graphs=120, seed=seed)
    model = PortableTrendMicroscope(hidden_dim=32, seed=seed)
    train_info = model.fit_portable(corpus["train"], epochs=38, lr=0.045, seed=seed, batch_size=6)
    bench = evaluate_microscope_benchmarks(model, corpus["val"])
    model.training_summary = {"backend": "portable_adam", **train_info, "benchmarks": bench}
    weights = model.to_weights_dict()

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(weights, indent=2), encoding="utf-8")
    return {"model": model, "weights": weights, "benchmarks": bench, "path": str(out)}
