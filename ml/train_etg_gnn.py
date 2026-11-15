"""CLI trainer & benchmark for the Earth Trend Graph Spatio-Temporal GNN (`etg-ml-v1`)."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path
from typing import List, Optional

from etg_stgnn import train_and_evaluate_etg_stgnn


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train and benchmark ETGLagGraphNet on an etg-ml-v1 Earth Trend Graph export."
    )
    parser.add_argument(
        "--input",
        type=str,
        default="",
        help="Path or URL to etg-ml-v1 JSON export.",
    )
    parser.add_argument(
        "--server",
        type=str,
        default="http://localhost:3000",
        help="Running EarthTrends server URL when --input is omitted.",
    )
    parser.add_argument("--target-uuid", type=str, default=None, help="Target ETG node UUID.")
    parser.add_argument("--target-idx", type=int, default=None, help="Target ETG node index.")
    parser.add_argument("--horizon", type=int, default=1, help="Forecast horizon in steps.")
    parser.add_argument("--lags", type=int, default=3, help="Temporal lookback window.")
    parser.add_argument("--hidden-dim", type=int, default=12, help="GNN hidden dimension.")
    parser.add_argument("--epochs", type=int, default=180, help="Adam training epochs.")
    parser.add_argument("--lr", type=float, default=0.025, help="Adam learning rate.")
    parser.add_argument("--seed", type=int, default=42, help="Deterministic RNG seed.")
    parser.add_argument(
        "--output-json",
        type=str,
        default="",
        help="Optional output JSON report path.",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)

    if args.input:
        if args.input.startswith("http://") or args.input.startswith("https://"):
            with urllib.request.urlopen(args.input, timeout=15) as resp:
                source = json.loads(resp.read().decode("utf-8"))
        else:
            source = Path(args.input)
    else:
        query = f"{args.server.rstrip('/')}/api/graph/predict?format=ml_export"
        if args.target_uuid:
            query += f"&targetUuid={args.target_uuid}"
        with urllib.request.urlopen(query, timeout=15) as resp:
            source = json.loads(resp.read().decode("utf-8"))

    report = train_and_evaluate_etg_stgnn(
        source=source,
        target_uuid=args.target_uuid,
        target_idx=args.target_idx,
        horizon_steps=args.horizon,
        window_lags=args.lags,
        hidden_dim=args.hidden_dim,
        epochs=args.epochs,
        lr=args.lr,
        seed=args.seed,
    )

    if args.output_json:
        out_path = Path(args.output_json)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    m = report["metrics"]
    print(f"\n=== ETG Spatio-Temporal GNN Evaluation ({report['target_name']}) ===")
    print(
        f"Target UUID: {report['target_uuid']} | Bucket: {report['bucket']} | "
        f"Train={report['train_count']} | Test={report['test_count']} | Neighbors={report['neighbor_count']}"
    )
    print(f"Persistence        RMSE={m['persistence']['rmse']:.4f}  R2={m['persistence']['r2']:.3f}")
    print(f"Self-AR Ridge      RMSE={m['self_ar']['rmse']:.4f}  R2={m['self_ar']['r2']:.3f}")
    print(f"Linear Graph Ridge RMSE={m['linear_graph_ridge']['rmse']:.4f}  R2={m['linear_graph_ridge']['r2']:.3f}")
    print(
        f"ETGLagGraphNet     RMSE={m['etg_lag_gnn']['rmse']:.4f}  R2={m['etg_lag_gnn']['r2']:.3f}  "
        f"Lift vs Self-AR: {report['skill_lift_vs_self_pct']:+.2f}%"
    )
    print(f"Last Actual={report['last_actual']} -> Next Step Forecast={report['next_forecast']}")
    if report["edge_attributions"]:
        print("\nLearned Incoming Driver Attention:")
        for attr in report["edge_attributions"]:
            print(
                f"  - {attr['node_name']} ({attr['edge_type']}, lag={attr['optimal_lag_steps']}): "
                f"weight={attr['learned_attention_weight']:.3f}"
            )
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
