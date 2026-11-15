"""
PyTorch Blackwell (`bf16`) Transformer teacher and GPU knowledge distillation
into portable `etg-trend-microscope-v1` weights.
"""

from __future__ import annotations

import copy
from pathlib import Path
import random
from typing import Any, Dict, List, Optional, Union

from microscope.corpus_and_benchmarks import evaluate_microscope_benchmarks
from microscope.features import (
    NODE_FEATURE_DIM,
    NODE_FEATURE_NAMES,
    PAIR_FEATURE_DIM,
    PAIR_FEATURE_NAMES,
    WEIGHTS_SCHEMA_V1,
    _clamp,
)
from microscope.portable_model import PortableTrendMicroscope

try:  # pragma: no cover - optional GPU/PyTorch dependency (present on Colab/L4)
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    TORCH_AVAILABLE = False


if TORCH_AVAILABLE:  # pragma: no cover - optional Colab / GPU path

    class PyTorchTrendMicroscope(nn.Module):  # type: ignore[misc]
        """Deep Transformer teacher with cross-node & bilinear pair attention for Blackwell GPU."""

        def __init__(self, d_model: int = 128, nhead: int = 4, num_layers: int = 2) -> None:
            super().__init__()
            self.d_model = d_model
            self.node_in = nn.Sequential(
                nn.Linear(NODE_FEATURE_DIM, d_model),
                nn.GELU(),
                nn.LayerNorm(d_model),
            )
            enc_layer = nn.TransformerEncoderLayer(
                d_model=d_model,
                nhead=nhead,
                dim_feedforward=d_model * 2,
                dropout=0.1,
                batch_first=True,
                activation="gelu",
            )
            self.graph_tx = nn.TransformerEncoder(enc_layer, num_layers=num_layers)
            self.pair_mlp = nn.Sequential(
                nn.Linear(d_model * 2 + PAIR_FEATURE_DIM, d_model),
                nn.GELU(),
                nn.Linear(d_model, d_model),
                nn.GELU(),
            )
            self.inflection_head = nn.Linear(d_model, 5)
            self.dealias_head = nn.Linear(d_model, 4)
            self.coupling_head = nn.Linear(d_model, 11)

        def forward(
            self,
            x_nodes: "torch.Tensor",
            pair_src: "torch.Tensor",
            pair_dst: "torch.Tensor",
            x_pairs: "torch.Tensor",
        ) -> Dict[str, "torch.Tensor"]:
            h0 = self.node_in(x_nodes).unsqueeze(0)
            h_tx = self.graph_tx(h0).squeeze(0)
            pair_in = torch.cat([h_tx[pair_src], h_tx[pair_dst], x_pairs], dim=-1)
            m_pair = self.pair_mlp(pair_in)
            return {
                "inflection": self.inflection_head(h_tx),
                "dealias": self.dealias_head(h_tx),
                "coupling": self.coupling_head(m_pair),
            }

    class DistillablePortableMicroscope(nn.Module):  # type: ignore[misc]
        """PyTorch mirror of `PortableTrendMicroscope` for GPU knowledge distillation."""

        def __init__(self, hidden_dim: int = 32) -> None:
            super().__init__()
            self.hidden_dim = hidden_dim
            self.w_trust = nn.Parameter(torch.tensor(4.0))
            self.w_corroborated = nn.Parameter(torch.tensor(1.8))
            self.w_community = nn.Parameter(torch.tensor(-0.25))
            self.gate_bias = nn.Parameter(torch.tensor(-2.55))

            self.node_enc1 = nn.Linear(NODE_FEATURE_DIM, hidden_dim)
            self.edge_enc1 = nn.Linear(hidden_dim * 2 + PAIR_FEATURE_DIM, hidden_dim)
            self.edge_attn = nn.Linear(hidden_dim, 1)
            self.node_enc2 = nn.Linear(hidden_dim * 2, hidden_dim)
            self.inflection_head = nn.Linear(hidden_dim, 5)
            self.dealias_head = nn.Linear(hidden_dim, 4)
            self.coupling_head = nn.Linear(hidden_dim, 11)

        def forward(
            self,
            x_nodes: "torch.Tensor",
            pair_src: "torch.Tensor",
            pair_dst: "torch.Tensor",
            x_pairs: "torch.Tensor",
        ) -> Dict[str, "torch.Tensor"]:
            n = x_nodes.shape[0]
            gate_logits = (
                self.w_trust.clamp(3.8, 4.2) * x_nodes[:, 16]
                + self.w_corroborated.clamp(1.7, 2.1) * x_nodes[:, 18]
                + self.w_community.clamp(-0.35, -0.25) * x_nodes[:, 17]
                + self.gate_bias.clamp(-2.70, -2.55)
            )
            gates = torch.sigmoid(gate_logits)
            h0 = torch.tanh(self.node_enc1(x_nodes))

            pair_in = torch.cat([h0[pair_src], h0[pair_dst], x_pairs], dim=-1)
            m_pair = torch.tanh(self.edge_enc1(pair_in))
            clean_peak = x_pairs[:, 4:8].abs().amax(dim=-1)
            rel_pair = ((clean_peak - 0.28) / 0.72).clamp(0.0, 1.0)
            a_pair = gates[pair_src] * rel_pair * torch.sigmoid(self.edge_attn(m_pair).squeeze(-1))

            weighted_msg = a_pair.float().unsqueeze(-1) * m_pair.float()
            ctx_acc = torch.zeros((n, h0.shape[-1]), device=h0.device, dtype=torch.float32)
            ctx_acc.index_add_(0, pair_dst, weighted_msg)
            denom = torch.ones((n, 1), device=h0.device, dtype=torch.float32)
            denom.index_add_(0, pair_dst, a_pair.float().unsqueeze(-1))
            ctx = (ctx_acc / denom).to(h0.dtype)

            h_nodes = torch.tanh(self.node_enc2(torch.cat([h0, ctx], dim=-1)))
            return {
                "inflection": self.inflection_head(h_nodes),
                "dealias": self.dealias_head(h_nodes),
                "coupling": self.coupling_head(m_pair),
            }

        def to_portable(self, summary: Optional[Dict[str, Any]] = None) -> PortableTrendMicroscope:
            def _extract(lin: nn.Linear) -> Dict[str, Any]:
                return {
                    "weight": lin.weight.detach().cpu().tolist(),
                    "bias": lin.bias.detach().cpu().tolist(),
                }

            payload = {
                "schema_version": WEIGHTS_SCHEMA_V1,
                "hidden_dim": self.hidden_dim,
                "node_feature_names": list(NODE_FEATURE_NAMES),
                "pair_feature_names": list(PAIR_FEATURE_NAMES),
                "trust_gate": {
                    "w_trust": float(_clamp(self.w_trust.detach().cpu().item(), 3.8, 4.2)),
                    "w_corroborated": float(_clamp(self.w_corroborated.detach().cpu().item(), 1.7, 2.1)),
                    "w_community": float(_clamp(self.w_community.detach().cpu().item(), -0.35, -0.25)),
                    "bias": float(_clamp(self.gate_bias.detach().cpu().item(), -2.70, -2.55)),
                },
                "node_enc1": _extract(self.node_enc1),
                "edge_enc1": _extract(self.edge_enc1),
                "edge_attn": _extract(self.edge_attn),
                "node_enc2": _extract(self.node_enc2),
                "inflection_head": _extract(self.inflection_head),
                "dealias_head": _extract(self.dealias_head),
                "coupling_head": _extract(self.coupling_head),
                "training_summary": summary or {},
            }
            return PortableTrendMicroscope.from_weights_dict(payload)

    def _pack_graph_torch(g: Dict[str, Any], dev: "torch.device") -> Dict[str, Any]:
        x_nodes = torch.tensor(g["node_features"], dtype=torch.float32, device=dev)
        pairs_sorted = sorted(g["pair_features"].keys())
        p_src = torch.tensor([uv[0] for uv in pairs_sorted], dtype=torch.long, device=dev)
        p_dst = torch.tensor([uv[1] for uv in pairs_sorted], dtype=torch.long, device=dev)
        x_pairs = torch.tensor([g["pair_features"][uv] for uv in pairs_sorted], dtype=torch.float32, device=dev)

        nt = g["node_targets"]
        t_onset = torch.tensor([float(x["onset"]) for x in nt], dtype=torch.float32, device=dev)
        t_dir = torch.tensor([int(x["direction"]) for x in nt], dtype=torch.long, device=dev)
        t_lead = torch.tensor([float(x["lead_steps"]) for x in nt], dtype=torch.float32, device=dev)
        t_shares = torch.tensor([x["shares"] for x in nt], dtype=torch.float32, device=dev)
        t_false = torch.tensor([float(x["false_trend"]) for x in nt], dtype=torch.float32, device=dev)

        pt = g["pair_targets"]
        t_coup = torch.tensor([float(pt[uv]["true_coupling"]) for uv in pairs_sorted], dtype=torch.float32, device=dev)
        t_pol = torch.tensor([int(pt[uv]["polarity"]) for uv in pairs_sorted], dtype=torch.long, device=dev)
        t_lag = torch.tensor([int(pt[uv]["lag"]) for uv in pairs_sorted], dtype=torch.long, device=dev)
        t_conf = torch.tensor([float(pt[uv]["confounder"]) for uv in pairs_sorted], dtype=torch.float32, device=dev)
        return {
            "x_nodes": x_nodes,
            "pair_src": p_src,
            "pair_dst": p_dst,
            "x_pairs": x_pairs,
            "t_onset": t_onset,
            "t_dir": t_dir,
            "t_lead": t_lead,
            "t_shares": t_shares,
            "t_false": t_false,
            "t_coup": t_coup,
            "t_pol": t_pol,
            "t_lag": t_lag,
            "t_conf": t_conf,
        }

    def _compute_multitask_loss(
        out: Dict[str, "torch.Tensor"],
        batch: Dict[str, Any],
        teacher_out: Optional[Dict[str, "torch.Tensor"]] = None,
    ) -> "torch.Tensor":
        inf_o = out["inflection"].float()
        dea_o = out["dealias"].float()
        cou_o = out["coupling"].float()

        l_on = F.binary_cross_entropy_with_logits(inf_o[:, 0], batch["t_onset"])
        l_dir = F.cross_entropy(inf_o[:, 1:4], batch["t_dir"])
        lead_pred = F.softplus(inf_o[:, 4]).reshape(-1)
        on_mask = batch["t_onset"] > 0.5
        l_lead = F.smooth_l1_loss(lead_pred[on_mask], batch["t_lead"][on_mask]) if on_mask.any() else inf_o.sum() * 0.0

        log_sh = F.log_softmax(dea_o[:, :3], dim=-1)
        l_sh = -(batch["t_shares"] * log_sh).sum(dim=-1).mean()
        l_fl = F.binary_cross_entropy_with_logits(dea_o[:, 3], batch["t_false"])

        l_coup = F.binary_cross_entropy_with_logits(cou_o[:, 0], batch["t_coup"])
        l_pol = F.cross_entropy(cou_o[:, 1:4], batch["t_pol"])
        c_mask = batch["t_coup"] > 0.5
        l_lag = F.cross_entropy(cou_o[c_mask, 4:10], batch["t_lag"][c_mask]) if c_mask.any() else cou_o.sum() * 0.0
        l_conf = F.binary_cross_entropy_with_logits(cou_o[:, 10], batch["t_conf"])

        gt_loss = 1.2 * l_on + 0.7 * l_dir + 0.1 * l_lead + 1.2 * l_sh + 1.1 * l_fl + 1.3 * l_coup + 0.9 * l_pol + 0.6 * l_lag + 1.2 * l_conf
        if teacher_out is None:
            return gt_loss

        with torch.no_grad():
            t_inf = teacher_out["inflection"].float()
            t_dea = teacher_out["dealias"].float()
            t_cou = teacher_out["coupling"].float()

        kd_on = F.binary_cross_entropy_with_logits(inf_o[:, 0], torch.sigmoid(t_inf[:, 0]))
        kd_dir = F.kl_div(F.log_softmax(inf_o[:, 1:4], dim=-1), F.softmax(t_inf[:, 1:4], dim=-1), reduction="batchmean")
        kd_sh = F.kl_div(F.log_softmax(dea_o[:, :3], dim=-1), F.softmax(t_dea[:, :3], dim=-1), reduction="batchmean")
        kd_fl = F.binary_cross_entropy_with_logits(dea_o[:, 3], torch.sigmoid(t_dea[:, 3]))
        kd_c = F.binary_cross_entropy_with_logits(cou_o[:, 0], torch.sigmoid(t_cou[:, 0]))
        kd_p = F.kl_div(F.log_softmax(cou_o[:, 1:4], dim=-1), F.softmax(t_cou[:, 1:4], dim=-1), reduction="batchmean")
        kd_cf = F.binary_cross_entropy_with_logits(cou_o[:, 10], torch.sigmoid(t_cou[:, 10]))
        kd_loss = kd_on + kd_dir + kd_sh + kd_fl + kd_c + kd_p + kd_cf
        return 0.6 * gt_loss + 0.4 * kd_loss

    def train_blackwell_microscope_and_distill(
        corpus: Dict[str, List[Dict[str, Any]]],
        teacher_epochs: int = 45,
        distill_epochs: int = 55,
        d_model: int = 128,
        lr: float = 1.8e-3,
        compile_model: bool = True,
        device_str: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Train Transformer teacher on CUDA/bf16 and distill into PortableTrendMicroscope."""
        if device_str is None:
            dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            dev = torch.device(device_str)
        use_bf16 = dev.type == "cuda" and torch.cuda.is_bf16_supported()
        amp_dtype = torch.bfloat16 if use_bf16 else torch.float32

        packed_train = [_pack_graph_torch(g, dev) for g in corpus["train"]]
        teacher = PyTorchTrendMicroscope(d_model=d_model, nhead=4, num_layers=2).to(dev)
        active_teacher: Any = teacher
        if compile_model and dev.type == "cuda" and hasattr(torch, "compile"):
            try:
                active_teacher = torch.compile(teacher)
            except Exception:
                active_teacher = teacher

        opt_t = torch.optim.AdamW(teacher.parameters(), lr=lr, weight_decay=2e-4)
        sched_t = torch.optim.lr_scheduler.CosineAnnealingLR(opt_t, T_max=max(1, teacher_epochs))
        teacher_losses: List[float] = []

        rng = random.Random(42)
        for ep in range(teacher_epochs):
            rng.shuffle(packed_train)
            teacher.train()
            ep_loss = 0.0
            for b in packed_train:
                opt_t.zero_grad(set_to_none=True)
                try:
                    with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                        out = active_teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                        loss = _compute_multitask_loss(out, b)
                except Exception:
                    active_teacher = teacher
                    with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                        out = active_teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                        loss = _compute_multitask_loss(out, b)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(teacher.parameters(), 2.0)
                opt_t.step()
                ep_loss += float(loss.detach().cpu().item())
            sched_t.step()
            teacher_losses.append(round(ep_loss / max(1, len(packed_train)), 4))

        teacher.eval()
        student = DistillablePortableMicroscope(hidden_dim=32).to(dev)
        opt_s = torch.optim.AdamW(student.parameters(), lr=lr * 1.4, weight_decay=1e-4)
        sched_s = torch.optim.lr_scheduler.CosineAnnealingLR(opt_s, T_max=max(1, distill_epochs))
        distill_losses: List[float] = []

        for ep in range(distill_epochs):
            rng.shuffle(packed_train)
            student.train()
            ep_loss = 0.0
            for b in packed_train:
                opt_s.zero_grad(set_to_none=True)
                with torch.no_grad():
                    t_out = teacher(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=use_bf16):
                    s_out = student(b["x_nodes"], b["pair_src"], b["pair_dst"], b["x_pairs"])
                    loss = _compute_multitask_loss(s_out, b, teacher_out=t_out)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(student.parameters(), 2.0)
                opt_s.step()
                ep_loss += float(loss.detach().cpu().item())
            sched_s.step()
            distill_losses.append(round(ep_loss / max(1, len(packed_train)), 4))

        student.eval()
        portable = student.to_portable({"device": str(dev), "bf16": use_bf16, "distilled_from_d_model": d_model})
        bench = evaluate_microscope_benchmarks(portable, corpus["val"])
        portable.training_summary["benchmarks"] = bench
        return {
            "teacher": teacher,
            "student": student,
            "portable_model": portable,
            "portable_weights": portable.to_weights_dict(),
            "device": str(dev),
            "bf16": use_bf16,
            "teacher_loss_history": teacher_losses,
            "distill_loss_history": distill_losses,
            "benchmarks": bench,
        }

    def export_microscope_onnx(
        model: "nn.Module",
        sample_graph: Dict[str, Any],
        out_path: Union[str, Path],
    ) -> Path:
        target = Path(out_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        cpu_model = copy.deepcopy(model).cpu().eval()
        packed = _pack_graph_torch(sample_graph, torch.device("cpu"))
        args = (packed["x_nodes"], packed["pair_src"], packed["pair_dst"], packed["x_pairs"])
        export_kwargs: Dict[str, Any] = {
            "input_names": ["x_nodes", "pair_src", "pair_dst", "x_pairs"],
            "output_names": ["inflection", "dealias", "coupling"],
            "dynamic_axes": {
                "x_nodes": {0: "num_nodes"},
                "pair_src": {0: "num_edges"},
                "pair_dst": {0: "num_edges"},
                "x_pairs": {0: "num_edges"},
            },
            "opset_version": 17,
        }
        try:
            torch.onnx.export(cpu_model, args, str(target), dynamo=False, **export_kwargs)
        except TypeError:
            torch.onnx.export(cpu_model, args, str(target), **export_kwargs)
        return target
