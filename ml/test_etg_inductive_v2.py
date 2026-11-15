import copy
import sys
import unittest
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from etg_inductive_gnn import (  # noqa: E402
    PortableInductiveETGNet,
    evaluate_model_on_holdout,
    load_etg_ml_v2_dataset,
    train_and_evaluate_inductive_v2,
)
from harvest_global_multiscale import (  # noqa: E402
    build_synthetic_global_multiscale_bundle,
    inject_synthetic_community_node,
)
from l4_service.app import L4InferenceEngine  # noqa: E402


class TestEtgInductiveV2(unittest.TestCase):
    def test_harvester_builds_valid_v2_multiscale_dataset(self) -> None:
        bundle = build_synthetic_global_multiscale_bundle(num_months=60, horizon_steps=1, seed=42)
        loaded = load_etg_ml_v2_dataset(bundle)
        self.assertEqual(loaded["schema_version"], "etg-ml-v2")
        self.assertEqual(len(loaded["node_ids"]), 8)
        self.assertEqual(len(loaded["node_static_features"][0]), 16)
        self.assertEqual(len(loaded["feature_tensor"][0][0]), 8)
        self.assertEqual(len(loaded["edge_attr"][0]), 8)
        self.assertIn("month", loaded["multi_scale_blocks"])
        self.assertIn("year", loaded["multi_scale_blocks"])

    def test_portable_inductive_beats_persistence_and_roundtrips_weights(self) -> None:
        bundle = build_synthetic_global_multiscale_bundle(num_months=64, horizon_steps=1, seed=42)
        res = train_and_evaluate_inductive_v2(bundle, epochs=80, seed=42)
        metrics = res["eval_metrics"]

        self.assertGreater(metrics["eval_count"], 10)
        self.assertLess(metrics["model_rmse"], metrics["persistence_rmse"])
        self.assertGreater(metrics["skill_vs_persistence_pct"], 5.0)

        reloaded = PortableInductiveETGNet.from_portable_weights_dict(res["portable_weights"])
        metrics_reloaded = evaluate_model_on_holdout(reloaded, bundle)
        self.assertAlmostEqual(metrics["model_rmse"], metrics_reloaded["model_rmse"], places=6)

        preds = reloaded.predict_bundle(bundle)
        sample = preds[4]
        self.assertLessEqual(sample["quantiles"]["p10"], sample["quantiles"]["p50"])
        self.assertLessEqual(sample["quantiles"]["p50"], sample["quantiles"]["p90"])
        self.assertIn(sample["trendForecast"]["direction"], ("decreasing", "stable", "increasing"))
        probs = sample["trendForecast"]["probabilities"]
        self.assertAlmostEqual(
            probs["decreasing"] + probs["stable"] + probs["increasing"], 1.0, places=2
        )

    def test_zero_shot_unseen_community_node_and_trust_gate_noise_protection(self) -> None:
        bundle = build_synthetic_global_multiscale_bundle(num_months=64, horizon_steps=1, seed=42)
        res = train_and_evaluate_inductive_v2(bundle, epochs=80, seed=42)
        model: PortableInductiveETGNet = res["model"]

        # Unseen high-trust corroborated sensor vs unseen low-trust noisy sensor
        self.assertGreater(model._compute_trust_gate(0.92, True), 0.90)
        self.assertLess(model._compute_trust_gate(0.14, False), 0.05)

        target_idx = 5
        base_eval = evaluate_model_on_holdout(model, bundle, target_indices=[target_idx])

        good_bundle = inject_synthetic_community_node(
            bundle,
            node_uuid="community-unseen-verified-flux",
            target_idx=target_idx,
            informative=True,
            trust_score=0.92,
            corroborated=True,
            seed=77,
        )
        # Zero-shot forward inference on extended graph must succeed and adapt if fine-tuned
        good_preds = model.predict_bundle(good_bundle, node_indices=[target_idx])
        self.assertIn(target_idx, good_preds)

        noisy_bundle = inject_synthetic_community_node(
            bundle,
            node_uuid="community-unseen-noisy-crowd",
            target_idx=target_idx,
            informative=False,
            trust_score=0.14,
            corroborated=False,
            seed=88,
        )
        noisy_eval = evaluate_model_on_holdout(model, noisy_bundle, target_indices=[target_idx])
        # Low-trust gate must keep noisy sensor from destabilizing target holdout RMSE
        self.assertLess(
            abs(noisy_eval["model_rmse"] - base_eval["model_rmse"]),
            0.15,
        )

    def test_l4_inference_engine_predict_and_validation_rollback_guard(self) -> None:
        bundle = build_synthetic_global_multiscale_bundle(num_months=64, horizon_steps=1, seed=42)
        engine = L4InferenceEngine()
        health = engine.health()
        self.assertEqual(health["status"], "ok")

        pred = engine.predict_from_bundle(bundle, target_uuid="signal-colorado-hydrology")
        self.assertEqual(pred["engineUsed"], "l4_inductive_gnn")
        self.assertLessEqual(pred["quantiles"]["p10"], pred["quantiles"]["p50"])
        self.assertLessEqual(pred["quantiles"]["p50"], pred["quantiles"]["p90"])

        # Clean fine-tune batch should be accepted cleanly
        clean_res = engine.finetune_incremental(bundle, steps=15, lr=0.01)
        self.assertTrue(clean_res["accepted"])

        weights_before = engine.portable_model.to_portable_weights_dict()

        # Non-finite poisoned batch must be rejected and weights preserved
        nan_bundle = copy.deepcopy(bundle)
        nan_bundle["feature_tensor"][2][0][1] = float("nan")
        nan_res = engine.finetune_incremental(nan_bundle, steps=10, lr=0.02)
        self.assertFalse(nan_res["accepted"])
        self.assertEqual(engine.portable_model.to_portable_weights_dict(), weights_before)

        # Corrupted wildly noisy training targets must trigger validation rollback guard
        poisoned_bundle = copy.deepcopy(bundle)
        cutoff = int(poisoned_bundle["train_cutoff_index"])
        for t in range(cutoff - 1):
            for j in range(len(poisoned_bundle["node_ids"])):
                poisoned_bundle["labels"]["next_value_targets"][t][j] = (
                    25.0 if (t + j) % 2 == 0 else -25.0
                )
        bad_res = engine.finetune_incremental(poisoned_bundle, steps=35, lr=0.08)
        self.assertFalse(bad_res["accepted"])
        self.assertGreaterEqual(engine.health()["finetune_rollbacks"], 2)
        self.assertEqual(engine.portable_model.to_portable_weights_dict(), weights_before)


if __name__ == "__main__":
    unittest.main()
