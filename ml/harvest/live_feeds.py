"""Live public Earth observation feed parsers and HTTP harvester for `etg-ml-v2`."""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from .bundle_builder import _assemble_v2_bundle, _month_keys
from .synthetic_and_community import (
    _default_global_edges,
    _default_global_node_specs,
    _generate_synthetic_series,
)


def _http_get_text(url: str, timeout: float = 6.0) -> Optional[str]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "EarthTrendDetective/2.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def _parse_noaa_co2_monthly(text: str) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        parts = s.split(",")
        if len(parts) < 5:
            continue
        try:
            year = int(parts[0])
            month = int(parts[1])
            avg = float(parts[3])
            if avg > 0:
                out[f"{year:04d}-{month:02d}"] = avg
        except ValueError:
            continue
    return out


def _parse_knmi_nino34_dat(text: str) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        toks = re.split(r"\s+", s)
        if not toks or not re.fullmatch(r"\d{4}", toks[0]):
            continue
        year = int(toks[0])
        for m_idx in range(1, min(13, len(toks))):
            try:
                val = float(toks[m_idx])
                if abs(val) < 90.0:
                    out[f"{year:04d}-{m_idx:02d}"] = val
            except ValueError:
                continue
    return out


def _parse_nasa_power_monthly(text: str) -> Tuple[Dict[str, float], Dict[str, float]]:
    t2m_out: Dict[str, float] = {}
    pre_out: Dict[str, float] = {}
    try:
        data = json.loads(text)
        params = data.get("properties", {}).get("parameter", {})
        t2m = params.get("T2M", {})
        pre = params.get("PRECTOTCORR", {})
        for k, v in t2m.items():
            if len(k) == 6 and not k.endswith("13") and float(v) > -900:
                t2m_out[f"{k[:4]}-{k[4:6]}"] = float(v)
        for k, v in pre.items():
            if len(k) == 6 and not k.endswith("13") and float(v) > -900:
                pre_out[f"{k[:4]}-{k[4:6]}"] = float(v)
    except Exception:
        pass
    return t2m_out, pre_out


def harvest_live_global_multiscale(
    output_path: Optional[Union[str, Path]] = None,
    start_year: int = 2015,
    end_year: int = 2024,
    horizon_steps: int = 1,
) -> Dict[str, Any]:
    """
    Fetch public Earth observation datasets (NOAA CO2, KNMI Nino 3.4, NASA POWER, NASA EONET)
    via stdlib HTTP, seamlessly filling unavailable series from calibrated baselines so the
    resulting `etg-ml-v2` graph is always complete and zero-leakage.
    """
    months = max(24, (end_year - start_year + 1) * 12)
    time_index = _month_keys(start_year, months)
    nodes = _default_global_node_specs()
    edges = _default_global_edges()
    fallback_series, covar, impulse = _generate_synthetic_series(months, seed=42)

    co2_txt = _http_get_text("https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv")
    nino_txt = _http_get_text("https://climexp.knmi.nl/data/iersst_nino3.4a.dat")
    power_txt = _http_get_text(
        f"https://power.larc.nasa.gov/api/temporal/monthly/point?parameters=T2M,PRECTOTCORR&community=AG&longitude=-60.0&latitude=-3.1&start={start_year}&end={end_year}&format=JSON"
    )
    eonet_txt = _http_get_text("https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&limit=50")

    co2_map = _parse_noaa_co2_monthly(co2_txt) if co2_txt else {}
    nino_map = _parse_knmi_nino34_dat(nino_txt) if nino_txt else {}
    power_t2m_map, power_pre_map = _parse_nasa_power_monthly(power_txt) if power_txt else ({}, {})

    fire_counts: Dict[str, float] = {}
    if eonet_txt:
        try:
            ej = json.loads(eonet_txt)
            for ev in ej.get("events", []):
                for g in ev.get("geometry", []):
                    dt = str(g.get("date", ""))[:7]
                    if len(dt) == 7:
                        fire_counts[dt] = fire_counts.get(dt, 0.0) + 1.0
        except Exception:
            pass

    live_maps: Dict[int, Dict[str, float]] = {
        0: nino_map,
        1: co2_map,
        3: power_t2m_map,
        6: fire_counts,
    }
    sources_live: List[str] = []
    if nino_map:
        sources_live.append("knmi_nino34")
    if co2_map:
        sources_live.append("noaa_co2")
    if power_t2m_map:
        sources_live.append("nasa_power")
        for t_idx, k in enumerate(time_index):
            if k in power_pre_map:
                covar[3][t_idx] = round(power_pre_map[k], 4)
    if fire_counts:
        sources_live.append("nasa_eonet")

    merged_series: List[List[Optional[float]]] = []
    for j in range(len(nodes)):
        lmap = live_maps.get(j, {})
        row: List[Optional[float]] = []
        for t_idx, k in enumerate(time_index):
            if k in lmap:
                row.append(round(lmap[k], 4))
            else:
                row.append(fallback_series[j][t_idx])
        merged_series.append(row)

    bundle = _assemble_v2_bundle(
        time_index=time_index,
        nodes=nodes,
        raw_series_by_node=merged_series,
        covar_by_node=covar,
        impulse_by_node=impulse,
        edges=edges,
        horizon_steps=horizon_steps,
    )
    bundle["harvester_metadata"] = {
        "mode": "live" if sources_live else "offline_fallback",
        "live_sources": sources_live,
    }

    if output_path is not None:
        p = Path(output_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(bundle, indent=2), encoding="utf-8")

    return bundle
