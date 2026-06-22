"""Augment positives to ~target count with deterministic ops.

Reads every wav under <in>/positives/{synthetic,real}/, applies a random
chain of (gain, pitch-shift, time-shift, additive noise, reverb stub),
writes augmented copies under <in>/positives/augmented/.

Original files are left untouched. Build_embedding_cache picks up all wavs.

Usage:
    python scripts/augment.py --in data/positives --out data/positives --target 10000 --seed 42
"""

from __future__ import annotations

import argparse
import hashlib
import os
import random
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, list_audio, write_manifest


def read_wav_i16(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getframerate() == TARGET_SR
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def write_wav_i16(path: Path, pcm: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(pcm, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_SR)
        w.writeframes(pcm.tobytes())


def to_float(x: np.ndarray) -> np.ndarray:
    return x.astype(np.float32) / 32768.0


def to_int16(x: np.ndarray) -> np.ndarray:
    return np.clip(x * 32768.0, -32768, 32767).astype(np.int16)


def op_gain(f: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    db = rng.uniform(-6.0, 6.0)
    g = 10.0 ** (db / 20.0)
    return f * g, {"op": "gain", "db": round(db, 2)}


def op_time_shift(f: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    shift_ms = rng.uniform(-200.0, 200.0)
    n = int(shift_ms * TARGET_SR / 1000)
    if n == 0:
        return f, {"op": "time_shift", "ms": 0.0}
    if n > 0:
        out = np.concatenate([np.zeros(n, dtype=f.dtype), f[:-n] if n < len(f) else np.zeros_like(f)])
    else:
        out = np.concatenate([f[-n:], np.zeros(-n, dtype=f.dtype)])
    return out, {"op": "time_shift", "ms": round(shift_ms, 1)}


def op_add_noise(f: np.ndarray, rng: random.Random, bg_pool: list[Path]) -> tuple[np.ndarray, dict]:
    if not bg_pool:
        return f, {"op": "noise", "skipped": "no_pool"}
    noise_path = rng.choice(bg_pool)
    nfile = read_wav_i16(noise_path)
    if len(nfile) < len(f):
        reps = (len(f) // max(1, len(nfile))) + 1
        nfile = np.tile(nfile, reps)
    start = rng.randrange(0, len(nfile) - len(f) + 1)
    nf = to_float(nfile[start:start + len(f)])
    snr = rng.uniform(5.0, 25.0)
    sig_p = np.mean(f * f) + 1e-12
    noi_p = np.mean(nf * nf) + 1e-12
    scale = float(np.sqrt(sig_p / (noi_p * (10.0 ** (snr / 10.0)))))
    return f + scale * nf, {"op": "noise", "snr_db": round(snr, 1), "noise": noise_path.name}


def op_pitch_shift(f: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    try:
        import librosa  # type: ignore
    except ImportError:
        return f, {"op": "pitch_shift", "skipped": "no_librosa"}
    semitones = rng.uniform(-2.0, 2.0)
    out = librosa.effects.pitch_shift(y=f, sr=TARGET_SR, n_steps=semitones)
    return out, {"op": "pitch_shift", "semitones": round(semitones, 2)}


def build_chain(rng: random.Random, bg_pool: list[Path]) -> list:
    # Always gain + time-shift; pitch-shift ~30%; noise if pool available ~70%
    chain = [op_gain, op_time_shift]
    if rng.random() < 0.3:
        chain.append(op_pitch_shift)
    if bg_pool and rng.random() < 0.7:
        chain.append(lambda f, r: op_add_noise(f, r, bg_pool))
    rng.shuffle(chain)
    return chain


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--target", type=int, default=10000)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--bg-dir", type=Path, default=Path("data/negatives/background"))
    args = p.parse_args()

    rng = random.Random(args.seed)

    src_pos: list[Path] = []
    for sub in ("synthetic", "real"):
        src_pos.extend(list_audio(args.inp / sub))
    if not src_pos:
        print(f"ERROR no positives under {args.inp}/[synthetic,real]", file=sys.stderr)
        return 1

    bg_pool: list[Path] = list_audio(args.bg_dir) if args.bg_dir.exists() else []
    out_dir = args.out / "augmented"
    out_dir.mkdir(parents=True, exist_ok=True)

    have = len(src_pos)
    need = max(0, args.target - have)
    print(f"src positives: {have}, target {args.target}, need {need} augmented")
    entries: list[dict] = []

    for i in range(need):
        src = src_pos[i % len(src_pos)]
        pcm = read_wav_i16(src)
        f = to_float(pcm)
        chain = build_chain(rng, bg_pool)
        applied = []
        for op in chain:
            f, meta = op(f, rng)
            applied.append(meta)
        out_path = out_dir / f"aug_{i:06d}__{src.stem}.wav"
        write_wav_i16(out_path, to_int16(f))
        entries.append({
            "path": str(out_path.relative_to(args.out.parents[1])),
            "label": 1,
            "source": "augmented",
            "src": str(src.relative_to(args.out.parents[1])) if args.out.parents[1] in src.parents else str(src),
            "sample_rate": TARGET_SR,
            "duration_s": round(len(f) / TARGET_SR, 3),
            "augmentation": applied,
        })
        if (i + 1) % 500 == 0:
            print(f"... {i + 1}/{need}")

    write_manifest(
        out_dir / "manifest.json",
        entries,
        generated_at_unix=int(os.path.getmtime(out_dir)),
        target=args.target,
        seed=args.seed,
        bg_pool_size=len(bg_pool),
    )
    print(f"OK wrote {len(entries)} augmented under {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
