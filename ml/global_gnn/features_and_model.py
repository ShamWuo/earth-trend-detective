"""
Shared feature extraction and PyTorch `ETGGlobalSpatiotemporalGNN` (`~2.1M` params).

Designed for 1-to-1 numeric parity with TypeScript CPU inference (`src/lib/solar/globalGnnInference.ts`),
strictly causal windowing (`<= t`), and compact `fp16` + `ONNX` export.
"""

from __future__ import annotations

from datetime import datetime
import math
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

WINDOW_LEN = 7
NUM_NODES = 7
F_NODE = 26
F_EDGE = 10
F_PHYS = 16
QUANTILE_TAUS = (0.10, 0.267857, 0.50, 0.90)  # Q_0.268 = Newsvendor 0.075 / 0.280


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 6371.0 * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def _bearing_rad(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lng2 - lng1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.atan2(y, x)


def _tetens_vpd_kpa(t2m_c: float, rh_pct: float) -> float:
    es = 0.61078 * math.exp((17.27 * t2m_c) / max(10.0, t2m_c + 237.3))
    return max(0.0, es * max(0.0, 1.0 - rh_pct / 100.0))


def _day_of_year(iso_date: str) -> int:
    try:
        return datetime.strptime(iso_date[:10], "%Y-%m-%d").timetuple().tm_yday
    except ValueError:
        return 180


def build_city_graph_tensors(
    city: Dict[str, Any],
    start_date: str = "2019-01-01",
    end_date: str = "2026-12-31",
) -> Dict[str, Any]:
    """
    Build strictly causal windowed tensors for a 7-node city subgraph.
    All inputs at origin `t` depend ONLY on observations at indices `<= t`
    plus astronomical `clrsky_next` and `doy_next` for `t + 1`.
    """
    nodes = city["nodes"]
    dates: List[str] = city["dates"]
    rows_by_node = city["rows_by_node"]
    assert len(nodes) == NUM_NODES, f"Expected 7 nodes, got {len(nodes)}"

    T = len(dates)
    node_ids = [n["id"] for n in nodes]
    node_series = [rows_by_node[nid] for nid in node_ids]

    # Precompute causal soil wetness proxy per node
    soil_proxy = np.zeros((T, NUM_NODES), dtype=np.float32)
    for j in range(NUM_NODES):
        s_val = 0.22
        for t in range(T):
            pr = float(node_series[j][t].get("precip", 0.0))
            s_val = max(0.05, min(0.65, 0.90 * s_val + 0.015 * pr))
            soil_proxy[t, j] = s_val

    # Directed edges (all src != dst across 7 nodes -> 42 edges)
    edge_pairs: List[Tuple[int, int]] = []
    edge_static: List[Tuple[float, float, float, float, float]] = []
    for dst in range(NUM_NODES):
        d_node = nodes[dst]
        for src in range(NUM_NODES):
            if src == dst:
                continue
            s_node = nodes[src]
            dist_km = _haversine_km(
                float(d_node["lat"]), float(d_node["lng"]),
                float(s_node["lat"]), float(s_node["lng"]),
            )
            brg = _bearing_rad(
                float(d_node["lat"]), float(d_node["lng"]),
                float(s_node["lat"]), float(s_node["lng"]),
            )
            elev_diff = (float(s_node.get("elevation_m", 0.0)) - float(d_node.get("elevation_m", 0.0))) / 2000.0
            is_to_target = 1.0 if dst == 0 else 0.0
            edge_pairs.append((src, dst))
            edge_static.append((dist_km / 150.0, brg, math.sin(brg), math.cos(brg), elev_diff, is_to_target))

    edge_index_np = np.array([[p[0] for p in edge_pairs], [p[1] for p in edge_pairs]], dtype=np.int64)

    windows_list: List[np.ndarray] = []
    edge_attr_list: List[np.ndarray] = []
    phys_list: List[np.ndarray] = []
    y_allsky_list: List[float] = []
    y_kt_list: List[float] = []
    y_clrsky_next_list: List[float] = []
    y_aux_list: List[List[float]] = []  # [t2m_next/35, vpd_next/4, precip_next>1mm]
    origin_dates: List[str] = []
    next_dates: List[str] = []

    for t in range(WINDOW_LEN - 1, T - 1):
        next_d = dates[t + 1]
        if next_d < start_date or next_d > end_date:
            continue

        doy_next = _day_of_year(next_d)
        ang_next = (2.0 * math.pi * doy_next) / 365.25
        sin_doy_n = math.sin(ang_next)
        cos_doy_n = math.cos(ang_next)

        # Build [W, N, F_NODE]
        win = np.zeros((WINDOW_LEN, NUM_NODES, F_NODE), dtype=np.float32)
        for w_i, s in enumerate(range(t - WINDOW_LEN + 1, t + 1)):
            for j in range(NUM_NODES):
                r = node_series[j][s]
                r1 = node_series[j][max(0, s - 1)]
                r2 = node_series[j][max(0, s - 2)]
                kt0 = float(r["kt"])
                kt1 = float(r1["kt"])
                kt2 = float(r2["kt"])
                clr_next_j = float(node_series[j][t + 1]["clrsky"])
                t2m_j = float(r["t2m"])
                rh_j = float(r["rh2m"])
                wd_rad = math.radians(float(r["wd10m"]))
                ewd_rad = math.radians(float(r["eve_wd"]))

                win[w_i, j, 0] = kt0
                win[w_i, j, 1] = kt0 - kt1
                win[w_i, j, 2] = kt0 - kt2
                win[w_i, j, 3] = (kt0 + kt1 + kt2) / 3.0
                win[w_i, j, 4] = float(r["clrsky"]) / 10.0
                win[w_i, j, 5] = clr_next_j / 10.0
                win[w_i, j, 6] = sin_doy_n
                win[w_i, j, 7] = cos_doy_n
                win[w_i, j, 8] = abs(float(nodes[j]["lat"])) / 90.0
                win[w_i, j, 9] = float(nodes[j].get("elevation_m", 0.0)) / 3000.0
                win[w_i, j, 10] = t2m_j / 35.0
                win[w_i, j, 11] = rh_j / 100.0
                win[w_i, j, 12] = _tetens_vpd_kpa(t2m_j, rh_j) / 4.0
                win[w_i, j, 13] = float(soil_proxy[s, j])
                win[w_i, j, 14] = math.log1p(max(0.0, float(r["precip"]))) / 3.0
                win[w_i, j, 15] = float(r["ws10m"]) / 15.0
                win[w_i, j, 16] = math.sin(wd_rad)
                win[w_i, j, 17] = math.cos(wd_rad)
                win[w_i, j, 18] = float(r["eve_cloud"]) / 100.0
                win[w_i, j, 19] = float(r["eve_cloud23"]) / 100.0
                win[w_i, j, 20] = float(r["eve_rh"]) / 100.0
                win[w_i, j, 21] = float(r["eve_ws"]) / 15.0
                win[w_i, j, 22] = math.sin(ewd_rad)
                win[w_i, j, 23] = max(-1.5, min(1.5, float(r["eve_ps_trend"]) / 10.0))
                win[w_i, j, 24] = math.cos(ewd_rad)
                win[w_i, j, 25] = (float(r.get("ps", 90.0)) - 90.0) / 20.0

        # Edge features [E, F_EDGE] at day t
        e_mat = np.zeros((len(edge_pairs), F_EDGE), dtype=np.float32)
        for e_i, ((src, dst), (d_norm, brg, s_brg, c_brg, el_d, to_tgt)) in enumerate(
            zip(edge_pairs, edge_static)
        ):
            rs = node_series[src][t]
            rd = node_series[dst][t]
            w_day = max(0.0, math.cos(math.radians(float(rd["wd10m"])) - brg))
            w_eve = max(0.0, math.cos(math.radians(float(rd["eve_wd"])) - brg))
            upslope = max(0.0, math.sin(math.radians(float(rd["eve_wd"])))) * (float(rs["eve_rh"]) / 100.0)
            e_mat[e_i, 0] = d_norm
            e_mat[e_i, 1] = s_brg
            e_mat[e_i, 2] = c_brg
            e_mat[e_i, 3] = el_d
            e_mat[e_i, 4] = w_day
            e_mat[e_i, 5] = w_eve
            e_mat[e_i, 6] = float(rs["kt"]) - float(rd["kt"])
            e_mat[e_i, 7] = (float(rs["eve_cloud23"]) - float(rd["eve_cloud23"])) / 100.0
            e_mat[e_i, 8] = upslope
            e_mat[e_i, 9] = to_tgt

        # Physics skip summary vector [F_PHYS] at target node 0, day t
        rt0 = node_series[0][t]
        rt1 = node_series[0][t - 1]
        rt2 = node_series[0][t - 2]
        clr_next_0 = float(node_series[0][t + 1]["clrsky"])

        up_kt_num = up_kt_den = 0.0
        up_ec_num = up_erh_num = up_e_den = 0.0
        nbr_kts: List[float] = []
        for j in range(1, NUM_NODES):
            rj = node_series[j][t]
            brg_j = _bearing_rad(
                float(nodes[0]["lat"]), float(nodes[0]["lng"]),
                float(nodes[j]["lat"]), float(nodes[j]["lng"]),
            )
            w_d = max(0.0, math.cos(math.radians(float(rt0["wd10m"])) - brg_j))
            w_e = max(0.0, math.cos(math.radians(float(rt0["eve_wd"])) - brg_j))
            up_kt_num += w_d * float(rj["kt"])
            up_kt_den += w_d
            up_ec_num += w_e * float(rj["eve_cloud23"])
            up_erh_num += w_e * float(rj["eve_rh"])
            up_e_den += w_e
            nbr_kts.append(float(rj["kt"]))

        avg_n_kt = sum(nbr_kts) / max(1, len(nbr_kts))
        n_kt_std = math.sqrt(sum((k - avg_n_kt) ** 2 for k in nbr_kts) / max(1, len(nbr_kts)))
        up_kt = up_kt_num / up_kt_den if up_kt_den > 1e-4 else avg_n_kt
        up_ec23 = (
            up_ec_num / up_e_den
            if up_e_den > 1e-4
            else sum(float(node_series[j][t]["eve_cloud23"]) for j in range(1, NUM_NODES)) / (NUM_NODES - 1)
        )
        up_erh = (
            up_erh_num / up_e_den
            if up_e_den > 1e-4
            else sum(float(node_series[j][t]["eve_rh"]) for j in range(1, NUM_NODES)) / (NUM_NODES - 1)
        )

        phys = np.array(
            [
                float(rt0["kt"]),
                float(rt0["kt"]) - float(rt1["kt"]),
                (float(rt0["kt"]) + float(rt1["kt"]) + float(rt2["kt"])) / 3.0,
                clr_next_0 / 10.0,
                1.0 - float(rt0["eve_cloud23"]) / 100.0,
                (1.0 - float(rt0["eve_cloud23"]) / 100.0) * clr_next_0 / 10.0,
                float(rt0["eve_rh"]) / 100.0,
                max(-1.5, min(1.5, float(rt0["eve_ps_trend"]) / 10.0)),
                up_kt,
                avg_n_kt,
                up_kt - float(rt0["kt"]),
                n_kt_std,
                up_ec23 / 100.0,
                (1.0 - up_ec23 / 100.0) * clr_next_0 / 10.0,
                up_erh / 100.0,
                max(0.0, math.sin(math.radians(float(rt0["eve_wd"])))) * (up_erh / 100.0),
            ],
            dtype=np.float32,
        )

        nxt0 = node_series[0][t + 1]
        vpd_next = float(nxt0.get("vpd") if nxt0.get("vpd") is not None else _tetens_vpd_kpa(float(nxt0["t2m"]), float(nxt0["rh2m"])))
        precip_next = 1.0 if float(nxt0.get("precip", 0.0)) >= 1.0 else 0.0

        windows_list.append(win)
        edge_attr_list.append(e_mat)
        phys_list.append(phys)
        y_allsky_list.append(float(nxt0["allsky"]))
        y_kt_list.append(float(nxt0["kt"]))
        y_clrsky_next_list.append(clr_next_0)
        y_aux_list.append([float(nxt0["t2m"]) / 35.0, vpd_next / 4.0, precip_next])
        origin_dates.append(dates[t])
        next_dates.append(next_d)

    return {
        "city_id": city["city_id"],
        "name": city["name"],
        "split": city["split"],
        "edge_index": edge_index_np,
        "windows": np.stack(windows_list, axis=0) if windows_list else np.zeros((0, WINDOW_LEN, NUM_NODES, F_NODE), dtype=np.float32),
        "edge_attr": np.stack(edge_attr_list, axis=0) if edge_attr_list else np.zeros((0, len(edge_pairs), F_EDGE), dtype=np.float32),
        "phys": np.stack(phys_list, axis=0) if phys_list else np.zeros((0, F_PHYS), dtype=np.float32),
        "y_allsky": np.array(y_allsky_list, dtype=np.float32),
        "y_kt": np.array(y_kt_list, dtype=np.float32),
        "y_clrsky_next": np.array(y_clrsky_next_list, dtype=np.float32),
        "y_aux": np.array(y_aux_list, dtype=np.float32) if y_aux_list else np.zeros((0, 3), dtype=np.float32),
        "origin_dates": origin_dates,
        "next_dates": next_dates,
    }


class PhysicsTrustGATv2Layer(nn.Module):
    """Multi-head edge-conditioned GATv2 layer with LayerNorm + FFN residual."""

    def __init__(self, d_model: int = 224, edge_dim: int = F_EDGE, num_heads: int = 4) -> None:
        super().__init__()
        assert d_model % num_heads == 0
        self.d_model = d_model
        self.num_heads = num_heads
        self.head_dim = d_model // num_heads

        self.q_proj = nn.Linear(d_model, d_model)
        self.k_proj = nn.Linear(d_model + edge_dim, d_model)
        self.v_proj = nn.Linear(d_model + edge_dim, d_model)
        self.attn_vec = nn.Parameter(torch.randn(num_heads, self.head_dim) * 0.05)
        self.edge_gate = nn.Sequential(
            nn.Linear(edge_dim, 24),
            nn.GELU(),
            nn.Linear(24, 1),
        )
        self.out_proj = nn.Linear(d_model, d_model)
        self.norm1 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_model * 2),
            nn.GELU(),
            nn.Linear(d_model * 2, d_model),
        )
        self.norm2 = nn.LayerNorm(d_model)

    def forward(
        self,
        h: torch.Tensor,          # [B, N, D]
        edge_index: torch.Tensor, # [2, E]
        edge_attr: torch.Tensor,  # [B, E, edge_dim]
    ) -> torch.Tensor:
        B, N, D = h.shape
        src_idx = edge_index[0]
        dst_idx = edge_index[1]
        E = src_idx.shape[0]

        h_src = h[:, src_idx, :]  # [B, E, D]
        h_dst = h[:, dst_idx, :]  # [B, E, D]
        src_edge = torch.cat([h_src, edge_attr], dim=-1)

        q = self.q_proj(h_dst).view(B, E, self.num_heads, self.head_dim)
        k = self.k_proj(src_edge).view(B, E, self.num_heads, self.head_dim)
        v = self.v_proj(src_edge).view(B, E, self.num_heads, self.head_dim)

        raw_score = (F.leaky_relu(q + k, 0.2) * self.attn_vec.view(1, 1, self.num_heads, self.head_dim)).sum(-1)
        gate = torch.sigmoid(self.edge_gate(edge_attr))  # [B, E, 1]
        attn = torch.sigmoid(raw_score) * gate           # [B, E, H]

        weighted_v = (v * attn.unsqueeze(-1)).view(B, E, D)
        idx_d = dst_idx.view(1, E, 1).expand(B, E, D).contiguous()
        agg = torch.zeros_like(h)
        agg.scatter_add_(1, idx_d, weighted_v)

        idx_1 = dst_idx.view(1, E, 1).expand(B, E, 1).contiguous()
        deg = torch.zeros((B, N, 1), device=h.device, dtype=h.dtype)
        deg.scatter_add_(1, idx_1, attn.mean(dim=-1, keepdim=True))
        agg = agg / deg.clamp(min=1.0)

        h_mid = self.norm1(h + self.out_proj(agg))
        return self.norm2(h_mid + self.ffn(h_mid))


