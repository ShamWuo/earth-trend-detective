"""Pure-Python & optional PyTorch Spatio-Temporal Lag-Aware Graph Neural Network models and evaluator."""

from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .windows_and_baselines import (
    NeighborEdgeSpec,
    SupervisedSample,
    _eval_preds,
    build_supervised_windows,
    evaluate_baselines,
    load_etg_ml_dataset,
    select_target_index,
)

try:
    import torch  # type: ignore
    import torch.nn as nn  # type: ignore

    HAS_TORCH = True
except ImportError:  # pragma: no cover - optional dependency
    torch = None
    nn = None
    HAS_TORCH = False

try:
    from torch_geometric.nn import MessagePassing  # type: ignore

    HAS_PYG = True
except ImportError:  # pragma: no cover - optional dependency
    MessagePassing = None
    HAS_PYG = False


class ETGLagGraphNet:
    """Pure-Python Spatio-Temporal Lag-Aware Graph Neural Network with Adam & early stopping."""

    def __init__(
        self,
        target_lag_dim: int,
        edge_attr_dim: int,
        neighbor_lag_dim: int,
        hidden_dim: int = 12,
        seed: int = 42,
    ) -> None:
        self.rng = random.Random(seed)
        self.target_lag_dim = target_lag_dim
        self.edge_attr_dim = edge_attr_dim
        self.neighbor_lag_dim = neighbor_lag_dim
        self.hidden_dim = hidden_dim

        # Edge message input: [neighbor_lags_z, shifted_z, pos_hinge, neg_hinge, z_shift*y0, edge_attr]
        self.msg_in_dim = neighbor_lag_dim + 4 + edge_attr_dim
        self.self_in_dim = target_lag_dim + 1  # y0, diff_1, rest lags

        def init_mat(rows: int, cols: int, scale: float) -> List[List[float]]:
            return [
                [self.rng.gauss(0.0, scale) for _ in range(cols)]
                for _ in range(rows)
            ]

        s_self = math.sqrt(2.0 / max(1, self.self_in_dim + hidden_dim))
        s_msg = math.sqrt(2.0 / max(1, self.msg_in_dim + hidden_dim))
        s_gate = math.sqrt(2.0 / max(1, self.msg_in_dim + 1))

        self.params: Dict[str, Any] = {
            "W_self": init_mat(hidden_dim, self.self_in_dim, s_self),
            "b_self": [0.0] * hidden_dim,
            "W_msg": init_mat(hidden_dim, self.msg_in_dim, s_msg),
            "b_msg": [0.0] * hidden_dim,
            "W_gate": init_mat(1, self.msg_in_dim, s_gate),
            "b_gate": [0.0],
            "W_head": [self.rng.gauss(0.0, 0.05) for _ in range(hidden_dim * 2 + 1)],
            "b_head": [0.0],
            "res_y0": [0.95],
        }

    def _make_self_vec(self, sample: SupervisedSample) -> List[float]:
        y0 = sample.target_lags_z[0]
        dy = y0 - (sample.target_lags_z[1] if len(sample.target_lags_z) > 1 else y0)
        return [y0, dy, *sample.target_lags_z[1:]]

    def _make_msg_vec(
        self,
        sample: SupervisedSample,
        nb_pos: int,
        edge_spec: NeighborEdgeSpec,
    ) -> List[float]:
        y0 = sample.target_lags_z[0]
        z_shift = sample.neighbor_shifted_z[nb_pos]
        pos_hinge = max(0.0, z_shift - 0.5)
        neg_hinge = max(0.0, -0.5 - z_shift)
        inter = max(-4.0, min(4.0, y0 * z_shift))
        padded_attr = (edge_spec.edge_attr + [0.0] * self.edge_attr_dim)[: self.edge_attr_dim]
        return [*sample.neighbor_lags_z[nb_pos], z_shift, pos_hinge, neg_hinge, inter, *padded_attr]

    def forward_single(
        self,
        sample: SupervisedSample,
        edges: Sequence[NeighborEdgeSpec],
    ) -> Tuple[float, Dict[str, Any]]:
        x_self = self._make_self_vec(sample)
        h_self = []
        for h in range(self.hidden_dim):
            z = self.params["b_self"][h] + sum(
                self.params["W_self"][h][j] * x_self[j]
                for j in range(len(x_self))
            )
            h_self.append(math.tanh(z))

        h_agg = [0.0] * self.hidden_dim
        gates: List[float] = []
        msg_vecs: List[List[float]] = []
        msg_hiddens: List[List[float]] = []

        if edges:
            raw_logits: List[float] = []
            for nb_pos, edge_spec in enumerate(edges):
                m_vec = self._make_msg_vec(sample, nb_pos, edge_spec)
                msg_vecs.append(m_vec)
                m_hid = []
                for h in range(self.hidden_dim):
                    mz = self.params["b_msg"][h] + sum(
                        self.params["W_msg"][h][j] * m_vec[j]
                        for j in range(len(m_vec))
                    )
                    m_hid.append(math.tanh(mz))
                msg_hiddens.append(m_hid)

                logit = self.params["b_gate"][0] + sum(
                    self.params["W_gate"][0][j] * m_vec[j]
                    for j in range(len(m_vec))
                )
                raw_logits.append(max(-15.0, min(15.0, logit)))

            # Softmax attention over incoming edges scaled by sqrt(len(edges))
            max_l = max(raw_logits)
            exps = [math.exp(l - max_l) for l in raw_logits]
            denom = sum(exps) + 1e-12
            gates = [e / denom for e in exps]

            for g, m_hid in zip(gates, msg_hiddens):
                for h in range(self.hidden_dim):
                    h_agg[h] += g * m_hid[h]

        concat = [*h_self, *h_agg, x_self[0]]
        pred_z = (
            self.params["b_head"][0]
            + self.params["res_y0"][0] * x_self[0]
            + sum(self.params["W_head"][j] * concat[j] for j in range(len(concat)))
        )

        cache = {
            "x_self": x_self,
            "h_self": h_self,
            "h_agg": h_agg,
            "concat": concat,
            "gates": gates,
            "msg_vecs": msg_vecs,
            "msg_hiddens": msg_hiddens,
        }
        return pred_z, cache

    def fit(
        self,
        train_samples: List[SupervisedSample],
        edges: Sequence[NeighborEdgeSpec],
        target_mean: float,
        target_std: float,
        epochs: int = 180,
        lr: float = 0.025,
        weight_decay: float = 1e-2,
    ) -> Dict[str, Any]:
        # Hold out inner tail for early stopping (zero test leakage)
        n = len(train_samples)
        if n >= 12:
            val_size = max(3, int(round(n * 0.22)))
            inner_train = train_samples[: n - val_size]
            inner_val = train_samples[n - val_size :]
        else:
            inner_train = train_samples
            inner_val = train_samples

        # Initialize Adam state
        m_state: Dict[str, Any] = {}
        v_state: Dict[str, Any] = {}
        for k, val in self.params.items():
            if isinstance(val[0], list):
                m_state[k] = [[0.0] * len(r) for r in val]
                v_state[k] = [[0.0] * len(r) for r in val]
            else:
                m_state[k] = [0.0] * len(val)
                v_state[k] = [0.0] * len(val)

        def snapshot_params() -> Dict[str, Any]:
            return {
                k: ([r[:] for r in v] if isinstance(v[0], list) else v[:])
                for k, v in self.params.items()
            }

        best_val_loss = float("inf")
        best_params = snapshot_params()
        beta1, beta2, eps = 0.9, 0.999, 1e-8

        for step in range(1, epochs + 1):
            grads: Dict[str, Any] = {
                k: ([[0.0] * len(r) for r in v] if isinstance(v[0], list) else [0.0] * len(v))
                for k, v in self.params.items()
            }

            inv_m = 1.0 / max(1, len(inner_train))
            for sample in inner_train:
                y_true_z = (sample.target_actual - target_mean) / target_std
                pred_z, cache = self.forward_single(sample, edges)
                err = pred_z - y_true_z
                # Smooth Huber derivative (delta=2.0 sigma) * 2
                d_out = 2.0 * max(-2.0, min(2.0, err)) * inv_m

                grads["b_head"][0] += d_out
                grads["res_y0"][0] += d_out * cache["x_self"][0]
                concat = cache["concat"]
                for j, val in enumerate(concat):
                    grads["W_head"][j] += d_out * val

                d_h_self = [
                    d_out * self.params["W_head"][h] * (1.0 - cache["h_self"][h] ** 2)
                    for h in range(self.hidden_dim)
                ]
                for h in range(self.hidden_dim):
                    grads["b_self"][h] += d_h_self[h]
                    for j, xv in enumerate(cache["x_self"]):
                        grads["W_self"][h][j] += d_h_self[h] * xv

                if edges:
                    d_h_agg = [
                        d_out * self.params["W_head"][self.hidden_dim + h]
                        for h in range(self.hidden_dim)
                    ]
                    gates = cache["gates"]
                    d_gates = []
                    for nb_pos, g in enumerate(gates):
                        m_hid = cache["msg_hiddens"][nb_pos]
                        m_vec = cache["msg_vecs"][nb_pos]
                        d_gates.append(sum(d_h_agg[h] * m_hid[h] for h in range(self.hidden_dim)))
                        for h in range(self.hidden_dim):
                            d_mz = d_h_agg[h] * g * (1.0 - m_hid[h] ** 2)
                            grads["b_msg"][h] += d_mz
                            for j, mv in enumerate(m_vec):
                                grads["W_msg"][h][j] += d_mz * mv

                    weighted_dgate = sum(g * dg for g, dg in zip(gates, d_gates))
                    for nb_pos, (g, dg) in enumerate(zip(gates, d_gates)):
                        d_logit = g * (dg - weighted_dgate)
                        grads["b_gate"][0] += d_logit
                        for j, mv in enumerate(cache["msg_vecs"][nb_pos]):
                            grads["W_gate"][0][j] += d_logit * mv

            # Clip global gradient norm and apply Adam step with L2 weight decay
            grad_sq = 0.0
            for param_grad in grads.values():
                if isinstance(param_grad[0], list):
                    for r in param_grad:
                        grad_sq += sum(g * g for g in r)
                else:
                    grad_sq += sum(g * g for g in param_grad)
            grad_norm = math.sqrt(grad_sq)
            grad_scale = min(1.0, 5.0 / grad_norm) if grad_norm > 1e-12 else 1.0

            bc1 = 1.0 - beta1**step
            bc2 = 1.0 - beta2**step
            for k, param in self.params.items():
                if isinstance(param[0], list):
                    for r in range(len(param)):
                        for c in range(len(param[r])):
                            g = grads[k][r][c] * grad_scale + weight_decay * param[r][c]
                            m_state[k][r][c] = beta1 * m_state[k][r][c] + (1.0 - beta1) * g
                            v_state[k][r][c] = beta2 * v_state[k][r][c] + (1.0 - beta2) * (g * g)
                            m_hat = m_state[k][r][c] / bc1
                            v_hat = v_state[k][r][c] / bc2
                            param[r][c] -= lr * m_hat / (math.sqrt(v_hat) + eps)
                else:
                    is_bias = k.startswith("b_")
                    for idx in range(len(param)):
                        g = grads[k][idx] * grad_scale + (
                            0.0 if is_bias else weight_decay * param[idx]
                        )
                        m_state[k][idx] = beta1 * m_state[k][idx] + (1.0 - beta1) * g
                        v_state[k][idx] = beta2 * v_state[k][idx] + (1.0 - beta2) * (g * g)
                        m_hat = m_state[k][idx] / bc1
                        v_hat = v_state[k][idx] / bc2
                        param[idx] -= lr * m_hat / (math.sqrt(v_hat) + eps)

            val_sq = 0.0
            for vs in inner_val:
                vp_z, _ = self.forward_single(vs, edges)
                vy_z = (vs.target_actual - target_mean) / target_std
                val_sq += (vp_z - vy_z) ** 2
            val_loss = val_sq / max(1, len(inner_val))
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                best_params = snapshot_params()

        self.params = best_params
        return {"best_val_mse_z": round(best_val_loss, 5), "epochs": epochs}

    def predict_batch(
        self,
        samples: Sequence[SupervisedSample],
        edges: Sequence[NeighborEdgeSpec],
        target_mean: float,
        target_std: float,
    ) -> Tuple[List[float], List[float]]:
        preds: List[float] = []
        avg_gates = [0.0] * len(edges)
        for sample in samples:
            pred_z, cache = self.forward_single(sample, edges)
            preds.append(target_mean + target_std * pred_z)
            for i, g in enumerate(cache["gates"]):
                avg_gates[i] += g / max(1, len(samples))
        return preds, avg_gates


