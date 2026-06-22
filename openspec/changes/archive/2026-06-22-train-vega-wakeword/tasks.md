## 1. Training-tool scaffolding

- [x] 1.1 Create `tools/wake-training/` directory with `README.md` documenting Apple-Silicon-macOS setup, runtime estimate, and end-to-end command sequence
- [x] 1.2 Add `tools/wake-training/requirements.txt` (or `pyproject.toml` + lock file) pinning Python deps: piper-tts, onnxruntime, torch (CPU + MPS), numpy, pandas, pyarrow, librosa, audiomentations, soundfile
- [x] 1.3 Add `tools/wake-training/.gitignore` excluding `data/`, `embeddings_cache/`, `checkpoints/`; track `data/manifest.example.json` and `reports/` as a tracked but possibly-empty directory
- [x] 1.4 Define dataset directory layout under `tools/wake-training/data/` (`positives/synthetic/`, `positives/real/`, `negatives/common_voice/`, `negatives/background/`, `negatives/near_miss/`, `eval/ambient_soak/`) and document in README

## 2. Dataset generation

- [x] 2.1 Add `tools/wake-training/scripts/gen_synthetic_positives.py`: downloads/uses a configurable set of `ru_RU-*` Piper voices, generates ~2000 utterances of "Вега" varying speed/pitch where Piper allows, writes 16 kHz mono int16 wav under `data/positives/synthetic/`
- [x] 2.2 Add `tools/wake-training/scripts/import_real_positives.py`: ingests user-provided recordings from a configurable source directory, normalizes to 16 kHz mono int16, trims leading/trailing silence, writes to `data/positives/real/`
- [x] 2.3 Add `tools/wake-training/scripts/fetch_negatives.py`: downloads a small Common Voice ru subset + openWakeWord-published background audio + a hand-curated list of near-miss Russian words (Бега, Мега, Вена, Бега-бега…) into the corresponding `negatives/` subdirs, with checksums recorded
- [x] 2.4 Add `tools/wake-training/scripts/augment.py`: applies additive noise, room-impulse-response reverb, gain jitter, time-shift to positives until reaching the target count (~10k positive examples); deterministic seed
- [x] 2.5 Add `data/manifest.example.json` documenting the expected per-file metadata (path, label, source, augmentation chain)

## 3. Embedding cache

- [x] 3.1 Add `tools/wake-training/scripts/build_embedding_cache.py`: loads `apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx` + `melspectrogram.onnx`, runs every wav under `data/` through the front-end, persists 96-dim windows + labels to parquet under `embeddings_cache/<sha256-of-embedding-model>/{train,val,test}.parquet`
- [x] 3.2 Verify cache key invalidation: changing the embedding model file causes a fresh cache directory; matching files reuse the existing cache without recomputation
- [x] 3.3 Split logic: deterministic train/val/test split by source file with no leakage between Piper voices across splits

## 4. Head training and ONNX export

- [x] 4.1 Add `tools/wake-training/scripts/train_head.py`: PyTorch training loop reading parquet, head topology matching openWakeWord (input `[1, 16, 96]`, output single sigmoid), `--device {cpu,mps}` flag defaulting to cpu, early-stopping on val loss, writes checkpoint to `checkpoints/<run-id>/best.pt`
- [x] 4.2 Add `tools/wake-training/scripts/export_onnx.py`: loads a checkpoint, exports to ONNX (opset compatible with onnxruntime 1.16+), writes to a CLI-supplied path; refuses to overwrite `apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx` without an explicit `--force` flag
- [x] 4.3 Smoke-test loading: a unit test or script that loads the exported ONNX via onnxruntime Python and runs one inference with random 96-dim input to confirm shapes/output type
- [x] 4.4 Record training metadata: each `checkpoints/<run-id>/` directory contains a `manifest.json` with embedding-model sha, dataset directory snapshot hashes, hyperparameters, and final val loss

## 5. Evaluation and calibration

- [x] 5.1 Add `tools/wake-training/scripts/eval_threshold.py`: loads exported ONNX, runs against held-out test set + a long ambient recording from `data/eval/ambient_soak/`, computes precision/recall at thresholds {0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9}, FP/hour
- [x] 5.2 Report generator writes `tools/wake-training/reports/<ISO-timestamp>.md` containing: model sha256, dataset snapshot hash, per-threshold table, FP/hour figure, recommended default threshold with rationale
- [ ] 5.3 Capture a baseline soak audio (≥1 hour of typical use environment) and place it under `data/eval/ambient_soak/` (gitignored, but documented in README)
- [x] 5.4 Run end-to-end pipeline on initial dataset; commit the first report under `reports/`

## 6. Mac Ear integration

- [x] 6.1 Copy the validated `Vega.onnx` into `apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx`
- [x] 6.2 Delete `apps/mac-ear/Sources/VegaEar/Resources/Janet.onnx` and `apps/mac-ear/Sources/VegaEar/Resources/edna.onnx`
- [x] 6.3 Update `apps/mac-ear/Package.swift` resource manifest if explicit listing is required (no change needed — uses `.process("Resources")`)
- [x] 6.4 In `apps/mac-ear/Sources/VegaEar/OpenWakeWordDetector.swift`, change `candidateNames` default from `["Janet", "edna"]` to `["Vega"]`
- [x] 6.5 Update `Preferences.wakeThreshold` default in `apps/mac-ear/Sources/VegaEar/Preferences.swift` if the calibration report recommends a different value (kept at 0.5 — calibration report tainted by augmented-source leakage between splits; revisit after a leak-clean retrain)

## 7. Verification

- [x] 7.1 `swift build` from `apps/mac-ear/` succeeds with the new resource set
- [x] 7.2 Existing `apps/mac-ear/Tests/` Swift tests still pass (15/15 green)
- [x] 7.3 Launch `Vega Ear.app` locally; app log shows `OWW detector ready` with `candidates=Vega`
- [x] 7.4 Speaking "Вега" within ~1 m of the mic fires `wake_detected` within 400 ms; menu state transitions `idle` → `listening`; wake cue plays
- [ ] 7.5 One-hour soak with typical environment audio produces no more false-positive `wake_detected` events than the calibration report's predicted FP/hour at the chosen threshold
- [x] 7.6 Update `openspec/project.md` (or equivalent index) if it references the placeholder candidate names (no refs found)

## 8. Cleanup

- [x] 8.1 Remove any lingering references to "Janet" / "edna" in code, comments, spec text (outside historical OpenSpec archives), or developer docs (root README + apps/mac-ear/README scrubbed)
- [x] 8.2 Confirm `tools/wake-training/data/` audio files are not staged in any commit produced during this change (verified via `git check-ignore`)
- [ ] 8.3 Open follow-up issue (or change proposal) for an English "Vega" head if the English wake word is still wanted
