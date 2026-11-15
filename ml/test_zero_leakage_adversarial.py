"""Adversarial zero-leakage torture tests for ETG Python ML pipelines."""

import copy
import math
import random
import sys
import unittest
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from etg_inductive_gnn import PortableInductiveETGNet  # noqa: E402
from etg_stgnn import build_supervised_windows, load_etg_ml_dataset  # noqa: E402
from etg_trend_microscope import (  # noqa: E402
    build_microscope_training_corpus,
    extract_node_microscope_features,
    extract_pair_microscope_features,
)


def _make_synthetic_bundle(num_steps: int = 44, cutoff: int = 32, horizon: int = 1) -> dict:
    rng = random.Random(2026)
    n_nodes = 3
    time_index = [f"{2022 + t // 12}-{t % 12 + 1:02d}" for t in range(num_steps)]
    time_ms = [1_640_995_200_000 + t * 2_592_000_000 for t in range(num_steps)]

    raw_series = []
    for j in range(n_nodes):
        s = []
        for t in range(num_steps):
            val = 12.0 + 0.1 * t + (2.0 + 0.5 * j) * math.sin(2 * math.pi * t / 12.0 + j * 0.4)
            val += rng.gauss(0.0, 0.15)
            s.append(val)
        raw_series.append(s)

    # Compute mean/std strictly on [0 .. cutoff - 1]
    norms = []
    for j in range(n_nodes):
        pre = raw_series[j][:cutoff]
        m = sum(pre) / len(pre)
        v = sum((x - m) ** 2 for x in pre) / max(1, len(pre))
        norms.append({"node_id": f"node-{j}", "mean": m, "std": max(1e-4, math.sqrt(v))})

    feat_tensor = []
    mask_tensor = []
    next_targets = []
    trend_targets = []
    for t in range(num_steps):
        row_feat = []
        row_mask = []
        row_next = []
        row_trend = []
        for j in range(n_nodes):
            m = norms[j]["mean"]
            sd = norms[j]["std"]
            val = raw_series[j][t]
            z = (val - m) / sd
            dz = z - ((raw_series[j][t - 1] - m) / sd if t > 0 else z)
            row_feat.append([val, z, dz, 0.0, 0.0, 0.0, 0.0, 0.0])
            row_mask.append(1)
            if t + horizon < num_steps:
                tgt_z = (raw_series[j][t + horizon] - m) / sd
                row_next.append(tgt_z)
                row_trend.append(2 if tgt_z - z > 0.2 else 0 if tgt_z - z < -0.2 else 1)
            else:
                row_next.append(None)
                row_trend.append(None)
        feat_tensor.append(row_feat)
        mask_tensor.append(row_mask)
        next_targets.append(row_next)
        trend_targets.append(row_trend)

    return {
        "schema_version": "etg-ml-v2",
        "primary_bucket": "month",
        "node_ids": [f"node-{j}" for j in range(n_nodes)],
        "node_metadata": [
            {
                "uuid": f"node-{j}",
                "name": f"Station {j}",
                "label": "Signal",
                "dataset": "nasa_power_solar",
                "lat": 39.0 + j,
                "lng": -105.0 - j,
                "temporal_scale": "month",
                "trust_score": 0.9,
                "corroborated": True,
                "degree": 2,
                "in_degree": 1,
                "out_degree": 1,
            }
            for j in range(n_nodes)
        ],
        "node_static_features": [
            [0.5, 0.8, -0.5, 0.8, 0.9, 0.0, 0.5, 1.0, 0.5, 0.0, 0.1, 0.2, 0.3, 0.0, 0.0, 1.0]
            for _ in range(n_nodes)
        ],
        "time_index": time_index,
        "time_index_ms": time_ms,
        "train_cutoff_index": cutoff,
        "normalization": norms,
        "feature_tensor": feat_tensor,
        "mask_tensor": mask_tensor,
        "edge_index": [[1, 2], [0, 0]],
        "edge_types": ["correlates_with", "drives_opposite"],
        "edge_attr": [
            [0.8, 0.75, 1.0, 0.0, 1.0, 120.0, 1.0, 0.5],
            [-0.7, -0.65, 2.0, 0.0, 0.8, 240.0, -1.0, 0.5],
        ],
        "labels": {
            "horizon_steps": horizon,
            "next_value_targets": next_targets,
            "trend_class_targets": trend_targets,
        },
        "impulse_events": [],
    }


