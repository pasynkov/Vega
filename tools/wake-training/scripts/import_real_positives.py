"""Ingest user-recorded wake-word utterances → 16 kHz mono int16 wav.

Accepts a source dir containing either:
  - the Ear's per-recording layout: <ts>/audio.ogg + meta.json + transcript.txt
  - flat audio files (any ffmpeg-decodable extension)

Trims leading/trailing silence, writes wav under --out.

Usage:
    python scripts/import_real_positives.py --src ../../recordings --out data/positives/real
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, write_manifest

DECODABLE_EXTS = {".ogg", ".opus", ".wav", ".flac", ".mp3", ".m4a", ".aac"}


def ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        print("ERROR ffmpeg not on PATH; brew install ffmpeg", file=sys.stderr)
        sys.exit(1)
    return exe


def decode_to_pcm16(src: Path) -> np.ndarray:
    cmd = [
        ffmpeg(), "-loglevel", "error", "-i", str(src),
        "-ar", str(TARGET_SR), "-ac", "1", "-f", "s16le", "-",
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True)
    return np.frombuffer(proc.stdout, dtype=np.int16)


def trim_to_wake_window(pcm: np.ndarray, max_seconds: float = 1.5,
                        pad_pre_ms: int = 120, thresh_db: float = -40.0) -> np.ndarray:
    """Trim to a tight window starting just before speech onset, capped at max_seconds.

    Recordings from the Ear capture several seconds of audio even though the
    transcript is just 'Вега'. Labeling every window of a 6 s clip as positive
    makes the head learn 'user voice = wake' instead of the word itself, so we
    keep only the first ~max_seconds after the onset and discard the tail.
    """
    if len(pcm) == 0:
        return pcm
    f = pcm.astype(np.float32) / 32768.0
    frame = TARGET_SR // 50  # 20 ms
    n = len(f) // frame
    if n < 2:
        return pcm
    rms = np.sqrt(np.mean(f[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    db = 20.0 * np.log10(rms + 1e-12)
    active = db > thresh_db
    if not active.any():
        return pcm[: int(max_seconds * TARGET_SR)]
    first = int(active.argmax())
    pre = pad_pre_ms * TARGET_SR // 1000
    start = max(0, first * frame - pre)
    end = min(len(pcm), start + int(max_seconds * TARGET_SR))
    return pcm[start:end]


def write_wav(path: Path, pcm_i16: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_SR)
        w.writeframes(pcm_i16.tobytes())


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--src", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--no-trim", action="store_true")
    p.add_argument("--max-seconds", type=float, default=1.5,
                   help="Hard-cap clip duration after onset trim. Keeps positives focused on the wake word.")
    p.add_argument("--expected-text", default="Вега",
                   help="If a transcript.txt is present, skip files whose transcript != this text.")
    args = p.parse_args()

    if not args.src.exists():
        print(f"ERROR source dir not found: {args.src}", file=sys.stderr)
        return 1
    args.out.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    skipped = 0

    # Two ingestion patterns:
    for child in sorted(args.src.iterdir()):
        if child.is_dir():
            audio = next((child / f"audio{ext}" for ext in (".ogg", ".opus", ".wav") if (child / f"audio{ext}").exists()), None)
            if audio is None:
                continue
            meta = {}
            meta_p = child / "meta.json"
            if meta_p.exists():
                try:
                    meta = json.loads(meta_p.read_text())
                except Exception:
                    pass
            tx_p = child / "transcript.txt"
            if tx_p.exists():
                tx = tx_p.read_text().strip()
                if tx and tx.lower() != args.expected_text.lower():
                    print(f"skip {child.name}: transcript={tx!r} != {args.expected_text!r}")
                    skipped += 1
                    continue
            try:
                pcm = decode_to_pcm16(audio)
            except subprocess.CalledProcessError as e:
                print(f"WARN ffmpeg failed for {audio}: {e}", file=sys.stderr)
                continue
            if not args.no_trim:
                pcm = trim_to_wake_window(pcm, max_seconds=args.max_seconds)
            name = f"{child.name}.wav"
            out_path = args.out / name
            write_wav(out_path, pcm)
            entries.append({
                "path": str(out_path.relative_to(args.out.parents[1])),
                "label": 1,
                "source": "user_recording",
                "recording_id": meta.get("sessionId"),
                "device": meta.get("deviceName"),
                "sample_rate": TARGET_SR,
                "duration_s": round(len(pcm) / TARGET_SR, 3),
                "augmentation": [],
            })
        elif child.is_file() and child.suffix.lower() in DECODABLE_EXTS:
            try:
                pcm = decode_to_pcm16(child)
            except subprocess.CalledProcessError:
                continue
            if not args.no_trim:
                pcm = trim_to_wake_window(pcm, max_seconds=args.max_seconds)
            out_path = args.out / (child.stem + ".wav")
            write_wav(out_path, pcm)
            entries.append({
                "path": str(out_path.relative_to(args.out.parents[1])),
                "label": 1,
                "source": "user_recording_flat",
                "sample_rate": TARGET_SR,
                "duration_s": round(len(pcm) / TARGET_SR, 3),
                "augmentation": [],
            })

    write_manifest(
        args.out / "manifest.json",
        entries,
        generated_at_unix=int(os.path.getmtime(args.out)),
        src=str(args.src),
        expected_text=args.expected_text,
        skipped_mismatched_transcript=skipped,
    )
    print(f"OK wrote {len(entries)} real positives under {args.out} (skipped {skipped})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
