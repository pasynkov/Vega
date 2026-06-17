# Vega Ear — macOS

Swift menu-bar app. Listens for the wake word "Vega" with Porcupine, streams raw 48 kHz mono PCM (`linear16`) to Vega Core, plays Tink/Pop/Basso cues for wake / endpoint / error. Core handles streaming STT and writes a Telegram-ready OGG/OPUS to `recordings/`.

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
2. Provide your **Picovoice access key** via one of:
   - Keychain: `security add-generic-password -s vega.picovoice -a $USER -w <KEY>`
   - or write `PICOVOICE_ACCESS_KEY=<KEY>` to `~/.config/vega/ear.env`
3. Drop your **`Vega.ppn`** model into `Sources/VegaEar/Resources/`. Get one from the Picovoice console: create a custom wake word "Vega" for the platform `mac (Apple Silicon)` or `mac (Intel)` to match your machine.

## Audio encoding

The MVP wire codec is `linear16` — the Ear streams raw PCM. Core encodes the persisted artifact to OGG/OPUS via ffmpeg. No native encoder runs on the Ear.

A future change can introduce on-device OPUS encoding (Apple `AVAudioConverter` with `kAudioFormatOpus`, available on macOS 14.4+, is the most likely path). The `AudioFrameProducer` protocol in `OpusEncoder.swift` is the seam to swap in.
