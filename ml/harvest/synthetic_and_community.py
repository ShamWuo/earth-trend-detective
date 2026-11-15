"""Deterministic synthetic 8-node global multi-scale Earth Trend Graph builder and community node injector."""

from __future__ import annotations

import copy
import math
import random
from typing import Any, Dict, List, Optional, Tuple

from .bundle_builder import (
    _assemble_v2_bundle,
    _build_node_static_vec,
    _causal_corr_and_lag,
    _month_keys,
)


def _default_global_node_specs() -> List[Dict[str, Any]]:
    return [
        {
            "uuid": "signal-knmi-nino34",
            "label": "Signal",
            "name": "KNMI Nino 3.4 SST Anomaly",
            "dataset": "sst_anomaly",
            "sphere": "Ocean",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "ENSO Nino 3.4 Index",
            "lat": 0.0,
            "lng": -140.0,
            "elevation_m": 0.0,
            "trust_score": 0.96,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-noaa-global-co2",
            "label": "Signal",
            "name": "NOAA Mauna Loa Atmospheric CO2",
            "dataset": "air_quality",
            "sphere": "Atmosphere",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "Atmospheric CO2 ppm",
            "lat": 19.54,
            "lng": -155.58,
            "elevation_m": 3397.0,
            "trust_score": 0.98,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-arctic-amplification",
            "label": "Signal",
            "name": "Svalbard Arctic Temperature Anomaly",
            "dataset": "nasa_power",
            "sphere": "Cryosphere",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "Polar Temperature Anomaly",
            "lat": 78.9,
            "lng": 11.9,
            "elevation_m": 45.0,
            "trust_score": 0.95,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-amazon-canopy-vpd",
            "label": "Signal",
            "name": "Central Amazon Canopy Vapor Pressure Deficit",
            "dataset": "vegetation",
            "sphere": "Biosphere",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "Canopy VPD & Thermal Stress",
            "lat": -3.1,
            "lng": -60.0,
            "elevation_m": 92.0,
            "trust_score": 0.92,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-colorado-hydrology",
            "label": "Signal",
            "name": "Upper Colorado Basin Runoff Index",
            "dataset": "hydrology",
            "sphere": "Hydrosphere",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "Basin Discharge Anomaly",
            "lat": 39.5,
            "lng": -106.0,
            "elevation_m": 2450.0,
            "trust_score": 0.93,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-europe-pm25",
            "label": "Signal",
            "name": "Western Europe Boundary PM2.5",
            "dataset": "air_quality",
            "sphere": "Atmosphere",
            "temporal_scale": "month",
            "available_scales": ["month", "year"],
            "phenomenon_type": "Surface PM2.5 Concentration",
            "lat": 48.8,
            "lng": 2.3,
            "elevation_m": 35.0,
            "trust_score": 0.90,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-eonet-impulse-fire",
            "label": "Signal",
            "name": "NASA EONET Amazon Fire Radiative Impulse",
            "dataset": "wildfires",
            "sphere": "Biosphere",
            "temporal_scale": "impulse",
            "available_scales": ["impulse", "month"],
            "phenomenon_type": "Wildfire Impulse Count",
            "lat": -4.2,
            "lng": -58.5,
            "elevation_m": 120.0,
            "trust_score": 0.91,
            "is_community": False,
            "corroborated": True,
        },
        {
            "uuid": "signal-community-flux-station",
            "label": "Signal",
            "name": "Community Snowpack & Soil Flux Node",
            "dataset": "community",
            "sphere": "Hydrosphere",
            "temporal_scale": "month",
            "available_scales": ["day", "month"],
            "phenomenon_type": "Citizen Snowmelt Flux",
            "lat": 39.8,
            "lng": -105.7,
            "elevation_m": 2890.0,
            "trust_score": 0.86,
            "is_community": True,
            "corroborated": True,
        },
    ]


def _default_global_edges() -> List[Dict[str, Any]]:
    return [
        {"src": 0, "dst": 3, "type": "teleconnects", "weight": 0.90, "cross_scale": True},
        {"src": 6, "dst": 3, "type": "causes", "weight": 0.84, "cross_scale": True},
        {"src": 0, "dst": 4, "type": "drives_opposite", "weight": 0.88, "cross_scale": True},
        {"src": 7, "dst": 4, "type": "leads", "weight": 0.92, "cross_scale": True},
        {"src": 1, "dst": 2, "type": "leads", "weight": 0.85, "cross_scale": True},
        {"src": 0, "dst": 2, "type": "teleconnects", "weight": 0.72, "cross_scale": False},
        {"src": 3, "dst": 6, "type": "correlates_with", "weight": 0.78, "cross_scale": True},
        {"src": 2, "dst": 5, "type": "teleconnects", "weight": 0.74, "cross_scale": False},
    ]


