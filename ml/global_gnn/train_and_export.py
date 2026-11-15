"""
Colab G4 Blackwell training, 5-city global benchmark + Denver showcase evaluation,
and fp16 binary + ONNX + live-data ETG weight export (`ml/weights/etg-global-gnn-v3.*`).
"""

from __future__ import annotations

import copy
from datetime import datetime
import json
import math
from pathlib import Path
import struct
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from global_gnn.cities_and_harvest import (
    GLOBAL_36_CITIES,
    harvest_global_36_city_dataset,
)
from global_gnn.features_and_model import (
    ETGGlobalSpatiotemporalGNN,
    F_EDGE,
    F_NODE,
    F_PHYS,
    NUM_NODES,
    QUANTILE_TAUS,
    WINDOW_LEN,
    build_city_graph_tensors,
)

LOW_SOLAR_THRESHOLD_KWH = 3.5
SCHOOL_PV_KW = 250.0
BATTERY_USABLE_KWH = 350.0
OFF_PEAK_RATE_USD = 0.075
ON_PEAK_DEFICIT_RATE_USD = 0.28
FALSE_POSITIVE_COST_USD = BATTERY_USABLE_KWH * OFF_PEAK_RATE_USD  # $26.25
DEFICIT_SPREAD_USD_PER_KWH = ON_PEAK_DEFICIT_RATE_USD - OFF_PEAK_RATE_USD  # $0.205/kWh


def _compute_tariff_cost(actuals: np.ndarray, decisions: np.ndarray) -> Dict[str, Any]:
    total_penalty = 0.0
    storm_shortfall = 0
    total_storms = 0
    false_pos = 0
    for y, precharge in zip(actuals.tolist(), decisions.tolist()):
        if y < LOW_SOLAR_THRESHOLD_KWH:
            total_storms += 1
            if not precharge:
                storm_shortfall += 1
                unbuf = min(BATTERY_USABLE_KWH, max(0.0, (LOW_SOLAR_THRESHOLD_KWH - y) * SCHOOL_PV_KW))
                total_penalty += unbuf * DEFICIT_SPREAD_USD_PER_KWH
        elif precharge:
            false_pos += 1
            total_penalty += FALSE_POSITIVE_COST_USD
    days = max(1, len(actuals))
    ann = total_penalty * (365.25 / days)
    recall = ((total_storms - storm_shortfall) / total_storms * 100.0) if total_storms > 0 else 100.0
    return {
        "total_penalty_usd": round(total_penalty, 2),
        "annualized_penalty_usd": round(ann, 2),
        "storm_capture_recall_pct": round(recall, 1),
        "storm_shortfall_days": storm_shortfall,
        "total_low_solar_days": total_storms,
        "unnecessary_precharge_days": false_pos,
    }


def _paired_two_sided_pvalue(a: np.ndarray, b: np.ndarray) -> float:
    diff = a - b
    n = len(diff)
    if n < 5:
        return 1.0
    mean_d = float(np.mean(diff))
    sd_d = float(np.std(diff, ddof=1))
    if sd_d <= 1e-12:
        return 1.0 if abs(mean_d) <= 1e-12 else 0.0
    t_stat = abs(mean_d) / (sd_d / math.sqrt(n))
    return float(max(0.0, min(1.0, math.erfc(t_stat / math.sqrt(2.0)))))


def _daily_cost_series(actuals: np.ndarray, decisions: np.ndarray) -> np.ndarray:
    costs = np.zeros(len(actuals), dtype=np.float64)
    for i, (y, pre) in enumerate(zip(actuals.tolist(), decisions.tolist())):
        if y < LOW_SOLAR_THRESHOLD_KWH and not pre:
            unbuf = min(BATTERY_USABLE_KWH, max(0.0, (LOW_SOLAR_THRESHOLD_KWH - y) * SCHOOL_PV_KW))
            costs[i] = unbuf * DEFICIT_SPREAD_USD_PER_KWH
        elif y >= LOW_SOLAR_THRESHOLD_KWH and pre:
            costs[i] = FALSE_POSITIVE_COST_USD
    return costs


