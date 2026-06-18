## Why

Picovoice denied the free-trial request, leaving the existing Porcupine-based wake-word detector with no viable licensing path for personal/non-commercial use. The Ear must keep its always-on wake-word UX while moving to a fully local, royalty-free model. A community search confirmed that no pretrained "Vega" wake-word model exists on HuggingFace, the Home Assistant collection, or the microWakeWord pool, so the MVP ships two ready-made short-name candidates ("Janet" and "Edna") for an A/B in real usage; training a custom-branded model is deferred to a follow-up change once we know whether either community word is acceptable in practice.

## What Changes

- **BREAKING**: Remove the Porcupine implementation, the Picovoice access-key secret, and any code/config that loads `Vega.ppn`.
- Add an `OpenWakeWordDetector` Swift implementation behind the existing `WakeWordDetector` protocol. It runs OpenWakeWord (shared melspec + embedding front-end + N classifier heads) via `onnxruntime-swift` against streamed mic PCM.
- Bundle the OWW shared front-end (`melspectrogram.onnx`, `embedding_model.onnx`) and two community classifier heads (`Janet.onnx`, `edna.onnx`) at `apps/mac-ear/Sources/VegaEar/Resources/`. The detector runs both classifier heads on every frame; either crossing the threshold fires `wake_detected`. The winning candidate label and score are logged for offline A/B analysis.
- Expose a tunable wake-word confidence threshold in `Preferences.swift` (default `0.5`), applied uniformly to all candidate classifiers and persisted alongside other user preferences.
- Update mac-ear capability spec: the wake-word detector requirement now references OpenWakeWord/ONNX instead of Porcupine, and a new requirement covers the persisted threshold.

## Capabilities

### New Capabilities

_None — the wake-word behavior already lives under `mac-ear`._

### Modified Capabilities

- `mac-ear`: replace the Porcupine-specific wake-word requirement with an OpenWakeWord/ONNX-specific one and add a tunable-threshold requirement.

## Impact

- **Code**: `apps/mac-ear/Sources/VegaEar/PorcupineDetector.swift` removed; new `OpenWakeWordDetector.swift` added; `Preferences.swift`, `AppDelegate.swift`/`StatusItemController.swift`, and `SecretStore.swift` updated to drop Picovoice references and wire the new threshold.
- **Dependencies**: `apps/mac-ear/Package.swift` drops the Picovoice Porcupine iOS/macOS SDK, adds `onnxruntime-swift-package-manager`.
- **Assets**: four new bundled resources at `Resources/`: `melspectrogram.onnx` (~1.1 MB), `embedding_model.onnx` (~1.3 MB), `Janet.onnx` (~200 KB), `edna.onnx` (~200 KB). Old `Vega.ppn` and `Vendor/PvPorcupine.xcframework` removed.
- **Configuration / secrets**: `PICOVOICE_ACCESS_KEY` env var and any matching keychain entry are removed; `.env.example` and related env templates updated accordingly.
- **Docs**: `apps/mac-ear/README.md` updated to describe the OpenWakeWord pipeline, list the bundled candidate models with their source URL and SHA-256, document the `Wake sensitivity` submenu, and note that picking a winning candidate (or training a custom-branded one) is a follow-up.
- **Out of scope**: `apps/core`, `packages/ear-protocol`, and the ear protocol message shape are unchanged — wake-word remains a mac-ear-internal concern that produces the same `wake_detected` event. A custom-trained "Vega" model and its training pipeline are deferred to a follow-up change.