def _generate_synthetic_series(
    num_months: int,
    seed: int,
) -> Tuple[List[List[Optional[float]]], List[List[float]], List[List[float]]]:
    rng = random.Random(seed)
    nino: List[Optional[float]] = []
    co2: List[Optional[float]] = []
    arctic: List[Optional[float]] = []
    amazon: List[Optional[float]] = []
    colorado: List[Optional[float]] = []
    europe_pm: List[Optional[float]] = []
    fire_imp: List[Optional[float]] = []
    comm_flux: List[Optional[float]] = []

    covar: List[List[float]] = [[0.0] * num_months for _ in range(8)]
    impulse: List[List[float]] = [[0.0] * num_months for _ in range(8)]

    for t in range(num_months):
        season = math.sin(2.0 * math.pi * (t % 12) / 12.0)
        nino_v = 1.35 * math.sin(2.0 * math.pi * t / 18.0 + 0.4) + 0.55 * math.cos(2.0 * math.pi * t / 9.0) + rng.gauss(0.0, 0.08)
        nino.append(round(nino_v, 4))

        co2_v = 408.0 + 0.22 * t + 2.6 * season + rng.gauss(0.0, 0.08)
        co2.append(round(co2_v, 4))

        fire_spike = 1.8 if (t % 12 in (7, 8) and (t > 0 and (nino[t - 1] or 0.0) > 0.6)) else (0.9 if t % 17 == 5 else 0.05)
        fire_v = fire_spike + abs(rng.gauss(0.0, 0.06))
        fire_imp.append(round(fire_v, 4))
        impulse[6][t] = round(min(2.0, fire_spike), 4)
        impulse[3][t] = round(min(1.5, fire_spike * 0.65), 4)

        flux_v = 1.15 * math.cos(2.0 * math.pi * t / 12.0 - 0.5) - 0.75 * nino_v + rng.gauss(0.0, 0.07)
        comm_flux.append(round(flux_v, 4))
        covar[4][t] = round(flux_v * 0.4, 4)

    for t in range(num_months):
        prev_nino = float(nino[t - 1] if t > 0 else nino[0] or 0.0)
        prev_fire = float(fire_imp[t - 1] if t > 0 else fire_imp[0] or 0.0)
        prev_flux = float(comm_flux[t - 1] if t > 0 else comm_flux[0] or 0.0)
        prev_co2_anom = (float(co2[t - 1] if t > 0 else co2[0] or 408.0) - 414.0) * 0.25

        arc_v = 0.8 + 0.75 * prev_co2_anom + 0.48 * prev_nino + 0.25 * math.sin(2.0 * math.pi * t / 12.0) + rng.gauss(0.0, 0.09)
        arctic.append(round(arc_v, 4))

        amz_v = 1.2 + 0.92 * prev_nino + 0.85 * prev_fire + rng.gauss(0.0, 0.08)
        amazon.append(round(amz_v, 4))

        # Strong opposite Nino forcing + strong causal community snowpack flux signal at t-1
        col_v = 10.0 - 1.45 * prev_nino + 1.30 * prev_flux + rng.gauss(0.0, 0.08)
        colorado.append(round(col_v, 4))

        # PM2.5 responds negatively to Arctic jet gradient + wind covariate
        wind_cov = 0.8 * math.cos(2.0 * math.pi * t / 12.0)
        covar[5][t] = round(wind_cov, 4)
        prev_arc = float(arctic[t - 1] if t > 0 else arc_v)
        eu_v = 14.5 - 0.85 * prev_arc + 1.25 * wind_cov + rng.gauss(0.0, 0.12)
        europe_pm.append(round(eu_v, 4))

    return [nino, co2, arctic, amazon, colorado, europe_pm, fire_imp, comm_flux], covar, impulse


def build_synthetic_global_multiscale_bundle(
    num_months: int = 60,
    horizon_steps: int = 1,
    seed: int = 42,
) -> Dict[str, Any]:
    """Build a deterministic leak-free `etg-ml-v2` global multi-scale Earth Trend Graph bundle."""
    months = max(16, int(num_months))
    time_index = _month_keys(2020, months)
    nodes = _default_global_node_specs()
    edges = _default_global_edges()
    series, covar, impulse = _generate_synthetic_series(months, seed)
    return _assemble_v2_bundle(
        time_index=time_index,
        nodes=nodes,
        raw_series_by_node=series,
        covar_by_node=covar,
        impulse_by_node=impulse,
        edges=edges,
        horizon_steps=horizon_steps,
    )


