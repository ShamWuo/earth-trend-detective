"""Unit tests for the standalone ETG Spatio-Temporal Graph Neural Network pipeline."""

from __future__ import annotations

import json
import math
import random
import tempfile
import unittest
from pathlib import Path

from etg_stgnn import (
    load_etg_ml_dataset,
    train_and_evaluate_etg_stgnn,
)
from train_etg_gnn import main as cli_main


def build_synthetic_nonlinear_etg_bundle(steps: int = 72) -> dict:
    """Builds an etg-ml-v1 bundle where target(t+1) exhibits nonlinear threshold+interaction
    coupling with upstream driver(t-1), plus a pure noise distractor node."""
    rng = random.Random(123)
    driver_vals = []
    noise_vals = []
    target_vals = [10.0, 10.2]

    for t in range(steps):
        driver_vals.append(2.1 * math.sin(t * 0.27) + 0.55 * math.cos(t * 0.13) + rng.gauss(0.0, 0.25))
        noise_vals.append(rng.gauss(0.0, 1.5))

    for t in range(1, steps - 1):
        d = driver_vals[t]
        y_prev = target_vals[-1] - 10.0
        # Strong nonlinear threshold + state-interaction forcing from upstream driver:
        # positive anomalies above +0.4 trigger compounding stress amplification
        threshold_surge = 2.6 * max(0.0, d - 0.35) ** 1.4
        deficit_relief = -1.8 * max(0.0, -0.35 - d)
        interaction = 0.28 * y_prev * d
        next_y = 10.0 + 0.32 * y_prev + threshold_surge + deficit_relief + interaction + rng.gauss(0.0, 0.25)
        target_vals.append(next_y)

    time_index = [f"{2020 + t // 12}-{(t % 12) + 1:02d}" for t in range(steps)]
    feature_tensor = []
    mask_tensor = []
    for t in range(steps):
        d_prev = driver_vals[t - 1] if t > 0 else driver_vals[t]
        n_prev = noise_vals[t - 1] if t > 0 else noise_vals[t]
        t_prev = target_vals[t - 1] if t > 0 else target_vals[t]
        feature_tensor.append(
            [
                [target_vals[t], target_vals[t] - 10.0, target_vals[t] - t_prev],
                [driver_vals[t], driver_vals[t], driver_vals[t] - d_prev],
                [noise_vals[t], noise_vals[t], noise_vals[t] - n_prev],
            ]
        )
        mask_tensor.append([1.0, 1.0, 1.0])

    return {
        "schema_version": "etg-ml-v1",
        "bucket": "month",
        "node_ids": ["target-basin", "enso-driver", "random-distractor"],
        "node_metadata": [
            {"index": 0, "uuid": "target-basin", "label": "Signal", "name": "Target Basin Stress"},
            {"index": 1, "uuid": "enso-driver", "label": "Signal", "name": "ENSO Forcing Driver"},
            {"index": 2, "uuid": "random-distractor", "label": "Signal", "name": "Uncorrelated Noise"},
        ],
        "edge_index": [[1, 2], [0, 0]],
        "edge_types": ["teleconnects", "correlates_with"],
        "edge_attr_names": [
            "correlation_r",
            "detrended_r",
            "optimal_lag_steps",
            "weight",
            "distance_km_norm",
            "sin_bearing",
            "cos_bearing",
            "is_opposite",
        ],
        "edge_attr": [
            [0.82, 0.79, 1, 0.92, 0.35, 0.5, 0.86, 0],
            [0.02, -0.01, 1, 0.25, 0.45, -0.5, 0.86, 0],
        ],
        "time_index": time_index,
        "feature_names": ["value", "z_score", "diff_1"],
        "feature_tensor": feature_tensor,
        "mask_tensor": mask_tensor,
    }


class TestEtgStGnn(unittest.TestCase):
    def test_validates_schema_and_beats_baselines_on_nonlinear_driver(self) -> None:
        bundle = build_synthetic_nonlinear_etg_bundle()
        ds = load_etg_ml_dataset(bundle)
        self.assertEqual(len(ds.node_ids), 3)
        self.assertEqual(len(ds.time_index), 72)

        report = train_and_evaluate_etg_stgnn(
            bundle,
            target_uuid="target-basin",
            horizon_steps=1,
            window_lags=3,
            hidden_dim=14,
            epochs=220,
            lr=0.03,
            seed=7,
        )

        metrics = report["metrics"]
        self.assertLess(metrics["etg_lag_gnn"]["rmse"], metrics["persistence"]["rmse"])
        self.assertLess(metrics["etg_lag_gnn"]["rmse"], metrics["self_ar"]["rmse"] * 0.85)
        self.assertLess(
            metrics["etg_lag_gnn"]["rmse"], metrics["linear_graph_ridge"]["rmse"]
        )
        self.assertGreater(report["skill_lift_vs_self_pct"], 15.0)

        top_driver = report["edge_attributions"][0]
        self.assertEqual(top_driver["node_uuid"], "enso-driver")
        self.assertGreater(
            top_driver["learned_attention_weight"],
            report["edge_attributions"][1]["learned_attention_weight"],
        )

    def test_cli_reads_json_file_and_writes_report(self) -> None:
        bundle = build_synthetic_nonlinear_etg_bundle(steps=56)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            in_file = tmp_dir / "export.json"
            out_file = tmp_dir / "eval.json"
            in_file.write_text(json.dumps(bundle), encoding="utf-8")

            rc = cli_main(
                [
                    "--input",
                    str(in_file),
                    "--target-uuid",
                    "target-basin",
                    "--epochs",
                    "80",
                    "--output-json",
                    str(out_file),
                ]
            )
            self.assertEqual(rc, 0)
            self.assertTrue(out_file.exists())
            parsed = json.loads(out_file.read_text(encoding="utf-8"))
            self.assertEqual(parsed["schema_version"], "etg-stgnn-eval-v1")
            self.assertIn("etg_lag_gnn", parsed["metrics"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
