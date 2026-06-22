"""Export a trained head to ONNX matching the Mac Ear's expected shape.

Refuses to write to apps/mac-ear/.../Vega.onnx without --force.

Usage:
    python scripts/export_onnx.py --run-id v0 --out checkpoints/v0/Vega.onnx
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

from _common import EAR_RES
from train_head import Head


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--run-id", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--checkpoints", type=Path, default=Path("checkpoints"))
    p.add_argument("--opset", type=int, default=17)
    p.add_argument("--force", action="store_true",
                   help="Allow overwriting Mac Ear bundled Vega.onnx")
    args = p.parse_args()

    bundled = EAR_RES / "Vega.onnx"
    if args.out.resolve() == bundled.resolve() and not args.force:
        print(f"ERROR refusing to overwrite {bundled} without --force", file=sys.stderr)
        return 1

    ckpt = args.checkpoints / args.run_id / "best.pt"
    if not ckpt.exists():
        print(f"ERROR no checkpoint at {ckpt}", file=sys.stderr)
        return 1

    model = Head()
    model.load_state_dict(torch.load(ckpt, map_location="cpu"))
    model.eval()

    dummy = torch.zeros(1, 16, 96, dtype=torch.float32)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    # dynamo=False forces the legacy single-file exporter; the new dynamo
    # exporter splits weights into <name>.data which Bundle.module won't
    # ship alongside the .onnx graph.
    torch.onnx.export(
        model,
        dummy,
        str(args.out),
        opset_version=args.opset,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
        dynamo=False,
    )
    print(f"OK exported {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
