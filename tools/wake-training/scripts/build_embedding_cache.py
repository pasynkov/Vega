"""Run the openWakeWord front-end over every wav under data/ and cache 96-dim windows + labels.

Cache layout:
    embeddings_cache/<sha256-of-embedding_model>/
        train.parquet
        val.parquet
        test.parquet
        meta.json

Each row: {window: list[float] (length 16*96 = 1536), label: int, src: str, source: str}.

Front-end matches OpenWakeWordDetector.swift exactly:
    mel input : float32 [1, 1760] of raw int16-valued samples (NOT normalized)
    mel output: [1, 1, n_frames, 32]; apply x/10 + 2
    embed in  : [1, 76, 32, 1]      embed out: [1, 1, 1, 96]
    head in   : [1, 16, 96]         head out : sigmoid scalar

Hop is 80 ms (1280 samples). A clip yields max(0, n_embeds - 16 + 1) training windows.

Usage:
    python scripts/build_embedding_cache.py \
        --embedding-model ../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx \
        --mel-model      ../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx \
        --data data --cache embeddings_cache
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, list_audio, sha256_file

MEL_CONTEXT = 1760
CHUNK = 1280
MEL_HOP_PER_CHUNK = 8
EMBED_WINDOW = 76
EMBED_DIM = 96
HEAD_WINDOW = 16
MEL_BINS = 32

POSITIVE_DIRS = ["positives/synthetic", "positives/real", "positives/augmented"]
NEGATIVE_DIRS = ["negatives/common_voice", "negatives/background", "negatives/near_miss"]


def read_wav_i16(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != TARGET_SR:
            return np.zeros(0, dtype=np.int16)
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def stream_clip_to_embeddings(pcm_i16: np.ndarray, mel_sess, mel_in, mel_out, emb_sess, emb_in, emb_out,
                              min_total_samples: int | None = None,
                              pad_side: str = "right") -> np.ndarray:
    """Replay the streaming loop, return an array of 96-dim embeddings.

    `min_total_samples` (optional) pads the clip with zeros so a minimum number
    of windows can be produced. `pad_side` controls whether silence is appended
    after ('right') or prepended ('left') — for positive wake-word clips, pad
    right so the wake word stays at the start of the clip and the early
    embeddings capture it.
    """
    if min_total_samples and len(pcm_i16) < min_total_samples:
        pad = min_total_samples - len(pcm_i16)
        z = np.zeros(pad, dtype=np.int16)
        pcm_i16 = np.concatenate([pcm_i16, z]) if pad_side == "right" else np.concatenate([z, pcm_i16])
    elif len(pcm_i16) < MEL_CONTEXT:
        pad = MEL_CONTEXT - len(pcm_i16)
        z = np.zeros(pad, dtype=np.int16)
        pcm_i16 = np.concatenate([pcm_i16, z]) if pad_side == "right" else np.concatenate([z, pcm_i16])

    mel_buf: list[np.ndarray] = []  # list of (8, 32) mel chunks → concatenated frames
    embeds: list[np.ndarray] = []

    cursor = MEL_CONTEXT
    while cursor <= len(pcm_i16):
        window = pcm_i16[cursor - MEL_CONTEXT:cursor].astype(np.float32)
        mel = mel_sess.run([mel_out], {mel_in: window[None, :]})[0]
        # [1,1,n_frames,32] → take last MEL_HOP_PER_CHUNK frames
        m = mel.squeeze(0).squeeze(0)  # [n_frames, 32]
        if m.shape[0] < MEL_HOP_PER_CHUNK:
            cursor += CHUNK
            continue
        new = (m[-MEL_HOP_PER_CHUNK:] / 10.0) + 2.0  # (8, 32)
        mel_buf.append(new)
        # Flatten current mel buffer for embedding inference
        all_mel = np.concatenate(mel_buf, axis=0) if mel_buf else np.zeros((0, 32), dtype=np.float32)
        if all_mel.shape[0] >= EMBED_WINDOW:
            emb_in_tensor = all_mel[-EMBED_WINDOW:].reshape(1, EMBED_WINDOW, MEL_BINS, 1).astype(np.float32)
            emb = emb_sess.run([emb_out], {emb_in: emb_in_tensor})[0]
            embeds.append(emb.reshape(-1)[:EMBED_DIM])
        cursor += CHUNK

    return np.stack(embeds, axis=0) if embeds else np.zeros((0, EMBED_DIM), dtype=np.float32)


def windows_from_embeddings(embeds: np.ndarray) -> np.ndarray:
    """Sliding 16-embedding windows → [n_windows, 16, 96]."""
    n = embeds.shape[0]
    if n < HEAD_WINDOW:
        return np.zeros((0, HEAD_WINDOW, EMBED_DIM), dtype=np.float32)
    out = np.zeros((n - HEAD_WINDOW + 1, HEAD_WINDOW, EMBED_DIM), dtype=np.float32)
    for i in range(out.shape[0]):
        out[i] = embeds[i:i + HEAD_WINDOW]
    return out


def split_for_file(rel_path: str) -> str:
    """Stable split keyed by SOURCE file (not augmented variant) — prevents leakage.

    `aug_NNNNNN__<SOURCE>.wav` rolls up to <SOURCE>; everything else uses its own stem.
    Scarce negatives (real mic silence captures) are forced into train so we never
    waste them on val/test where they would not help suppress live false positives.
    """
    stem = Path(rel_path).stem
    if stem.startswith("real_mic_silence"):
        return "train"
    if stem.startswith("aug_") and "__" in stem:
        key = stem.split("__", 1)[1]
    else:
        key = stem
    h = int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) % 100
    if h < 80:
        return "train"
    if h < 90:
        return "val"
    return "test"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--embedding-model", type=Path, required=True)
    p.add_argument("--mel-model", type=Path, required=True)
    p.add_argument("--data", type=Path, required=True)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--max-windows-per-clip", type=int, default=8,
                   help="Cap windows per negative clip.")
    p.add_argument("--positive-window-cap", type=int, default=2,
                   help="Cap windows per positive clip; positives are trimmed to ~1.5s so we want the first 1-2 windows containing the wake word.")
    p.add_argument("--positive-min-seconds", type=float, default=2.2,
                   help="Right-pad positive clips with silence to this duration so at least one window is produced.")
    args = p.parse_args()

    if not args.embedding_model.exists() or not args.mel_model.exists():
        print("ERROR onnx models not found", file=sys.stderr)
        return 1

    emb_sha = sha256_file(args.embedding_model)
    cache_dir = args.cache / emb_sha
    cache_dir.mkdir(parents=True, exist_ok=True)

    meta_path = cache_dir / "meta.json"
    if meta_path.exists():
        existing = json.loads(meta_path.read_text())
        print(f"cache exists at {cache_dir} (built {existing.get('built_at_unix')})")
    else:
        print(f"building cache at {cache_dir}")

    import onnxruntime as ort
    import pandas as pd

    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    mel = ort.InferenceSession(str(args.mel_model), sess_options=so, providers=["CPUExecutionProvider"])
    emb = ort.InferenceSession(str(args.embedding_model), sess_options=so, providers=["CPUExecutionProvider"])
    mel_in = mel.get_inputs()[0].name
    mel_out = mel.get_outputs()[0].name
    emb_in = emb.get_inputs()[0].name
    emb_out = emb.get_outputs()[0].name

    rows: dict[str, list[dict]] = {"train": [], "val": [], "test": []}

    def ingest(sub: str, label: int) -> None:
        d = args.data / sub
        files = list_audio(d)
        print(f"{sub}: {len(files)} files")
        is_positive = label == 1
        cap = args.positive_window_cap if is_positive else args.max_windows_per_clip
        # Background silence: cap a bit higher than other negatives so the head sees
        # enough mic-noise variation, but not so much that it dominates the loss.
        if sub == "negatives/background":
            cap = 20
        # Pad short clips of both classes so every clip contributes at least one window.
        # Positives pad-right (wake stays at start); negatives same direction for consistency.
        min_samples = int(args.positive_min_seconds * TARGET_SR)
        for f in files:
            pcm = read_wav_i16(f)
            if pcm.size == 0:
                continue
            embeds = stream_clip_to_embeddings(
                pcm, mel, mel_in, mel_out, emb, emb_in, emb_out,
                min_total_samples=min_samples,
                pad_side="right",
            )
            wins = windows_from_embeddings(embeds)
            if wins.shape[0] == 0:
                continue
            if is_positive:
                # Take the earliest windows — they contain the wake word; later ones drift into padding.
                wins = wins[:cap]
            elif wins.shape[0] > cap:
                idxs = np.linspace(0, wins.shape[0] - 1, cap).astype(int)
                wins = wins[idxs]
            rel = str(f.relative_to(args.data))
            split = split_for_file(rel)
            for w in wins:
                rows[split].append({
                    "window": w.reshape(-1).tolist(),
                    "label": label,
                    "src": rel,
                    "source": sub,
                })

    for sub in POSITIVE_DIRS:
        ingest(sub, 1)
    for sub in NEGATIVE_DIRS:
        ingest(sub, 0)

    for split, items in rows.items():
        if not items:
            print(f"WARN split {split} empty")
            continue
        df = pd.DataFrame(items)
        out_path = cache_dir / f"{split}.parquet"
        df.to_parquet(out_path, compression="zstd")
        print(f"{split}: {len(items)} windows → {out_path}")

    meta_path.write_text(json.dumps({
        "built_at_unix": int(os.path.getmtime(cache_dir)),
        "embedding_model_sha256": emb_sha,
        "mel_model_sha256": sha256_file(args.mel_model),
        "data_root": str(args.data),
        "counts": {k: len(v) for k, v in rows.items()},
        "max_windows_per_clip": args.max_windows_per_clip,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
