## Why

The Mac Ear currently ships test classifier heads (`Janet.onnx`, `edna.onnx`) borrowed from the openWakeWord community as placeholder wake words. The product wake word is "Вега" (Russian). Without a dedicated, trained classifier the assistant cannot ship: users cannot address it by name, and the test heads have no relevance to real usage. We need a reproducible training pipeline so the wake word can be retrained as voice, mic, or environment changes.

## What Changes

- Train a custom openWakeWord classifier head for the Russian utterance "Вега" using Piper TTS synthetic positives + user-recorded real positives + Common Voice / room-noise negatives.
- Cache 96-dim embeddings via the existing shipped `embedding_model.onnx` (front-end stays untouched) and train a small MLP head locally on macOS with PyTorch (CPU/MPS), exporting to ONNX.
- Bundle the resulting `Vega.onnx` into `apps/mac-ear/Sources/VegaEar/Resources/` and update the detector candidate set to `["Vega"]` (test heads `Janet.onnx`, `edna.onnx` removed from bundle and code).
- Add a reproducible training tool tree under `tools/wake-training/` (scripts, dataset layout, README, locked Python deps) so the head can be retrained without manual setup.
- **BREAKING**: the wake-word candidate set changes from `["Janet", "edna"]` to `["Vega"]`. Anyone still relying on the test wake words will lose detection.

## Capabilities

### New Capabilities

- `wake-word-training`: Reproducible local pipeline that turns a dataset (synthetic + real positives, mixed negatives) into a deployable openWakeWord classifier head ONNX, including dataset layout, embedding cache step, training script, evaluation report (precision/recall/threshold sweep), and export contract that the Mac Ear runtime can consume without changes to the shared front-end.

### Modified Capabilities

- `mac-ear`: The "Always-on wake-word detection" requirement changes its candidate set and bundled head files. The MVP candidate list is now `["Vega"]` backed by `Vega.onnx`; `Janet.onnx` and `edna.onnx` are removed from the bundle. The detector protocol, ONNX-based implementation contract, and threshold behavior are otherwise unchanged.

## Impact

- Code: `apps/mac-ear/Sources/VegaEar/OpenWakeWordDetector.swift` (default `candidateNames`), `apps/mac-ear/Sources/VegaEar/Resources/` (drop `Janet.onnx` and `edna.onnx`, add `Vega.onnx`), `apps/mac-ear/Package.swift` (resource manifest, if explicit).
- New tree: `tools/wake-training/` containing dataset scripts, training script, evaluation script, `requirements.txt` (or `pyproject.toml`), and `README.md`. Dataset itself is gitignored; only scripts and a small `data/manifest.example.json` are tracked.
- Storage: training datasets (Common Voice subset, generated Piper audio, user recordings) consume ~5–10 GB locally; never committed.
- Runtime: detector threshold may need recalibration in `Preferences.wakeThreshold` default after evaluation report — value change only, no schema change.
- No backend (`apps/core`) or protocol (`packages/ear-protocol`) changes.
- No new runtime dependencies in the shipped Mac Ear; training-only Python deps live in `tools/wake-training/`.
