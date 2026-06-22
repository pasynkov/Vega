"""Fetch negative-class datasets.

- Common Voice ru subset: small sample of validated clips (HF dataset stream).
- openWakeWord-published background audio: room/TV/music tarball.
- Near-miss words: Piper-synthesized 'Бега', 'Мега', 'Вена', 'Бега-бега', 'Эгида'.

All downloads checksummed; rerun is idempotent.

Usage:
    python scripts/fetch_negatives.py --out data/negatives
"""

from __future__ import annotations

import argparse
import hashlib
import os
import random
import shutil
import subprocess
import sys
import tarfile
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR, sha256_file, write_manifest

NEAR_MISS_WORDS = ["Бега", "Мега", "Вена", "Бега-бега", "Эгида", "Регата", "Вега-Лугарь"]

# Public mirror of openWakeWord background dataset (small subset; full set is large).
# Falls back to skipping if unreachable.
OWW_BG_URLS = [
    "https://huggingface.co/datasets/dscripka/openwakeword/resolve/main/audioset_16k.tar.gz",
]


def curl(url: str, dst: Path) -> bool:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and dst.stat().st_size > 0:
        return True
    print(f"download {url}")
    rc = subprocess.run(["curl", "-fSL", url, "-o", str(dst)]).returncode
    return rc == 0


def extract_tar(tar_path: Path, out_dir: Path, max_files: int | None = None) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    with tarfile.open(tar_path) as tf:
        for m in tf:
            if not m.isfile():
                continue
            if not m.name.lower().endswith((".wav", ".flac", ".mp3", ".ogg")):
                continue
            target = out_dir / Path(m.name).name
            if target.exists():
                n += 1
                if max_files and n >= max_files:
                    break
                continue
            with tf.extractfile(m) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            n += 1
            if max_files and n >= max_files:
                break
    return n


def decode_to_pcm16(src: Path) -> np.ndarray:
    cmd = [
        "ffmpeg", "-loglevel", "error", "-i", str(src),
        "-ar", str(TARGET_SR), "-ac", "1", "-f", "s16le", "-",
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True)
    return np.frombuffer(proc.stdout, dtype=np.int16)


def normalize_dir(src_dir: Path, dst_dir: Path) -> int:
    dst_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in sorted(src_dir.iterdir()):
        if not f.is_file():
            continue
        try:
            pcm = decode_to_pcm16(f)
        except subprocess.CalledProcessError:
            continue
        out = dst_dir / (f.stem + ".wav")
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_SR)
            w.writeframes(pcm.tobytes())
        n += 1
    return n


