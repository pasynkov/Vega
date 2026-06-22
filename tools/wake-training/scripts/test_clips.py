"""Run the trained head over wav clips and report max-score + fire decisions.

Streams every clip through the OWW front-end (mel → embedding → head), prints
per-clip: max window score, time-of-max, # windows over threshold(s).

Usage:
    python scripts/test_clips.py --onnx checkpoints/v0/Vega.onnx \
        --clips data/positives/real --thresholds 0.3 0.5 0.7
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from _common import TARGET_SR, list_audio
from build_embedding_cache import (
    CHUNK,
    EMBED_DIM,
    HEAD_WINDOW,
    read_wav_i16,
    stream_clip_to_embeddings,
    windows_from_embeddings,
)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--onnx", type=Path, required=True)
    p.add_argument("--clips", type=Path, required=True)
    p.add_argument("--mel-model", type=Path,
                   default=Path("../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx"))
    p.add_argument("--embedding-model", type=Path,
                   default=Path("../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx"))
    p.add_argument("--thresholds", type=float, nargs="*", default=[0.3, 0.5, 0.7, 0.85])
    p.add_argument("--glob", default="*.wav")
    p.add_argument("--min-seconds", type=float, default=2.4,
                   help="Right-pad short clips with silence to this duration (mirrors build_embedding_cache).")
    args = p.parse_args()

    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    mel = ort.InferenceSession(str(args.mel_model), sess_options=so, providers=["CPUExecutionProvider"])
    emb = ort.InferenceSession(str(args.embedding_model), sess_options=so, providers=["CPUExecutionProvider"])
    head = ort.InferenceSession(str(args.onnx), sess_options=so, providers=["CPUExecutionProvider"])
    mi, mo = mel.get_inputs()[0].name, mel.get_outputs()[0].name
    ei, eo = emb.get_inputs()[0].name, emb.get_outputs()[0].name
    hi, ho = head.get_inputs()[0].name, head.get_outputs()[0].name

    files = sorted(args.clips.glob(args.glob)) if args.clips.is_dir() else [args.clips]
    if not files:
        print(f"ERROR no clips match {args.clips}/{args.glob}", file=sys.stderr)
        return 1

    thr_hits = {t: 0 for t in args.thresholds}
    rows = []
    max_name_len = max(len(f.name) for f in files)

    for f in files:
        pcm = read_wav_i16(f)
        if pcm.size == 0:
            print(f"{f.name:<{max_name_len}}  SKIP (empty/bad)")
            continue
        dur = len(pcm) / TARGET_SR
        embeds = stream_clip_to_embeddings(
            pcm, mel, mi, mo, emb, ei, eo,
            min_total_samples=int(args.min_seconds * TARGET_SR),
            pad_side="right",
        )
        wins = windows_from_embeddings(embeds)
        if wins.shape[0] == 0:
            print(f"{f.name:<{max_name_len}}  ({dur:5.2f}s) no windows (too short)")
            continue
        scores = head.run([ho], {hi: wins.astype(np.float32)})[0].reshape(-1)
        peak = float(scores.max())
        peak_idx = int(scores.argmax())
        # Each window represents the audio ending at frame (peak_idx + HEAD_WINDOW)
        # window i ends after (i + HEAD_WINDOW) embeddings, each 80 ms.
        peak_t = (peak_idx + HEAD_WINDOW) * (CHUNK / TARGET_SR)
        per_thr = []
        for t in args.thresholds:
            hit = int((scores >= t).sum())
            if hit:
                thr_hits[t] += 1
            per_thr.append(f"{t:.2f}:{hit:>2}")
        marks = []
        for t in args.thresholds:
            marks.append("✓" if peak >= t else "·")
        rows.append((f.name, dur, peak, peak_t, scores.shape[0], per_thr, marks))
        print(f"{f.name:<{max_name_len}}  ({dur:5.2f}s) peak={peak:.4f} @t={peak_t:.2f}s wins={scores.shape[0]:>3} "
              f"{'  '.join(per_thr)}  fired:[{' '.join(marks)}]")

    print()
    print("=" * 60)
    print(f"Files: {len(rows)}/{len(files)}")
    for t in args.thresholds:
        print(f"  threshold {t:.2f}: fired on {thr_hits[t]}/{len(rows)} clips ({100*thr_hits[t]/max(1,len(rows)):.0f}%)")
    if rows:
        peaks = np.array([r[2] for r in rows])
        print(f"peak score: min={peaks.min():.4f}  mean={peaks.mean():.4f}  max={peaks.max():.4f}  median={np.median(peaks):.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
