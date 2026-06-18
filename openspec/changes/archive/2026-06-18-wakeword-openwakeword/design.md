## Context

Mac Ear today calls Porcupine (Picovoice) via `PorcupineDetector` to detect the "Vega" wake word. The detector sits behind the `WakeWordDetector` Swift protocol and is wired through `SessionCoordinator` and the C SDK in `Vendor/PvPorcupine.xcframework`. Picovoice declined our free-trial request, so the only remaining licensed paths are paid commercial tiers — incompatible with the personal/non-commercial nature of this project.

The rest of the audio pipeline (`AudioEngine` AUHAL capture, downsample-to-16k, `SilenceDetector`, `EarSocket`, cues, status item) already feeds 16 kHz mono PCM into the wake detector frame by frame. We can swap implementations behind the protocol without touching the coordinator or the ear-protocol contract.

OpenWakeWord (OWW) is an Apache-2.0 wake-word framework. Its production form is a per-word ONNX classifier head running on top of a shared Google `speech_embeddings` front-end. Per-word classifier files are ~200 KB; the shared frontend is ~2.4 MB total (`melspectrogram.onnx` + `embedding_model.onnx`). `onnxruntime-swift-package-manager` ships an SPM-friendly binary that runs CoreML/CPU-EP inference natively on macOS.

A search across HuggingFace, ESPHome's official set, the `fwartner/home-assistant-wakewords-collection` (102 EN models), and `TaterTotterson/microWakeWords` (~190 unique words, but TFLite-only / different runtime) confirmed that no pretrained "Vega" model exists. Training a custom one is ~2–3 hours on free Colab using Piper-TTS synthetic data, but we can validate the Swift+ORT integration end-to-end without it by reusing existing short single-word OWW models. The community collection ships ready-to-use `Janet.onnx` and `edna.onnx` (200 KB each) — both short, distinctive, and acoustically distinct from each other, so they are good A/B candidates for the MVP.

## Goals / Non-Goals

**Goals:**
- Replace Porcupine with a local, royalty-free wake-word stack producing the same `wake_detected` behavior surfaced via the existing `WakeWordDetector` protocol.
- Ship an MVP that bundles two ready-made community classifier heads (`Janet.onnx`, `edna.onnx`) so the user can A/B them in everyday use and pick the better-performing word before committing to a custom-trained model.
- Expose a user-tunable sensitivity threshold (default `0.5`) persisted in the existing `Preferences.swift` JSON file.
- Keep mac-ear ↔ Core protocol, cues, status states, and audio pipeline unchanged.

**Non-Goals:**
- Shipping a custom-trained model in this change. Once the user picks a winner between Janet and Edna (or asks to add a new candidate), training a dedicated model becomes a follow-up change.
- Production-grade multi-keyword UX (separate cues per word, per-word telemetry, etc.). The MVP fires the same `wake_detected` event regardless of which classifier won, and logs the winning label for offline FA/FR analysis only.
- Changes to `apps/core` or `packages/ear-protocol`.
- A GUI for choosing the active wake word; the MVP selection happens by editing a single constant or removing a classifier from `Resources/`. Surfacing this in the menu can be a follow-up.

## Decisions

### 1. OpenWakeWord over alternatives (microWakeWord, sherpa-onnx KWS, hotkey-only)

**Choice:** OpenWakeWord, run via `onnxruntime-swift`.

**Why:**
- Apache-2.0 with an actively maintained ecosystem (HA Voice, ESPHome, Rhasspy ship it).
- ONNX inference fits the macOS native app cleanly (`onnxruntime-swift-package-manager` SPM dep), no JNI/embedded-runtime gymnastics.
- Shared feature extractor + tiny classifier heads means each per-word file is small (~200 KB), close to the Picovoice `.ppn` footprint we are replacing, and adding a second/third candidate costs effectively zero extra compute.
- Large community model pool — `fwartner/home-assistant-wakewords-collection` alone exposes 100+ ready-made ONNX classifier heads we can drop in without training.

**Alternatives considered:**
- **microWakeWord**: smaller (~40 KB int8) and faster, but tooling is ESP32-centric, ships TFLite only, and the Swift TFLite story is rougher. Size advantage irrelevant on Apple-silicon laptops. The `TaterTotterson/microWakeWords` collection (~190 unique words) would force adding `TensorFlowLiteSwift` SPM as a parallel runtime — not worth it when OWW gives us enough coverage.
- **sherpa-onnx KWS**: works without retraining via phoneme-graph keywords but the model is bigger (~20 MB) and less tuned for false-accept rates on a single short word.
- **Push-to-talk hotkey only**: simplest, but breaks the hands-free UX the existing spec is built around. Out of scope for this change.

### 2. Wake phrase: two community-trained candidates ("Janet" and "Edna") for MVP A/B

**Choice:** Drop both `Janet.onnx` and `edna.onnx` (from `fwartner/home-assistant-wakewords-collection`) into `Resources/`. The detector runs both classifier heads on every frame and fires `wake_detected` if either one crosses the threshold. The chosen label is logged for offline FA/FR analysis. Original ambition was a single custom "Vega" model, but no pretrained "Vega" exists anywhere we searched, so we use the MVP to validate the Swift+ORT integration first and let the user pick the better-performing word in actual day-to-day use.

**Why:** Both are short single-syllable-cluster words (`JAN-et`, `ED-nuh`), acoustically distinct from each other, and trivially available as 200 KB ONNX files. Running both in parallel is cheap because the heavy melspec+embedding front-end is shared. Bypassing custom training keeps this change small and lets us defer the "what wake word do we actually want" decision to data instead of speculation. Training a custom model (e.g. for "Vega") becomes a follow-up change once we know whether either candidate is acceptable in practice.