class ETGGlobalSpatiotemporalGNN(nn.Module):
    """
    Unified ~2.1M-parameter Global Spatiotemporal Graph Transformer:
      - Temporal GRU encoder over trailing W=7 causal days across N=7 nodes
      - 4 stacked PhysicsTrustGATv2 layers (d_model=224, 4 heads)
      - Physics-guided skip connection + zero-init Local Residual Adapter
      - Monotonic quantile solar heads [P10, Q_0.268, P50, P90] + Storm + Aux heads
    """

    def __init__(
        self,
        f_node: int = F_NODE,
        f_edge: int = F_EDGE,
        f_phys: int = F_PHYS,
        d_model: int = 224,
        num_layers: int = 4,
        num_heads: int = 4,
        adapter_dim: int = 32,
    ) -> None:
        super().__init__()
        self.d_model = d_model
        self.num_layers = num_layers
        self.num_heads = num_heads

        self.temp_in = nn.Linear(f_node, d_model)
        self.temp_gru = nn.GRU(d_model, d_model, batch_first=True)
        self.temp_norm = nn.LayerNorm(d_model)

        self.gnn_layers = nn.ModuleList(
            [PhysicsTrustGATv2Layer(d_model=d_model, edge_dim=f_edge, num_heads=num_heads) for _ in range(num_layers)]
        )

        # Residual local-city adapter (zero-initialized -> exact identity at zero-shot!)
        self.adapter_down = nn.Linear(d_model, adapter_dim)
        self.adapter_up = nn.Linear(adapter_dim, d_model)
        nn.init.zeros_(self.adapter_up.weight)
        nn.init.zeros_(self.adapter_up.bias)

        # Final target readout MLP combining GNN representation + physics summary
        self.head_mlp = nn.Sequential(
            nn.Linear(d_model + f_phys, d_model),
            nn.GELU(),
            nn.LayerNorm(d_model),
            nn.Linear(d_model, 128),
            nn.GELU(),
        )
        # Monotonic quantile offsets for kt: [P10, Q_0.268, P50, P90]
        self.kt_head = nn.Linear(128, 4)
        self.storm_head = nn.Linear(128, 1)
        self.aux_head = nn.Linear(128, 3)  # [t2m_next/35, vpd_next/4, precip_logit]

    def forward(
        self,
        windows: torch.Tensor,    # [B, W, N, F_NODE]
        edge_index: torch.Tensor, # [2, E]
        edge_attr: torch.Tensor,  # [B, E, F_EDGE]
        phys: torch.Tensor,       # [B, F_PHYS]
        clrsky_next: torch.Tensor # [B]
    ) -> Dict[str, torch.Tensor]:
        B, W, N, Fn = windows.shape
        flat = windows.permute(0, 2, 1, 3).reshape(B * N, W, Fn)
        t_emb = F.gelu(self.temp_in(flat))
        gru_out, _ = self.temp_gru(t_emb)
        h = self.temp_norm(gru_out[:, -1, :].view(B, N, self.d_model))

        for layer in self.gnn_layers:
            h = layer(h, edge_index, edge_attr)

        h_tgt = h[:, 0, :]
        h_tgt = h_tgt + self.adapter_up(F.gelu(self.adapter_down(h_tgt)))

        feat_cat = torch.cat([h_tgt, phys], dim=-1)
        z = self.head_mlp(feat_cat)

        raw_q = self.kt_head(z)
        # Base P50 residual around today's kt / upwind physics anchor
        base_kt = phys[:, 0]
        kt_50 = torch.clamp(base_kt + raw_q[:, 2], 0.02, 1.06)
        d_268 = F.softplus(raw_q[:, 1]) + 1e-3
        d_10 = F.softplus(raw_q[:, 0]) + 1e-3
        d_90 = F.softplus(raw_q[:, 3]) + 1e-3

        kt_268 = torch.clamp(kt_50 - d_268, 0.02, 1.06)
        kt_10 = torch.clamp(kt_268 - d_10, 0.02, 1.06)
        kt_90 = torch.clamp(kt_50 + d_90, 0.02, 1.06)
        kt_quantiles = torch.stack([kt_10, kt_268, kt_50, kt_90], dim=-1)
        allsky_quantiles = kt_quantiles * clrsky_next.unsqueeze(-1)

        return {
            "kt_quantiles": kt_quantiles,
            "allsky_quantiles": allsky_quantiles,
            "allsky_q268": allsky_quantiles[:, 1],
            "allsky_p50": allsky_quantiles[:, 2],
            "storm_logit": self.storm_head(z).squeeze(-1),
            "aux": self.aux_head(z),
        }
