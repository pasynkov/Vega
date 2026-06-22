# Vega Ear — macOS

Swift menu-bar app. Listens for a wake word using OpenWakeWord (ONNX), streams raw 48 kHz mono PCM (`linear16`) to Vega Core, plays Tink/Pop/Basso cues for wake / endpoint / error. Core handles streaming STT and writes a Telegram-ready OGG/OPUS to `recordings/`.

## Build (CLI)

```bash
cd apps/mac-ear
swift build
swift run VegaEar
```

## Build (Xcode)

```bash
open Package.swift
```

Xcode generates a project from `Package.swift`. To run the menu-bar app correctly:

1. In the target settings, add to **Info.plist** (use the template at `Sources/VegaEar/Resources/VegaEar-Info.plist`):
   - `LSUIElement = YES` (no Dock icon)
   - `NSMicrophoneUsageDescription` — copy from the template
2. No API keys are required. The bundled OpenWakeWord ONNX models live under `Sources/VegaEar/Resources/`.

## Wake-word pipeline

The Ear runs OpenWakeWord locally via ONNX Runtime (Swift Package). On every 80 ms of 16 kHz mono PCM:

1. `melspectrogram.onnx` converts the most recent ~110 ms window of raw Int16 PCM into 8 new mel-spec frames (32 bins, OWW transform `x/10 + 2`).
2. `embedding_model.onnx` consumes the last 76 mel frames and emits a single 96-dim embedding.
3. Each classifier head (`Vega.onnx`) reads the last 16 embeddings and produces a sigmoid score in `[0, 1]`.
4. The first head whose score crosses the user-configurable threshold fires `wake_detected`. A short cooldown suppresses double-fires within ~1.5 s.

The candidate list and the threshold are the only knobs:

- Candidates are a hard-coded array in `OpenWakeWordDetector.init` (`["Vega"]`). To add or trim candidates, edit the array and rebuild. The Russian "Вега" head is trained locally via `tools/wake-training/`.
- The "Wake sensitivity" menu-bar submenu offers four presets: `Low (0.3)`, `Default (0.5)`, `High (0.7)`, `Very High (0.85)`. The active preset is check-marked. Selection updates the live detector immediately and persists to `~/Library/Application Support/Vega/preferences.json`.

## Bundled models

All three ONNX files live in `Sources/VegaEar/Resources/` and are loaded via `Bundle.module`. The shared front-end ships under Apache-2.0 (openWakeWord upstream); the `Vega.onnx` head is trained locally via `tools/wake-training/` and ships under the repo's licence.

| File                  | Purpose                                       | Source                                                                                                                  | SHA-256                                                              |
|-----------------------|-----------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------|
| `melspectrogram.onnx` | OWW shared mel front-end                      | [openWakeWord upstream](https://github.com/dscripka/openWakeWord/tree/main/openwakeword/resources/models)               | `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f` |
| `embedding_model.onnx`| OWW shared speech-embedding model             | [openWakeWord upstream](https://github.com/dscripka/openWakeWord/tree/main/openwakeword/resources/models)               | `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f` |
| `Vega.onnx`           | Russian "Вега" wake-word classifier head      | [tools/wake-training/](../../tools/wake-training/)                                                                       | `33279186110700aea044f72184488fb6675b7a0299c9cce1a377eb3098f32989` |

Retraining: see `tools/wake-training/README.md`. A follow-up may add an English "Vega" head as a second candidate.

## Audio encoding

The MVP wire codec is `linear16` — the Ear streams raw PCM. Core encodes the persisted artifact to OGG/OPUS via ffmpeg. No native encoder runs on the Ear.

A future change can introduce on-device OPUS encoding (Apple `AVAudioConverter` with `kAudioFormatOpus`, available on macOS 14.4+, is the most likely path). The `AudioFrameProducer` protocol in `OpusEncoder.swift` is the seam to swap in.
