"""
Pure-Python portable 3-head perceptual ETG Trend Microscope (`PortableTrendMicroscope`).
Zero third-party dependencies for inference and pure-Python mini-batch Adam training.
"""

from __future__ import annotations

import copy
import math
from operator import mul
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

from microscope.features import (
    NODE_FEATURE_DIM,
    NODE_FEATURE_NAMES,
    PAIR_FEATURE_DIM,
    PAIR_FEATURE_NAMES,
    WEIGHTS_SCHEMA_V1,
    _clamp,
    _sigmoid,
    _softmax,
    _softplus,
    extract_node_microscope_features,
    extract_pair_microscope_features,
)


def _matvec(mat: List[List[float]], bias: List[float], x: Sequence[float]) -> List[float]:
    return [sum(map(mul, row, x)) + b for row, b in zip(mat, bias)]


def _tanh_vec(xs: Sequence[float]) -> List[float]:
    return [math.tanh(_clamp(v, -20.0, 20.0)) for v in xs]


def _init_linear(out_dim: int, in_dim: int, rng: random.Random, scale: float = 0.25) -> Dict[str, Any]:
    s = scale / math.sqrt(max(1, in_dim))
    return {
        "weight": [[round(rng.gauss(0.0, s), 6) for _ in range(in_dim)] for _ in range(out_dim)],
        "bias": [0.0 for _ in range(out_dim)],
    }


def _classify_radar_badge(
    onset_prob: float,
    mk_z_norm: float,
    shares: Sequence[float],
    false_trend_prob: float,
) -> str:
    sec_share, cyc_share, art_share = shares[0], shares[1], shares[2]
    if false_trend_prob >= 0.52:
        return "SENSOR_GLITCH_RISK" if art_share >= cyc_share else "FALSE_TREND_CYCLE"
    if onset_prob >= 0.55:
        return "EARLY_ONSET" if mk_z_norm < 0.49 else "SECULAR_ACCELERATION"
    if sec_share >= 0.55 and mk_z_norm >= 0.45:
        return "SECULAR_ACCELERATION"
    return "NOMINAL"


