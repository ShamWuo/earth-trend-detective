"""
Global Multi-Scale Earth Trend Graph (`etg-ml-v2`) Dataset Harvester & Builder.

Zero external dependencies (Python 3.9+ stdlib only):
- `build_synthetic_global_multiscale_bundle`: deterministic 8-node global multi-scale
  Earth system benchmark (ENSO Nino3.4, Mauna Loa CO2, Arctic amplification, Amazon canopy VPD,
  Colorado hydrology, Europe PM2.5, EONET impulse wildfire, corroborated community flux station)
  with strict `< train_cutoff_index` normalization, seasonal climatology, and causal edge lags.
- `inject_synthetic_community_node`: appends an unseen community contributor node + edge for
  zero-shot inductive testing (high-trust informative vs. low-trust noisy crowd sensor).
- `harvest_live_global_multiscale`: fetches real public datasets from NOAA GML, NASA GISTEMP,
  KNMI Climate Explorer, NASA EONET, and NASA POWER (gracefully falling back per-source to
  calibrated baselines when offline or rate-limited) and emits `etg-ml-v2`.

Facade re-exporting cohesive submodules from `ml/harvest/`.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

from harvest.bundle_builder import (
    EDGE_ATTR_NAMES,
    NODE_STATIC_FEATURE_NAMES,
    TEMPORAL_FEATURE_NAMES,
    _assemble_v2_bundle,
    _bearing_rad,
    _build_node_static_vec,
    _causal_corr_and_lag,
    _compute_train_stats,
    _haversine_km,
    _month_keys,
)
from harvest.live_feeds import (
    _http_get_text,
    _parse_knmi_nino34_dat,
    _parse_nasa_power_monthly,
    _parse_noaa_co2_monthly,
    harvest_live_global_multiscale,
)
from harvest.synthetic_and_community import (
    _default_global_edges,
    _default_global_node_specs,
    _generate_synthetic_series,
    build_synthetic_global_multiscale_bundle,
    inject_synthetic_community_node,
)

__all__ = [
    "NODE_STATIC_FEATURE_NAMES",
    "EDGE_ATTR_NAMES",
    "TEMPORAL_FEATURE_NAMES",
    "_haversine_km",
    "_bearing_rad",
    "_month_keys",
    "_compute_train_stats",
    "_causal_corr_and_lag",
    "_build_node_static_vec",
    "_assemble_v2_bundle",
    "_default_global_node_specs",
    "_default_global_edges",
    "_generate_synthetic_series",
    "build_synthetic_global_multiscale_bundle",
    "inject_synthetic_community_node",
    "_http_get_text",
    "_parse_noaa_co2_monthly",
    "_parse_knmi_nino34_dat",
    "_parse_nasa_power_monthly",
    "harvest_live_global_multiscale",
    "main",
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Harvest/build etg-ml-v2 multi-scale dataset.")
    parser.add_argument("--offline-synthetic", action="store_true", help="Generate offline multi-scale dataset.")
    parser.add_argument("--live", action="store_true", help="Fetch live NOAA/KNMI/NASA/EONET feeds.")
    parser.add_argument("--months", type=int, default=60, help="Months for synthetic mode.")
    parser.add_argument("--output", type=str, default="", help="Optional JSON output path.")
    args = parser.parse_args()

    if args.live:
        bundle = harvest_live_global_multiscale(output_path=args.output or None)
    else:
        bundle = build_synthetic_global_multiscale_bundle(num_months=args.months)
        if args.output:
            p = Path(args.output)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(bundle, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "schema_version": bundle["schema_version"],
                "nodes": len(bundle["node_ids"]),
                "edges": len(bundle["edge_index"][0]),
                "timesteps": len(bundle["time_index"]),
                "train_cutoff_index": bundle["train_cutoff_index"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