def inject_synthetic_community_node(
    bundle: Dict[str, Any],
    node_uuid: str,
    target_idx: int,
    informative: bool,
    trust_score: float,
    corroborated: bool = False,
    seed: int = 99,
) -> Dict[str, Any]:
    """
    Append an unseen community contributor node + edge to an `etg-ml-v2` bundle
    for zero-shot inductive & trust-gating verification without modifying prior nodes.
    """
    out = copy.deepcopy(bundle)
    rng = random.Random(seed)
    T = len(out["feature_tensor"])
    N = len(out["node_ids"])
    if target_idx < 0 or target_idx >= N:
        raise ValueError(f"target_idx {target_idx} out of range [0, {N})")

    cutoff = int(out["train_cutoff_index"])
    horizon = int(out["labels"].get("horizon_steps", 1))

    # Build z-scores directly in normalized space for clean causal/noisy contrast
    raw_z: List[float] = []
    for t in range(T):
        if informative:
            # No-leakage causal physical precursor observed *at* timestep t that anticipates
            # target dynamics at t + horizon (e.g., upstream soil moisture/pressure precursor).
            fut_t = min(T - 1, t + horizon)
            target_fut_z = out["feature_tensor"][fut_t][target_idx][1]
            cur_z = out["feature_tensor"][t][target_idx][1]
            raw_z.append(0.88 * (target_fut_z - 0.72 * cur_z) * 2.2 + rng.gauss(0.0, 0.08))
        else:
            raw_z.append(rng.gauss(0.0, 3.5))

    tr_slice = raw_z[:cutoff]
    mean = sum(tr_slice) / max(1, len(tr_slice))
    std = max(1e-6, math.sqrt(sum((v - mean) ** 2 for v in tr_slice) / max(1, len(tr_slice))))
    z_seq = [(v - mean) / std if not informative else v for v in raw_z]

    for t in range(T):
        z = z_seq[t]
        prev_z = z_seq[t - 1] if t > 0 else z
        hist = z_seq[max(0, t - 3) : t + 1]
        rm4 = sum(hist) / len(hist)
        rs4 = math.sqrt(sum((x - rm4) ** 2 for x in hist) / max(1, len(hist)))
        out["feature_tensor"][t].append([
            round(z, 5),
            round(z, 5),
            round(z - prev_z, 5),
            round(rm4, 5),
            round(rs4, 5),
            round(z * 0.85, 5),
            0.0,
            0.0,
        ])
        out["mask_tensor"][t].append(1)

        f_idx = t + horizon
        if f_idx < T:
            fut_z = z_seq[f_idx]
            dz = fut_z - z
            out["labels"]["next_value_targets"][t].append(round(fut_z, 5))
            out["labels"]["trend_class_targets"][t].append(0 if dz <= -0.35 else 2 if dz >= 0.35 else 1)
            jump = abs(fut_z - rm4) >= 1.5
            out["labels"]["regime_shift_targets"][t].append(1 if jump else 0)
        else:
            out["labels"]["next_value_targets"][t].append(None)
            out["labels"]["trend_class_targets"][t].append(None)
            out["labels"]["regime_shift_targets"][t].append(None)

    tgt_meta = out["node_metadata"][target_idx]
    new_meta = {
        "index": N,
        "uuid": node_uuid,
        "label": "Signal",
        "name": f"Community Sensor ({node_uuid})",
        "dataset": "community",
        "sphere": tgt_meta.get("sphere", "Hydrosphere"),
        "temporal_scale": "month",
        "available_scales": ["day", "month"],
        "phenomenon_type": "Community Field Sensor",
        "lat": float(tgt_meta.get("lat", 0.0)) + 0.35,
        "lng": float(tgt_meta.get("lng", 0.0)) - 0.35,
        "elevation_m": float(tgt_meta.get("elevation_m", 100.0)),
        "trust_score": round(trust_score, 4),
        "is_community": True,
        "corroborated": bool(corroborated),
    }

    out["node_ids"].append(node_uuid)
    out["node_metadata"].append(new_meta)
    out["node_static_features"].append(_build_node_static_vec(new_meta))
    out["normalization"].append({"mean": round(mean, 6), "std": round(std, 6)})

    # Connect unseen community node -> target_idx with causal correlation from pre-cutoff slice
    tgt_series = [out["feature_tensor"][t][target_idx][1] for t in range(T)]
    corr_r, opt_lag = _causal_corr_and_lag(z_seq, tgt_series, cutoff)
    out["edge_index"][0].append(N)
    out["edge_index"][1].append(target_idx)
    out["edge_types"].append("leads" if informative else "correlates_with")
    out["edge_attr"].append([
        corr_r,
        round(opt_lag / 6.0, 4),
        0.92 if trust_score >= 0.7 else 0.55,
        0.01,
        0.5,
        -0.5,
        0.0,
        1.0,
    ])
    return out