**Alternatives considered:**
- **Single candidate (Janet only)**: simpler, but commits to a word before we have evidence either works in this user's environment.
- **Train a custom "Vega" model up front**: 2–3 hours of work plus iteration. Wrong order — we should prove the Swift+ORT pipeline first, then train a custom model only if neither community candidate is acceptable.
- **Ship 5+ candidates**: more data, but every extra classifier is another log line per frame and another mental option. Two is enough to A/B.

### 3. Model storage

**Choice:** Bundle the OWW shared models plus the candidate classifiers as resources at `apps/mac-ear/Sources/VegaEar/Resources/`, loaded through `Bundle.module.url(forResource:withExtension:)` (same pattern Porcupine used). Concrete files: `melspectrogram.onnx` (~1.1 MB), `embedding_model.onnx` (~1.3 MB), `Janet.onnx` (~200 KB), `edna.onnx` (~200 KB). Total bundle increase ≈ 2.8 MB.

**Why:** Matches the existing resource-loading pattern in `PorcupineDetector`. Avoids a runtime download path and signed-asset complications. Files are small enough to commit.

### 4. Threshold tunable via `Preferences.swift`, default 0.5 — applied uniformly to all candidates

**Choice:** Add `wakeThreshold: Double` to `Preferences`. Persist alongside `micUID` in the existing JSON file. Default 0.5. Exposed in the status-item menu as a small submenu (Low 0.3 / Default 0.5 / High 0.7 / Very High 0.85). The same threshold gates all candidate classifiers; we do not maintain per-word thresholds in the MVP.

**Why:** Wake-word sensitivity is environment-dependent (mic quality, room, ambient noise). Hardcoding pessimizes UX. A 4-option submenu is enough surface area without building a full preferences window. A single shared threshold keeps Preferences and the UX simple; if A/B reveals one classifier needs a different threshold than the other, we collapse to the winner before adding per-word thresholds.

### 5. SDK and Keychain cleanup is part of this change

**Choice:** Delete `Vendor/PvPorcupine.xcframework`, `Vendor/PvModel/porcupine_params.pv`, the `vega.picovoice` keychain service entry, and all references to `PICOVOICE_ACCESS_KEY` (env, `.env.example`, `SecretStore.swift`).

**Why:** Avoid orphan dead code/secrets the proposal explicitly forbids. `SecretStore.swift` becomes a no-op file we can simply delete; OWW needs no secret.

### 6. Defer the custom-training pipeline until after MVP A/B

**Choice:** Do not ship `tools/wakeword-training/` in this change. If neither candidate proves acceptable, or the user later decides on a brand-aligned word like "Vega" specifically, the training notebook lands in a follow-up change scoped to that decision.

**Why:** Building and committing a training pipeline before we know whether we need one is speculative. The candidate-A/B step costs almost nothing and converts a hypothetical ("we will need a custom Vega model") into evidence.

## Risks / Trade-offs

- **Neither candidate matches the original "Vega" branding** → Mitigation: explicit follow-up to train a custom model is acknowledged. The status-item / menu copy uses neutral language ("Listening for wake word…") so the brand can change without rework.
- **Higher false-accept rate on short keywords (e.g. "Janet" overlapping with TV speech)** → Mitigation: tunable threshold (Decision 4), and downstream `SilenceDetector` still requires user speech to keep the session open. The A/B logging gives us empirical FA counts per word.
- **Model size / cold-start latency** → ONNX Runtime + shared front-end add ~5–10 MB to the app bundle and ~100–200 ms initial load. Acceptable for a menu-bar app launched once per session.
- **CPU floor while idle** → Streaming OWW inference on M-series CPU ≈ 1–3 % single-core for one classifier; adding the second classifier head adds <0.5 % because the heavy front-end pass is shared.
- **Bundle resource glob may catch unrelated files** → Mitigation: keep `Resources/` minimal and explicit; SwiftPM `.process` already handles models correctly today.

## Migration Plan

1. Drop the four ONNX files into `Resources/` (already staged in this branch).
2. In a single PR: delete Porcupine integration, add OWW detector wired for both candidates, add SPM dep, update `Preferences`, status menu, README, `.env.example`. The `Vega.ppn` and `porcupine_params.pv` resources are removed in the same commit; the `Vendor/PvPorcupine.xcframework` directory is removed.
3. Manually verify: app launches, mic stream feeds OWW, threshold submenu adjusts sensitivity live, saying "Janet" or "Edna" triggers a session end-to-end against Core, debug "Trigger test wake" still works.
4. Daily use for ~1 week. Each `wake_detected` log line records which candidate won and at what score. After enough samples, pick a winner and either keep only its classifier or open a follow-up change to train a custom model.
5. No data migration needed. Users who had `PICOVOICE_ACCESS_KEY` in keychain or `~/.config/vega/ear.env` will see a clean removal (we do not delete user-managed env files, only stop reading them).

**Rollback:** Revert the commit. Porcupine integration is self-contained, so a single revert restores the previous detector.

## Open Questions

- After A/B, do we keep two-candidate inference permanently (e.g. as a "pick which name responds to you today" feature) or collapse to one? Default expectation: collapse, but the multi-candidate code path is cheap to keep.
- Whether to expose the active candidate(s) in the menu UI vs. config-only. Out of scope for v1; the menu just shows generic "Listening".
- Threshold submenu UX placement — top-level menu vs. nested under "Listening". To be decided during implementation by visual inspection.
