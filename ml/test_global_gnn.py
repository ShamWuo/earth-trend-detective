"""Unit tests for ml/global_gnn feature extraction, strict causality, and fp16 export."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import random
import sys
import tempfile
import unittest

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

from global_gnn.cities_and_harvest import (
    GLOBAL_36_CITIES,
    build_city_ring_nodes,
    estimate_astronomical_clrsky_kwh,
)

try:
    import numpy as np
    import torch
    from global_gnn.features_and_model import (
        ETGGlobalSpatiotemporalGNN,
        F_EDGE,
        F_NODE,
        F_PHYS,
        NUM_NODES,
        WINDOW_LEN,
        build_city_graph_tensors,
    )
    from global_gnn.train_and_export import export_packed_fp16_weights

    ML_DEPS_AVAILABLE = True
except ImportError:
    ML_DEPS_AVAILABLE = False


def _make_fake_city(city_id: str = "denver", days: int = 32) -> dict:
    spec = next(c for c in GLOBAL_36_CITIES if c.city_id == city_id)
    nodes = build_city_ring_nodes(spec)
    rng = random.Random(7)
    dates = [f"2025-01-{d + 1:02d}" for d in range(min(31, days))]
    if days > 31:
        dates += [f"2025-02-{d - 30:02d}" for d in range(31, days)]
    rows_by_node = {}
    for j, n in enumerate(nodes):
        rows = []
        for idx, _iso in enumerate(dates):
            clr = estimate_astronomical_clrsky_kwh(float(n["lat"]), float(n["elevation_m"]), idx + 1)
            kt = 0.62 + 0.18 * math.sin(idx * 0.4 + j * 0.2) + rng.gauss(0.0, 0.03)
            kt = max(0.12, min(0.95, kt))
            rows.append(
                {
                    "allsky": kt * clr,
                    "clrsky": clr,
                    "kt": kt,
                    "t2m": 8.0 + 4.0 * math.cos(idx * 0.3),
                    "rh2m": 48.0,
                    "precip": 2.5 if idx % 9 == 0 else 0.0,
                    "ws10m": 4.5,
                    "wd10m": 265.0,
                    "ps": 83.2,
                    "eve_cloud": 35.0,
                    "eve_cloud23": 38.0,
                    "eve_rh": 52.0,
                    "eve_ws": 4.1,
                    "eve_wd": 275.0,
                    "eve_ps_trend": -1.2 if idx % 9 == 0 else 0.4,
                }
            )
        rows_by_node[n["id"]] = rows
    return {
        "city_id": spec.city_id,
        "name": spec.name,
        "split": spec.split,
        "nodes": nodes,
        "dates": dates,
        "rows_by_node": rows_by_node,
    }


class TestGlobalGnn(unittest.TestCase):
    def test_36_cities_disjoint_splits_and_ring_geometry(self) -> None:
        self.assertEqual(len(GLOBAL_36_CITIES), 36)
        train_ids = {c.city_id for c in GLOBAL_36_CITIES if c.split == "global_train"}
        test_ids = {c.city_id for c in GLOBAL_36_CITIES if c.split == "global_test"}
        denver_ids = {c.city_id for c in GLOBAL_36_CITIES if c.split == "denver_showcase"}
        self.assertEqual(len(train_ids), 30)
        self.assertEqual(len(test_ids), 5)
        self.assertEqual(denver_ids, {"denver"})
        self.assertTrue(train_ids.isdisjoint(test_ids))
        self.assertTrue(train_ids.isdisjoint(denver_ids))

        ring = build_city_ring_nodes(GLOBAL_36_CITIES[0])
        self.assertEqual(len(ring), 7)
        self.assertEqual(ring[0]["role"], "target")
        for nbr in ring[1:]:
            self.assertGreater(nbr["distance_km"], 90.0)
            self.assertLess(nbr["distance_km"], 140.0)

    def test_exported_weights_integrity_when_present(self) -> None:
        weights_dir = Path(__file__).resolve().parent / "weights"
        bin_p = weights_dir / "etg-global-gnn-v3.bin"
        meta_p = weights_dir / "etg-global-gnn-v3.meta.json"
        if not bin_p.exists() or not meta_p.exists():
            self.skipTest("Exported etg-global-gnn-v3 weights not yet present")
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        self.assertEqual(meta["schema_version"], "etg-global-gnn-v3")
        self.assertEqual(bin_p.stat().st_size, meta["total_bytes"])
        self.assertGreater(meta["architecture"]["param_count"], 1_000_000)

    @unittest.skipUnless(ML_DEPS_AVAILABLE, "numpy/torch not installed in local stdlib environment")
    def test_strict_causality_under_future_spikes(self) -> None:
        city = _make_fake_city("denver", days=24)
        base_t = build_city_graph_tensors(city)

        spiked = copy.deepcopy(city)
        for nid in spiked["rows_by_node"]:
            for d in range(18, 24):
                spiked["rows_by_node"][nid][d]["kt"] = 0.05
                spiked["rows_by_node"][nid][d]["allsky"] = 0.2
                spiked["rows_by_node"][nid][d]["eve_cloud23"] = 99.0
                spiked["rows_by_node"][nid][d]["t2m"] = -35.0
                spiked["rows_by_node"][nid][d]["precip"] = 99.0
        spiked_t = build_city_graph_tensors(spiked)

        self.assertTrue(np.allclose(base_t["windows"][:10], spiked_t["windows"][:10], atol=1e-7))
        self.assertTrue(np.allclose(base_t["edge_attr"][:10], spiked_t["edge_attr"][:10], atol=1e-7))
        self.assertTrue(np.allclose(base_t["phys"][:10], spiked_t["phys"][:10], atol=1e-7))

    @unittest.skipUnless(ML_DEPS_AVAILABLE, "numpy/torch not installed in local stdlib environment")
    def test_model_forward_monotonic_quantiles_and_fp16_export(self) -> None:
        city = _make_fake_city("denver", days=20)
        t_data = build_city_graph_tensors(city)
        self.assertEqual(t_data["windows"].shape[1:], (WINDOW_LEN, NUM_NODES, F_NODE))
        self.assertEqual(t_data["edge_attr"].shape[1:], (42, F_EDGE))
        self.assertEqual(t_data["phys"].shape[1:], (F_PHYS,))

        model = ETGGlobalSpatiotemporalGNN(d_model=64, num_layers=2, num_heads=4, adapter_dim=16).eval()
        with torch.no_grad():
            out = model(
                torch.from_numpy(t_data["windows"][:4]),
                torch.from_numpy(t_data["edge_index"]),
                torch.from_numpy(t_data["edge_attr"][:4]),
                torch.from_numpy(t_data["phys"][:4]),
                torch.from_numpy(t_data["y_clrsky_next"][:4]),
            )
        qs = out["allsky_quantiles"].numpy()
        self.assertEqual(qs.shape, (4, 4))
        self.assertTrue(np.all(qs[:, 0] <= qs[:, 1] + 1e-6))
        self.assertTrue(np.all(qs[:, 1] <= qs[:, 2] + 1e-6))
        self.assertTrue(np.all(qs[:, 2] <= qs[:, 3] + 1e-6))

        with tempfile.TemporaryDirectory() as tmp:
            bp = Path(tmp) / "m.bin"
            mp = Path(tmp) / "m.meta.json"
            export_packed_fp16_weights(model, bp, mp, {"ok": True}, {"cities": 36})
            meta = json.loads(mp.read_text(encoding="utf-8"))
            self.assertEqual(bp.stat().st_size, meta["total_bytes"])
            self.assertGreater(len(meta["tensors"]), 10)


if __name__ == "__main__":
    unittest.main()
