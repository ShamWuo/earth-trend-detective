"""
PyTorch `PyTorchInductiveETGTransformer` and Trust-Gated Heterogeneous Lag-Aware GATv2
implementation for Colab Blackwell (`B200`, `bf16` + `torch.compile`) training,
GCP `L4` incremental replay-regularized adaptation, and ONNX export.
"""

from __future__ import annotations

import copy
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from inductive.portable_net import load_etg_ml_v2_dataset

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    TORCH_AVAILABLE = True
except ImportError:  # pragma: no cover - local CPU stdlib fallback
    torch = None  # type: ignore[assignment]
    nn = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    TORCH_AVAILABLE = False


if TORCH_AVAILABLE:

    class TrustGatedGATLayer(nn.Module):  # type: ignore[misc]
        """Heterogeneous lag-aware GATv2 layer with learned community trust-gating."""

        def __init__(self, d_model: int, edge_dim: int = 8, num_heads: int = 4) -> None:
            super().__init__()
            self.d_model = d_model
            self.num_heads = num_heads
            self.head_dim = d_model // num_heads
            self.q_proj = nn.Linear(d_model, d_model)
            self.k_proj = nn.Linear(d_model + edge_dim, d_model)
            self.v_proj = nn.Linear(d_model + edge_dim, d_model)
            self.attn_vec = nn.Parameter(torch.randn(num_heads, self.head_dim) * 0.05)
            self.trust_mlp = nn.Sequential(
                nn.Linear(2, 16),
                nn.GELU(),
                nn.Linear(16, 1),
            )
            self.out_proj = nn.Linear(d_model, d_model)
            self.norm = nn.LayerNorm(d_model)
            self.ffn = nn.Sequential(
                nn.Linear(d_model, d_model * 2),
                nn.GELU(),
                nn.Linear(d_model * 2, d_model),
            )
            self.norm_ffn = nn.LayerNorm(d_model)

        def forward(
            self,
            h: "torch.Tensor",
            edge_index: "torch.Tensor",
            edge_attr: "torch.Tensor",
            node_trust: "torch.Tensor",
            node_corroborated: "torch.Tensor",
            active_mask: Optional["torch.Tensor"] = None,
        ) -> "torch.Tensor":
            # h: [B, N, D], edge_index: [2, E], edge_attr: [E, 8]
            B, N, D = h.shape
            if edge_index.numel() == 0:
                return self.norm_ffn(h + self.ffn(h))

            src_idx = edge_index[0]
            dst_idx = edge_index[1]
            E = src_idx.shape[0]

            h_src = h[:, src_idx, :]  # [B, E, D]
            h_dst = h[:, dst_idx, :]  # [B, E, D]
            ea = edge_attr.unsqueeze(0).expand(B, -1, -1)
            src_edge = torch.cat([h_src, ea], dim=-1)

            q = self.q_proj(h_dst).view(B, E, self.num_heads, self.head_dim)
            k = self.k_proj(src_edge).view(B, E, self.num_heads, self.head_dim)
            v = self.v_proj(src_edge).view(B, E, self.num_heads, self.head_dim)

            raw_score = (F.leaky_relu(q + k, 0.2) * self.attn_vec.view(1, 1, self.num_heads, self.head_dim)).sum(-1)
            trust_in = torch.stack([node_trust[src_idx], node_corroborated[src_idx]], dim=-1)
            gate = torch.sigmoid(self.trust_mlp(trust_in)).view(1, E, 1)  # [1, E, 1]

            if active_mask is not None:
                src_vis = active_mask[:, src_idx].unsqueeze(-1)
                gate = gate * src_vis

            attn_weights = torch.sigmoid(raw_score) * gate
            weighted_v = (v * attn_weights.unsqueeze(-1)).view(B, E, D)

            agg = torch.zeros_like(h)
            dst_expand = dst_idx.view(1, E, 1).expand(B, E, D)
            agg.scatter_add_(1, dst_expand, weighted_v)

            deg = torch.zeros(B, N, 1, device=h.device, dtype=h.dtype)
            deg.scatter_add_(1, dst_idx.view(1, E, 1).expand(B, E, 1), attn_weights.mean(dim=-1, keepdim=True))
            agg = agg / deg.clamp(min=1.0)

            h_mid = self.norm(h + self.out_proj(agg))
            return self.norm_ffn(h_mid + self.ffn(h_mid))

    class PyTorchInductiveETGTransformer(nn.Module):  # type: ignore[misc]
        """
        Inductive Multi-Scale Spatio-Temporal Earth Trend Graph Transformer
        designed for Google Colab Blackwell (`B200`, `bf16` + `torch.compile`) training
        and hosted GCP `L4` inference + online replay-regularized adaptation.
        """

        def __init__(
            self,
            static_dim: int = 16,
            temp_dim: int = 8,
            edge_dim: int = 8,
            d_model: int = 96,
            num_layers: int = 2,
        ) -> None:
            super().__init__()
            self.d_model = d_model
            self.static_encoder = nn.Sequential(
                nn.Linear(static_dim, d_model),
                nn.GELU(),
                nn.LayerNorm(d_model),
            )
            self.temp_proj = nn.Linear(temp_dim, d_model)
            self.temp_gru = nn.GRU(d_model, d_model, batch_first=True)
            self.scale_embed = nn.Embedding(4, d_model)  # day, month, year, impulse

            self.gnn_layers = nn.ModuleList(
                [TrustGatedGATLayer(d_model, edge_dim=edge_dim, num_heads=4) for _ in range(num_layers)]
            )

            # Lightweight residual adapter for validation-gated GCP L4 incremental fine-tuning
            self.adapter_down = nn.Linear(d_model, d_model // 4)
            self.adapter_up = nn.Linear(d_model // 4, d_model)
            nn.init.zeros_(self.adapter_up.weight)
            nn.init.zeros_(self.adapter_up.bias)

            self.quantile_head = nn.Linear(d_model, 3)  # p10, p50, p90 (deltas around p50)
            self.trend_head = nn.Linear(d_model, 3)     # decreasing, stable, increasing
            self.regime_head = nn.Linear(d_model, 1)    # regime-shift logit

        def forward(
            self,
            temp_window: "torch.Tensor",       # [B, W, N, 8]
            static_feats: "torch.Tensor",      # [N, 16]
            edge_index: "torch.Tensor",        # [2, E]
            edge_attr: "torch.Tensor",         # [E, 8]
            window_mask: Optional["torch.Tensor"] = None,  # [B, W, N]
            scale_id: int = 1,
        ) -> Dict[str, "torch.Tensor"]:
            B, W, N, _ = temp_window.shape
            flat_t = temp_window.permute(0, 2, 1, 3).reshape(B * N, W, -1)
            t_emb = F.gelu(self.temp_proj(flat_t))
            gru_out, _ = self.temp_gru(t_emb)
            last_t = gru_out[:, -1, :].view(B, N, self.d_model)

            s_emb = self.static_encoder(static_feats).unsqueeze(0).expand(B, -1, -1)
            sc = self.scale_embed(
                torch.tensor(scale_id, device=temp_window.device, dtype=torch.long)
            ).view(1, 1, self.d_model)
            h = last_t + s_emb + sc

            node_trust = static_feats[:, 5]
            node_corr = static_feats[:, 7]
            active_m = window_mask[:, -1, :] if window_mask is not None else None

            for layer in self.gnn_layers:
                h = layer(h, edge_index, edge_attr, node_trust, node_corr, active_m)

            adapter_delta = self.adapter_up(F.gelu(self.adapter_down(h)))
            h_out = h + adapter_delta

            cur_z = temp_window[:, -1, :, 1]  # current step z_score
            q_raw = self.quantile_head(h_out)
            p50 = cur_z + q_raw[..., 1]
            lower = F.softplus(q_raw[..., 0]) + 0.1
            upper = F.softplus(q_raw[..., 2]) + 0.1
            quantiles = torch.stack([p50 - lower, p50, p50 + upper], dim=-1)

            trend_logits = self.trend_head(h_out)
            regime_logits = self.regime_head(h_out).squeeze(-1)
            return {
                "p50": p50,
                "quantiles": quantiles,
                "trend_logits": trend_logits,
                "regime_logits": regime_logits,
            }

    def _pinball_loss(preds_q: "torch.Tensor", target: "torch.Tensor", mask: "torch.Tensor") -> "torch.Tensor":
        taus = [0.1, 0.5, 0.9]
        total = torch.tensor(0.0, device=preds_q.device, dtype=preds_q.dtype)
        denom = mask.sum().clamp(min=1.0)
        for idx, tau in enumerate(taus):
            diff = target - preds_q[..., idx]
            loss = torch.maximum(tau * diff, (tau - 1.0) * diff)
            total = total + (loss * mask).sum() / denom
        return total / 3.0

    def _bundle_to_torch_tensors(bundle: Dict[str, Any], device: "torch.device") -> Dict[str, "torch.Tensor"]:
        feat = torch.tensor(bundle["feature_tensor"], dtype=torch.float32, device=device)
        mask = torch.tensor(bundle["mask_tensor"], dtype=torch.float32, device=device)
        static = torch.tensor(bundle["node_static_features"], dtype=torch.float32, device=device)
        edge_index = torch.tensor(bundle["edge_index"], dtype=torch.long, device=device)
        edge_attr = torch.tensor(bundle["edge_attr"], dtype=torch.float32, device=device)

        T, N, _ = feat.shape
        nv_raw = bundle["labels"]["next_value_targets"]
        tc_raw = bundle["labels"]["trend_class_targets"]
        rs_raw = bundle["labels"]["regime_shift_targets"]

        nv = torch.zeros((T, N), dtype=torch.float32, device=device)
        nv_mask = torch.zeros((T, N), dtype=torch.float32, device=device)
        tc = torch.zeros((T, N), dtype=torch.long, device=device)
        tc_mask = torch.zeros((T, N), dtype=torch.float32, device=device)
        rs = torch.zeros((T, N), dtype=torch.float32, device=device)

        for t in range(T):
            for j in range(N):
                if nv_raw[t][j] is not None:
                    nv[t, j] = float(nv_raw[t][j])
                    nv_mask[t, j] = 1.0
                if tc_raw and tc_raw[t][j] is not None:
                    tc[t, j] = int(tc_raw[t][j])
                    tc_mask[t, j] = 1.0
                if rs_raw and rs_raw[t][j] is not None:
                    rs[t, j] = float(rs_raw[t][j])

        return {
            "feat": feat,
            "mask": mask,
            "static": static,
            "edge_index": edge_index,
            "edge_attr": edge_attr,
            "nv": nv,
            "nv_mask": nv_mask,
            "tc": tc,
            "tc_mask": tc_mask,
            "rs": rs,
        }

    def train_pytorch_blackwell(
        source: Union[str, Path, Dict[str, Any]],
        epochs: int = 80,
        window_size: int = 8,
        d_model: int = 96,
        lr: float = 1.5e-3,
        compile_model: bool = True,
        device_str: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Train `PyTorchInductiveETGTransformer` optimized for Blackwell/L4 CUDA GPUs."""
        bundle = load_etg_ml_v2_dataset(source)
        if device_str:
            device = torch.device(device_str)
        elif torch.cuda.is_available():
            device = torch.device("cuda")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")

        if device.type == "cuda":
            torch.set_float32_matmul_precision("high")

        tensors = _bundle_to_torch_tensors(bundle, device)
        T = tensors["feat"].shape[0]
        cutoff = int(bundle["train_cutoff_index"])
        horizon = int(bundle["labels"].get("horizon_steps", 1))
        W = min(window_size, max(2, cutoff - horizon - 1))

        scale_map = {"day": 0, "month": 1, "year": 2}
        scale_id = scale_map.get(str(bundle.get("primary_bucket", "month")), 1)

        model = PyTorchInductiveETGTransformer(d_model=d_model).to(device)
        train_model: Any = model
        if compile_model and device.type == "cuda":
            major, _ = torch.cuda.get_device_capability(device)
            if major >= 8 and hasattr(torch, "compile"):
                train_model = torch.compile(model)

        optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
        use_bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()

        tr_origins = list(range(W - 1, max(W - 1, cutoff - horizon)))
        loss_history: List[float] = []

        def _forward_and_loss(active_mod: Any) -> "torch.Tensor":
            out = active_mod(
                windows, tensors["static"], tensors["edge_index"], tensors["edge_attr"], w_masks, scale_id
            )
            loss_p50 = ((out["p50"] - tgt_nv) ** 2 * tgt_mask).sum() / tgt_mask.sum().clamp(min=1.0)
            loss_q = _pinball_loss(out["quantiles"], tgt_nv, tgt_mask)
            loss_tc = (
                F.cross_entropy(out["trend_logits"].reshape(-1, 3), tgt_tc.reshape(-1), reduction="none")
                * tgt_tc_mask.reshape(-1)
            ).sum() / tgt_tc_mask.sum().clamp(min=1.0)
            loss_rs = (
                F.binary_cross_entropy_with_logits(out["regime_logits"], tgt_rs, reduction="none") * tgt_mask
            ).sum() / tgt_mask.sum().clamp(min=1.0)
            return loss_p50 + 0.5 * loss_q + 0.2 * loss_tc + 0.15 * loss_rs

        for _ in range(epochs):
            train_model.train()
            optimizer.zero_grad(set_to_none=True)

            windows = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in tr_origins], dim=0)
            w_masks = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in tr_origins], dim=0)
            tgt_nv = tensors["nv"][tr_origins]
            tgt_mask = tensors["nv_mask"][tr_origins]
            tgt_tc = tensors["tc"][tr_origins]
            tgt_tc_mask = tensors["tc_mask"][tr_origins]
            tgt_rs = tensors["rs"][tr_origins]

            try:
                if use_bf16:
                    with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                        loss = _forward_and_loss(train_model)
                else:
                    loss = _forward_and_loss(train_model)
            except Exception:
                if train_model is not model:
                    train_model = model
                    train_model.train()
                    if use_bf16:
                        with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                            loss = _forward_and_loss(train_model)
                    else:
                        loss = _forward_and_loss(train_model)
                else:
                    raise

            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            loss_history.append(float(loss.detach().cpu().item()))

        model.eval()
        eval_origins = [t for t in range(max(W - 1, cutoff - horizon), T) if tensors["nv_mask"][t].sum() > 0]
        eval_rmse = 0.0
        persist_rmse = 0.0
        if eval_origins:
            with torch.no_grad():
                ewin = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in eval_origins], dim=0)
                em = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in eval_origins], dim=0)
                eout = model(ewin, tensors["static"], tensors["edge_index"], tensors["edge_attr"], em, scale_id)
                t_nv = tensors["nv"][eval_origins]
                t_m = tensors["nv_mask"][eval_origins]
                c_z = ewin[:, -1, :, 1]
                eval_rmse = float(torch.sqrt(((eout["p50"] - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())
                persist_rmse = float(torch.sqrt(((c_z - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())

        skill = ((persist_rmse - eval_rmse) / persist_rmse * 100.0) if persist_rmse > 1e-9 else 0.0
        return {
            "model": model,
            "device": str(device),
            "bf16": use_bf16,
            "loss_history": loss_history,
            "eval_metrics": {
                "model_rmse": round(eval_rmse, 6),
                "persistence_rmse": round(persist_rmse, 6),
                "skill_vs_persistence_pct": round(skill, 2),
                "eval_steps": len(eval_origins),
            },
        }

    def finetune_incremental_adapter(
        model: PyTorchInductiveETGTransformer,
        bundle: Dict[str, Any],
        steps: int = 25,
        lr: float = 5e-4,
        replay_anchor_weight: float = 0.05,
        window_size: int = 8,
    ) -> Dict[str, Any]:
        """
        GCP L4 replay-regularized online adaptation with validation rollback guard.
        Freezes trunk parameters and only updates residual adapter + trust gate.
        """
        load_etg_ml_v2_dataset(bundle)
        device = next(model.parameters()).device
        tensors = _bundle_to_torch_tensors(bundle, device)
        cutoff = int(bundle["train_cutoff_index"])
        horizon = int(bundle["labels"].get("horizon_steps", 1))
        T = tensors["feat"].shape[0]
        W = min(window_size, max(2, cutoff - horizon - 1))

        valid_origins = [t for t in range(W - 1, T) if tensors["nv_mask"][t].sum() > 0]
        if len(valid_origins) < 4:
            return {"accepted": False, "reason": "Insufficient valid windows for validation-gated finetune."}

        split = max(2, int(len(valid_origins) * 0.75))
        tr_idx = valid_origins[:split]
        va_idx = valid_origins[split:]
        scale_map = {"day": 0, "month": 1, "year": 2}
        scale_id = scale_map.get(str(bundle.get("primary_bucket", "month")), 1)

        def eval_split(origins: List[int]) -> float:
            model.eval()
            with torch.no_grad():
                w_t = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in origins], dim=0)
                m_t = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in origins], dim=0)
                out = model(w_t, tensors["static"], tensors["edge_index"], tensors["edge_attr"], m_t, scale_id)
                t_nv = tensors["nv"][origins]
                t_m = tensors["nv_mask"][origins]
                return float(torch.sqrt(((out["p50"] - t_nv) ** 2 * t_m).sum() / t_m.sum().clamp(min=1.0)).cpu().item())

        val_before = eval_split(va_idx)
        prior_state = copy.deepcopy(model.state_dict())
        adapter_params = [
            p for name, p in model.named_parameters()
            if "adapter" in name or "trust_mlp" in name or "quantile_head" in name
        ]
        anchor_copies = [p.detach().clone() for p in adapter_params]
        opt = torch.optim.AdamW(adapter_params, lr=lr, weight_decay=1e-4)

        w_tr = torch.stack([tensors["feat"][t - W + 1 : t + 1] for t in tr_idx], dim=0)
        m_tr = torch.stack([tensors["mask"][t - W + 1 : t + 1] for t in tr_idx], dim=0)
        tgt_nv = tensors["nv"][tr_idx]
        tgt_m = tensors["nv_mask"][tr_idx]

        model.train()
        for _ in range(steps):
            opt.zero_grad(set_to_none=True)
            out = model(w_tr, tensors["static"], tensors["edge_index"], tensors["edge_attr"], m_tr, scale_id)
            mse = ((out["p50"] - tgt_nv) ** 2 * tgt_m).sum() / tgt_m.sum().clamp(min=1.0)
            anchor_pen = sum(((p - a) ** 2).mean() for p, a in zip(adapter_params, anchor_copies))
            loss = mse + replay_anchor_weight * anchor_pen
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapter_params, 1.0)
            opt.step()

        val_after = eval_split(va_idx)
        if not math.isfinite(val_after) or val_after > val_before * 1.01:
            model.load_state_dict(prior_state)
            return {
                "accepted": False,
                "val_rmse_before": round(val_before, 6),
                "val_rmse_after": round(val_after, 6) if math.isfinite(val_after) else None,
                "rollback_reason": "Validation RMSE degraded or became non-finite; rolled back.",
            }

        return {
            "accepted": True,
            "val_rmse_before": round(val_before, 6),
            "val_rmse_after": round(val_after, 6),
        }

    def export_pytorch_onnx(
        model: PyTorchInductiveETGTransformer,
        bundle: Dict[str, Any],
        out_path: Union[str, Path],
        window_size: int = 8,
    ) -> Path:
        """Export trained PyTorch Inductive ETG Transformer to ONNX on CPU cleanly."""
        out_file = Path(out_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        cpu_device = torch.device("cpu")
        cpu_model = copy.deepcopy(model).to(cpu_device).eval()
        tensors = _bundle_to_torch_tensors(bundle, cpu_device)
        W = min(window_size, tensors["feat"].shape[0])
        dummy_win = tensors["feat"][:W].unsqueeze(0)
        dummy_mask = tensors["mask"][:W].unsqueeze(0)

        class _OnnxWrapper(nn.Module):
            def __init__(self, inner: PyTorchInductiveETGTransformer) -> None:
                super().__init__()
                self.inner = inner

            def forward(
                self,
                win: "torch.Tensor",
                st: "torch.Tensor",
                ei: "torch.Tensor",
                ea: "torch.Tensor",
                mk: "torch.Tensor",
            ) -> Tuple["torch.Tensor", "torch.Tensor", "torch.Tensor"]:
                o = self.inner(win, st, ei, ea, mk, 1)
                return o["quantiles"], o["trend_logits"], o["regime_logits"]

        wrapper = _OnnxWrapper(cpu_model).eval()
        export_kwargs: Dict[str, Any] = {
            "input_names": ["temp_window", "static_feats", "edge_index", "edge_attr", "window_mask"],
            "output_names": ["quantiles", "trend_logits", "regime_logits"],
            "dynamic_axes": {"temp_window": {0: "batch", 2: "num_nodes"}, "static_feats": {0: "num_nodes"}},
            "opset_version": 17,
        }
        try:
            torch.onnx.export(
                wrapper,
                (dummy_win, tensors["static"], tensors["edge_index"], tensors["edge_attr"], dummy_mask),
                str(out_file),
                dynamo=False,
                **export_kwargs,
            )
        except TypeError:
            torch.onnx.export(
                wrapper,
                (dummy_win, tensors["static"], tensors["edge_index"], tensors["edge_attr"], dummy_mask),
                str(out_file),
                **export_kwargs,
            )
        return out_file
