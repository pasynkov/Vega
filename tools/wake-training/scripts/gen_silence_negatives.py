"""Generate silence + low-amplitude noise negatives.

Pure silence and quiet room noise so the head learns 'silence != wake'.
Critical when positives are right-padded with zeros for windowing.

Usage:
    python scripts/gen_silence_negatives.py --out data/negatives/silence --count 500
"""

from __future__ import annotations

import argparse
import random
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR


def write_wav(path: Path, pcm: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_SR)
        w.writeframes(pcm.astype(np.int16).tobytes())


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--count", type=int, default=500)
    p.add_argument("--seed", type=int, default=23)
    args = p.parse_args()

    rng = np.random.default_rng(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)

    n = 0
    for i in range(args.count):
        kind = rng.integers(0, 4)
        dur = rng.uniform(2.4, 3.5)
        samples = int(dur * TARGET_SR)
        if kind == 0:
            # pure zero silence
            pcm = np.zeros(samples, dtype=np.int16)
        elif kind == 1:
            # low-amplitude white noise (-60dBFS ≈ peak 32)
            pcm = (rng.normal(0, 30, samples)).astype(np.int16)
        elif kind == 2:
            # very low pink-ish noise
            pcm = (rng.normal(0, 80, samples)).astype(np.int16)
        else:
            # silence with tiny click/breath spike
            pcm = np.zeros(samples, dtype=np.int16)
            spike_pos = int(rng.uniform(0.1, dur - 0.1) * TARGET_SR)
            spike_len = int(rng.uniform(20, 200))
            pcm[spike_pos:spike_pos + spike_len] = rng.integers(-300, 300, spike_len).astype(np.int16)
        write_wav(args.out / f"silence_{i:05d}_kind{kind}.wav", pcm)
        n += 1
        if n % 100 == 0:
            print(f"... {n}/{args.count}")
    print(f"OK wrote {n} silence/quiet negatives under {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