class PortableTrendMicroscope:
    """
    Pure-Python portable 3-head perceptual Trend Microscope (`etg-trend-microscope-v1`).
    Matches the GPU-distilled `DistillablePortableMicroscope` and TypeScript engine 1:1.
    """

    def __init__(
        self,
        hidden_dim: int = 32,
        seed: int = 42,
        weights: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.hidden_dim = hidden_dim
        if weights is not None:
            self.load_weights_dict(weights)
        else:
            rng = random.Random(seed)
            self.trust_gate = {
                "w_trust": 4.0,
                "w_corroborated": 1.8,
                "w_community": -0.25,
                "bias": -2.55,
            }
            self.node_enc1 = _init_linear(hidden_dim, NODE_FEATURE_DIM, rng, 0.8)
            self.edge_enc1 = _init_linear(hidden_dim, hidden_dim * 2 + PAIR_FEATURE_DIM, rng, 0.8)
            self.edge_attn = _init_linear(1, hidden_dim, rng, 0.5)
            self.node_enc2 = _init_linear(hidden_dim, hidden_dim * 2, rng, 0.8)
            self.inflection_head = _init_linear(5, hidden_dim, rng, 0.5)
            self.dealias_head = _init_linear(4, hidden_dim, rng, 0.5)
            self.coupling_head = _init_linear(11, hidden_dim, rng, 0.5)
            self.training_summary: Dict[str, Any] = {}

    def clone(self) -> "PortableTrendMicroscope":
        return PortableTrendMicroscope.from_weights_dict(self.to_weights_dict())

    def compute_trust_gate(self, trust_score: float, corroborated: bool, is_community: bool = False) -> float:
        tg = self.trust_gate
        logit = (
            float(tg["w_trust"]) * float(trust_score)
            + float(tg["w_corroborated"]) * (1.0 if corroborated else 0.0)
            + float(tg["w_community"]) * (1.0 if is_community else 0.0)
            + float(tg["bias"])
        )
        return _sigmoid(logit)

    def load_weights_dict(self, data: Dict[str, Any]) -> None:
        self.hidden_dim = int(data.get("hidden_dim", 32))
        self.trust_gate = copy.deepcopy(data["trust_gate"])
        self.node_enc1 = copy.deepcopy(data["node_enc1"])
        self.edge_enc1 = copy.deepcopy(data["edge_enc1"])
        self.edge_attn = copy.deepcopy(data["edge_attn"])
        self.node_enc2 = copy.deepcopy(data["node_enc2"])
        self.inflection_head = copy.deepcopy(data["inflection_head"])
        self.dealias_head = copy.deepcopy(data["dealias_head"])
        self.coupling_head = copy.deepcopy(data["coupling_head"])
        self.training_summary = copy.deepcopy(data.get("training_summary", {}))

    @classmethod
    def from_weights_dict(cls, data: Dict[str, Any]) -> "PortableTrendMicroscope":
        if data.get("schema_version") != WEIGHTS_SCHEMA_V1:
            raise ValueError(f"Expected {WEIGHTS_SCHEMA_V1} weights, got {data.get('schema_version')}")
        return cls(hidden_dim=int(data.get("hidden_dim", 32)), weights=data)

    def to_weights_dict(self) -> Dict[str, Any]:
        def _round_layer(layer: Dict[str, Any]) -> Dict[str, Any]:
            return {
                "weight": [[round(float(v), 6) for v in row] for row in layer["weight"]],
                "bias": [round(float(b), 6) for b in layer["bias"]],
            }

        return {
            "schema_version": WEIGHTS_SCHEMA_V1,
            "hidden_dim": self.hidden_dim,
            "node_feature_names": list(NODE_FEATURE_NAMES),
            "pair_feature_names": list(PAIR_FEATURE_NAMES),
            "trust_gate": {k: round(float(v), 6) for k, v in self.trust_gate.items()},
            "node_enc1": _round_layer(self.node_enc1),
            "edge_enc1": _round_layer(self.edge_enc1),
            "edge_attn": _round_layer(self.edge_attn),
            "node_enc2": _round_layer(self.node_enc2),
            "inflection_head": _round_layer(self.inflection_head),
            "dealias_head": _round_layer(self.dealias_head),
            "coupling_head": _round_layer(self.coupling_head),
            "training_summary": copy.deepcopy(self.training_summary),
        }

    def forward_graph(
        self,
        node_features: Sequence[Sequence[float]],
        pair_features: Dict[Tuple[int, int], Sequence[float]],
    ) -> Dict[str, Any]:
        """Exact deterministic forward pass matching DistillablePortableMicroscope & TypeScript."""
        n = len(node_features)
        h_dim = self.hidden_dim
        gates = [
            self.compute_trust_gate(
                trust_score=float(x[16]),
                corroborated=float(x[18]) >= 0.5,
                is_community=float(x[17]) >= 0.5,
            )
            for x in node_features
        ]
        h0 = [_tanh_vec(_matvec(self.node_enc1["weight"], self.node_enc1["bias"], x)) for x in node_features]

        ctx = [[0.0] * h_dim for _ in range(n)]
        denom = [1.0] * n
        edge_msgs: Dict[Tuple[int, int], List[float]] = {}
        edge_attns: Dict[Tuple[int, int], float] = {}

        for (u, v), xp in pair_features.items():
            if u == v:
                continue
            inp = h0[u] + h0[v] + list(xp)
            m_uv = _tanh_vec(_matvec(self.edge_enc1["weight"], self.edge_enc1["bias"], inp))
            a_raw = _matvec(self.edge_attn["weight"], self.edge_attn["bias"], m_uv)[0]
            rel_uv = _clamp((max(abs(float(xp[4 + k])) for k in range(4)) - 0.28) / 0.72, 0.0, 1.0)
            a_uv = gates[u] * rel_uv * _sigmoid(a_raw)
            edge_msgs[(u, v)] = m_uv
            edge_attns[(u, v)] = a_uv
            denom[v] += a_uv
            cv = ctx[v]
            for d in range(h_dim):
                cv[d] += a_uv * m_uv[d]

        for v in range(n):
            inv = 1.0 / denom[v]
            ctx[v] = [c * inv for c in ctx[v]]

        h_nodes = [
            _tanh_vec(_matvec(self.node_enc2["weight"], self.node_enc2["bias"], h0[v] + ctx[v]))
            for v in range(n)
        ]

        node_outputs: List[Dict[str, Any]] = []
        for v in range(n):
            inf_out = _matvec(self.inflection_head["weight"], self.inflection_head["bias"], h_nodes[v])
            dea_out = _matvec(self.dealias_head["weight"], self.dealias_head["bias"], h_nodes[v])
            onset_prob = _sigmoid(inf_out[0])
            dir_probs = _softmax(inf_out[1:4])
            lead_steps = _clamp(_softplus(inf_out[4]), 0.0, 12.0)
            shares = _softmax(dea_out[:3])
            false_prob = _sigmoid(dea_out[3])
            mk_norm = float(node_features[v][10])
            badge = _classify_radar_badge(onset_prob, mk_norm, shares, false_prob)
            node_outputs.append(
                {
                    "index": v,
                    "trustGate": round(gates[v], 4),
                    "onsetProb": round(onset_prob, 4),
                    "directionProbs": {
                        "decreasing": round(dir_probs[0], 4),
                        "steady": round(dir_probs[1], 4),
                        "increasing": round(dir_probs[2], 4),
                    },
                    "leadSteps": round(lead_steps, 2),
                    "dealiasing": {
                        "secularShare": round(shares[0], 4),
                        "oscillationShare": round(shares[1], 4),
                        "artifactShare": round(shares[2], 4),
                        "falseTrendProb": round(false_prob, 4),
                    },
                    "radarBadge": badge,
                    "raw_logits": {
                        "inflection": inf_out,
                        "dealias": dea_out,
                    },
                }
            )

        pair_outputs: Dict[Tuple[int, int], Dict[str, Any]] = {}
        for (u, v), m_uv in edge_msgs.items():
            c_out = _matvec(self.coupling_head["weight"], self.coupling_head["bias"], m_uv)
            true_prob = _sigmoid(c_out[0])
            pol_probs = _softmax(c_out[1:4])  # [opposite, none, co_trending]
            lag_probs = _softmax(c_out[4:10])  # lag 0..5
            conf_prob = _sigmoid(c_out[10])
            best_lag = max(range(6), key=lambda k: lag_probs[k])
            pol = (
                "drives_opposite"
                if pol_probs[0] >= pol_probs[1] and pol_probs[0] >= pol_probs[2]
                else "co_trending"
                if pol_probs[2] >= pol_probs[1]
                else "none"
            )
            pair_outputs[(u, v)] = {
                "src": u,
                "dst": v,
                "attentionWeight": round(edge_attns[(u, v)], 4),
                "trueCouplingProb": round(true_prob, 4),
                "polarity": pol,
                "polarityProbs": {
                    "drives_opposite": round(pol_probs[0], 4),
                    "none": round(pol_probs[1], 4),
                    "co_trending": round(pol_probs[2], 4),
                },
                "optimalLagSteps": best_lag,
                "lagProbs": [round(p, 4) for p in lag_probs],
                "confounderProb": round(conf_prob, 4),
                "raw_logits": c_out,
            }

        return {
            "nodes": node_outputs,
            "pairs": pair_outputs,
        }

    def scan_graph(
        self,
        nodes_meta: Sequence[Dict[str, Any]],
        nodes_series: Sequence[Sequence[float]],
        existing_edges: Optional[Sequence[Tuple[int, int]]] = None,
        focus_idx: Optional[int] = None,
        top_k: int = 8,
    ) -> Dict[str, Any]:
        """Run full 3-head Trend Microscope scan and emit structured AI cue cards."""
        n = len(nodes_meta)
        x_nodes = [
            extract_node_microscope_features(
                nodes_series[i],
                scale=str(nodes_meta[i].get("temporal_scale", "month")),
                lat=float(nodes_meta[i].get("lat", 0.0)),
                lng=float(nodes_meta[i].get("lng", 0.0)),
                trust_score=float(nodes_meta[i].get("trust_score", 0.8)),
                is_community=bool(nodes_meta[i].get("is_community", False)),
                corroborated=bool(nodes_meta[i].get("corroborated", False)),
            )
            for i in range(n)
        ]

        x_pairs: Dict[Tuple[int, int], List[float]] = {}
        for u in range(n):
            for v in range(n):
                if u == v:
                    continue
                if focus_idx is not None and u != focus_idx and v != focus_idx and n > 12:
                    continue
                su, sv = nodes_series[u], nodes_series[v]
                m_len = min(len(su), len(sv))
                pair_scale = str(nodes_meta[v].get("temporal_scale", "month"))
                x_pairs[(u, v)] = extract_pair_microscope_features(
                    su[-m_len:] if m_len > 0 else [],
                    sv[-m_len:] if m_len > 0 else [],
                    u_lat=float(nodes_meta[u].get("lat", 0.0)),
                    u_lng=float(nodes_meta[u].get("lng", 0.0)),
                    v_lat=float(nodes_meta[v].get("lat", 0.0)),
                    v_lng=float(nodes_meta[v].get("lng", 0.0)),
                    u_trust=float(nodes_meta[u].get("trust_score", 0.8)),
                    v_trust=float(nodes_meta[v].get("trust_score", 0.8)),
                    scale=pair_scale,
                )

        raw_out = self.forward_graph(x_nodes, x_pairs)
        existing_set = set(existing_edges or [])

        node_cues: List[Dict[str, Any]] = []
        for idx, n_out in enumerate(raw_out["nodes"]):
            meta = nodes_meta[idx]
            x_n = x_nodes[idx]
            mk_z = round(x_n[10] * 4.0, 3)
            de = n_out["dealiasing"]
            dp = n_out["directionProbs"]
            best_dir = (
                "increasing"
                if dp["increasing"] >= dp["decreasing"] and dp["increasing"] >= dp["steady"]
                else "decreasing"
                if dp["decreasing"] >= dp["steady"]
                else "stable"
            )
            pre_mk = n_out["onsetProb"] >= 0.55 and mk_z < 1.96
            cue_str = (
                f"[{meta.get('name', meta.get('uuid', idx))}] badge={n_out['radarBadge']} | "
                f"onset={n_out['onsetProb']*100:.0f}% ({'PRE-MK' if pre_mk else f'MK |Z|={mk_z:.2f}'}) | "
                f"attrib: {de['secularShare']*100:.0f}% secular / {de['oscillationShare']*100:.0f}% cycle / "
                f"{de['artifactShare']*100:.0f}% noise (false_prob={de['falseTrendProb']*100:.0f}%)"
            )
            node_cues.append(
                {
                    "uuid": str(meta.get("uuid", f"node-{idx}")),
                    "name": str(meta.get("name", f"Node {idx}")),
                    "radarBadge": n_out["radarBadge"],
                    "onsetProb": n_out["onsetProb"],
                    "preMannKendallAlert": pre_mk,
                    "mkAbsZ": mk_z,
                    "emergingDirection": best_dir,
                    "leadStepsAhead": n_out["leadSteps"],
                    "dealiasing": de,
                    "trustGate": n_out["trustGate"],
                    "aiCue": cue_str,
                }
            )

        verified_links: List[Dict[str, Any]] = []
        illusions: List[Dict[str, Any]] = []
        for (u, v), p_out in raw_out["pairs"].items():
            if focus_idx is not None and u != focus_idx and v != focus_idx:
                continue
            mu, mv = nodes_meta[u], nodes_meta[v]
            xp = x_pairs[(u, v)]
            raw_peak = max((xp[k] for k in range(4)), key=lambda c: abs(c))
            clean_peak = max((xp[4 + k] for k in range(4)), key=lambda c: abs(c))
            item = {
                "sourceUuid": str(mu.get("uuid", f"node-{u}")),
                "targetUuid": str(mv.get("uuid", f"node-{v}")),
                "sourceName": str(mu.get("name", f"Node {u}")),
                "targetName": str(mv.get("name", f"Node {v}")),
                "alreadyWired": (u, v) in existing_set or (v, u) in existing_set,
                "trueCouplingProb": p_out["trueCouplingProb"],
                "confounderProb": p_out["confounderProb"],
                "polarity": p_out["polarity"],
                "optimalLagSteps": p_out["optimalLagSteps"],
                "rawPeakR": round(raw_peak, 3),
                "cleanPeakR": round(clean_peak, 3),
                "aiCue": (
                    f"{mu.get('name')} -> {mv.get('name')}: {p_out['polarity']} "
                    f"(P_true={p_out['trueCouplingProb']*100:.0f}%, lag={p_out['optimalLagSteps']}, "
                    f"P_illusion={p_out['confounderProb']*100:.0f}%, raw_r={raw_peak:+.2f}, clean_r={clean_peak:+.2f})"
                ),
            }
            if p_out["trueCouplingProb"] >= 0.55 and p_out["polarity"] != "none" and p_out["confounderProb"] < 0.55:
                verified_links.append(item)
            elif p_out["confounderProb"] >= 0.55 and abs(raw_peak) >= 0.45:
                illusions.append(item)

        verified_links.sort(key=lambda x: x["trueCouplingProb"], reverse=True)
        illusions.sort(key=lambda x: x["confounderProb"], reverse=True)

        onsets = sorted([c for c in node_cues if c["onsetProb"] >= 0.52], key=lambda x: x["onsetProb"], reverse=True)
        alerts = sorted(
            [c for c in node_cues if c["dealiasing"]["falseTrendProb"] >= 0.52],
            key=lambda x: x["dealiasing"]["falseTrendProb"],
            reverse=True,
        )

        brief_lines = [
            f"ETG Trend Microscope ({WEIGHTS_SCHEMA_V1}) — {n} nodes scanned:",
            "Emerging Onsets: " + (", ".join(c["aiCue"] for c in onsets[:3]) if onsets else "None flagged."),
            "Verified Lagged/Dipole Couplings: "
            + (", ".join(l["aiCue"] for l in verified_links[:3]) if verified_links else "None above gate."),
            "Suppressed Confounder Illusions: "
            + (", ".join(l["aiCue"] for l in illusions[:3]) if illusions else "None detected."),
            "Cycle / Sensor-Drift Alerts: " + (", ".join(c["aiCue"] for c in alerts[:3]) if alerts else "None."),
        ]

        return {
            "schemaVersion": WEIGHTS_SCHEMA_V1,
            "nodeCount": n,
            "nodes": node_cues,
            "verifiedCouplings": verified_links[:top_k],
            "suppressedIllusions": illusions[:top_k],
            "aiPerceptionBrief": "\n".join(brief_lines),
        }

    def scan_v2_bundle(
        self,
        bundle: Dict[str, Any],
        focus_uuid: Optional[str] = None,
        top_k: int = 8,
    ) -> Dict[str, Any]:
        """Convenience wrapper accepting an `etg-ml-v2` JSON bundle."""
        node_ids = bundle.get("node_ids", [])
        meta_list = bundle.get("node_metadata", [])
        feat_t = bundle.get("feature_tensor", [])
        mask_t = bundle.get("mask_tensor", [])
        n = len(node_ids)
        series_by_node: List[List[float]] = []
        for j in range(n):
            vals = [float(feat_t[t][j][0]) for t in range(len(feat_t)) if mask_t[t][j] == 1]
            series_by_node.append(vals)

        edge_index = bundle.get("edge_index", [[], []])
        existing_edges = list(zip(edge_index[0], edge_index[1])) if len(edge_index) == 2 else []
        focus_idx = node_ids.index(focus_uuid) if focus_uuid and focus_uuid in node_ids else None
        return self.scan_graph(
            meta_list,
            series_by_node,
            existing_edges=existing_edges,
            focus_idx=focus_idx,
            top_k=top_k,
        )

    def fit_portable(
        self,
        graphs: Sequence[Dict[str, Any]],
        epochs: int = 40,
        lr: float = 0.04,
        seed: int = 42,
        batch_size: int = 8,
    ) -> Dict[str, Any]:
        """
        Pure-Python analytical backpropagation + mini-batch Adam optimizer over `graphs`.
        Allows full calibration without PyTorch while keeping exact weight layout.
        """
        rng = random.Random(seed)
        h_dim = self.hidden_dim

        layers = [
            ("node_enc1", self.node_enc1),
            ("edge_enc1", self.edge_enc1),
            ("edge_attn", self.edge_attn),
            ("node_enc2", self.node_enc2),
            ("inflection_head", self.inflection_head),
            ("dealias_head", self.dealias_head),
            ("coupling_head", self.coupling_head),
        ]
        m_w = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
        v_w = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
        m_b = {k: [0.0] * len(layer["bias"]) for k, layer in layers}
        v_b = {k: [0.0] * len(layer["bias"]) for k, layer in layers}

        order = list(range(len(graphs)))
        loss_history: List[float] = []
        step_t = 0
        b1, b2, eps = 0.9, 0.999, 1e-8
        weight_decay = 1e-4

        for ep in range(epochs):
            rng.shuffle(order)
            total_loss = 0.0
            lr_t = lr * (0.5 ** (ep / max(1, epochs * 0.75)))
            for batch_start in range(0, len(order), batch_size):
                batch_ids = order[batch_start : batch_start + batch_size]
                gw = {k: [[0.0] * len(layer["weight"][0]) for _ in layer["weight"]] for k, layer in layers}
                gb = {k: [0.0] * len(layer["bias"]) for k, layer in layers}
                batch_scale = 1.0 / max(1, len(batch_ids))

                for g_idx in batch_ids:
                    g = graphs[g_idx]
                    x_nodes = g["node_features"]
                    x_pairs = g["pair_features"]
                    n = len(x_nodes)
                    if n == 0:
                        continue

                    gates = [
                        self.compute_trust_gate(
                            float(x[16]),
                            float(x[18]) >= 0.5,
                            float(x[17]) >= 0.5,
                        )
                        for x in x_nodes
                    ]
                    h0 = [_tanh_vec(_matvec(self.node_enc1["weight"], self.node_enc1["bias"], x)) for x in x_nodes]

                    ctx = [[0.0] * h_dim for _ in range(n)]
                    denom = [1.0] * n
                    edge_cache: List[Tuple[int, int, List[float], List[float], float, float, float]] = []
                    ew = self.edge_enc1["weight"]
                    eb = self.edge_enc1["bias"]
                    aw = self.edge_attn["weight"]
                    ab = self.edge_attn["bias"]
                    for (u, v), xp in x_pairs.items():
                        if u == v:
                            continue
                        inp = h0[u] + h0[v] + list(xp)
                        m_uv = _tanh_vec(_matvec(ew, eb, inp))
                        a_raw = _matvec(aw, ab, m_uv)[0]
                        sig_a = _sigmoid(a_raw)
                        rel_uv = _clamp((max(abs(float(xp[4 + k])) for k in range(4)) - 0.28) / 0.72, 0.0, 1.0)
                        a_uv = gates[u] * rel_uv * sig_a
                        denom[v] += a_uv
                        cv = ctx[v]
                        for d in range(h_dim):
                            cv[d] += a_uv * m_uv[d]
                        edge_cache.append((u, v, inp, m_uv, sig_a, a_uv, rel_uv))

                    for v in range(n):
                        inv = 1.0 / denom[v]
                        ctx[v] = [c * inv for c in ctx[v]]

                    h2_inp = [h0[v] + ctx[v] for v in range(n)]
                    n2w = self.node_enc2["weight"]
                    n2b = self.node_enc2["bias"]
                    h_nodes = [_tanh_vec(_matvec(n2w, n2b, h2_inp[v])) for v in range(n)]

                    d_h0 = [[0.0] * h_dim for _ in range(n)]
                    d_ctx = [[0.0] * h_dim for _ in range(n)]
                    inv_n = batch_scale / max(1, n)
                    iw = self.inflection_head["weight"]
                    ib = self.inflection_head["bias"]
                    dw = self.dealias_head["weight"]
                    db = self.dealias_head["bias"]

                    for v in range(n):
                        hv = h_nodes[v]
                        inf_out = _matvec(iw, ib, hv)
                        dea_out = _matvec(dw, db, hv)

                        tgt_onset = float(g["node_targets"][v]["onset"])
                        tgt_dir = int(g["node_targets"][v]["direction"])
                        tgt_lead = float(g["node_targets"][v]["lead_steps"])
                        tgt_shares = g["node_targets"][v]["shares"]
                        tgt_false = float(g["node_targets"][v]["false_trend"])

                        p_on = _sigmoid(inf_out[0])
                        p_dir = _softmax(inf_out[1:4])
                        lead_pred = _softplus(inf_out[4])
                        sig_lead = _sigmoid(inf_out[4])
                        p_sh = _softmax(dea_out[:3])
                        p_false = _sigmoid(dea_out[3])

                        l_on = -(tgt_onset * math.log(max(1e-7, p_on)) + (1.0 - tgt_onset) * math.log(max(1e-7, 1.0 - p_on)))
                        l_dir = -math.log(max(1e-7, p_dir[tgt_dir]))
                        l_lead = 0.08 * (lead_pred - tgt_lead) ** 2 if tgt_onset > 0.5 else 0.0
                        l_sh = -sum(tgt_shares[k] * math.log(max(1e-7, p_sh[k])) for k in range(3))
                        l_fl = -(tgt_false * math.log(max(1e-7, p_false)) + (1.0 - tgt_false) * math.log(max(1e-7, 1.0 - p_false)))
                        total_loss += (1.2 * l_on + 0.7 * l_dir + l_lead + 1.2 * l_sh + 1.1 * l_fl) / max(1, n)

                        d_inf = [
                            1.2 * (p_on - tgt_onset) * inv_n,
                            0.7 * (p_dir[0] - (1.0 if tgt_dir == 0 else 0.0)) * inv_n,
                            0.7 * (p_dir[1] - (1.0 if tgt_dir == 1 else 0.0)) * inv_n,
                            0.7 * (p_dir[2] - (1.0 if tgt_dir == 2 else 0.0)) * inv_n,
                            (0.16 * (lead_pred - tgt_lead) * sig_lead if tgt_onset > 0.5 else 0.0) * inv_n,
                        ]
                        d_dea = [
                            1.2 * (p_sh[0] - tgt_shares[0]) * inv_n,
                            1.2 * (p_sh[1] - tgt_shares[1]) * inv_n,
                            1.2 * (p_sh[2] - tgt_shares[2]) * inv_n,
                            1.1 * (p_false - tgt_false) * inv_n,
                        ]

                        d_hv = [0.0] * h_dim
                        for o in range(5):
                            do = d_inf[o]
                            gb["inflection_head"][o] += do
                            row = iw[o]
                            gw_row = gw["inflection_head"][o]
                            for d in range(h_dim):
                                gw_row[d] += do * hv[d]
                                d_hv[d] += do * row[d]

                        for o in range(4):
                            do = d_dea[o]
                            gb["dealias_head"][o] += do
                            row = dw[o]
                            gw_row = gw["dealias_head"][o]
                            for d in range(h_dim):
                                gw_row[d] += do * hv[d]
                                d_hv[d] += do * row[d]

                        inp2 = h2_inp[v]
                        dh0v = d_h0[v]
                        dctxv = d_ctx[v]
                        for o in range(h_dim):
                            dz = d_hv[o] * (1.0 - hv[o] * hv[o])
                            gb["node_enc2"][o] += dz
                            row = n2w[o]
                            gw_row = gw["node_enc2"][o]
                            for d in range(h_dim):
                                gw_row[d] += dz * inp2[d]
                                gw_row[h_dim + d] += dz * inp2[h_dim + d]
                                dh0v[d] += dz * row[d]
                                dctxv[d] += dz * row[h_dim + d]

                    inv_e = batch_scale / max(1, len(edge_cache))
                    pair_targets = g["pair_targets"]
                    cw = self.coupling_head["weight"]
                    cb = self.coupling_head["bias"]
                    gcw = gw["coupling_head"]
                    gcb = gb["coupling_head"]
                    gew = gw["edge_enc1"]
                    geb = gb["edge_enc1"]
                    gaw = gw["edge_attn"][0]
                    aw0 = aw[0]

                    for u, v, inp_e, m_uv, sig_a, a_uv, rel_uv in edge_cache:
                        d_m = [0.0] * h_dim
                        inv_den = 1.0 / denom[v]
                        da_uv = 0.0
                        cv = ctx[v]
                        d_cv = d_ctx[v]
                        scale_m = a_uv * inv_den
                        for d in range(h_dim):
                            dcv_d = d_cv[d]
                            d_m[d] += dcv_d * scale_m
                            da_uv += dcv_d * (m_uv[d] - cv[d]) * inv_den
                        da_raw = da_uv * gates[u] * rel_uv * sig_a * (1.0 - sig_a)
                        gb["edge_attn"][0] += da_raw
                        for d in range(h_dim):
                            gaw[d] += da_raw * m_uv[d]
                            d_m[d] += da_raw * aw0[d]

                        pt = pair_targets.get((u, v))
                        if pt is not None:
                            c_out = _matvec(cw, cb, m_uv)
                            p_coup = _sigmoid(c_out[0])
                            p_pol = _softmax(c_out[1:4])
                            p_lag = _softmax(c_out[4:10])
                            p_conf = _sigmoid(c_out[10])

                            t_coup = float(pt["true_coupling"])
                            t_pol = int(pt["polarity"])
                            t_lag = int(pt["lag"])
                            t_conf = float(pt["confounder"])

                            l_c = -(t_coup * math.log(max(1e-7, p_coup)) + (1.0 - t_coup) * math.log(max(1e-7, 1.0 - p_coup)))
                            l_p = -math.log(max(1e-7, p_pol[t_pol]))
                            l_l = -math.log(max(1e-7, p_lag[t_lag])) if t_coup > 0.5 else 0.0
                            l_cf = -(t_conf * math.log(max(1e-7, p_conf)) + (1.0 - t_conf) * math.log(max(1e-7, 1.0 - p_conf)))
                            total_loss += (1.3 * l_c + 0.9 * l_p + 0.6 * l_l + 1.2 * l_cf) / max(1, len(edge_cache))

                            d_c = [
                                1.3 * (p_coup - t_coup) * inv_e,
                                0.9 * (p_pol[0] - (1.0 if t_pol == 0 else 0.0)) * inv_e,
                                0.9 * (p_pol[1] - (1.0 if t_pol == 1 else 0.0)) * inv_e,
                                0.9 * (p_pol[2] - (1.0 if t_pol == 2 else 0.0)) * inv_e,
                            ] + [
                                (0.6 * (p_lag[k] - (1.0 if t_lag == k else 0.0)) if t_coup > 0.5 else 0.0) * inv_e
                                for k in range(6)
                            ] + [1.2 * (p_conf - t_conf) * inv_e]

                            for o in range(11):
                                do = d_c[o]
                                gcb[o] += do
                                row = cw[o]
                                gw_row = gcw[o]
                                for d in range(h_dim):
                                    gw_row[d] += do * m_uv[d]
                                    d_m[d] += do * row[d]

                        dh0u = d_h0[u]
                        dh0v = d_h0[v]
                        len_inp = len(inp_e)
                        for o in range(h_dim):
                            mv_o = m_uv[o]
                            dz = d_m[o] * (1.0 - mv_o * mv_o)
                            geb[o] += dz
                            row = ew[o]
                            gw_row = gew[o]
                            for d in range(len_inp):
                                gw_row[d] += dz * inp_e[d]
                            for d in range(h_dim):
                                dh0u[d] += dz * row[d]
                                dh0v[d] += dz * row[h_dim + d]

                    n1b = gb["node_enc1"]
                    n1gw = gw["node_enc1"]
                    for v in range(n):
                        hv0 = h0[v]
                        xv = x_nodes[v]
                        dh0v = d_h0[v]
                        for o in range(h_dim):
                            dz = dh0v[o] * (1.0 - hv0[o] * hv0[o])
                            n1b[o] += dz
                            gw_row = n1gw[o]
                            for d in range(NODE_FEATURE_DIM):
                                gw_row[d] += dz * xv[d]

                # Mini-batch Adam update
                step_t += 1
                corr1 = 1.0 - b1 ** step_t
                corr2 = 1.0 - b2 ** step_t
                for name, layer in layers:
                    w_mat = layer["weight"]
                    b_vec = layer["bias"]
                    g_mat = gw[name]
                    gb_vec = gb[name]
                    mw_mat, vw_mat = m_w[name], v_w[name]
                    mb_vec, vb_vec = m_b[name], v_b[name]
                    for o in range(len(b_vec)):
                        gbo = _clamp(gb_vec[o], -5.0, 5.0)
                        mb_vec[o] = b1 * mb_vec[o] + (1.0 - b1) * gbo
                        vb_vec[o] = b2 * vb_vec[o] + (1.0 - b2) * gbo * gbo
                        b_vec[o] -= lr_t * (mb_vec[o] / corr1) / (math.sqrt(vb_vec[o] / corr2) + eps)
                        w_row = w_mat[o]
                        g_row = g_mat[o]
                        mw_row, vw_row = mw_mat[o], vw_mat[o]
                        for d in range(len(w_row)):
                            gwd = _clamp(g_row[d] + weight_decay * w_row[d], -5.0, 5.0)
                            mw_row[d] = b1 * mw_row[d] + (1.0 - b1) * gwd
                            vw_row[d] = b2 * vw_row[d] + (1.0 - b2) * gwd * gwd
                            w_row[d] -= lr_t * (mw_row[d] / corr1) / (math.sqrt(vw_row[d] / corr2) + eps)

            loss_history.append(round(total_loss / max(1, len(graphs)), 4))

        return {"loss_history": loss_history, "epochs": epochs}
