import json
import math
import random
import sys
import unittest
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent
if str(ML_DIR) not in sys.path:
    sys.path.insert(0, str(ML_DIR))

from etg_trend_microscope import (  # noqa: E402
    NODE_FEATURE_DIM,
    PAIR_FEATURE_DIM,
    WEIGHTS_SCHEMA_V1,
    PortableTrendMicroscope,
    build_microscope_training_corpus,
    evaluate_microscope_benchmarks,
    evaluate_real_historical_microscope,
    extract_node_microscope_features,
    extract_pair_microscope_features,
)
from harvest_global_multiscale import build_synthetic_global_multiscale_bundle  # noqa: E402
from l4_service.app import L4InferenceEngine  # noqa: E402


class TestEtgTrendMicroscope(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = build_microscope_training_corpus(num_synthetic_graphs=80, seed=42)
        cls.model = PortableTrendMicroscope(hidden_dim=32, seed=42)
        cls.model.fit_portable(cls.corpus["train"], epochs=28, lr=0.036, seed=42)

    def test_feature_shapes_and_causal_pre_t_invariance(self) -> None:
        base_u = [math.sin(2.0 * math.pi * k / 12.0) + 0.04 * k for k in range(36)]
        base_v = [math.cos(2.0 * math.pi * k / 12.0) - 0.02 * k for k in range(36)]
        # Slice at t = 23 vs extended mutated suffix after t = 23
        feat_u = extract_node_microscope_features(base_u[:24], scale="month", lat=40.0, lng=-105.0, full_len=24)
        self.assertEqual(len(feat_u), NODE_FEATURE_DIM)
        feat_u_same_prefix = extract_node_microscope_features(
            (base_u[:24] + [9999.0, -9999.0])[:24],
            scale="month",
            lat=40.0,
            lng=-105.0,
            full_len=24,
        )
        self.assertEqual(feat_u, feat_u_same_prefix)

        feat_pair = extract_pair_microscope_features(
            base_u[:24],
            base_v[:24],
            u_lat=40.0,
            u_lng=-105.0,
            v_lat=-33.0,
            v_lng=-70.0,
            scale="month",
        )
        self.assertEqual(len(feat_pair), PAIR_FEATURE_DIM)

    def test_holdout_beats_classical_mann_kendall_and_raw_pearson(self) -> None:
        bench = evaluate_microscope_benchmarks(self.model, self.corpus["val"])
        self.assertGreater(bench["early_onset_auroc"], bench["classical_mk_auroc"])
        self.assertGreater(bench["early_onset_auroc"], 0.80)
        self.assertGreater(bench["pre_mk_recall_on_fresh_breaks"], 0.65)
        self.assertGreater(bench["true_link_auroc"], bench["raw_pearson_auroc"])
        self.assertGreater(bench["true_link_auroc"], 0.80)
        self.assertGreater(bench["illusion_rejection_rate"], 0.70)
        self.assertLess(bench["dealias_simplex_mae"], 0.25)
        self.assertGreater(bench["false_trend_f1"], 0.75)

    def test_rejects_seasonal_illusions_detects_opposite_dipole_and_dealiases_cycle(self) -> None:
        rng = random.Random(123)
        T = 56
        # 0: NH seasonal illusion, 1: SH inverse seasonal illusion (|r_raw| ~ 0.98)
        nh = [2.5 * math.sin(2.0 * math.pi * t / 12.0) + rng.gauss(0.0, 0.12) for t in range(T)]
        sh = [-2.5 * math.sin(2.0 * math.pi * t / 12.0) + rng.gauss(0.0, 0.12) for t in range(T)]

        # 2: Stochastic ENSO driver -> 3: Opposite lag-2 responder
        drv_innov = [rng.gauss(0.0, 0.55) for _ in range(T)]
        for t in range(1, T):
            drv_innov[t] = 0.55 * drv_innov[t - 1] + rng.gauss(0.0, 0.45)
        enso = [0.35 * math.sin(2.0 * math.pi * t / 12.0) + drv_innov[t] for t in range(T)]
        basin_opp = [
            0.35 * math.sin(2.0 * math.pi * t / 12.0 + 1.1) - 1.25 * drv_innov[max(0, t - 2)] + rng.gauss(0.0, 0.22)
            for t in range(T)
        ]

        # 4: Multi-year oscillation sampled on steep upward arc -> cycle false-trend
        cyc = [2.2 * math.sin(2.0 * math.pi * t / 30.0 + 3.4) + rng.gauss(0.0, 0.15) for t in range(T)]

        # 5: Uncorroborated noisy community sensor with sudden calibration step glitch
        glitch = [rng.gauss(0.0, 0.2) + (2.9 if t >= T - 4 else 0.0) for t in range(T)]

        metas = [
            {"uuid": "nh", "name": "NH Season", "lat": 52.0, "lng": 10.0, "temporal_scale": "month", "trust_score": 0.9, "is_community": False, "corroborated": True},
            {"uuid": "sh", "name": "SH Season", "lat": -42.0, "lng": -65.0, "temporal_scale": "month", "trust_score": 0.9, "is_community": False, "corroborated": True},
            {"uuid": "enso", "name": "ENSO Mode", "lat": 0.0, "lng": -140.0, "temporal_scale": "month", "trust_score": 0.95, "is_community": False, "corroborated": True},
            {"uuid": "basin", "name": "Opposite Basin", "lat": 38.0, "lng": -110.0, "temporal_scale": "month", "trust_score": 0.9, "is_community": False, "corroborated": True},
            {"uuid": "cyc", "name": "Decadal Cycle", "lat": 20.0, "lng": -30.0, "temporal_scale": "month", "trust_score": 0.9, "is_community": False, "corroborated": True},
            {"uuid": "glitch", "name": "Noisy DIY Sensor", "lat": 35.0, "lng": 5.0, "temporal_scale": "month", "trust_score": 0.14, "is_community": True, "corroborated": False},
        ]

        # Trust gate separation
        self.assertGreater(self.model.compute_trust_gate(0.92, True, True), 0.85)
        self.assertLess(self.model.compute_trust_gate(0.14, False, True), 0.12)

        scan = self.model.scan_graph(metas, [nh, sh, enso, basin_opp, cyc, glitch], top_k=12)
        illusions = {(l["sourceUuid"], l["targetUuid"]): l for l in scan["suppressedIllusions"]}
        self.assertIn(("nh", "sh"), illusions)
        self.assertGreater(illusions[("nh", "sh")]["confounderProb"], 0.60)
        self.assertLess(illusions[("nh", "sh")]["trueCouplingProb"], 0.40)

        verified = {(l["sourceUuid"], l["targetUuid"]): l for l in scan["verifiedCouplings"]}
        self.assertIn(("enso", "basin"), verified)
        self.assertEqual(verified[("enso", "basin")]["polarity"], "drives_opposite")
        self.assertGreaterEqual(verified[("enso", "basin")]["optimalLagSteps"], 1)

        node_by_id = {n["uuid"]: n for n in scan["nodes"]}
        self.assertGreater(node_by_id["cyc"]["dealiasing"]["falseTrendProb"], 0.50)
        self.assertGreater(node_by_id["cyc"]["dealiasing"]["oscillationShare"], 0.45)
        self.assertGreater(node_by_id["glitch"]["dealiasing"]["falseTrendProb"], 0.50)
        self.assertLess(node_by_id["glitch"]["trustGate"], 0.12)

    def test_weight_roundtrip_and_l4_engine_scan_microscope(self) -> None:
        weights = self.model.to_weights_dict()
        self.assertEqual(weights["schema_version"], WEIGHTS_SCHEMA_V1)
        reloaded = PortableTrendMicroscope.from_weights_dict(json.loads(json.dumps(weights)))

        bundle = build_synthetic_global_multiscale_bundle(num_months=60, horizon_steps=1, seed=42)
        scan_a = self.model.scan_v2_bundle(bundle)
        scan_b = reloaded.scan_v2_bundle(bundle)
        self.assertEqual(len(scan_a["nodes"]), len(scan_b["nodes"]))
        for na, nb in zip(scan_a["nodes"], scan_b["nodes"]):
            self.assertEqual(na["uuid"], nb["uuid"])
            self.assertEqual(na["radarBadge"], nb["radarBadge"])
            self.assertEqual(na["preMannKendallAlert"], nb["preMannKendallAlert"])
            self.assertEqual(na["emergingDirection"], nb["emergingDirection"])
            self.assertAlmostEqual(na["onsetProb"], nb["onsetProb"], delta=1e-3)
            self.assertAlmostEqual(na["leadStepsAhead"], nb["leadStepsAhead"], delta=1e-2)
            self.assertAlmostEqual(na["trustGate"], nb["trustGate"], delta=1e-3)
            for k in ("secularShare", "oscillationShare", "artifactShare", "falseTrendProb"):
                self.assertAlmostEqual(na["dealiasing"][k], nb["dealiasing"][k], delta=1e-3)
        self.assertEqual(len(scan_a["verifiedCouplings"]), len(scan_b["verifiedCouplings"]))
        for ca, cb in zip(scan_a["verifiedCouplings"], scan_b["verifiedCouplings"]):
            self.assertEqual(ca["sourceUuid"], cb["sourceUuid"])
            self.assertEqual(ca["targetUuid"], cb["targetUuid"])
            self.assertEqual(ca["polarity"], cb["polarity"])
            self.assertAlmostEqual(ca["trueCouplingProb"], cb["trueCouplingProb"], delta=1e-3)

        reloaded_2 = PortableTrendMicroscope.from_weights_dict(json.loads(json.dumps(reloaded.to_weights_dict())))
        self.assertEqual(scan_b, reloaded_2.scan_v2_bundle(bundle))

        engine = L4InferenceEngine()
        l4_scan = engine.scan_microscope(bundle, top_k=6)
        self.assertEqual(l4_scan["schemaVersion"], WEIGHTS_SCHEMA_V1)
        self.assertEqual(l4_scan["nodeCount"], 8)
        self.assertIn("ETG Trend Microscope", l4_scan["aiPerceptionBrief"])

    def test_real_historical_nasa_noaa_nsidc_knmi_benchmark(self) -> None:
        weights_path = ML_DIR / "weights" / "etg-trend-microscope-v1.json"
        if weights_path.exists():
            shipped = PortableTrendMicroscope.from_weights_dict(
                json.loads(weights_path.read_text(encoding="utf-8"))
            )
            res = evaluate_real_historical_microscope(shipped)
            self.assertTrue(res["allSecularChecksPassed"], f"Real check details: {res['nodes']}")
        res_local = evaluate_real_historical_microscope(self.model)
        self.assertGreaterEqual(res_local["secularChecksPassed"], 3)


if __name__ == "__main__":
    unittest.main()