if HAS_TORCH:  # pragma: no cover - optional PyTorch path

    class PyTorchETGLagGNN(nn.Module):
        """Optional PyTorch reference implementation mirroring ETGLagGraphNet."""

        def __init__(self, target_dim: int, edge_msg_dim: int, hidden_dim: int = 16) -> None:
            super().__init__()
            self.self_enc = nn.Sequential(nn.Linear(target_dim, hidden_dim), nn.Tanh())
            self.msg_enc = nn.Sequential(nn.Linear(edge_msg_dim, hidden_dim), nn.Tanh())
            self.gate_net = nn.Linear(edge_msg_dim, 1)
            self.head = nn.Linear(hidden_dim * 2 + 1, 1)

        def forward(
            self,
            x_self: "torch.Tensor",
            edge_msgs: Optional["torch.Tensor"] = None,
        ) -> "torch.Tensor":
            h_self = self.self_enc(x_self)
            if edge_msgs is not None and edge_msgs.shape[1] > 0:
                m_hid = self.msg_enc(edge_msgs)
                gates = torch.softmax(self.gate_net(edge_msgs), dim=1)
                h_agg = (gates * m_hid).sum(dim=1)
            else:
                h_agg = torch.zeros_like(h_self)
            concat = torch.cat([h_self, h_agg, x_self[:, :1]], dim=-1)
            return self.head(concat).squeeze(-1)


