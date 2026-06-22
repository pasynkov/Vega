"""Calibrate the wake-word threshold and emit a markdown report.

For each threshold in {0.3..0.9}:
- on the held-out test set: precision, recall
- on the ambient soak audio: false-positives-per-hour

Writes reports/<ISO>.md.

Usage:
    python scripts/eval_threshold.py \
        --onnx checkpoints/v0/Vega.onnx \
        --cache embeddings_cache \
        --ambient data/eval/ambient_soak \
        --report reports/
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, list_audio, sha256_file
from build_embedding_cache import (
    EMBED_DIM,
    HEAD_WINDOW,
    read_wav_i16,
    stream_clip_to_embeddings,
    windows_from_embeddings,
)

THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]


def load_test(cache_dir: Path):
    import pandas as pd
    df = pd.read_parquet(cache_dir / "test.parquet")
    x = np.stack(df["window"].apply(lambda l: np.asarray(l, dtype=np.float32)).values, axis=0).reshape(-1, 16, 96)
    y = df["label"].to_numpy(dtype=np.int32)
    return x, y


def score_test(sess, in_name, out_name, x: np.ndarray) -> np.ndarray:
    out = []
    bs = 1024
    for i in range(0, len(x), bs):
        chunk = x[i:i + bs]
        s = sess.run([out_name], {in_name: chunk})[0].reshape(-1)
        out.append(s)
    return np.concatenate(out)


def score_ambient(ambient_dir: Path, mel_sess, mel_in, mel_out, emb_sess, emb_in, emb_out, head_sess, head_in, head_out) -> tuple[np.ndarray, float]:
    """Returns (per-window head scores, total audio duration in seconds)."""
    files = list_audio(ambient_dir)
    if not files:
        return np.zeros(0, dtype=np.float32), 0.0
    all_scores = []
    total_dur = 0.0
    for f in files:
        pcm = read_wav_i16(f)
        if pcm.size == 0:
            continue
        total_dur += len(pcm) / TARGET_SR
        embeds = stream_clip_to_embeddings(pcm, mel_sess, mel_in, mel_out, emb_sess, emb_in, emb_out)
        wins = windows_from_embeddings(embeds)
        if wins.shape[0] == 0:
            continue
        bs = 1024
        for i in range(0, len(wins), bs):
            chunk = wins[i:i + bs].astype(np.float32)
            s = head_sess.run([head_out], {head_in: chunk})[0].reshape(-1)
            all_scores.append(s)
    if not all_scores:
        return np.zeros(0, dtype=np.float32), total_dur
    return np.concatenate(all_scores), total_dur


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--onnx", type=Path, required=True)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--cache-sha", default=None)
    p.add_argument("--mel-model", type=Path, default=Path("../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx"))
    p.add_argument("--embedding-model", type=Path, default=Path("../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx"))
    p.add_argument("--ambient", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    args = p.parse_args()

    if args.cache_sha:
        cache_dir = args.cache / args.cache_sha
    else:
        cs = [d for d in args.cache.iterdir() if d.is_dir() and len(d.name) == 64]
        if len(cs) != 1:
            print(f"ERROR pick --cache-sha; found {[c.name for c in cs]}", file=sys.stderr)
            return 1
        cache_dir = cs[0]

    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    head = ort.InferenceSession(str(args.onnx), sess_options=so, providers=["CPUExecutionProvider"])
    head_in = head.get_inputs()[0].name
    head_out = head.get_outputs()[0].name

    print("scoring test set ...")
    x, y = load_test(cache_dir)
    s = score_test(head, head_in, head_out, x)

    mel = ort.InferenceSession(str(args.mel_model), sess_options=so, providers=["CPUExecutionProvider"])
    emb = ort.InferenceSession(str(args.embedding_model), sess_options=so, providers=["CPUExecutionProvider"])
    mel_in, mel_out = mel.get_inputs()[0].name, mel.get_outputs()[0].name
    emb_in, emb_out = emb.get_inputs()[0].name, emb.get_outputs()[0].name

    print(f"scoring ambient soak under {args.ambient} ...")
    amb_scores, amb_dur = score_ambient(args.ambient, mel, mel_in, mel_out, emb, emb_in, emb_out, head, head_in, head_out)
    print(f"ambient: {amb_dur:.1f}s of audio, {len(amb_scores)} windows")

    rows = []
    for t in THRESHOLDS:
        tp = int(((s >= t) & (y == 1)).sum())
        fp = int(((s >= t) & (y == 0)).sum())
        fn = int(((s < t) & (y == 1)).sum())
        prec = tp / max(1, tp + fp)
        rec = tp / max(1, tp + fn)
        # ambient FP/hour
        amb_pos = int((amb_scores >= t).sum()) if len(amb_scores) else 0
        fp_per_hour = (amb_pos / max(1e-6, amb_dur)) * 3600.0 if amb_dur > 0 else float("nan")
        rows.append((t, prec, rec, tp, fp, fn, fp_per_hour))

    recommended = None
    for t, prec, rec, *_ , fp_h in rows:
        if rec >= 0.85 and (fp_h != fp_h or fp_h <= 1.0):
            recommended = t
            break
    if recommended is None:
        recommended = max(rows, key=lambda r: r[2])[0]

    args.report.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.utcnow().strftime("%Y-%m-%dT%H-%M-%SZ")
    md_path = args.report / f"{ts}.md"
    head_sha = sha256_file(args.onnx)
    meta = json.loads((cache_dir / "meta.json").read_text())

    lines = [
        f"# Wake-word calibration — {ts}",
        "",
        f"- Head ONNX: `{args.onnx}` sha256 `{head_sha}`",
        f"- Embedding model sha256: `{meta.get('embedding_model_sha256')}`",
        f"- Mel model sha256: `{meta.get('mel_model_sha256')}`",
        f"- Cache dir: `{cache_dir.name}`",
        f"- Cache counts: {meta.get('counts')}",
        f"- Ambient soak: `{args.ambient}` ({amb_dur:.1f}s)",
        "",
        "## Per-threshold metrics",
        "",
        "| Threshold | Precision | Recall | TP | FP | FN | FP / hour ambient |",
        "|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for t, prec, rec, tp, fp, fn, fp_h in rows:
        lines.append(f"| {t:.2f} | {prec:.3f} | {rec:.3f} | {tp} | {fp} | {fn} | {fp_h:.2f} |")
    lines += [
        "",
        f"## Recommended default threshold: **{recommended:.2f}**",
        "",
        "Heuristic: smallest threshold where recall ≥ 0.85 and ambient FP/hour ≤ 1.0;",
        "falls back to highest-recall threshold if none satisfy the constraint.",
    ]
    md_path.write_text("\n".join(lines))
    print(f"OK wrote {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
