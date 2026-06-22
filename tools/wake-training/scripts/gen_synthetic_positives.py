"""Synthesize ~N Piper TTS 'Вега' utterances across ru_RU-* voices.

Outputs 16 kHz mono int16 wav under data/positives/synthetic/.
Voice tarballs cached under ~/.cache/piper-voices/.

Usage:
    python scripts/gen_synthetic_positives.py --out data/positives/synthetic --count 2000
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, write_manifest

PIPER_VOICES = [
    "ru_RU-irina-medium",
    "ru_RU-denis-medium",
    "ru_RU-dmitri-medium",
    "ru_RU-ruslan-medium",
]
CACHE = Path.home() / ".cache/piper-voices"


def ensure_voice(voice: str) -> tuple[Path, Path]:
    """Download (if missing) the .onnx + .onnx.json for a Piper voice."""
    CACHE.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/{voice.split('-', 2)[1]}/{voice.split('-', 2)[2]}"
    onnx = CACHE / f"{voice}.onnx"
    cfg = CACHE / f"{voice}.onnx.json"
    if not onnx.exists():
        subprocess.run(["curl", "-fSL", f"{base}/{voice}.onnx", "-o", str(onnx)], check=True)
    if not cfg.exists():
        subprocess.run(["curl", "-fSL", f"{base}/{voice}.onnx.json", "-o", str(cfg)], check=True)
    return onnx, cfg


def synth(text: str, voice_onnx: Path, length_scale: float, noise_scale: float) -> np.ndarray:
    """Run piper as a subprocess, return float32 mono at the voice's native rate."""
    cmd = [
        "piper",
        "--model", str(voice_onnx),
        "--output_raw",
        "--length_scale", f"{length_scale:.3f}",
        "--noise_scale", f"{noise_scale:.3f}",
    ]
    proc = subprocess.run(cmd, input=text.encode("utf-8"), check=True, capture_output=True)
    pcm = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return pcm


def resample_to_16k(pcm: np.ndarray, src_sr: int) -> np.ndarray:
    if src_sr == TARGET_SR:
        return pcm
    import librosa  # local: heavy import, only when needed
    return librosa.resample(pcm, orig_sr=src_sr, target_sr=TARGET_SR)


def voice_sample_rate(cfg: Path) -> int:
    return int(json.loads(cfg.read_text())["audio"]["sample_rate"])


def write_wav(path: Path, pcm_f32: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm_i16 = np.clip(pcm_f32 * 32767.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_SR)
        w.writeframes(pcm_i16.tobytes())


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--count", type=int, default=2000)
    p.add_argument("--text", default="Вега")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--voices", nargs="*", default=PIPER_VOICES)
    args = p.parse_args()

    random.seed(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)

    voice_assets = []
    for v in args.voices:
        try:
            onnx, cfg = ensure_voice(v)
            voice_assets.append((v, onnx, cfg, voice_sample_rate(cfg)))
        except subprocess.CalledProcessError as e:
            print(f"WARN skip voice {v}: {e}", file=sys.stderr)
    if not voice_assets:
        print("ERROR no voices available; install piper-tts deps", file=sys.stderr)
        return 1

    entries: list[dict] = []
    n_per_voice = args.count // len(voice_assets) + 1
    idx = 0
    for v, onnx, cfg, sr in voice_assets:
        for j in range(n_per_voice):
            if idx >= args.count:
                break
            length_scale = random.uniform(0.85, 1.20)   # speed jitter
            noise_scale = random.uniform(0.55, 0.75)    # timbre jitter
            try:
                pcm = synth(args.text, onnx, length_scale, noise_scale)
            except subprocess.CalledProcessError as e:
                print(f"WARN piper failed voice={v} j={j}: {e.stderr.decode(errors='ignore')[:200]}", file=sys.stderr)
                continue
            pcm16 = resample_to_16k(pcm, sr)
            name = f"{v}__{j:04d}.wav"
            out_path = args.out / v / name
            write_wav(out_path, pcm16)
            entries.append({
                "path": str(out_path.relative_to(args.out.parents[1])),
                "label": 1,
                "source": "piper",
                "voice": v,
                "length_scale": round(length_scale, 3),
                "noise_scale": round(noise_scale, 3),
                "sample_rate": TARGET_SR,
                "duration_s": round(len(pcm16) / TARGET_SR, 3),
                "augmentation": [],
            })
            idx += 1
            if idx % 100 == 0:
                print(f"... {idx}/{args.count}")
        if idx >= args.count:
            break

    write_manifest(
        args.out / "manifest.json",
        entries,
        generated_at_unix=int(os.path.getmtime(args.out)),
        text=args.text,
        seed=args.seed,
    )
    print(f"OK wrote {len(entries)} synthetic positives under {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
