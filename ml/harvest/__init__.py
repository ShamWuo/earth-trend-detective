"""Cohesive submodules for building and harvesting `etg-ml-v2` Earth Trend Graph bundles."""

from .bundle_builder import (
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
from .live_feeds import (
    _http_get_text,
    _parse_knmi_nino34_dat,
    _parse_nasa_power_monthly,
    _parse_noaa_co2_monthly,
    harvest_live_global_multiscale,
)
from .synthetic_and_community import (
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
]
