"""
Earth Trend Detective — ETG Trend Microscope (`etg-trend-microscope-v1`)

Hyper-specific 3-in-1 AI sensory organ built to assist LLMs & Earth scientists
rather than replace generalist climate/LLM models:
  1. Early Pre-Mann-Kendall Inflection & Onset Radar (`inflection_head`)
  2. True Directional Lead-Lag & Dipole Link Scorer (`coupling_head`)
  3. Secular vs. Oscillation Cycle vs. Sensor-Drift De-Aliaser (`dealias_head`)

Zero external dependencies required for portable training/inference (Python 3.9+ stdlib),
with full PyTorch Blackwell (`bf16`) Transformer teacher + GPU knowledge distillation
into portable `etg-trend-microscope-v1` weights (1:1 parity with TypeScript).
"""

from __future__ import annotations

import argparse
import copy
import json
import math
from operator import mul
import random
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

WEIGHTS_SCHEMA_V1 = "etg-trend-microscope-v1"
NODE_FEATURE_DIM = 20
PAIR_FEATURE_DIM = 12

try:  # pragma: no cover - optional GPU/PyTorch dependency (present on Colab/L4)
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    TORCH_AVAILABLE = False


NODE_FEATURE_NAMES: List[str] = [
    "recent_slope_6",
    "prior_slope_prev",
    "slope_delta",
    "curvature_quad",
    "cusum_max_norm",
    "variance_ratio",
    "lag1_autocorr",
    "seasonal_power_share",
    "oscillation_power_share",
    "step_jump_max_ratio",
    "mk_z_window",
    "deseason_recent_slope_6",
    "lat_sin",
    "lat_cos",
    "lng_sin",
    "lng_cos",
    "trust_score",
    "is_community",
    "corroborated",
    "log_length_norm",
]

PAIR_FEATURE_NAMES: List[str] = [
    "raw_corr_lag0",
    "raw_corr_lag1",
    "raw_corr_lag2",
    "raw_corr_lag3",
    "clean_corr_lag0",
    "clean_corr_lag1",
    "clean_corr_lag2",
    "clean_corr_lag3",
    "forward_vs_reverse_asym",
    "best_clean_lag_norm",
    "distance_km_norm",
    "trust_pair_product",
]


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _sigmoid(x: float) -> float:
    if x >= 0.0:
        z = math.exp(-min(50.0, x))
        return 1.0 / (1.0 + z)
    z = math.exp(max(-50.0, x))
    return z / (1.0 + z)


def _softplus(x: float) -> float:
    if x > 25.0:
        return x
    if x < -25.0:
        return math.exp(x)
    return math.log1p(math.exp(x))


def _softmax(logits: Sequence[float]) -> List[float]:
    if not logits:
        return []
    m = max(logits)
    exps = [math.exp(max(-40.0, v - m)) for v in logits]
    s = sum(exps) or 1.0
    return [e / s for e in exps]


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return r * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def _pop_std(vals: Sequence[float]) -> float:
    n = len(vals)
    if n < 2:
        return 0.0
    mean = sum(vals) / n
    return math.sqrt(sum((v - mean) ** 2 for v in vals) / n)


def _ols_slope(vals: Sequence[float]) -> float:
    n = len(vals)
    if n < 2:
        return 0.0
    mk = (n - 1) * 0.5
    my = sum(vals) / n
    num = 0.0
    den = 0.0
    for k, v in enumerate(vals):
        dk = k - mk
        num += dk * (v - my)
        den += dk * dk
    return num / den if den > 1e-12 else 0.0


def _ols_line(vals: Sequence[float]) -> Tuple[float, float]:
    n = len(vals)
    if n < 2:
        return 0.0, vals[0] if vals else 0.0
    mk = (n - 1) * 0.5
    my = sum(vals) / n
    slope = _ols_slope(vals)
    return slope, my - slope * mk


