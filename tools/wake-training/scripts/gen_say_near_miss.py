"""Generate near-miss Russian words via macOS `say` for negative training.

Words chosen to phonetically neighbor 'Вега' so the head learns its boundary.

Usage:
    python scripts/gen_say_near_miss.py --out data/negatives/near_miss --per-word 30
"""

from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from gen_say_negatives import available_ru_voices, say_to_wav

WORDS = [
    "Бега",
    "Мега",
    "Вена",
    "Бега-бега",
    "Эгида",
    "Регата",
    "Вега-Лугарь",
    "Лега",
    "Дега",
    "Нега",
    "Тега",
    "Винега",
    "Омега",
    "Степа",
    "Запад",
]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--per-word", type=int, default=30)
    p.add_argument("--seed", type=int, default=11)
    args = p.parse_args()

    if not shutil.which("say") or not shutil.which("ffmpeg"):
        print("ERROR need both `say` and `ffmpeg`", file=sys.stderr)
        return 1
    voices = available_ru_voices() or ["Milena", "Yuri"]
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)
    n = 0
    for word in WORDS:
        for j in range(args.per_word):
            v = rng.choice(voices)
            out = args.out / f"{word.replace('-', '_')}__{v}__{j:03d}.wav"
            if say_to_wav(word, v, out):
                n += 1
    print(f"OK wrote {n} near-miss negatives under {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