class TestZeroLeakageAdversarialML(unittest.TestCase):
    def test_inductive_gnn_fit_shifts_zero_under_post_cutoff_spikes(self) -> None:
        clean_bundle = _make_synthetic_bundle(num_steps=44, cutoff=32, horizon=1)
        spiked_bundle = copy.deepcopy(clean_bundle)

        # Inject extreme +-9999 spikes into ALL post-cutoff timesteps (t >= cutoff)
        cutoff = spiked_bundle["train_cutoff_index"]
        for t in range(cutoff, len(spiked_bundle["feature_tensor"])):
            spike = 9999.0 if t % 2 == 0 else -9999.0
            for j in range(len(spiked_bundle["node_ids"])):
                spiked_bundle["feature_tensor"][t][j][0] = spike
                spiked_bundle["feature_tensor"][t][j][1] = spike
                spiked_bundle["feature_tensor"][t][j][2] = -spike
                # Also spike the target emitted at t = cutoff - 1 (which points to cutoff!)
        for j in range(len(spiked_bundle["node_ids"])):
            spiked_bundle["labels"]["next_value_targets"][cutoff - 1][j] = 9999.0
            for t in range(cutoff, len(spiked_bundle["labels"]["next_value_targets"])):
                if spiked_bundle["labels"]["next_value_targets"][t][j] is not None:
                    spiked_bundle["labels"]["next_value_targets"][t][j] = -9999.0

        net_clean = PortableInductiveETGNet(seed=7)
        net_clean.fit(clean_bundle, epochs=12, lr=0.015)

        net_spiked = PortableInductiveETGNet(seed=7)
        net_spiked.fit(spiked_bundle, epochs=12, lr=0.015)

        w_clean = net_clean.to_portable_weights_dict()
        w_spiked = net_spiked.to_portable_weights_dict()
        self.assertEqual(w_clean, w_spiked)
        self.assertEqual(net_clean.calibrated_z_spread, net_spiked.calibrated_z_spread)

        # Evaluate at cutoff - 1 (input strictly <= cutoff - 1, untouched by spikes)
        pred_clean = net_clean.predict_bundle(clean_bundle, t_idx=cutoff - 1)
        pred_spiked = net_spiked.predict_bundle(spiked_bundle, t_idx=cutoff - 1)
        for j in pred_clean:
            self.assertEqual(abs(pred_clean[j]["predicted_value"] - pred_spiked[j]["predicted_value"]), 0.0)

    def test_inductive_gnn_boundary_guard_when_cutoff_at_horizon(self) -> None:
        tiny_bundle = _make_synthetic_bundle(num_steps=10, cutoff=2, horizon=2)
        net = PortableInductiveETGNet(seed=3)
        hist = net.fit(tiny_bundle, epochs=3)
        self.assertEqual(hist["train_samples"], 0)

    def test_stgnn_windowing_normalization_invariant_to_future_spikes(self) -> None:
        raw_v2 = _make_synthetic_bundle(num_steps=44, cutoff=32, horizon=1)
        clean_bundle = {
            "schema_version": "etg-ml-v1",
            "bucket": "month",
            "node_ids": raw_v2["node_ids"],
            "node_metadata": raw_v2["node_metadata"],
            "edge_index": raw_v2["edge_index"],
            "edge_types": raw_v2["edge_types"],
            "edge_attr_names": ["corr_r", "detrended_r", "opt_lag"],
            "edge_attr": [row[:3] for row in raw_v2["edge_attr"]],
            "time_index": raw_v2["time_index"],
            "feature_names": ["value", "z_score", "diff_1"],
            "feature_tensor": [
                [[cell[0], cell[1], cell[2]] for cell in row]
                for row in raw_v2["feature_tensor"]
            ],
            "mask_tensor": raw_v2["mask_tensor"],
        }

        ds_clean = load_etg_ml_dataset(clean_bundle)
        w_clean = build_supervised_windows(ds_clean, target_idx=0, horizon_steps=1, window_lags=3, train_ratio=0.7)

        # Find exact post-train boundary timestamp: train_max_t + horizon_steps
        first_unseen_t = max(s.origin_t for s in w_clean["train_samples"]) + 1 + 1

        spiked_bundle = copy.deepcopy(clean_bundle)
        for t in range(first_unseen_t, len(spiked_bundle["feature_tensor"])):
            spike = 9999.0 if t % 2 == 0 else -9999.0
            for j in range(len(spiked_bundle["node_ids"])):
                spiked_bundle["feature_tensor"][t][j][0] = spike
                spiked_bundle["feature_tensor"][t][j][1] = spike

        ds_spiked = load_etg_ml_dataset(spiked_bundle)
        w_spiked = build_supervised_windows(ds_spiked, target_idx=0, horizon_steps=1, window_lags=3, train_ratio=0.7)

        self.assertEqual(abs(w_clean["target_mean"] - w_spiked["target_mean"]), 0.0)
        self.assertEqual(abs(w_clean["target_std"] - w_spiked["target_std"]), 0.0)
        self.assertEqual(len(w_clean["train_samples"]), len(w_spiked["train_samples"]))
        for a, b in zip(w_clean["train_samples"], w_spiked["train_samples"]):
            self.assertEqual(a.target_actual, b.target_actual)
            self.assertEqual(a.target_lags_z, b.target_lags_z)
            self.assertEqual(a.neighbor_lags_z, b.neighbor_lags_z)

    def test_trend_microscope_prefix_and_corpus_invariance_under_future_spikes(self) -> None:
        clean_bundle = _make_synthetic_bundle(num_steps=48, cutoff=36, horizon=1)
        spiked_bundle = copy.deepcopy(clean_bundle)
        for t in range(36, 48):
            for j in range(len(spiked_bundle["node_ids"])):
                spiked_bundle["feature_tensor"][t][j][0] = 9999.0 if t % 2 == 0 else -9999.0

        corpus_clean = build_microscope_training_corpus(
            live_bundle=clean_bundle, num_synthetic_graphs=8, seed=11
        )
        corpus_spiked = build_microscope_training_corpus(
            live_bundle=spiked_bundle, num_synthetic_graphs=8, seed=11
        )
        self.assertEqual(corpus_clean, corpus_spiked)

        # Prefix feature extraction invariance
        pref = [row[0][0] for row in clean_bundle["feature_tensor"][:30]]
        f1 = extract_node_microscope_features(pref, scale="month", lat=39.7, lng=-105.0)
        f2 = extract_node_microscope_features(
            [row[0][0] for row in spiked_bundle["feature_tensor"][:30]],
            scale="month",
            lat=39.7,
            lng=-105.0,
        )
        self.assertEqual(f1, f2)
        p1 = extract_pair_microscope_features(pref, [row[1][0] for row in clean_bundle["feature_tensor"][:30]])
        p2 = extract_pair_microscope_features(pref, [row[1][0] for row in spiked_bundle["feature_tensor"][:30]])
        self.assertEqual(p1, p2)


if __name__ == "__main__":
    unittest.main()