def fetch_common_voice_ru(out: Path, target_count: int) -> int:
    """Stream ungated Russian-speech dataset(s) and dump 16 kHz int16 wav.

    Tries multiple HF datasets in order; first one that yields rows wins.
    """
    try:
        from datasets import load_dataset  # type: ignore
        import soundfile as sf  # type: ignore
    except ImportError:
        print("WARN skipping common_voice: install 'datasets' + 'soundfile'", file=sys.stderr)
        return 0
    out.mkdir(parents=True, exist_ok=True)
    candidates = [
        # (dataset_id, config, split)
        ("facebook/voxpopuli", "ru", "train"),
        ("mozilla-foundation/common_voice_11_0", "ru", "validated"),
        ("mozilla-foundation/common_voice_17_0", "ru", "validated"),
    ]
    ds = None
    chosen = None
    for ds_id, cfg, split in candidates:
        try:
            ds = load_dataset(ds_id, cfg, split=split, streaming=True, trust_remote_code=True)
            # touch first row to surface auth errors early
            it = iter(ds)
            first = next(it)
            ds = ds  # restart below with a fresh iterator
            chosen = (ds_id, cfg, split)
            print(f"using {ds_id}/{cfg} split={split}")
            break
        except Exception as e:  # noqa: BLE001
            print(f"WARN dataset {ds_id} unavailable: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
            ds = None
            continue
    if ds is None:
        print("ERROR no Russian-speech dataset usable; install HF token or pick another source", file=sys.stderr)
        return 0
    n = 0
    for row in ds:
        if n >= target_count:
            break
        arr = np.asarray(row["audio"]["array"], dtype=np.float32)
        sr = int(row["audio"]["sampling_rate"])
        if sr != TARGET_SR:
            import librosa  # type: ignore
            arr = librosa.resample(arr, orig_sr=sr, target_sr=TARGET_SR)
        pcm = np.clip(arr * 32767.0, -32768, 32767).astype(np.int16)
        out_path = out / f"cv_ru_{n:06d}.wav"
        with wave.open(str(out_path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(TARGET_SR)
            w.writeframes(pcm.tobytes())
        n += 1
    return n


def fetch_near_miss(out: Path, per_word: int, voices: list[str]) -> int:
    """Synthesize near-miss words via piper. Reuses gen_synthetic_positives helpers."""
    out.mkdir(parents=True, exist_ok=True)
    from gen_synthetic_positives import ensure_voice, synth, voice_sample_rate, resample_to_16k, write_wav
    rng = random.Random(7)
    n = 0
    for v in voices:
        try:
            onnx, cfg = ensure_voice(v)
            sr = voice_sample_rate(cfg)
        except subprocess.CalledProcessError as e:
            print(f"WARN skip near-miss voice {v}: {e}", file=sys.stderr)
            continue
        for word in NEAR_MISS_WORDS:
            for j in range(per_word):
                length_scale = rng.uniform(0.85, 1.2)
                noise_scale = rng.uniform(0.55, 0.75)
                try:
                    pcm = synth(word, onnx, length_scale, noise_scale)
                except subprocess.CalledProcessError:
                    continue
                pcm16 = resample_to_16k(pcm, sr)
                slug = word.replace("-", "_")
                write_wav(out / f"{v}__{slug}__{j:03d}.wav", pcm16)
                n += 1
    return n


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--cv-count", type=int, default=2000)
    p.add_argument("--near-miss-per-word", type=int, default=20)
    p.add_argument("--bg-max-files", type=int, default=1000)
    p.add_argument("--skip-bg", action="store_true")
    p.add_argument("--skip-cv", action="store_true")
    p.add_argument("--skip-near-miss", action="store_true")
    args = p.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    summary: dict[str, int | str] = {}

    if not args.skip_cv:
        cv_out = args.out / "common_voice"
        n = fetch_common_voice_ru(cv_out, args.cv_count)
        summary["common_voice"] = n
        print(f"common_voice: {n} clips")

    if not args.skip_bg:
        bg_out = args.out / "background"
        bg_out.mkdir(parents=True, exist_ok=True)
        cache = args.out / "_cache"
        any_ok = False
        for url in OWW_BG_URLS:
            tar = cache / Path(url).name
            if not curl(url, tar):
                print(f"WARN bg download failed: {url}", file=sys.stderr)
                continue
            extracted = bg_out / "_raw"
            try:
                n = extract_tar(tar, extracted, max_files=args.bg_max_files)
                norm_n = normalize_dir(extracted, bg_out)
                summary["background"] = norm_n
                summary["background_tar_sha256"] = sha256_file(tar)
                shutil.rmtree(extracted, ignore_errors=True)
                print(f"background: {norm_n} clips")
                any_ok = True
                break
            except tarfile.TarError as e:
                print(f"WARN bg extract failed: {e}", file=sys.stderr)
        if not any_ok:
            summary["background"] = 0

    if not args.skip_near_miss:
        nm_out = args.out / "near_miss"
        from gen_synthetic_positives import PIPER_VOICES
        n = fetch_near_miss(nm_out, args.near_miss_per_word, PIPER_VOICES)
        summary["near_miss"] = n
        print(f"near_miss: {n} clips")

    write_manifest(
        args.out / "manifest.json",
        [],
        generated_at_unix=int(os.path.getmtime(args.out)),
        summary=summary,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
