"""Smoke-test: load exported Vega.onnx via onnxruntime, run one inference."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--onnx", type=Path, required=True)
    args = p.parse_args()

    import onnxruntime as ort
    sess = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    in_shape = sess.get_inputs()[0].shape
    out_name = sess.get_outputs()[0].name
    print(f"input  {in_name} {in_shape}")
    print(f"output {out_name} {sess.get_outputs()[0].shape}")

    x = np.random.randn(1, 16, 96).astype(np.float32)
    y = sess.run([out_name], {in_name: x})[0]
    print(f"output value shape={y.shape} dtype={y.dtype} value={float(y.reshape(-1)[0]):.4f}")
    if y.shape[-1] != 1:
        print("ERROR output is not single-scalar", file=sys.stderr)
        return 1
    val = float(y.reshape(-1)[0])
    if not (0.0 <= val <= 1.0):
        print(f"ERROR output {val} not in [0,1] (sigmoid expected)", file=sys.stderr)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
