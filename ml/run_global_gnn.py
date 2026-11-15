"""CLI entrypoint to harvest 36-city global data, train ETGGlobalSpatiotemporalGNN, and export weights."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

_ML_DIR = str(Path(__file__).resolve().parent)
if _ML_DIR not in sys.path:
    sys.path.insert(0, _ML_DIR)

from global_gnn.train_and_export import train_and_evaluate_global_gnn


def main() -> None:
    parser = argparse.ArgumentParser(description="Train & export unified 36-city ETG Global Spatiotemporal GNN.")
    parser.add_argument("--cache-dir", default="/content/etg_global_cache")
    parser.add_argument("--weights-dir", default="ml/weights")
    parser.add_argument("--epochs", type=int, default=38)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--lr", type=float, default=1.2e-3)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    summary = train_and_evaluate_global_gnn(
        cache_dir=args.cache_dir,
        weights_dir=args.weights_dir,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        seed=args.seed,
    )
    out_summary = Path(args.weights_dir) / "etg-global-gnn-v3-summary.json"
    out_summary.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[done] Summary saved to {out_summary}")


if __name__ == "__main__":
    main()
