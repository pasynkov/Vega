"""Generate Russian negative-class speech via the macOS `say` command.

Use as fallback when Common Voice / voxpopuli are not available. Voices used:
- Milena (RU) — female
- Yuri (RU) — male

Output: 16 kHz mono int16 wav under <out>/.

Usage:
    python scripts/gen_say_negatives.py --out data/negatives/common_voice --count 500
"""

from __future__ import annotations

import argparse
import random
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

from _common import TARGET_SR


# Common Russian sentences (short, varied) — sourced from public-domain phrasebooks
PHRASES_RU = [
    "Сегодня хорошая погода",
    "Я люблю слушать музыку",
    "Где находится ближайшая аптека",
    "Подскажи пожалуйста время",
    "Включи свет в комнате",
    "Сколько стоит билет в кино",
    "Москва столица России",
    "Книга лежит на столе",
    "Дети играют во дворе",
    "Кошка спит на диване",
    "Завтра я поеду на работу",
    "Утром выпил чашку кофе",
    "Океан очень глубокий",
    "Поезд приходит в полдень",
    "Эта песня мне нравится",
    "Зима в этом году тёплая",
    "Книжный магазин на углу",
    "Дай мне немного воды пожалуйста",
    "Я хочу поехать в горы",
    "Пятница самый лучший день недели",
    "Старый дом скоро снесут",
    "Дождь идёт уже второй час",
    "Лето в этом году короткое",
    "Чёрная собака бежит по улице",
    "Машина припаркована у дома",
    "Завтрак готов на кухне",
    "Бега начнутся в десять",
    "Мега магазин открыт круглосуточно",
    "В Вене старинная архитектура",
    "Регата прошла отлично",
    "Эгида богини спасала героев",
    "Бега-бега заяц от волка",
]


def say_to_wav(text: str, voice: str, out_path: Path) -> bool:
    with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
        aiff = Path(tmp.name)
    try:
        rc = subprocess.run(
            ["say", "-v", voice, "-o", str(aiff), text],
            check=False,
            capture_output=True,
        )
        if rc.returncode != 0:
            return False
        ff = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(aiff),
                "-ar", str(TARGET_SR), "-ac", "1", "-sample_fmt", "s16",
                str(out_path),
            ],
            check=False,
            capture_output=True,
        )
        return ff.returncode == 0
    finally:
        try:
            aiff.unlink()
        except FileNotFoundError:
            pass


def available_ru_voices() -> list[str]:
    out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "ru_RU":
            voices.append(parts[0])
    return voices


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--count", type=int, default=500)
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    if not shutil.which("say"):
        print("ERROR macOS `say` not available", file=sys.stderr)
        return 1
    if not shutil.which("ffmpeg"):
        print("ERROR ffmpeg not on PATH", file=sys.stderr)
        return 1

    voices = available_ru_voices() or ["Milena", "Yuri"]
    print(f"voices: {voices}")
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)

    n = 0
    while n < args.count:
        v = rng.choice(voices)
        text = rng.choice(PHRASES_RU)
        # add slight variation by tacking on / dropping the last word sometimes
        if rng.random() < 0.3 and " " in text:
            text = text.rsplit(" ", 1)[0]
        out = args.out / f"say_{v}_{n:06d}.wav"
        if say_to_wav(text, v, out):
            n += 1
            if n % 50 == 0:
                print(f"... {n}/{args.count}")
        else:
            print(f"WARN failed: voice={v} text={text!r}", file=sys.stderr)

    print(f"OK wrote {n} say-generated negatives under {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
