"""
Pure-Python math helpers and causal node/pair feature extractors for ETG Trend Microscope (`etg-trend-microscope-v1`).
1:1 parity with TypeScript feature extraction in `src/lib/graph/trendMicroscope.ts`.
"""

from __future__ import annotations

import math
from typing import List, Optional, Sequence, Tuple

WEIGHTS_SCHEMA_V1 = "etg-trend-microscope-v1"
NODE_FEATURE_DIM = 20
PAIR_FEATURE_DIM = 12

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