def train_and_evaluate_etg_stgnn(
    source: Any,
    target_uuid: Optional[str] = None,
    target_idx: Optional[int] = None,
    horizon_steps: int = 1,
    window_lags: int = 3,
    hidden_dim: int = 12,
    epochs: int = 180,
    lr: float = 0.025,
    seed: int = 42,
) -> Dict[str, Any]:
    """Full benchmark comparing Persistence, Self-AR Ridge, Linear Graph Ridge, and ETGLagGraphNet."""
    dataset = load_etg_ml_dataset(source)
    chosen_idx = select_target_index(dataset, target_uuid=target_uuid, target_idx=target_idx)
    windowed = build_supervised_windows(
        dataset,
        target_idx=chosen_idx,
        horizon_steps=horizon_steps,
        window_lags=window_lags,
    )
    baselines = evaluate_baselines(windowed)

    edges: List[NeighborEdgeSpec] = windowed["incoming_edges"]
    mu: float = windowed["target_mean"]
    sd: float = windowed["target_std"]
    train: List[SupervisedSample] = windowed["train_samples"]
    test: List[SupervisedSample] = windowed["test_samples"]
    latest_sample: SupervisedSample = windowed["latest_sample"]

    model = ETGLagGraphNet(
        target_lag_dim=window_lags,
        edge_attr_dim=max(8, len(dataset.edge_attr_names)),
        neighbor_lag_dim=window_lags,
        hidden_dim=hidden_dim,
        seed=seed,
    )
    fit_info = model.fit(train, edges, mu, sd, epochs=epochs, lr=lr)

    test_gnn_preds, avg_gates = model.predict_batch(test, edges, mu, sd)
    latest_pred, _ = model.predict_batch([latest_sample], edges, mu, sd)

    p_rmse = max(1e-9, baselines["persistence"]["rmse"])
    gnn_metrics = _eval_preds(baselines["test_actuals"], test_gnn_preds, p_rmse)
    self_rmse = baselines["self_ar"]["rmse"]
    skill_lift_vs_self = (
        round(((self_rmse - gnn_metrics["rmse"]) / self_rmse) * 100.0, 2)
        if self_rmse > 1e-9
        else 0.0
    )

    attributions = sorted(
        [
            {
                "node_uuid": spec.src_uuid,
                "node_name": spec.src_name,
                "edge_type": spec.edge_type,
                "optimal_lag_steps": spec.optimal_lag,
                "learned_attention_weight": round(avg_gates[idx], 4)
                if idx < len(avg_gates)
                else 0.0,
            }
            for idx, spec in enumerate(edges)
        ],
        key=lambda row: row["learned_attention_weight"],
        reverse=True,
    )

    return {
        "schema_version": "etg-stgnn-eval-v1",
        "backend": "torch" if HAS_TORCH else "python-stdlib",
        "target_uuid": windowed["target_uuid"],
        "target_name": windowed["target_name"],
        "bucket": dataset.bucket,
        "train_count": len(train),
        "test_count": len(test),
        "horizon_steps": horizon_steps,
        "window_lags": window_lags,
        "neighbor_count": len(edges),
        "training": fit_info,
        "metrics": {
            "persistence": baselines["persistence"],
            "self_ar": baselines["self_ar"],
            "linear_graph_ridge": baselines["linear_graph_ridge"],
            "etg_lag_gnn": gnn_metrics,
        },
        "skill_lift_vs_self_pct": skill_lift_vs_self,
        "next_forecast": round(latest_pred[0], 4),
        "last_actual": round(latest_sample.last_actual, 4),
        "edge_attributions": attributions,
    }