def _eval_solar_metrics(
    actuals: np.ndarray,
    preds_p50: np.ndarray,
    preds_q268: np.ndarray,
    persist_preds: np.ndarray,
    persist_rmse: Optional[float] = None,
    thresh_q268: float = LOW_SOLAR_THRESHOLD_KWH,
) -> Dict[str, Any]:
    rmse = float(np.sqrt(np.mean((actuals - preds_p50) ** 2)))
    mae = float(np.mean(np.abs(actuals - preds_p50)))
    ss_res = float(np.sum((actuals - preds_p50) ** 2))
    ss_tot = float(np.sum((actuals - np.mean(actuals)) ** 2))
    r2 = 1.0 - (ss_res / ss_tot) if ss_tot > 1e-9 else 0.0
    p_rmse = persist_rmse if persist_rmse is not None else float(np.sqrt(np.mean((actuals - persist_preds) ** 2)))
    skill = (1.0 - rmse / max(p_rmse, 1e-6)) * 100.0

    y_storm = actuals < LOW_SOLAR_THRESHOLD_KWH
    pred_storm = preds_q268 < thresh_q268
    tp = int(np.sum(y_storm & pred_storm))
    fp = int(np.sum((~y_storm) & pred_storm))
    fn = int(np.sum(y_storm & (~pred_storm)))
    prec = tp / max(1, tp + fp)
    rec = tp / max(1, tp + fn)
    f1 = (2 * prec * rec) / max(1e-9, prec + rec)
    cost = _compute_tariff_cost(actuals, pred_storm)
    return {
        "rmse": round(rmse, 4),
        "mae": round(mae, 4),
        "r2": round(r2, 4),
        "skill_pct": round(skill, 2),
        "storm_precision": round(prec, 4),
        "storm_recall": round(rec, 4),
        "storm_f1": round(f1, 4),
        **cost,
    }


def _loss_fn(
    out: Dict[str, torch.Tensor],
    y_allsky: torch.Tensor,
    y_kt: torch.Tensor,
    y_aux: torch.Tensor,
    clrsky_next: torch.Tensor,
) -> torch.Tensor:
    # 1. Huber + MSE on P50 allsky
    p50 = out["allsky_p50"]
    loss_p50 = 0.65 * F.smooth_l1_loss(p50, y_allsky, beta=0.75) + 0.35 * F.mse_loss(p50, y_allsky)

    # 2. Pinball quantile loss on [P10, Q_0.268, P50, P90] in kWh/m2/day
    q_preds = out["allsky_quantiles"]
    loss_q = torch.tensor(0.0, device=y_allsky.device, dtype=y_allsky.dtype)
    for k, tau in enumerate(QUANTILE_TAUS):
        diff = y_allsky - q_preds[:, k]
        loss_q = loss_q + torch.maximum(tau * diff, (tau - 1.0) * diff).mean()
    loss_q = loss_q / len(QUANTILE_TAUS)

    # 3. Storm BCE (< 3.5 kWh/m2/day)
    y_storm = (y_allsky < LOW_SOLAR_THRESHOLD_KWH).float()
    loss_storm = F.binary_cross_entropy_with_logits(out["storm_logit"], y_storm)

    # 4. Multi-variable thermodynamic auxiliary loss (T2M, VPD, Precip>1mm)
    aux = out["aux"]
    loss_t2m = F.smooth_l1_loss(aux[:, 0], y_aux[:, 0], beta=0.25)
    loss_vpd = F.smooth_l1_loss(aux[:, 1], y_aux[:, 1], beta=0.25)
    loss_pr = F.binary_cross_entropy_with_logits(aux[:, 2], y_aux[:, 2])
    loss_aux = 0.5 * loss_t2m + 0.5 * loss_vpd + 0.35 * loss_pr

    return loss_p50 + 0.55 * loss_q + 0.25 * loss_storm + 0.15 * loss_aux


def _predict_in_batches(
    model: ETGGlobalSpatiotemporalGNN,
    city_t: Dict[str, Any],
    device: torch.device,
    batch_size: int = 256,
) -> Dict[str, np.ndarray]:
    model.eval()
    n = len(city_t["y_allsky"])
    ei = torch.from_numpy(city_t["edge_index"]).to(device)
    p50_all, q268_all, p10_all, p90_all, storm_p_all = [], [], [], [], []
    with torch.no_grad():
        for i in range(0, n, batch_size):
            w = torch.from_numpy(city_t["windows"][i : i + batch_size]).to(device)
            ea = torch.from_numpy(city_t["edge_attr"][i : i + batch_size]).to(device)
            ph = torch.from_numpy(city_t["phys"][i : i + batch_size]).to(device)
            cl = torch.from_numpy(city_t["y_clrsky_next"][i : i + batch_size]).to(device)
            out = model(w, ei, ea, ph, cl)
            qs = out["allsky_quantiles"].cpu().numpy()
            p10_all.append(qs[:, 0])
            q268_all.append(qs[:, 1])
            p50_all.append(qs[:, 2])
            p90_all.append(qs[:, 3])
            storm_p_all.append(torch.sigmoid(out["storm_logit"]).cpu().numpy())
    return {
        "p10": np.concatenate(p10_all),
        "q268": np.concatenate(q268_all),
        "p50": np.concatenate(p50_all),
        "p90": np.concatenate(p90_all),
        "storm_prob": np.concatenate(storm_p_all),
    }


