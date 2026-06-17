## 1. Bundled models

- [x] 1.1 Drop OWW shared front-end (`melspectrogram.onnx`, `embedding_model.onnx`) and two community classifier heads (`Janet.onnx`, `edna.onnx`) into `apps/mac-ear/Sources/VegaEar/Resources/`
- [x] 1.2 Note model provenance and SHA-256 of each file in `apps/mac-ear/README.md` so the source is auditable

## 2. Swift dependency surgery

- [x] 2.1 Add `onnxruntime-swift-package-manager` as a Swift Package Manager dependency in `apps/mac-ear/Package.swift`
- [x] 2.2 Remove the `PvPorcupine` binary target and the `Vendor/PvPorcupine.xcframework` reference from `Package.swift`
- [x] 2.3 Drop the `.copy("../../Vendor/PvModel/porcupine_params.pv")` resource and delete `apps/mac-ear/Vendor/PvPorcupine.xcframework` and `apps/mac-ear/Vendor/PvModel/`
- [x] 2.4 Verify `swift build` succeeds with the new dependency set on a clean checkout

## 3. OpenWakeWord detector implementation

- [x] 3.1 Add `apps/mac-ear/Sources/VegaEar/OpenWakeWordDetector.swift` implementing the existing `WakeWordDetector` protocol over ONNX Runtime: load `melspectrogram.onnx`, `embedding_model.onnx`, and a configurable list of classifier-head models from `Bundle.module`; accumulate 16 kHz Int16 frames; run the shared front-end once per chunk; run each classifier head; fire `onDetect(score)` on the first classifier whose score exceeds the configured threshold; log the winning candidate label and score for every detection
- [x] 3.2 Implement a runtime-mutable threshold setter on `OpenWakeWordDetector` so the menu preset can update sensitivity live without re-init
- [x] 3.3 Hardcode the MVP candidate list to `["Janet", "edna"]` (case-preserving filenames matching the bundled resources); easy to extend or trim later by editing one array
- [x] 3.4 Delete `apps/mac-ear/Sources/VegaEar/PorcupineDetector.swift` and `apps/mac-ear/Sources/VegaEar/SecretStore.swift`
- [x] 3.5 Replace the Porcupine construction in `main.swift`/`AppDelegate.swift` with `OpenWakeWordDetector(threshold: prefs.wakeThreshold)`; remove all references to `SecretStore` and `PICOVOICE_ACCESS_KEY`

## 4. Preferences and menu

- [x] 4.1 Extend `Preferences.swift` with a `wakeThreshold: Double` property (default 0.5, persisted in `preferences.json`), a `setWakeThreshold(_:)` mutator that clamps to `(0.0, 1.0)`, and load/save coverage
- [x] 4.2 Add unit tests in `Tests/VegaEarTests/` that cover threshold defaulting, persistence, and invalid-value handling
- [x] 4.3 Add a "Wake sensitivity" submenu in `StatusItemController.swift` with presets `Low (0.3)`, `Default (0.5)`, `High (0.7)`, `Very High (0.85)`; the active option SHALL show a check-mark; selection updates `Preferences` and the live detector threshold

## 5. Cleanup, docs, and verification

- [x] 5.1 Remove `PICOVOICE_ACCESS_KEY` from `.env.example`, `apps/core/.env.example`, and any other env templates; remove related lines from `~/.config/vega/ear.env` documentation
- [x] 5.2 Update `apps/mac-ear/README.md`: drop the Porcupine setup section, document the OpenWakeWord pipeline, list the bundled candidate models (`Janet`, `edna`) with their source URL and SHA-256, document the `Wake sensitivity` submenu, and note that picking a winning candidate is a follow-up
- [ ] 5.3 Manually verify on a real Mac: app launches into `idle`, saying "Janet" or "Edna" triggers a session within 400 ms against Core, each preset changes sensitivity audibly without restart, debug "Trigger test wake" still works, threshold persists across relaunch, both candidates produce log entries on detection
- [x] 5.4 Run `openspec validate wakeword-openwakeword --strict` and resolve any reported issues

## 6. A/B follow-through (out of this change, captured here for memory)

- [ ] 6.1 After ~1 week of daily use, count `wake_detected` log entries per candidate and inspect both for false accepts vs. real wakes
- [ ] 6.2 Decide between (a) keep the better candidate and drop the loser, (b) keep both permanently with a UI for selection, or (c) train a custom-branded model (separate change)