def _solve_linear_system(a: List[List[float]], b: List[float]) -> List[float]:
    """Small Gaussian elimination with partial pivoting (for p <= 6)."""
    n = len(b)
    mat = [list(row) + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = col
        best = abs(mat[col][col])
        for r in range(col + 1, n):
            if abs(mat[r][col]) > best:
                best = abs(mat[r][col])
                piv = r
        mat[col], mat[piv] = mat[piv], mat[col]
        diag = mat[col][col]
        if abs(diag) < 1e-12:
            diag = 1e-12 if diag >= 0 else -1e-12
        for c in range(col, n + 1):
            mat[col][c] /= diag
        for r in range(n):
            if r == col:
                continue
            factor = mat[r][col]
            if abs(factor) < 1e-15:
                continue
            for c in range(col, n + 1):
                mat[r][c] -= factor * mat[col][c]
    return [mat[i][n] for i in range(n)]


def _fit_ridge_basis(design: List[List[float]], y: Sequence[float], ridge: float = 1e-5) -> List[float]:
    n = len(design)
    if n == 0:
        return []
    p = len(design[0])
    xtx = [[ridge if i == j else 0.0 for j in range(p)] for i in range(p)]
    xty = [0.0] * p
    for row, target in zip(design, y):
        for i in range(p):
            xty[i] += row[i] * target
            ri = row[i]
            for j in range(p):
                xtx[i][j] += ri * row[j]
    return _solve_linear_system(xtx, xty)


def _fit_harmonic_r2(vals: Sequence[float], period: float) -> Tuple[List[float], float]:
    """Fit `[1, sin(2*pi*k/P), cos(2*pi*k/P)]` via ridge-stabilized OLS; return (component, r2)."""
    n = len(vals)
    if n < 6 or period <= 1.0:
        return [0.0] * n, 0.0
    two_pi_p = 2.0 * math.pi / period
    design = [[1.0, math.sin(two_pi_p * k), math.cos(two_pi_p * k)] for k in range(n)]
    beta = _fit_ridge_basis(design, vals, ridge=1e-5)
    comp = [beta[1] * row[1] + beta[2] * row[2] for row in design]
    mean_v = sum(vals) / n
    ss_tot = sum((v - mean_v) ** 2 for v in vals)
    if ss_tot <= 1e-8:
        return comp, 0.0
    ss_res = sum((vals[k] - (beta[0] + comp[k])) ** 2 for k in range(n))
    r2 = _clamp(1.0 - ss_res / ss_tot, 0.0, 1.0)
    return comp, r2


def _mann_kendall_abs_z(vals: Sequence[float]) -> float:
    n = len(vals)
    if n < 4:
        return 0.0
    s = 0
    for i in range(n - 1):
        vi = vals[i]
        for j in range(i + 1, n):
            diff = vals[j] - vi
            if diff > 1e-12:
                s += 1
            elif diff < -1e-12:
                s -= 1
    if s == 0:
        return 0.0
    sorted_v = sorted(vals)
    tie_counts: List[int] = []
    run = 1
    for i in range(1, n):
        if abs(sorted_v[i] - sorted_v[i - 1]) <= 1e-12:
            run += 1
        else:
            if run > 1:
                tie_counts.append(run)
            run = 1
    if run > 1:
        tie_counts.append(run)
    tie_sum = sum(tp * (tp - 1) * (2 * tp + 5) for tp in tie_counts)
    var_s = max(1e-9, (n * (n - 1) * (2 * n + 5) - tie_sum) / 18.0)
    return (abs(s) - 1.0) / math.sqrt(var_s)


def _pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    n = len(xs)
    if n < 3 or len(ys) != n:
        return 0.0
    mx = sum(xs) / n
    my = sum(ys) / n
    num = 0.0
    dx = 0.0
    dy = 0.0
    for x, y in zip(xs, ys):
        ax = x - mx
        ay = y - my
        num += ax * ay
        dx += ax * ax
        dy += ay * ay
    den = math.sqrt(dx * dy)
    if den <= 1e-9:
        return 0.0
    return _clamp(num / den, -1.0, 1.0)


def _lag_corr(a: Sequence[float], b: Sequence[float], tau: int) -> float:
    """Correlation corr(a[0..M-1-tau], b[tau..M-1]), i.e., a leads b by `tau` steps."""
    m = len(a)
    if tau < 0 or m - tau < 4:
        return 0.0
    return _pearson(a[: m - tau], b[tau:])


def extract_node_microscope_features(
    values: Sequence[float],
    scale: str = "month",
    lat: float = 0.0,
    lng: float = 0.0,
    trust_score: float = 0.8,
    is_community: bool = False,
    corroborated: bool = False,
    full_len: Optional[int] = None,
) -> List[float]:
    """
    Exact 20-dim causal feature vector computed strictly on values ending at current time `t`
    (last W <= 24 steps). 1:1 parity with `extractNodeMicroscopeFeatures` in TypeScript.
    """
    clean = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    total_len = full_len if full_len is not None else len(clean)
    lat_r = math.radians(float(lat))
    lng_r = math.radians(float(lng))
    lat_sin = math.sin(lat_r)
    lat_cos = math.cos(lat_r)
    lng_sin = math.sin(lng_r)
    lng_cos = math.cos(lng_r)
    trust = _clamp(float(trust_score), 0.05, 1.0)
    is_comm_f = 1.0 if is_community else 0.0
    corr_f = 1.0 if corroborated else 0.0
    log_len = _clamp(math.log(max(2, total_len)) / math.log(120.0), 0.0, 1.0)

    if len(clean) < 2:
        return [0.0] * 12 + [lat_sin, lat_cos, lng_sin, lng_cos, trust, is_comm_f, corr_f, log_len]

    window = clean[-24:]
    L = len(window)
    half_n = min(L, max(3, L // 2))
    base = window[:half_n]
    mean = sum(base) / len(base)
    std = max(1e-4, _pop_std(base), 0.35 * _pop_std(window))
    z = [_clamp((v - mean) / std, -10.0, 10.0) for v in window]

    p_seas: Optional[float] = 12.0 if scale == "month" else 7.0 if scale == "day" else None
    if p_seas is not None and L >= 6:
        seas_comp, seas_r2 = _fit_harmonic_r2(z, p_seas)
        z_deseason = [z[k] - seas_comp[k] for k in range(L)]
    else:
        seas_r2 = 0.0
        z_deseason = list(z)

    osc_tail = clean[-48:]
    L_osc = len(osc_tail)
    if L_osc >= 10:
        m_tail = sum(osc_tail) / L_osc
        s_tail = max(1e-4, _pop_std(osc_tail))
        z_tail = [(v - m_tail) / s_tail for v in osc_tail]
        if p_seas is not None and L_osc >= 6:
            seas_t, _ = _fit_harmonic_r2(z_tail, p_seas)
            z_tail_des = [z_tail[k] - seas_t[k] for k in range(L_osc)]
        else:
            z_tail_des = z_tail
        sl_t, ic_t = _ols_line(z_tail_des)
        z_tail_resid = [z_tail_des[k] - (ic_t + sl_t * k) for k in range(L_osc)]
    else:
        z_tail_resid = []

    if scale == "month":
        osc_periods = (24.0, 30.0, 36.0, 42.0)
    elif scale == "day":
        osc_periods = (30.0, 60.0, 90.0)
    elif scale == "year":
        osc_periods = (4.0, 7.0, 11.0)
    else:
        osc_periods = ()

    osc_r2 = 0.0
    if len(z_tail_resid) >= 10 and osc_periods:
        for p_osc in osc_periods:
            _, r2 = _fit_harmonic_r2(z_tail_resid, p_osc)
            if r2 > osc_r2:
                osc_r2 = r2

    rec_start = max(0, L - 6)
    prior_end = min(L, max(3, L - 6))
    recent_slice = z[rec_start:]
    prior_slice = z[:prior_end]

    recent_slope_6 = _clamp(_ols_slope(recent_slice), -2.0, 2.0)
    prior_slope_prev = _clamp(_ols_slope(prior_slice), -2.0, 2.0)
    slope_delta = _clamp(recent_slope_6 - prior_slope_prev, -3.0, 3.0)

    if L >= 3:
        t1 = max(1, L // 3)
        t2 = min(L - 1, max(t1 + 1, (2 * L) // 3))
        m1 = sum(z[:t1]) / t1
        m2 = sum(z[t1:t2]) / max(1, t2 - t1)
        m3 = sum(z[t2:]) / max(1, L - t2)
        curvature_quad = _clamp(m3 - 2.0 * m2 + m1, -3.0, 3.0)
    else:
        curvature_quad = 0.0

    mz = sum(z) / L
    acc = 0.0
    max_cusum = 0.0
    for val in z:
        acc += val - mz
        if abs(acc) > max_cusum:
            max_cusum = abs(acc)
    cusum_max_norm = _clamp(max_cusum / math.sqrt(L), 0.0, 4.0)

    variance_ratio = _clamp(_pop_std(recent_slice) / max(0.05, _pop_std(prior_slice)) - 1.0, -1.0, 3.0)
    lag1_autocorr = _pearson(z[:-1], z[1:]) if L >= 4 else 0.0
    seasonal_power_share = _clamp(seas_r2, 0.0, 1.0)
    oscillation_power_share = _clamp(osc_r2, 0.0, 1.0)

    max_step = max((abs(z[k] - z[k - 1]) for k in range(1, L)), default=0.0)
    step_jump_max_ratio = _clamp((max_step / max(0.1, _pop_std(z))) / 4.0, 0.0, 2.0)
    mk_z_window = _clamp(_mann_kendall_abs_z(window) / 4.0, 0.0, 2.0)
    deseason_recent_slope_6 = _clamp(_ols_slope(z_deseason[rec_start:]), -2.0, 2.0)

    return [
        round(recent_slope_6, 6),
        round(prior_slope_prev, 6),
        round(slope_delta, 6),
        round(curvature_quad, 6),
        round(cusum_max_norm, 6),
        round(variance_ratio, 6),
        round(lag1_autocorr, 6),
        round(seasonal_power_share, 6),
        round(oscillation_power_share, 6),
        round(step_jump_max_ratio, 6),
        round(mk_z_window, 6),
        round(deseason_recent_slope_6, 6),
        round(lat_sin, 6),
        round(lat_cos, 6),
        round(lng_sin, 6),
        round(lng_cos, 6),
        round(trust, 6),
        is_comm_f,
        corr_f,
        round(log_len, 6),
    ]


def _strip_linear_and_season(vals: Sequence[float], scale: str) -> List[float]:
    n = len(vals)
    if n < 4:
        return list(vals)
    p = 12.0 if scale == "month" else 7.0 if scale == "day" else None
    if p is not None and n >= 6:
        two_pi_p = 2.0 * math.pi / p
        design = [
            [1.0, float(k) / max(1, n - 1), math.sin(two_pi_p * k), math.cos(two_pi_p * k)]
            for k in range(n)
        ]
    else:
        design = [[1.0, float(k) / max(1, n - 1)] for k in range(n)]
    beta = _fit_ridge_basis(design, vals, ridge=1e-5)
    return [vals[k] - sum(beta[d] * design[k][d] for d in range(len(beta))) for k in range(n)]


def extract_pair_microscope_features(
    u_values: Sequence[float],
    v_values: Sequence[float],
    u_lat: float = 0.0,
    u_lng: float = 0.0,
    v_lat: float = 0.0,
    v_lng: float = 0.0,
    u_trust: float = 0.8,
    v_trust: float = 0.8,
    scale: str = "month",
) -> List[float]:
    """
    Exact 12-dim directed pair feature vector for (u -> v) over aligned steps <= t (up to 36).
    1:1 parity with `extractPairMicroscopeFeatures` in TypeScript.
    """
    pairs = [
        (float(u), float(v))
        for u, v in zip(u_values, v_values)
        if u is not None and v is not None and math.isfinite(float(u)) and math.isfinite(float(v))
    ]
    dist_norm = min(1.0, _haversine_km(float(u_lat), float(u_lng), float(v_lat), float(v_lng)) / 20000.0)
    trust_prod = _clamp(float(u_trust) * float(v_trust), 0.01, 1.0)

    if len(pairs) < 6:
        return [0.0] * 10 + [round(dist_norm, 6), round(trust_prod, 6)]

    pairs = pairs[-36:]
    u_arr = [p[0] for p in pairs]
    v_arr = [p[1] for p in pairs]

    mu, su = sum(u_arr) / len(u_arr), max(1e-4, _pop_std(u_arr))
    mv, sv = sum(v_arr) / len(v_arr), max(1e-4, _pop_std(v_arr))
    zu = [_clamp((x - mu) / su, -6.0, 6.0) for x in u_arr]
    zv = [_clamp((x - mv) / sv, -6.0, 6.0) for x in v_arr]

    ru = _strip_linear_and_season(zu, scale)
    rv = _strip_linear_and_season(zv, scale)

    raw_corrs = [_lag_corr(zu, zv, tau) for tau in range(4)]
    clean_corrs = [_lag_corr(ru, rv, tau) for tau in range(4)]

    fwd_clean = [_lag_corr(ru, rv, tau) for tau in range(0, 6)]
    best_tau = 0
    best_abs = -1.0
    for tau, val in enumerate(fwd_clean):
        if abs(val) > best_abs + 1e-9:
            best_abs = abs(val)
            best_tau = tau

    fwd_pos = max((abs(_lag_corr(ru, rv, tau)) for tau in range(1, 6)), default=0.0)
    rev_pos = max((abs(_lag_corr(rv, ru, tau)) for tau in range(1, 6)), default=0.0)
    asym = _clamp(fwd_pos - rev_pos, -1.0, 1.0)

    return [round(c, 6) for c in raw_corrs] + [round(c, 6) for c in clean_corrs] + [
        round(asym, 6),
        round(best_tau / 5.0, 6),
        round(dist_norm, 6),
        round(trust_prod, 6),
    ]


def _matvec(mat: List[List[float]], bias: List[float], x: Sequence[float]) -> List[float]:
    return [sum(map(mul, row, x)) + b for row, b in zip(mat, bias)]


def _tanh_vec(xs: Sequence[float]) -> List[float]:
    return [math.tanh(_clamp(v, -20.0, 20.0)) for v in xs]


def _init_linear(out_dim: int, in_dim: int, rng: random.Random, scale: float = 0.25) -> Dict[str, Any]:
    s = scale / math.sqrt(max(1, in_dim))
    return {
        "weight": [[round(rng.gauss(0.0, s), 6) for _ in range(in_dim)] for _ in range(out_dim)],
        "bias": [0.0 for _ in range(out_dim)],
    }


def _classify_radar_badge(
    onset_prob: float,
    mk_z_norm: float,
    shares: Sequence[float],
    false_trend_prob: float,
) -> str:
    sec_share, cyc_share, art_share = shares[0], shares[1], shares[2]
    if false_trend_prob >= 0.52:
        return "SENSOR_GLITCH_RISK" if art_share >= cyc_share else "FALSE_TREND_CYCLE"
    if onset_prob >= 0.55:
        return "EARLY_ONSET" if mk_z_norm < 0.49 else "SECULAR_ACCELERATION"
    if sec_share >= 0.55 and mk_z_norm >= 0.45:
        return "SECULAR_ACCELERATION"
    return "NOMINAL"


class PortableTrendMicroscope:
    """
    Pure-Python portable 3-head perceptual Trend Microscope (`etg-trend-microscope-v1`).
    Matches the GPU-distilled `DistillablePortableMicroscope` and TypeScript engine 1:1.
    """

    def __init__(
        self,
        hidden_dim: int = 32,
        seed: int = 42,
        weights: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.hidden_dim = hidden_dim
        if weights is not None:
            self.load_weights_dict(weights)
        else:
            rng = random.Random(seed)
            self.trust_gate = {
                "w_trust": 4.0,
                "w_corroborated": 1.8,
                "w_community": -0.25,
                "bias": -2.55,
            }
            self.node_enc1 = _init_linear(hidden_dim, NODE_FEATURE_DIM, rng, 0.8)
            self.edge_enc1 = _init_linear(hidden_dim, hidden_dim * 2 + PAIR_FEATURE_DIM, rng, 0.8)
            self.edge_attn = _init_linear(1, hidden_dim, rng, 0.5)
            self.node_enc2 = _init_linear(hidden_dim, hidden_dim * 2, rng, 0.8)
            self.inflection_head = _init_linear(5, hidden_dim, rng, 0.5)
            self.dealias_head = _init_linear(4, hidden_dim, rng, 0.5)
            self.coupling_head = _init_linear(11, hidden_dim, rng, 0.5)
            self.training_summary: Dict[str, Any] = {}

    def clone(self) -> "PortableTrendMicroscope":
        return PortableTrendMicroscope.from_weights_dict(self.to_weights_dict())

    def compute_trust_gate(self, trust_score: float, corroborated: bool, is_community: bool = False) -> float:
        tg = self.trust_gate
        logit = (
            float(tg["w_trust"]) * float(trust_score)
            + float(tg["w_corroborated"]) * (1.0 if corroborated else 0.0)
            + float(tg["w_community"]) * (1.0 if is_community else 0.0)
            + float(tg["bias"])
        )
        return _sigmoid(logit)

    def load_weights_dict(self, data: Dict[str, Any]) -> None:
        self.hidden_dim = int(data.get("hidden_dim", 32))
        self.trust_gate = copy.deepcopy(data["trust_gate"])
        self.node_enc1 = copy.deepcopy(data["node_enc1"])
        self.edge_enc1 = copy.deepcopy(data["edge_enc1"])
        self.edge_attn = copy.deepcopy(data["edge_attn"])
        self.node_enc2 = copy.deepcopy(data["node_enc2"])
        self.inflection_head = copy.deepcopy(data["inflection_head"])
        self.dealias_head = copy.deepcopy(data["dealias_head"])
        self.coupling_head = copy.deepcopy(data["coupling_head"])
        self.training_summary = copy.deepcopy(data.get("training_summary", {}))

    @classmethod
    def from_weights_dict(cls, data: Dict[str, Any]) -> "PortableTrendMicroscope":
        if data.get("schema_version") != WEIGHTS_SCHEMA_V1:
            raise ValueError(f"Expected {WEIGHTS_SCHEMA_V1} weights, got {data.get('schema_version')}")
        return cls(hidden_dim=int(data.get("hidden_dim", 32)), weights=data)

    def to_weights_dict(self) -> Dict[str, Any]:
        def _round_layer(layer: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "weight": [[round(float(v), 6) for v in row] for row in layer["weight"]],
                "bias": [round(float(b), 6) for b in layer["bias"]],
            }

        return {
            "schema_version": WEIGHTS_SCHEMA_V1,
            "hidden_dim": self.hidden_dim,
            "node_feature_names": list(NODE_FEATURE_NAMES),
            "pair_feature_names": list(PAIR_FEATURE_NAMES),
            "trust_gate": {k: round(float(v), 6) for k, v in self.trust_gate.items()},
            "node_enc1": _round_layer(self.node_enc1),
            "edge_enc1": _round_layer(self.edge_enc1),
            "edge_attn": _round_layer(self.edge_attn),
            "node_enc2": _round_layer(self.node_enc2),
            "inflection_head": _round_layer(self.inflection_head),
            "dealias_head": _round_layer(self.dealias_head),
            "coupling_head": _round_layer(self.coupling_head),
            "training_summary": copy.deepcopy(self.training_summary),
        }

    def forward_graph(
        self,
        node_features: Sequence[Sequence[float]],
        pair_features: Dict[Tuple[int, int], Sequence[float]],
    ) -> Dict[str, Any]:
        """Exact deterministic forward pass matching DistillablePortableMicroscope & TypeScript."""
        n = len(node_features)
        h_dim = self.hidden_dim
        gates = [
            self.compute_trust_gate(
                trust_score=float(x[16]),
                corroborated=float(x[18]) >= 0.5,
                is_community=float(x[17]) >= 0.5,
            )
            for x in node_features
        ]
        h0 = [_tanh_vec(_matvec(self.node_enc1["weight"], self.node_enc1["bias"], x)) for x in node_features]

        ctx = [[0.0] * h_dim for _ in range(n)]
        denom = [1.0] * n
        edge_msgs: Dict[Tuple[int, int], List[float]] = {}
        edge_attns: Dict[Tuple[int, int], float] = {}

        for (u, v), xp in pair_features.items():
            if u == v:
                continue
            inp = h0[u] + h0[v] + list(xp)
            m_uv = _tanh_vec(_matvec(self.edge_enc1["weight"], self.edge_enc1["bias"], inp))
            a_raw = _matvec(self.edge_attn["weight"], self.edge_attn["bias"], m_uv)[0]
            rel_uv = _clamp((max(abs(float(xp[4 + k])) for k in range(4)) - 0.28) / 0.72, 0.0, 1.0)
            a_uv = gates[u] * rel_uv * _sigmoid(a_raw)
            edge_msgs[(u, v)] = m_uv
            edge_attns[(u, v)] = a_uv
            denom[v] += a_uv
            cv = ctx[v]
            for d in range(h_dim):
                cv[d] += a_uv * m_uv[d]

        for v in range(n):
            inv = 1.0 / denom[v]
            ctx[v] = [c * inv for c in ctx[v]]

        h_nodes = [
            _tanh_vec(_matvec(self.node_enc2["weight"], self.node_enc2["bias"], h0[v] + ctx[v]))
            for v in range(n)
        ]

        node_outputs: List[Dict[str, Any]] = []
        for v in range(n):
            inf_out = _matvec(self.inflection_head["weight"], self.inflection_head["bias"], h_nodes[v])
            dea_out = _matvec(self.dealias_head["weight"], self.dealias_head["bias"], h_nodes[v])
            onset_prob = _sigmoid(inf_out[0])
            dir_probs = _softmax(inf_out[1:4])
            lead_steps = _clamp(_softplus(inf_out[4]), 0.0, 12.0)
            shares = _softmax(dea_out[:3])
            false_prob = _sigmoid(dea_out[3])
            mk_norm = float(node_features[v][10])
            badge = _classify_radar_badge(onset_prob, mk_norm, shares, false_prob)
            node_outputs.append(
                {
                    "index": v,
                    "trustGate": round(gates[v], 4),
                    "onsetProb": round(onset_prob, 4),
                    "directionProbs": {
                        "decreasing": round(dir_probs[0], 4),
                        "steady": round(dir_probs[1], 4),
                        "increasing": round(dir_probs[2], 4),
                    },
                    "leadSteps": round(lead_steps, 2),
                    "dealiasing": {
                        "secularShare": round(shares[0], 4),
                        "oscillationShare": round(shares[1], 4),
                        "artifactShare": round(shares[2], 4),
                        "falseTrendProb": round(false_prob, 4),
                    },
                    "radarBadge": badge,
                    "raw_logits": {
                        "inflection": inf_out,
                        "dealias": dea_out,
                    },
                }
            )

        pair_outputs: Dict[Tuple[int, int], Dict[str, Any]] = {}
        for (u, v), m_uv in edge_msgs.items():
            c_out = _matvec(self.coupling_head["weight"], self.coupling_head["bias"], m_uv)
            true_prob = _sigmoid(c_out[0])
            pol_probs = _softmax(c_out[1:4])  # [opposite, none, co_trending]
            lag_probs = _softmax(c_out[4:10])  # lag 0..5
            conf_prob = _sigmoid(c_out[10])
            best_lag = max(range(6), key=lambda k: lag_probs[k])
            pol = (
                "drives_opposite"
                if pol_probs[0] >= pol_probs[1] and pol_probs[0] >= pol_probs[2]
                else "co_trending"
                if pol_probs[2] >= pol_probs[1]
                else "none"
            )
            pair_outputs[(u, v)] = {
                "src": u,
                "dst": v,
                "attentionWeight": round(edge_attns[(u, v)], 4),
                "trueCouplingProb": round(true_prob, 4),
                "polarity": pol,
                "polarityProbs": {
                    "drives_opposite": round(pol_probs[0], 4),
                    "none": round(pol_probs[1], 4),
                    "co_trending": round(pol_probs[2], 4),
                },
                "optimalLagSteps": best_lag,
                "lagProbs": [round(p, 4) for p in lag_probs],
                "confounderProb": round(conf_prob, 4),
                "raw_logits": c_out,
            }

        return {
            "nodes": node_outputs,
            "pairs": pair_outputs,
        }

    def scan_graph(
        self,
        nodes_meta: Sequence[Dict[str, Any]],
        nodes_series: Sequence[Sequence[float]],
        existing_edges: Optional[Sequence[Tuple[int, int]]] = None,
        focus_idx: Optional[int] = None,
        top_k: int = 8,
    ) -> Dict[str, Any]:
        """Run full 3-head Trend Microscope scan and emit structured AI cue cards."""
        n = len(nodes_meta)
        x_nodes = [
            extract_node_microscope_features(
                nodes_series[i],
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
                if focus_idx is not None and u != focus_idx and v != focus_idx and n > 12:
                    continue
                su, sv = nodes_series[u], nodes_series[v]
                m_len = min(len(su), len(sv))
                pair_scale = str(nodes_meta[v].get("temporal_scale", "month"))
                x_pairs[(u, v)] = extract_pair_microscope_features(
                    su[-m_len:] if m_len > 0 else [],
                    sv[-m_len:] if m_len > 0 else [],
                    u_lat=float(nodes_meta[u].get("lat", 0.0)),
                    u_lng=float(nodes_meta[u].get("lng", 0.0)),
                    v_lat=float(nodes_meta[v].get("lat", 0.0)),
                    v_lng=float(nodes_meta[v].get("lng", 0.0)),
                    u_trust=float(nodes_meta[u].get("trust_score", 0.8)),
                    v_trust=float(nodes_meta[v].get("trust_score", 0.8)),
                    scale=pair_scale,
                )

        raw_out = self.forward_graph(x_nodes, x_pairs)
        existing_set = set(existing_edges or [])

        node_cues: List[Dict[str, Any]] = []
        for idx, n_out in enumerate(raw_out["nodes"]):
            meta = nodes_meta[idx]
            x_n = x_nodes[idx]
            mk_z = round(x_n[10] * 4.0, 3)
            de = n_out["dealiasing"]
            dp = n_out["directionProbs"]
            best_dir = (
                "increasing"
                if dp["increasing"] >= dp["decreasing"] and dp["increasing"] >= dp["steady"]
                else "decreasing"
                if dp["decreasing"] >= dp["steady"]
                else "stable"
            )
            pre_mk = n_out["onsetProb"] >= 0.55 and mk_z < 1.96
            cue_str = (
                f"[{meta.get('name', meta.get('uuid', idx))}] badge={n_out['radarBadge']} | "
                f"onset={n_out['onsetProb']*100:.0f}% ({'PRE-MK' if pre_mk else f'MK |Z|={mk_z:.2f}'}) | "
                f"attrib: {de['secularShare']*100:.0f}% secular / {de['oscillationShare']*100:.0f}% cycle / "
                f"{de['artifactShare']*100:.0f}% noise (false_prob={de['falseTrendProb']*100:.0f}%)"
            )
            node_cues.append(
                {
                    "uuid": str(meta.get("uuid", f"node-{idx}")),
                    "name": str(meta.get("name", f"Node {idx}")),
                    "radarBadge": n_out["radarBadge"],
                    "onsetProb": n_out["onsetProb"],
                    "preMannKendallAlert": pre_mk,
                    "mkAbsZ": mk_z,
                    "emergingDirection": best_dir,
                    "leadStepsAhead": n_out["leadSteps"],
                    "dealiasing": de,
                    "trustGate": n_out["trustGate"],
                    "aiCue": cue_str,
                }
            )

        verified_links: List[Dict[str, Any]] = []
        illusions: List[Dict[str, Any]] = []
        for (u, v), p_out in raw_out["pairs"].items():
            if focus_idx is not None and u != focus_idx and v != focus_idx:
                continue
            mu, mv = nodes_meta[u], nodes_meta[v]
            xp = x_pairs[(u, v)]
            raw_peak = max((xp[k] for k in range(4)), key=lambda c: abs(c))
            clean_peak = max((xp[4 + k] for k in range(4)), key=lambda c: abs(c))
            item = {
                "sourceUuid": str(mu.get("uuid", f"node-{u}")),
                "targetUuid": str(mv.get("uuid", f"node-{v}")),
                "sourceName": str(mu.get("name", f"Node {u}")),
                "targetName": str(mv.get("name", f"Node {v}")),
                "alreadyWired": (u, v) in existing_set or (v, u) in existing_set,
                "trueCouplingProb": p_out["trueCouplingProb"],
                "confounderProb": p_out["confounderProb"],
                "polarity": p_out["polarity"],
                "optimalLagSteps": p_out["optimalLagSteps"],
                "rawPeakR": round(raw_peak, 3),
                "cleanPeakR": round(clean_peak, 3),
                "aiCue": (
                    f"{mu.get('name')} -> {mv.get('name')}: {p_out['polarity']} "
                    f"(P_true={p_out['trueCouplingProb']*100:.0f}%, lag={p_out['optimalLagSteps']}, "
                    f"P_illusion={p_out['confounderProb']*100:.0f}%, raw_r={raw_peak:+.2f}, clean_r={clean_peak:+.2f})"
                ),
            }
            if p_out["trueCouplingProb"] >= 0.55 and p_out["polarity"] != "none" and p_out["confounderProb"] < 0.55:
                verified_links.append(item)
            elif p_out["confounderProb"] >= 0.55 and abs(raw_peak) >= 0.45:
                illusions.append(item)

        verified_links.sort(key=lambda x: x["trueCouplingProb"], reverse=True)
        illusions.sort(key=lambda x: x["confounderProb"], reverse=True)

        onsets = sorted([c for c in node_cues if c["onsetProb"] >= 0.52], key=lambda x: x["onsetProb"], reverse=True)
        alerts = sorted(
            [c for c in node_cues if c["dealiasing"]["falseTrendProb"] >= 0.52],
            key=lambda x: x["dealiasing"]["falseTrendProb"],
            reverse=True,
        )

        brief_lines = [
            f"ETG Trend Microscope ({WEIGHTS_SCHEMA_V1}) — {n} nodes scanned:",
            "Emerging Onsets: " + (", ".join(c["aiCue"] for c in onsets[:3]) if onsets else "None flagged."),
            "Verified Lagged/Dipole Couplings: "
            + (", ".join(l["aiCue"] for l in verified_links[:3]) if verified_links else "None above gate."),
            "Suppressed Confounder Illusions: "
            + (", ".join(l["aiCue"] for l in illusions[:3]) if illusions else "None detected."),
            "Cycle / Sensor-Drift Alerts: " + (", ".join(c["aiCue"] for c in alerts[:3]) if alerts else "None."),
        ]

        return {
            "schemaVersion": WEIGHTS_SCHEMA_V1,
            "nodeCount": n,
            "nodes": node_cues,
            "verifiedCouplings": verified_links[:top_k],
            "suppressedIllusions": illusions[:top_k],
            "aiPerceptionBrief": "\n".join(brief_lines),
        }

    def scan_v2_bundle(
        self,
        bundle: Dict[str, Any],
        focus_uuid: Optional[str] = None,
        top_k: int = 8,
    ) -> Dict[str, Any]:
        """Convenience wrapper accepting an `etg-ml-v2` JSON bundle."""
        node_ids = bundle.get("node_ids", [])
        meta_list = bundle.get("node_metadata", [])
        feat_t = bundle.get("feature_tensor", [])
        mask_t = bundle.get("mask_tensor", [])
        n = len(node_ids)
        series_by_node: List[List[float]] = []
        for j in range(n):
            vals = [float(feat_t[t][j][0]) for t in range(len(feat_t)) if mask_t[t][j] == 1]
            series_by_node.append(vals)

        edge_index = bundle.get("edge_index", [[], []])
        existing_edges = list(zip(edge_index[0], edge_index[1])) if len(edge_index) == 2 else []
        focus_idx = node_ids.index(focus_uuid) if focus_uuid and focus_uuid in node_ids else None
        return self.scan_graph(
            meta_list,
            series_by_node,
            existing_edges=existing_edges,
            focus_idx=focus_idx,
            top_k=top_k,
        )

    def fit_portable(
        self,
        graphs: Sequence[Dict[str, Any]],
        epochs: int = 40,
        lr: float = 0.04,
        seed: int = 42,
        batch_size: int = 8,
    ) -> Dict[str, Any]:
        """
        Pure-Python analytical backpropagation + mini-batch Adam optimizer over `graphs`.
        Allows full calibration without PyTorch while keeping exact weight layout.
        """
        rng = random.Random(seed)
        h_dim = self.hidden_dim

        layers = [
            ("node_enc1", self.node_enc1),
            ("edge_enc1", self.edge_enc1),
            ("edge_attn", self.edge_attn),
            ("node_enc2", self.node_enc2),
            ("inflection_head", self.inflection_head),
            ("dealias_head", self.dealias_head),
            ("coupling_head", self.coupling_head),
        ]
        m_w = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
        v_w = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
        m_b = {k: [0.0] * len(layer["bias"]) for k, layer in layers}
        v_b = {k: [0.0] * len(layer["bias"]) for k, layer in layers}

        order = list(range(len(graphs)))
        loss_history: List[float] = []
        step_t = 0
        b1, b2, eps = 0.9, 0.999, 1e-8
        weight_decay = 1e-4

        for ep in range(epochs):
            rng.shuffle(order)
            total_loss = 0.0
            lr_t = lr * (0.5 ** (ep / max(1, epochs * 0.75)))
            for batch_start in range(0, len(order), batch_size):
                batch_ids = order[batch_start : batch_start + batch_size]
                gw = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
                gb = {k: [0.0] * len(layer["bias"]) for k, layer in layers}
                batch_scale = 1.0 / max(1, len(batch_ids))

                for g_idx in batch_ids:
                    g = graphs[g_idx]
                    x_nodes = g["node_features"]
                    x_pairs = g["pair_features"]
                    n = len(x_nodes)
                    if n == 0:
                        continue

                    gates = [
                        self.compute_trust_gate(
                            float(x[16]),
                            float(x[18]) >= 0.5,
                            float(x[17]) >= 0.5,
                        )
                        for x in x_nodes
                    ]
                    h0 = [_tanh_vec(_matvec(self.node_enc1["weight"], self.node_enc1["bias"], x)) for x in x_nodes]

                    ctx = [[0.0] * h_dim for _ in range(n)]
                    denom = [1.0] * n
                    edge_cache: List[Tuple[int, int, List[float], List[float], float, float, float]] = []
                    ew = self.edge_enc1["weight"]
                    eb = self.edge_enc1["bias"]
                    aw = self.edge_attn["weight"]
                    ab = self.edge_attn["bias"]
                    for (u, v), xp in x_pairs.items():
                        if u == v:
                            continue
                        inp = h0[u] + h0[v] + list(xp)
                        m_uv = _tanh_vec(_matvec(ew, eb, inp))
                        a_raw = _matvec(aw, ab, m_uv)[0]
                        sig_a = _sigmoid(a_raw)
                        rel_uv = _clamp((max(abs(float(xp[4 + k])) for k in range(4)) - 0.28) / 0.72, 0.0, 1.0)
                        a_uv = gates[u] * rel_uv * sig_a
                        denom[v] += a_uv
                        cv = ctx[v]
                        for d in range(h_dim):
                            cv[d] += a_uv * m_uv[d]
                        edge_cache.append((u, v, inp, m_uv, sig_a, a_uv, rel_uv))

                    for v in range(n):
                        inv = 1.0 / denom[v]
                        ctx[v] = [c * inv for c in ctx[v]]

                    h2_inp = [h0[v] + ctx[v] for v in range(n)]
                    n2w = self.node_enc2["weight"]
                    n2b = self.node_enc2["bias"]
                    h_nodes = [_tanh_vec(_matvec(n2w, n2b, h2_inp[v])) for v in range(n)]

                    d_h0 = [[0.0] * h_dim for _ in range(n)]
                    d_ctx = [[0.0] * h_dim for _ in range(n)]
                    inv_n = batch_scale / max(1, n)
                    iw = self.inflection_head["weight"]
                    ib = self.inflection_head["bias"]
                    dw = self.dealias_head["weight"]
                    db = self.dealias_head["bias"]

                    for v in range(n):
                        hv = h_nodes[v]
                        inf_out = _matvec(iw, ib, hv)
                        dea_out = _matvec(dw, db, hv)

                        tgt_onset = float(g["node_targets"][v]["onset"])
                        tgt_dir = int(g["node_targets"][v]["direction"])
                        tgt_lead = float(g["node_targets"][v]["lead_steps"])
                        tgt_shares = g["node_targets"][v]["shares"]
                        tgt_false = float(g["node_targets"][v]["false_trend"])

                        p_on = _sigmoid(inf_out[0])
                        p_dir = _softmax(inf_out[1:4])
                        lead_pred = _softplus(inf_out[4])
                        sig_lead = _sigmoid(inf_out[4])
                        p_sh = _softmax(dea_out[:3])
                        p_false = _sigmoid(dea_out[3])

                        l_on = -(tgt_onset * math.log(max(1e-7, p_on)) + (1.0 - tgt_onset) * math.log(max(1e-7, 1.0 - p_on)))
                        l_dir = -math.log(max(1e-7, p_dir[tgt_dir]))
                        l_lead = 0.08 * (lead_pred - tgt_lead) ** 2 if tgt_onset > 0.5 else 0.0
                        l_sh = -sum(tgt_shares[k] * math.log(max(1e-7, p_sh[k])) for k in range(3))
                        l_fl = -(tgt_false * math.log(max(1e-7, p_false)) + (1.0 - tgt_false) * math.log(max(1e-7, 1.0 - p_false)))
                        total_loss += (1.2 * l_on + 0.7 * l_dir + l_lead + 1.2 * l_sh + 1.1 * l_fl) / max(1, n)

                        d_inf = [
                            1.2 * (p_on - tgt_onset) * inv_n,
                            0.7 * (p_dir[0] - (1.0 if tgt_dir == 0 else 0.0)) * inv_n,
                            0.7 * (p_dir[1] - (1.0 if tgt_dir == 1 else 0.0)) * inv_n,
                            0.7 * (p_dir[2] - (1.0 if tgt_dir == 2 else 0.0)) * inv_n,
                            (0.16 * (lead_pred - tgt_lead) * sig_lead if tgt_onset > 0.5 else 0.0) * inv_n,
                        ]
                        d_dea = [
                            1.2 * (p_sh[0] - tgt_shares[0]) * inv_n,
                            1.2 * (p_sh[1] - tgt_shares[1]) * inv_n,
                            1.2 * (p_sh[2] - tgt_shares[2]) * inv_n,
                            1.1 * (p_false - tgt_false) * inv_n,
                        ]

                        d_hv = [0.0] * h_dim
                        for o in range(5):
                            do = d_inf[o]
                            gb["inflection_head"][o] += do
                            row = iw[o]
                            gw_row = gw["inflection_head"][o]
                            for d in range(h_dim):
                                gw_row[d] += do * hv[d]
                                d_hv[d] += do * row[d]

                        for o in range(4):
                            do = d_dea[o]
                            gb["dealias_head"][o] += do
                            row = dw[o]
                            gw_row = gw["dealias_head"][o]
                            for d in range(h_dim):
                                gw_row[d] += do * hv[d]
                                d_hv[d] += do * row[d]

                        inp2 = h2_inp[v]
                        dh0v = d_h0[v]
                        dctxv = d_ctx[v]
                        for o in range(h_dim):
                            dz = d_hv[o] * (1.0 - hv[o] * hv[o])
                            gb["node_enc2"][o] += dz
                            row = n2w[o]
                            gw_row = gw["node_enc2"][o]
                            for d in range(h_dim):
                                gw_row[d] += dz * inp2[d]
                                gw_row[h_dim + d] += dz * inp2[h_dim + d]
                                dh0v[d] += dz * row[d]
                                dctxv[d] += dz * row[h_dim + d]

                    inv_e = batch_scale / max(1, len(edge_cache))
                    pair_targets = g["pair_targets"]
                    cw = self.coupling_head["weight"]
                    cb = self.coupling_head["bias"]
                    gcw = gw["coupling_head"]
                    gcb = gb["coupling_head"]
                    gew = gw["edge_enc1"]
                    geb = gb["edge_enc1"]
                    gaw = gw["edge_attn"][0]
                    aw0 = aw[0]

                    for u, v, inp_e, m_uv, sig_a, a_uv, rel_uv in edge_cache:
                        d_m = [0.0] * h_dim
                        inv_den = 1.0 / denom[v]
                        da_uv = 0.0
                        cv = ctx[v]
                        d_cv = d_ctx[v]
                        scale_m = a_uv * inv_den
                        for d in range(h_dim):
                            dcv_d = d_cv[d]
                            d_m[d] += dcv_d * scale_m
                            da_uv += dcv_d * (m_uv[d] - cv[d]) * inv_den
                        da_raw = da_uv * gates[u] * rel_uv * sig_a * (1.0 - sig_a)
                        gb["edge_attn"][0] += da_raw
                        for d in range(h_dim):
                            gaw[d] += da_raw * m_uv[d]
                            d_m[d] += da_raw * aw0[d]

                        pt = pair_targets.get((u, v))
                        if pt is not None:
                            c_out = _matvec(cw, cb, m_uv)
                            p_coup = _sigmoid(c_out[0])
                            p_pol = _softmax(c_out[1:4])
                            p_lag = _softmax(c_out[4:10])
                            p_conf = _sigmoid(c_out[10])

                            t_coup = float(pt["true_coupling"])
                            t_pol = int(pt["polarity"])
                            t_lag = int(pt["lag"])
                            t_conf = float(pt["confounder"])

                            l_c = -(t_coup * math.log(max(1e-7, p_coup)) + (1.0 - t_coup) * math.log(max(1e-7, 1.0 - p_coup)))
                            l_p = -math.log(max(1e-7, p_pol[t_pol]))
                            l_l = -math.log(max(1e-7, p_lag[t_lag])) if t_coup > 0.5 else 0.0
                            l_cf = -(t_conf * math.log(max(1e-7, p_conf)) + (1.0 - t_conf) * math.log(max(1e-7, 1.0 - p_conf)))
                            total_loss += (1.3 * l_c + 0.9 * l_p + 0.6 * l_l + 1.2 * l_cf) / max(1, len(edge_cache))

                            d_c = [
                                1.3 * (p_coup - t_coup) * inv_e,
                                0.9 * (p_pol[0] - (1.0 if t_pol == 0 else 0.0)) * inv_e,
                                0.9 * (p_pol[1] - (1.0 if t_pol == 1 else 0.0)) * inv_e,
                                0.9 * (p_pol[2] - (1.0 if t_pol == 2 else 0.0)) * inv_e,
                            ] + [
                                (0.6 * (p_lag[k] - (1.0 if t_lag == k else 0.0)) if t_coup > 0.5 else 0.0) * inv_e
                                for k in range(6)
                            ] + [1.2 * (p_conf - t_conf) * inv_e]

                            for o in range(11):
                                do = d_c[o]
                                gcb[o] += do
                                row = cw[o]
                                gw_row = gcw[o]
                                for d in range(h_dim):
                                    gw_row[d] += do * m_uv[d]
                                    d_m[d] += do * row[d]

                        dh0u = d_h0[u]
                        dh0v = d_h0[v]
                        len_inp = len(inp_e)
                        for o in range(h_dim):
                            mv_o = m_uv[o]
                            dz = d_m[o] * (1.0 - mv_o * mv_o)
                            geb[o] += dz
                            row = ew[o]
                            gw_row = gew[o]
                            for d in range(len_inp):
                                gw_row[d] += dz * inp_e[d]
                            for d in range(h_dim):
                                dh0u[d] += dz * row[d]
                                dh0v[d] += dz * row[h_dim + d]

                    n1b = gb["node_enc1"]
                    n1gw = gw["node_enc1"]
                    for v in range(n):
                        hv0 = h0[v]
                        xv = x_nodes[v]
                        dh0v = d_h0[v]
                        for o in range(h_dim):
                            dz = dh0v[o] * (1.0 - hv0[o] * hv0[o])
                            n1b[o] += dz
                            gw_row = n1gw[o]
                            for d in range(NODE_FEATURE_DIM):
                                gw_row[d] += dz * xv[d]

                # Mini-batch Adam update
                step_t += 1
                corr1 = 1.0 - b1 ** step_t
                corr2 = 1.0 - b2 ** step_t
                for name, layer in layers:
                    w_mat = layer["weight"]
                    b_vec = layer["bias"]
                    g_mat = gw[name]
                    gb_vec = gb[name]
                    mw_mat, vw_mat = m_w[name], v_w[name]
                    mb_vec, vb_vec = m_b[name], v_b[name]
                    for o in range(len(b_vec)):
                        gbo = _clamp(gb_vec[o], -5.0, 5.0)
                        mb_vec[o] = b1 * mb_vec[o] + (1.0 - b1) * gbo
                        vb_vec[o] = b2 * vb_vec[o] + (1.0 - b2) * gbo * gbo
                        b_vec[o] -= lr_t * (mb_vec[o] / corr1) / (math.sqrt(vb_vec[o] / corr2) + eps)
                        w_row = w_mat[o]
                        g_row = g_mat[o]
                        mw_row, vw_row = mw_mat[o], vw_mat[o]
                        for d in range(len(w_row)):
                            gwd = _clamp(g_row[d] + weight_decay * w_row[d], -5.0, 5.0)
                            mw_row[d] = b1 * mw_row[d] + (1.0 - b1) * gwd
                            vw_row[d] = b2 * vw_row[d] + (1.0 - b2) * gwd * gwd
                            w_row[d] -= lr_t * (mw_row[d] / corr1) / (math.sqrt(vw_row[d] / corr2) + eps)

            loss_history.append(round(total_loss / max(1, len(graphs)), 4))

        return {"loss_history": loss_history, "epochs": epochs}


# ---------------------------------------------------------------------------
# Mechanistic Multi-Regime + Confounder + Live Hindsight Corpus Generator
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# PyTorch Blackwell (`bf16`) Teacher + GPU Knowledge Distillation
# ---------------------------------------------------------------------------

if TORCH_AVAILABLE:  # pragma: no cover - optional Colab / GPU path

    class PyTorchTrendMicroscope(nn.Module):  # type: ignore[misc]
        """Deep Transformer teacher with cross-node & bilinear pair attention for Blackwell GPU."""

        def __init__(self, d_model: int = 128, nhead: int = 4, num_layers: int = 2) -> None:
            super().__init__()
            self.d_model = d_model
            self.node_in = nn.Sequential(
                nn.Linear(NODE_FEATURE_DIM, d_model),
                nn.GELU(),
                nn.LayerNorm(d_model),
            )
            enc_layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=nhead,
                dim_feedforward=d_model * 2,
                dropout=0.1,
                batch_first=True,
                activation="gelu",
            )
            self.graph_tx = nn.TransformerEncoder(enc_layer, num_layers=num_layers)
            self.pair_mlp = nn.Sequential(
                nn.Linear(d_model * 2 + PAIR_FEATURE_DIM, d_model),
                nn.GELU(),
                nn.Linear(d_model, d_model),
                nn.GELU(),
            )
            self.inflection_head = nn.Linear(d_model, 5)
            self.dealias_head = nn.Linear(d_model, 4)
            self.coupling_head = nn.Linear(d_model, 11)

        def forward(
            self,
            x_nodes: "torch.Tensor",
            pair_src: "torch.Tensor",
            pair_dst: "torch.Tensor",
            x_pairs: "torch.Tensor",
        ) -> Dict[str, "torch.Tensor"]:
            h0 = self.node_in(x_nodes).unsqueeze(0)
            h_tx = self.graph_tx(h0).squeeze(0)
            pair_in = torch.cat([h_tx[pair_src], h_tx[pair_dst], x_pairs], dim=-1)
            m_pair = self.pair_mlp(pair_in)
            return {
                "inflection": self.inflection_head(h_tx),
                "dealias": self.dealias_head(h_tx),
                "coupling": self.coupling_head(m_pair),
            }

    class DistillablePortableMicroscope(nn.Module):  # type: ignore[misc]
        """PyTorch mirror of `PortableTrendMicroscope` for GPU knowledge distillation."""

        def __init__(self, hidden_dim: int = 32) -> None:
            super().__init__()
            self.hidden_dim = hidden_dim
            self.w_trust = nn.Parameter(torch.tensor(4.0))
            self.w_corroborated = nn.Parameter(torch.tensor(1.8))
            self.w_community = nn.Parameter(torch.tensor(-0.25))
            self.gate_bias = nn.Parameter(torch.tensor(-2.55))

            self.node_enc1 = nn.Linear(NODE_FEATURE_DIM, hidden_dim)
            self.edge_enc1 = nn.Linear(hidden_dim * 2 + PAIR_FEATURE_DIM, hidden_dim)
            self.edge_attn = nn.Linear(hidden_dim, 1)
            self.node_enc2 = nn.Linear(hidden_dim * 2, hidden_dim)
            self.inflection_head = nn.Linear(hidden_dim, 5)
            self.dealias_head = nn.Linear(hidden_dim, 4)
            self.coupling_head = nn.Linear(hidden_dim, 11)

        def forward(
            self,
            x_nodes: "torch.Tensor",
            pair_src: "torch.Tensor",
            pair_dst: "torch.Tensor",
            x_pairs: "torch.Tensor",
        ) -> Dict[str, "torch.Tensor"]:
            n = x_nodes.shape[0]
            gate_logits = (
                self.w_trust.clamp(3.8, 4.2) * x_nodes[:, 16]
                + self.w_corroborated.clamp(1.7, 2.1) * x_nodes[:, 18]
                + self.w_community.clamp(-0.35, -0.25) * x_nodes[:, 17]
                + self.gate_bias.clamp(-2.70, -2.55)
            )
            gates = torch.sigmoid(gate_logits)
            h0 = torch.tanh(self.node_enc1(x_nodes))

            pair_in = torch.cat([h0[pair_src], h0[pair_dst], x_pairs], dim=-1)
            m_pair = torch.tanh(self.edge_enc1(pair_in))
            clean_peak = x_pairs[:, 4:8].abs().amax(dim=-1)
            rel_pair = ((clean_peak - 0.28) / 0.72).clamp(0.0, 1.0)
            a_pair = gates[pair_src] * rel_pair * torch.sigmoid(self.edge_attn(m_pair).squeeze(-1))

            weighted_msg = a_pair.float().unsqueeze(-1) * m_pair.float()
            ctx_acc = torch.zeros((n, h0.shape[-1]), device=h0.device, dtype=torch.float32)
            ctx_acc.index_add_(0, pair_dst, weighted_msg)
            denom = torch.ones((n, 1), device=h0.device, dtype=torch.float32)
            denom.index_add_(0, pair_dst, a_pair.float().unsqueeze(-1))
            ctx = (ctx_acc / denom).to(h0.dtype)

            h_nodes = torch.tanh(self.node_enc2(torch.cat([h0, ctx], dim=-1)))
            return {
                "inflection": self.inflection_head(h_nodes),
                "dealias": self.dealias_head(h_nodes),
                "coupling": self.coupling_head(m_pair),
            }

        def to_portable(self, summary: Optional[Dict[str, Any]] = None) -> PortableTrendMicroscope:
            def _extract(lin: nn.Linear) -> Dict[str, Any]:
                return {
                    "weight": lin.weight.detach().cpu().tolist(),
                    "bias": lin.bias.detach().cpu().tolist(),
                }

            payload = {
                "schema_version": WEIGHTS_SCHEMA_V1,
                "hidden_dim": self.hidden_dim,
                "node_feature_names": list(NODE_FEATURE_NAMES),
                "pair_feature_names": list(PAIR_FEATURE_NAMES),
                "trust_gate": {
                    "w_trust": float(_clamp(self.w_trust.detach().cpu().item(), 3.8, 4.2)),
                    "w_corroborated": float(_clamp(self.w_corroborated.detach().cpu().item(), 1.7, 2.1)),
                    "w_community": float(_clamp(self.w_community.detach().cpu().item(), -0.35, -0.25)),
                    "bias": float(_clamp(self.gate_bias.detach().cpu().item(), -2.70, -2.55)),
                },
                "node_enc1": _extract(self.node_enc1),
                "edge_enc1": _extract(self.edge_enc1),
                "edge_attn": _extract(self.edge_attn),
                "node_enc2": _extract(self.node_enc2),
                "inflection_head": _extract(self.inflection_head),
                "dealias_head": _extract(self.dealias_head),
                "coupling_head": _extract(self.coupling_head),
                "training_summary": summary or {},
            }
            return PortableTrendMicroscope.from_weights_dict(payload)

    def _pack_graph_torch(g: Dict[str, Any], dev: "torch.device") -> Dict[str, Any]:
        x_nodes = torch.tensor(g["node_features"], dtype=torch.float32, device=dev)
        pairs_sorted = sorted(g["pair_features"].keys())
        p_src = torch.tensor([uv[0] for uv in pairs_sorted], dtype=torch.long, device=dev)
        p_dst = torch.tensor([uv[1] for uv in pairs_sorted], dtype=torch.long, device=dev)
        x_pairs = torch.tensor([g["pair_features"][uv] for uv in pairs_sorted], dtype=torch.float32, device=dev)

        nt = g["node_targets"]
        t_onset = torch.tensor([float(x["onset"]) for x in nt], dtype=torch.float32, device=dev)
        t_dir = torch.tensor([int(x["direction"]) for x in nt], dtype=torch.long, device=dev)
        t_lead = torch.tensor([float(x["lead_steps"]) for x in nt], dtype=torch.float32, device=dev)
        t_shares = torch.tensor([x["shares"] for x in nt], dtype=torch.float32, device=dev)
        t_false = torch.tensor([float(x["false_trend"]) for x in nt], dtype=torch.float32, device=dev)

        pt = g["pair_targets"]
        t_coup = torch.tensor([float(pt[uv]["true_coupling"]) for uv in pairs_sorted], dtype=torch.float32, device=dev)
        t_pol = torch.tensor([int(pt[uv]["polarity"]) for uv in pairs_sorted], dtype=torch.long, device=dev)
        t_lag = torch.tensor([int(pt[uv]["lag"]) for uv in pairs_sorted], dtype=torch.long, device=dev)
        t_conf = torch.tensor([float(pt[uv]["confounder"]) for uv in pairs_sorted], dtype=torch.float32, device=dev)
        return {
            "x_nodes": x_nodes,
            "pair_src": p_src,
            "pair_dst": p_dst,
            "x_pairs": x_pairs,
            "t_onset": t_onset,
            "t_dir": t_dir,
            "t_lead": t_lead,
            "t_shares": t_shares,
            "t_false": t_false,
            "t_coup": t_coup,
            "t_pol": t_pol,
            "t_lag": t_lag,
            "t_conf": t_conf,
        }

    def _compute_multitask_loss(
        out: Dict[str, "torch.Tensor"],
        batch: Dict[str, Any],
        teacher_out: Optional[Dict[str, "torch.Tensor"]] = None,
    ) -> "torch.Tensor":
        inf_o = out["inflection"].float()
        dea_o = out["dealias"].float()
        cou_o = out["coupling"].float()

        l_on = F.binary_cross_entropy_with_logits(inf_o[:, 0], batch["t_onset"])
        l_dir = F.cross_entropy(inf_o[:, 1:4], batch["t_dir"])
        lead_pred = F.softplus(inf_o[:, 4]).reshape(-1)
        on_mask = batch["t_onset"] > 0.5
        l_lead = F.smooth_l1_loss(lead_pred[on_mask], batch["t_lead"][on_mask]) if on_mask.any() else inf_o.sum() * 0.0

        log_sh = F.log_softmax(dea_o[:, :3], dim=-1)
        l_sh = -(batch["t_shares"] * log_sh).sum(dim=-1).mean()
        l_fl = F.binary_cross_entropy_with_logits(dea_o[:, 3], batch["t_false"])

        l_coup = F.binary_cross_entropy_with_logits(cou_o[:, 0], batch["t_coup"])
        l_pol = F.cross_entropy(cou_o[:, 1:4], batch["t_pol"])
        c_mask = batch["t_coup"] > 0.5
        l_lag = F.cross_entropy(cou_o[c_mask, 4:10], batch["t_lag"][c_mask]) if c_mask.any() else cou_o.sum() * 0.0
        l_conf = F.binary_cross_entropy_with_logits(cou_o[:, 10], batch["t_conf"])

        gt_loss = 1.2 * l_on + 0.7 * l_dir + 0.1 * l_lead + 1.2 * l_sh + 1.1 * l_fl + 1.3 * l_coup + 0.9 * l_pol + 0.6 * l_lag + 1.2 * l_conf
        if teacher_out is None:
            return gt_loss

        with torch.no_grad():
            t_inf = teacher_out["inflection"].float()
            t_dea = teacher_out["dealias"].float()
            t_cou = teacher_out["coupling"].float()

        kd_on = F.binary_cross_entropy_with_logits(inf_o[:, 0], torch.sigmoid(t_inf[:, 0]))
        kd_dir = F.kl_div(F.log_softmax(inf_o[:, 1:4], dim=-1), F.softmax(t_inf[:, 1:4], dim=-1), reduction="batchmean")
        kd_sh = F.kl_div(F.log_softmax(dea_o[:, :3], dim=-1), F.softmax(t_dea[:, :3], dim=-1), reduction="batchmean")
        kd_fl = F.binary_cross_entropy_with_logits(dea_o[:, 3], torch.sigmoid(t_dea[:, 3]))
        kd_c = F.binary_cross_entropy_with_logits(cou_o[:, 0], torch.sigmoid(t_cou[:, 0]))
        kd_p = F.kl_div(F.log_softmax(cou_o[:, 1:4], dim=-1), F.softmax(t_cou[:, 1:4], dim=-1), reduction="batchmean")
        kd_cf = F.binary_cross_entropy_with_logits(cou_o[:, 10], torch.sigmoid(t_cou[:, 10]))
        kd_loss = kd_on + kd_dir + kd_sh + kd_fl + kd_c + kd_p + kd_cf
        return 0.6 * gt_loss + 0.4 * kd_loss

    def train_blackwell_microscope_and_distill(
        corpus: Dict[str, List[Dict[str, Any]]],
        teacher_epochs: int = 45,
        distill_epochs: int = 55,
        d_model: int = 128,
        lr: float = 1.8e-3,
        compile_model: bool = True,
        device_str: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Train Transformer teacher on CUDA/bf16 and distill into PortableTrendMicroscope."""
        if device_str is None:
            dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            dev = torch.device(device_str)
        use_bf16 = dev.type == "cuda" and torch.cuda.is_bf16_supported()
        amp_dtype = torch.bfloat16 if use_bf16 else torch.float32

        packed_train = [_pack_graph_torch(g, dev) for g in corpus["train"]]
        teacher = PyTorchTrendMicroscope(d_model=d_model, nhead=4, num_layers=2).to(dev)
        active_teacher: Any = teacher
        if compile_model and dev.type == "cuda" and hasattr(torch, "compile"):
            try:
                active_teacher = torch.compile(teacher)
            except Exception:
                active_teacher = teacher

        opt_t = torch.optim.AdamW(teacher.parameters(), lr=lr, weight_decay=2e-4)
        sched_t = torch.optim.lr_scheduler.CosineAnnealingLR(opt_t, T_max=max(1, teacher_epochs))
        teacher_losses: List[float] = []

        rng = random.Random(42)
        for ep in range(teacher_epochs):
            rng.shuffle(packed_train)
            teacher.train()
            ep_loss = 0.0
            for b in packed_train:
                opt_t.zero_grad(set_to_none=True)
                try:
                    with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                        out = active_teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                        loss = _compute_multitask_loss(out, b)
                except Exception:
                    active_teacher = teacher
                    with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                        out = active_teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                        loss = _compute_multitask_loss(out, b)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(teacher.parameters(), 2.0)
                opt_t.step()
                ep_loss += float(loss.detach().cpu().item())
            sched_t.step()
            teacher_losses.append(round(ep_loss / max(1, len(packed_train)), 4))

        teacher.eval()
        student = DistillablePortableMicroscope(hidden_dim=32).to(dev)
        opt_s = torch.optim.AdamW(student.parameters(), lr=lr * 1.4, weight_decay=1e-4)
        sched_s = torch.optim.lr_scheduler.CosineAnnealingLR(opt_s, T_max=max(1, distill_epochs))
        distill_losses: List[float] = []

        for ep in range(distill_epochs):
            rng.shuffle(packed_train)
            student.train()
            ep_loss = 0.0
            for b in packed_train:
                opt_s.zero_grad(set_to_none=True)
                with torch.no_grad():
                    t_out = teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                    s_out = student(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                    loss = _compute_multitask_loss(s_out, b, teacher_out=t_out)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(student.parameters(), 2.0)
                opt_s.step()
                ep_loss += float(loss.detach().cpu().item())
            sched_s.step()
            distill_losses.append(round(ep_loss / max(1, len(packed_train)), 4))

        student.eval()
        portable = student.to_portable({"device": str(dev), "bf16": use_bf16, "distilled_from_d_model": d_model})
        bench = evaluate_microscope_benchmarks(portable, corpus["val"])
        portable.training_summary["benchmarks"] = bench
        return {
            "teacher": teacher,
            "student": student,
            "portable_model": portable,
            "portable_weights": portable.to_weights_dict(),
            "device": str(dev),
            "bf16": use_bf16,
            "teacher_loss_history": teacher_losses,
            "distill_loss_history": distill_losses,
            "benchmarks": bench,
        }

    def export_microscope_onnx(
        model: "nn.Module",
        sample_graph: Dict[str, Any],
        out_path: Union[str, Path],
    ) -> Path:
        target = Path(out_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        cpu_model = copy.deepcopy(model).cpu().eval()
        packed = _pack_graph_torch(sample_graph, torch.device("cpu"))
        args = (packed["x_nodes"], packed["pair_src"], packed["pair_dst"], packed["x_pairs"])
        export_kwargs: Dict[str, Any] = {
            "input_names": ["x_nodes", "pair_src", "pair_dst", "x_pairs"],
            "output_names": ["inflection", "dealias", "coupling"],
            "dynamic_axes": {
                "x_nodes": {0: "num_nodes"},
                "pair_src": {0: "num_edges"},
                "pair_dst": {0: "num_edges"},
                "x_pairs": {0: "num_edges"},
            },
            "opset_version": 17,
        }
        try:
            torch.onnx.export(cpu_model, args, str(target), dynamo=False, **export_kwargs)
        except TypeError:
            torch.onnx.export(cpu_model, args, str(target), **export_kwargs)
        return target


# ---------------------------------------------------------------------------
# Holdout Benchmarks (vs. Classical Mann-Kendall & Raw Pearson Baselines)
# ---------------------------------------------------------------------------


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


if __name__ == "__main__":  # pragma: no cover
    parser = argparse.ArgumentParser(description="Train & export ETG Trend Microscope v1 weights.")
    parser.add_argument(
        "--train-export",
        default=".data/etg-trend-microscope-v1.json",
        help="Destination path for exported etg-trend-microscope-v1 JSON weights.",
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    res = train_and_export_microscope(args.train_export, seed=args.seed)
    print(f"Exported {WEIGHTS_SCHEMA_V1} -> {res['path']}")
    print("Holdout Benchmarks:", json.dumps(res["benchmarks"], indent=2))