def _fit_ridge_np(X: np.ndarray, y: np.ndarray, lam: float) -> np.ndarray:
    p = X.shape[1]
    reg = np.eye(p, dtype=np.float64) * lam
    reg[0, 0] = 1e-6
    A = X.T @ X + reg
    b = X.T @ y
    return np.linalg.solve(A, b)


def _eval_linear_baselines(
    train_t: Dict[str, Any],
    test_t: Dict[str, Any],
) -> Dict[str, Any]:
    """Compare Persistence, Clear-Sky Persistence, Local-Daily Ridge, and Local+Eve Ridge."""
    # Use phys summary + bias column cleanly
    def _build_local_daily(t_dict: Dict[str, Any]) -> np.ndarray:
        ph = t_dict["phys"]
        w_last = t_dict["windows"][:, -1, 0, :]
        return np.column_stack(
            [
                np.ones(len(ph)),
                ph[:, 0],            # kt
                ph[:, 1],            # kt_diff1
                ph[:, 2],            # kt_roll3
                ph[:, 3],            # clrsky_next / 10
                ph[:, 0] * ph[:, 3] * 10.0,  # kt * clrsky_next
                w_last[:, 6],        # sin_doy
                w_last[:, 7],        # cos_doy
                w_last[:, 10],       # t2m
                w_last[:, 11],       # rh
                w_last[:, 14],       # precip
                w_last[:, 15],       # ws
            ]
        )

    def _build_local_eve(t_dict: Dict[str, Any]) -> np.ndarray:
        ld = _build_local_daily(t_dict)
        ph = t_dict["phys"]
        w_last = t_dict["windows"][:, -1, 0, :]
        return np.column_stack(
            [
                ld,
                ph[:, 4],            # eve_clear_23h
                ph[:, 5],            # eve_clear_23h * clrsky_next/10
                ph[:, 6],            # eve_rh
                ph[:, 7],            # eve_ps_trend
                w_last[:, 18],       # eve_cloud_mean
                w_last[:, 21],       # eve_ws
            ]
        )

    y_tr = train_t["y_allsky"].astype(np.float64)
    y_te = test_t["y_allsky"].astype(np.float64)
    persist_te = test_t["windows"][:, -1, 0, 0] * test_t["windows"][:, -1, 0, 4] * 10.0
    clr_persist_te = test_t["phys"][:, 0] * test_t["y_clrsky_next"]

    w_ld = _fit_ridge_np(_build_local_daily(train_t), y_tr, 6.0)
    w_le = _fit_ridge_np(_build_local_eve(train_t), y_tr, 8.0)
    p_ld = np.maximum(0.0, _build_local_daily(test_t) @ w_ld)
    p_le = np.maximum(0.0, _build_local_eve(test_t) @ w_le)

    persist_m = _eval_solar_metrics(y_te, persist_te, persist_te, persist_te)
    p_rmse = persist_m["rmse"]
    clr_m = _eval_solar_metrics(y_te, clr_persist_te, clr_persist_te, persist_te, persist_rmse=p_rmse)
    ld_m = _eval_solar_metrics(y_te, p_ld, p_ld, persist_te, persist_rmse=p_rmse)
    le_m = _eval_solar_metrics(y_te, p_le, p_le, persist_te, persist_rmse=p_rmse)

    return {
        "persistence": persist_m,
        "clear_sky_persistence": clr_m,
        "local_daily": ld_m,
        "local_eve": le_m,
        "preds": {"persistence": persist_te, "local_daily": p_ld, "local_eve": p_le},
    }


def export_packed_fp16_weights(
    model: ETGGlobalSpatiotemporalGNN,
    bin_path: Path,
    meta_path: Path,
    golden_sample: Dict[str, Any],
    summary_meta: Dict[str, Any],
) -> None:
    """Pack model state_dict in canonical order as raw little-endian fp16 + JSON manifest."""
    cpu_model = copy.deepcopy(model).to("cpu").eval()
    tensor_specs: List[Dict[str, Any]] = []
    chunks: List[bytes] = []
    offset = 0

    for name, param in cpu_model.state_dict().items():
        arr_f16 = param.detach().cpu().numpy().astype("<f2", copy=False)
        raw = arr_f16.tobytes(order="C")
        tensor_specs.append(
            {
                "name": name,
                "shape": list(arr_f16.shape),
                "dtype": "float16",
                "offset": offset,
                "byte_length": len(raw),
            }
        )
        chunks.append(raw)
        offset += len(raw)

    bin_path.parent.mkdir(parents=True, exist_ok=True)
    bin_path.write_bytes(b"".join(chunks))

    meta_payload = {
        "schema_version": "etg-global-gnn-v3",
        "architecture": {
            "f_node": F_NODE,
            "f_edge": F_EDGE,
            "f_phys": F_PHYS,
            "window_len": WINDOW_LEN,
            "num_nodes": NUM_NODES,
            "d_model": cpu_model.d_model,
            "num_layers": cpu_model.num_layers,
            "num_heads": cpu_model.num_heads,
            "param_count": sum(p.numel() for p in cpu_model.parameters()),
        },
        "total_bytes": offset,
        "tensors": tensor_specs,
        "summary": summary_meta,
        "golden_parity_check": golden_sample,
    }
    meta_path.write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")


