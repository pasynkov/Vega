"""Shared helpers for wake-training scripts. Kept dependency-light."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOL_ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = TOOL_ROOT / "data"
EAR_RES = REPO_ROOT / "apps/mac-ear/Sources/VegaEar/Resources"

TARGET_SR = 16_000

DATA_LAYOUT = {
    "positives/synthetic": "Piper TTS-generated 'Вега' utterances",
    "positives/real": "User-recorded 'Вега' (16 kHz mono int16 wav)",
    "negatives/common_voice": "Common Voice ru subset",
    "negatives/background": "openWakeWord-published background audio",
    "negatives/near_miss": "Russian near-miss words (Бега, Мега, Вена, ...)",
    "eval/ambient_soak": ">= 1h continuous typical-environment audio",
}


def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def list_audio(root: Path, exts: Iterable[str] = (".wav",)) -> list[Path]:
    if not root.exists():
        return []
    out: list[Path] = []
    for ext in exts:
        out.extend(sorted(root.rglob(f"*{ext}")))
    return out


def require_dir(path: Path, hint: str) -> None:
    if not path.exists() or not any(path.iterdir()):
        die(f"missing or empty dataset directory: {path}\nhint: {hint}")


def write_manifest(path: Path, entries: list[dict], **meta) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"version": 1, **meta, "files": entries}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