def train_and_evaluate_global_gnn(
    cache_dir: str = "/content/etg_global_cache",
    weights_dir: str = "ml/weights",
    epochs: int = 38,
    batch_size: int = 128,
    lr: float = 1.2e-3,
    seed: int = 42,
) -> Dict[str, Any]:
    torch.manual_seed(seed)
    np.random.seed(seed)
    t0 = time.time()

    if torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")
    use_bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()
    if device.type == "cuda":
        torch.set_float32_matmul_precision("high")
    print(f"[train] Device={device} (bf16={use_bf16})", flush=True)

    bundle = harvest_global_36_city_dataset(cache_dir=cache_dir)
    print(f"[harvest] Loaded {bundle['num_cities']} cities, {bundle['num_stations']} stations.", flush=True)

    train_city_tensors: List[Dict[str, Any]] = []
    val_city_tensors: List[Dict[str, Any]] = []
    test_city_map: Dict[str, Dict[str, Any]] = {}
    denver_splits: Dict[str, Dict[str, Any]] = {}

    for city in bundle["cities"]:
        sp = city["split"]
        if sp == "global_train":
            tr_t = build_city_graph_tensors(city, start_date="2019-01-01", end_date="2023-12-31")
            va_t = build_city_graph_tensors(city, start_date="2024-01-01", end_date="2024-12-31")
            if len(tr_t["y_allsky"]) >= 30:
                train_city_tensors.append(tr_t)
            if len(va_t["y_allsky"]) >= 15:
                val_city_tensors.append(va_t)
        elif sp == "global_test":
            tr_t = build_city_graph_tensors(city, start_date="2019-01-01", end_date="2024-12-31")
            te_t = build_city_graph_tensors(city, start_date="2025-01-01", end_date="2026-12-31")
            test_city_map[city["city_id"]] = {"train": tr_t, "test": te_t, "city": city}
        elif sp == "denver_showcase":
            denver_splits = {
                "train": build_city_graph_tensors(city, start_date="2019-01-01", end_date="2023-12-31"),
                "val": build_city_graph_tensors(city, start_date="2024-01-01", end_date="2024-12-31"),
                "pre2025": build_city_graph_tensors(city, start_date="2019-01-01", end_date="2024-12-31"),
                "test": build_city_graph_tensors(city, start_date="2025-01-01", end_date="2026-12-31"),
                "city": city,
            }

    # Concatenate global train & val batches (all 7-node rings share identical edge_index!)
    edge_index_shared = torch.from_numpy(train_city_tensors[0]["edge_index"]).to(device)

    tr_windows = np.concatenate([c["windows"] for c in train_city_tensors], axis=0)
    tr_edge_attr = np.concatenate([c["edge_attr"] for c in train_city_tensors], axis=0)
    tr_phys = np.concatenate([c["phys"] for c in train_city_tensors], axis=0)
    tr_y_allsky = np.concatenate([c["y_allsky"] for c in train_city_tensors], axis=0)
    tr_y_kt = np.concatenate([c["y_kt"] for c in train_city_tensors], axis=0)
    tr_clr = np.concatenate([c["y_clrsky_next"] for c in train_city_tensors], axis=0)
    tr_aux = np.concatenate([c["y_aux"] for c in train_city_tensors], axis=0)

    va_windows = np.concatenate([c["windows"] for c in val_city_tensors], axis=0)
    va_edge_attr = np.concatenate([c["edge_attr"] for c in val_city_tensors], axis=0)
    va_phys = np.concatenate([c["phys"] for c in val_city_tensors], axis=0)
    va_y_allsky = np.concatenate([c["y_allsky"] for c in val_city_tensors], axis=0)
    va_clr = np.concatenate([c["y_clrsky_next"] for c in val_city_tensors], axis=0)

    print(
        f"[dataset] Global Train={len(tr_y_allsky)} graph-days ({len(train_city_tensors)} cities) | "
        f"Global Val={len(va_y_allsky)} graph-days | Held-out Denver Test={len(denver_splits['test']['y_allsky'])} days",
        flush=True,
    )

    model = ETGGlobalSpatiotemporalGNN(d_model=224, num_layers=4, num_heads=4, adapter_dim=32).to(device)
    param_count = sum(p.numel() for p in model.parameters())
    print(f"[model] ETGGlobalSpatiotemporalGNN params={param_count:,}", flush=True)

    # Keep adapter frozen during global pretraining so zero-shot stays pure
    for name, p in model.named_parameters():
        if "adapter_" in name:
            p.requires_grad_(False)

    # Pin full tensors on GPU if they fit (30*1820*7*7*26 floats ~= 140 MB!)
    tr_w_gpu = torch.from_numpy(tr_windows).to(device)
    tr_ea_gpu = torch.from_numpy(tr_edge_attr).to(device)
    tr_ph_gpu = torch.from_numpy(tr_phys).to(device)
    tr_ya_gpu = torch.from_numpy(tr_y_allsky).to(device)
    tr_yk_gpu = torch.from_numpy(tr_y_kt).to(device)
    tr_cl_gpu = torch.from_numpy(tr_clr).to(device)
    tr_ax_gpu = torch.from_numpy(tr_aux).to(device)

    va_w_gpu = torch.from_numpy(va_windows).to(device)
    va_ea_gpu = torch.from_numpy(va_edge_attr).to(device)
    va_ph_gpu = torch.from_numpy(va_phys).to(device)
    va_ya_gpu = torch.from_numpy(va_y_allsky).to(device)
    va_cl_gpu = torch.from_numpy(va_clr).to(device)

    opt = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad],
        lr=lr,
        weight_decay=1e-4,
    )
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)

    best_val_rmse = float("inf")
    best_state = copy.deepcopy(model.state_dict())
    n_tr = len(tr_y_allsky)

    for ep in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n_tr, device="cpu").to(device)
        ep_loss = 0.0
        steps = 0
        for idx0 in range(0, n_tr, batch_size):
            b_idx = perm[idx0 : idx0 + batch_size]
            opt.zero_grad(set_to_none=True)
            if use_bf16:
                with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                    out = model(tr_w_gpu[b_idx], edge_index_shared, tr_ea_gpu[b_idx], tr_ph_gpu[b_idx], tr_cl_gpu[b_idx])
                    loss = _loss_fn(out, tr_ya_gpu[b_idx], tr_yk_gpu[b_idx], tr_ax_gpu[b_idx], tr_cl_gpu[b_idx])
            else:
                out = model(tr_w_gpu[b_idx], edge_index_shared, tr_ea_gpu[b_idx], tr_ph_gpu[b_idx], tr_cl_gpu[b_idx])
                loss = _loss_fn(out, tr_ya_gpu[b_idx], tr_yk_gpu[b_idx], tr_ax_gpu[b_idx], tr_cl_gpu[b_idx])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            ep_loss += float(loss.detach().cpu().item())
            steps += 1
        sched.step()

        model.eval()
        with torch.no_grad():
            sq_sum = 0.0
            for v0 in range(0, len(va_y_allsky), 512):
                v_out = model(
                    va_w_gpu[v0 : v0 + 512],
                    edge_index_shared,
                    va_ea_gpu[v0 : v0 + 512],
                    va_ph_gpu[v0 : v0 + 512],
                    va_cl_gpu[v0 : v0 + 512],
                )
                sq_sum += float(((v_out["allsky_p50"] - va_ya_gpu[v0 : v0 + 512]) ** 2).sum().cpu().item())
            val_rmse = math.sqrt(sq_sum / max(1, len(va_y_allsky)))

        if val_rmse < best_val_rmse:
            best_val_rmse = val_rmse
            best_state = copy.deepcopy(model.state_dict())

        if ep == 1 or ep % 5 == 0 or ep == epochs:
            print(f"  Epoch {ep:02d}/{epochs} | train_loss={ep_loss/max(1,steps):.4f} | val_rmse={val_rmse:.4f} (best={best_val_rmse:.4f})", flush=True)

    model.load_state_dict(best_state)
    zero_shot_state = copy.deepcopy(best_state)

    # --- 1. Evaluate Zero-Shot Global GNN on 5 Held-Out Cross-Continent Cities (2025-2026) ---
    global_5city_results: List[Dict[str, Any]] = []
    print("\n=== 5-City Held-Out Cross-Continent Benchmark (2025-2026, Zero-Shot Global GNN) ===", flush=True)
    for cid, entry in test_city_map.items():
        base = _eval_linear_baselines(entry["train"], entry["test"])
        gnn_p = _predict_in_batches(model, entry["test"], device)
        y_te = entry["test"]["y_allsky"].astype(np.float64)
        p_te = base["preds"]["persistence"]
        gnn_m = _eval_solar_metrics(
            y_te, gnn_p["p50"], gnn_p["q268"], p_te, persist_rmse=base["persistence"]["rmse"]
        )
        p_vs_local = _paired_two_sided_pvalue(
            (y_te - base["preds"]["local_eve"]) ** 2,
            (y_te - gnn_p["p50"]) ** 2,
        )
        row = {
            "city_id": cid,
            "name": entry["city"]["name"],
            "regime": entry["city"]["regime"],
            "n_test": len(y_te),
            "persistence_rmse": base["persistence"]["rmse"],
            "clear_sky_persistence_rmse": base["clear_sky_persistence"]["rmse"],
            "local_eve_rmse": base["local_eve"]["rmse"],
            "global_gnn_rmse": gnn_m["rmse"],
            "global_gnn_skill_pct": gnn_m["skill_pct"],
            "p_vs_local_eve": round(p_vs_local, 6),
        }
        global_5city_results.append(row)
        print(
            f"  {row['name']:20s} (n={row['n_test']}): Persist={row['persistence_rmse']:.4f} | "
            f"ClrPersist={row['clear_sky_persistence_rmse']:.4f} | Local+Eve={row['local_eve_rmse']:.4f} | "
            f"GlobalGNN={row['global_gnn_rmse']:.4f} ({row['global_gnn_skill_pct']:+.2f}%)",
            flush=True,
        )

    # --- 2. Evaluate Denver Zero-Shot + Local Adapter Showcase (2025-2026, n >= 606) ---
    d_tr = denver_splits["train"]
    d_va = denver_splits["val"]
    d_pre = denver_splits["pre2025"]
    d_te = denver_splits["test"]

    denver_base = _eval_linear_baselines(d_pre, d_te)
    y_den = d_te["y_allsky"].astype(np.float64)
    p_den_persist = denver_base["preds"]["persistence"]
    p_den_rmse = denver_base["persistence"]["rmse"]

    # Zero-shot Denver evaluation (0 Denver train days!)
    zs_pred = _predict_in_batches(model, d_te, device)
    zs_m = _eval_solar_metrics(y_den, zs_pred["p50"], zs_pred["q268"], p_den_persist, persist_rmse=p_den_rmse)

    # Local-Adapter fine-tune strictly on Denver 2019-2023 (validated on 2024, 0 test leakage!)
    adapted_model = copy.deepcopy(model)
    for name, p in adapted_model.named_parameters():
        is_adapt = ("adapter_" in name) or ("head_mlp" in name) or ("kt_head" in name) or ("storm_head" in name)
        p.requires_grad_(is_adapt)

    dw_tr = torch.from_numpy(d_tr["windows"]).to(device)
    dea_tr = torch.from_numpy(d_tr["edge_attr"]).to(device)
    dph_tr = torch.from_numpy(d_tr["phys"]).to(device)
    dya_tr = torch.from_numpy(d_tr["y_allsky"]).to(device)
    dyk_tr = torch.from_numpy(d_tr["y_kt"]).to(device)
    dcl_tr = torch.from_numpy(d_tr["y_clrsky_next"]).to(device)
    dax_tr = torch.from_numpy(d_tr["y_aux"]).to(device)
    d_ei = torch.from_numpy(d_tr["edge_index"]).to(device)

    dw_va = torch.from_numpy(d_va["windows"]).to(device)
    dea_va = torch.from_numpy(d_va["edge_attr"]).to(device)
    dph_va = torch.from_numpy(d_va["phys"]).to(device)
    dya_va = torch.from_numpy(d_va["y_allsky"]).to(device)
    dcl_va = torch.from_numpy(d_va["y_clrsky_next"]).to(device)

    adapt_opt = torch.optim.AdamW([p for p in adapted_model.parameters() if p.requires_grad], lr=6e-4, weight_decay=2e-4)
    best_den_val = zs_m["rmse"]  # fallback check
    # Compute actual zero-shot 2024 val RMSE first
    with torch.no_grad():
        v0_out = adapted_model(dw_va, d_ei, dea_va, dph_va, dcl_va)
        best_den_val = float(torch.sqrt(((v0_out["allsky_p50"] - dya_va) ** 2).mean()).cpu().item())
    best_adapt_state = copy.deepcopy(adapted_model.state_dict())

    n_d_tr = len(d_tr["y_allsky"])
    for ep in range(1, 25):
        adapted_model.train()
        perm = torch.randperm(n_d_tr, device="cpu").to(device)
        for i0 in range(0, n_d_tr, 128):
            bi = perm[i0 : i0 + 128]
            adapt_opt.zero_grad(set_to_none=True)
            out = adapted_model(dw_tr[bi], d_ei, dea_tr[bi], dph_tr[bi], dcl_tr[bi])
            loss = _loss_fn(out, dya_tr[bi], dyk_tr[bi], dax_tr[bi], dcl_tr[bi])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(adapted_model.parameters(), 1.0)
            adapt_opt.step()
        adapted_model.eval()
        with torch.no_grad():
            vo = adapted_model(dw_va, d_ei, dea_va, dph_va, dcl_va)
            v_rmse = float(torch.sqrt(((vo["allsky_p50"] - dya_va) ** 2).mean()).cpu().item())
        if v_rmse < best_den_val:
            best_den_val = v_rmse
            best_adapt_state = copy.deepcopy(adapted_model.state_dict())

    adapted_model.load_state_dict(best_adapt_state)
    ad_pred = _predict_in_batches(adapted_model, d_te, device)
    ad_m = _eval_solar_metrics(y_den, ad_pred["p50"], ad_pred["q268"], p_den_persist, persist_rmse=p_den_rmse)

    # Compute paired p-values & savings vs Persistence and Local+23h
    persist_cost_ann = denver_base["persistence"]["annualized_penalty_usd"]
    zs_savings = round(persist_cost_ann - zs_m["annualized_penalty_usd"], 2)
    ad_savings = round(persist_cost_ann - ad_m["annualized_penalty_usd"], 2)
    ld_savings = round(persist_cost_ann - denver_base["local_daily"]["annualized_penalty_usd"], 2)
    le_savings = round(persist_cost_ann - denver_base["local_eve"]["annualized_penalty_usd"], 2)

    p_ad_vs_persist = _paired_two_sided_pvalue((y_den - p_den_persist) ** 2, (y_den - ad_pred["p50"]) ** 2)
    p_ad_vs_local_daily = _paired_two_sided_pvalue((y_den - denver_base["preds"]["local_daily"]) ** 2, (y_den - ad_pred["p50"]) ** 2)
    p_ad_vs_local_eve = _paired_two_sided_pvalue((y_den - denver_base["preds"]["local_eve"]) ** 2, (y_den - ad_pred["p50"]) ** 2)
    p_cost_ad_vs_le = _paired_two_sided_pvalue(
        _daily_cost_series(y_den, denver_base["preds"]["local_eve"] < LOW_SOLAR_THRESHOLD_KWH),
        _daily_cost_series(y_den, ad_pred["q268"] < LOW_SOLAR_THRESHOLD_KWH),
    )

    print(f"\n=== Denver Held-Out Showcase (2025-2026, n={len(y_den)}) ===", flush=True)
    print(f"  1. Persistence          : RMSE={denver_base['persistence']['rmse']:.4f} | Savings=$0/yr", flush=True)
    print(f"  2. Clear-Sky Persistence: RMSE={denver_base['clear_sky_persistence']['rmse']:.4f}", flush=True)
    print(f"  3. Local-Only Daily     : RMSE={denver_base['local_daily']['rmse']:.4f} | Savings=+${ld_savings:.0f}/yr", flush=True)
    print(f"  4. Local + 23:00 Eve    : RMSE={denver_base['local_eve']['rmse']:.4f} | Savings=+${le_savings:.0f}/yr", flush=True)
    print(f"  5. Global GNN (0-Shot)  : RMSE={zs_m['rmse']:.4f} (+{zs_m['skill_pct']:.1f}%) | Recall={zs_m['storm_capture_recall_pct']:.1f}% | Savings=+${zs_savings:.0f}/yr", flush=True)
    print(f"  6. Global GNN (+Adapter): RMSE={ad_m['rmse']:.4f} (+{ad_m['skill_pct']:.1f}%) | Recall={ad_m['storm_capture_recall_pct']:.1f}% | Savings=+${ad_savings:.0f}/yr (p_rmse vs persist={p_ad_vs_persist:.2e}, p_cost vs Local+Eve={p_cost_ad_vs_le:.4f})", flush=True)

    # Golden CPU parity test sample from Zero-Shot Global GNN on Denver test[0]
    w_dir = Path(weights_dir)
    w_dir.mkdir(parents=True, exist_ok=True)
    model.load_state_dict(zero_shot_state)
    model_cpu = copy.deepcopy(model).to("cpu").eval()
    ei_cpu = torch.from_numpy(d_te["edge_index"])
    with torch.no_grad():
        g_out = model_cpu(
            torch.from_numpy(d_te["windows"][:1]),
            ei_cpu,
            torch.from_numpy(d_te["edge_attr"][:1]),
            torch.from_numpy(d_te["phys"][:1]),
            torch.from_numpy(d_te["y_clrsky_next"][:1]),
        )
    golden = {
        "next_date": d_te["next_dates"][0],
        "window": d_te["windows"][0].tolist(),
        "edge_index": d_te["edge_index"].tolist(),
        "edge_attr": d_te["edge_attr"][0].tolist(),
        "phys": d_te["phys"][0].tolist(),
        "clrsky_next": float(d_te["y_clrsky_next"][0]),
        "expected_quantiles": [round(float(x), 6) for x in g_out["allsky_quantiles"][0].tolist()],
        "expected_storm_prob": round(float(torch.sigmoid(g_out["storm_logit"][0]).item()), 6),
    }

    summary_meta = {
        "train_cities": len(train_city_tensors),
        "test_cities": len(global_5city_results) + 1,
        "total_cities": bundle["num_cities"],
        "total_stations": bundle["num_stations"],
        "train_graph_days": int(len(tr_y_allsky)),
        "val_graph_days": int(len(va_y_allsky)),
        "global_val_rmse": round(best_val_rmse, 4),
        "global_5city_benchmark": global_5city_results,
        "denver_showcase": {
            "n_test": int(len(y_den)),
            "persistence": denver_base["persistence"],
            "clear_sky_persistence": denver_base["clear_sky_persistence"],
            "local_daily": {**denver_base["local_daily"], "savings_usd": ld_savings},
            "local_eve": {**denver_base["local_eve"], "savings_usd": le_savings},
            "global_gnn_zeroshot": {**zs_m, "savings_usd": zs_savings},
            "global_gnn_adapted": {
                **ad_m,
                "savings_usd": ad_savings,
                "p_vs_persistence": p_ad_vs_persist,
                "p_vs_local_daily": p_ad_vs_local_daily,
                "p_vs_local_eve": p_ad_vs_local_eve,
                "p_cost_vs_local_eve": round(p_cost_ad_vs_le, 6),
            },
        },
        "elapsed_sec": round(time.time() - t0, 1),
    }

    # Export Global Zero-Shot binary + ONNX + Adapted binary
    export_packed_fp16_weights(
        model_cpu,
        w_dir / "etg-global-gnn-v3.bin",
        w_dir / "etg-global-gnn-v3.meta.json",
        golden,
        summary_meta,
    )
    adapt_cpu = copy.deepcopy(adapted_model).to("cpu").eval()
    with torch.no_grad():
        ag_out = adapt_cpu(
            torch.from_numpy(d_te["windows"][:1]),
            ei_cpu,
            torch.from_numpy(d_te["edge_attr"][:1]),
            torch.from_numpy(d_te["phys"][:1]),
            torch.from_numpy(d_te["y_clrsky_next"][:1]),
        )
    adapt_golden = dict(golden)
    adapt_golden["expected_quantiles"] = [round(float(x), 6) for x in ag_out["allsky_quantiles"][0].tolist()]
    adapt_golden["expected_storm_prob"] = round(float(torch.sigmoid(ag_out["storm_logit"][0]).item()), 6)
    export_packed_fp16_weights(
        adapt_cpu,
        w_dir / "etg-global-gnn-v3-denver-adapter.bin",
        w_dir / "etg-global-gnn-v3-denver-adapter.meta.json",
        adapt_golden,
        summary_meta,
    )

    # Export ONNX opset 17
    class _OnnxWrap(nn.Module):
        def __init__(self, m: ETGGlobalSpatiotemporalGNN) -> None:
            super().__init__()
            self.m = m

        def forward(
            self,
            windows: torch.Tensor,
            edge_index: torch.Tensor,
            edge_attr: torch.Tensor,
            phys: torch.Tensor,
            clrsky_next: torch.Tensor,
        ) -> Tuple[torch.Tensor, torch.Tensor]:
            o = self.m(windows, edge_index, edge_attr, phys, clrsky_next)
            return o["allsky_quantiles"], o["storm_logit"]

    onnx_path = w_dir / "etg-global-gnn-v3.onnx"
    try:
        torch.onnx.export(
            _OnnxWrap(model_cpu).eval(),
            (
                torch.from_numpy(d_te["windows"][:1]),
                ei_cpu,
                torch.from_numpy(d_te["edge_attr"][:1]),
                torch.from_numpy(d_te["phys"][:1]),
                torch.from_numpy(d_te["y_clrsky_next"][:1]),
            ),
            str(onnx_path),
            input_names=["windows", "edge_index", "edge_attr", "phys", "clrsky_next"],
            output_names=["allsky_quantiles", "storm_logit"],
            dynamic_axes={"windows": {0: "batch"}, "edge_attr": {0: "batch"}, "phys": {0: "batch"}, "clrsky_next": {0: "batch"}},
            opset_version=17,
            dynamo=False,
        )
        print(f"[export] Saved ONNX: {onnx_path} ({onnx_path.stat().st_size / 1e6:.2f} MB)", flush=True)
    except Exception as ex:
        print(f"[export] ONNX export warning (fp16 binary still exported cleanly): {ex}", flush=True)

    return summary_meta
