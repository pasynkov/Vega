# wake-word-training Specification

## Purpose

The wake-word-training capability provides a self-contained, reproducible local pipeline for turning a labeled Russian audio dataset into a deployable openWakeWord classifier head ONNX file that the Mac Ear loads as its `Vega` wake-word detector. The pipeline runs on macOS Apple Silicon without cloud compute, reuses the front-end model shipped with the Mac Ear so embeddings match at runtime, and produces calibration reports that justify the runtime confidence threshold. Training tooling is fully decoupled from the Mac Ear runtime: Python is required to train, never to build or run the app.

## Requirements

### Requirement: Reproducible local training pipeline

The project SHALL provide a self-contained training pipeline under `tools/wake-training/` that turns a labeled audio dataset into a deployable openWakeWord classifier head ONNX file on a clean macOS Apple Silicon checkout, without requiring CUDA, cloud compute, or paid services.

The pipeline SHALL be runnable end-to-end via documented Python scripts (no manual notebook orchestration required), SHALL pin its Python dependencies in a lockable file (`requirements.txt` or `pyproject.toml` with a lock file), and SHALL document its expected runtime so a contributor can estimate completion time before starting.

#### Scenario: New contributor reproduces training

- **WHEN** a contributor clones the repository on a clean Apple Silicon macOS machine, installs the Python deps documented in `tools/wake-training/README.md`, places the documented dataset directories under `tools/wake-training/data/`, and runs the documented sequence of scripts
- **THEN** the pipeline SHALL produce an ONNX classifier head file at the documented output path
- **AND** SHALL complete (excluding dataset download time) within the runtime estimate documented in the README
- **AND** SHALL not require network access during the training step itself

#### Scenario: Pipeline fails fast on missing data

- **WHEN** any documented dataset directory is missing or empty when a script is invoked
- **THEN** the script SHALL exit with a non-zero status and SHALL print a human-readable message naming the missing directory and how to populate it

### Requirement: Dataset layout

The training pipeline SHALL define a fixed directory layout for input data under `tools/wake-training/data/` distinguishing positive and negative examples, synthetic and real positives, and train/val/test splits, and SHALL document this layout in the tool README.

The pipeline SHALL gitignore the `data/` directory's audio contents while tracking a small example manifest file (`data/manifest.example.json`) that documents the expected schema.

Positive examples SHALL be Russian utterances of "Вега" originating from at least two sources: (a) Piper TTS synthesis over multiple `ru_RU-*` voices, and (b) recordings provided by the primary user. Negative examples SHALL include at minimum: Russian Common Voice clips, ambient/background audio recordings, and a curated set of near-miss words (phonetically similar Russian words that the head must learn to reject).

#### Scenario: Audio data is not committed

- **WHEN** a contributor runs `git status` after the training pipeline has been executed and `data/` is populated
- **THEN** no `.wav`, `.flac`, `.mp3`, or other audio file under `data/` SHALL appear as untracked or modified
- **AND** the example manifest `data/manifest.example.json` SHALL be tracked

#### Scenario: Pipeline rejects unknown layout

- **WHEN** a contributor places audio files outside the documented subdirectories under `data/`
- **THEN** the data-preparation script SHALL ignore them with a warning rather than silently including them in training

### Requirement: Embedding cache reuses the shipped front-end

The training pipeline SHALL compute 96-dim embeddings using the same `embedding_model.onnx` file that ships in `apps/mac-ear/Sources/VegaEar/Resources/`, SHALL persist the resulting embeddings + labels to an on-disk cache keyed by the SHA256 of that model file, and SHALL invalidate the cache automatically if the model file changes.

The cache format SHALL allow training to read the entire labeled embedding set without opening any raw audio file.

#### Scenario: Repeated training reuses the cache

- **WHEN** a contributor runs the embedding step a second time with the same dataset and the same `embedding_model.onnx`
- **THEN** the embedding step SHALL complete in significantly less time than the first run (cache hit)
- **AND** SHALL not invoke ONNX Runtime on any audio file already represented in the cache

#### Scenario: Embedding model change invalidates the cache

- **WHEN** the `embedding_model.onnx` file in the Mac Ear `Resources/` directory is replaced with a different file
- **THEN** the next embedding step SHALL recompute all embeddings rather than read from the stale cache
- **AND** the new cache file SHALL be keyed by the new SHA256

### Requirement: Head training and ONNX export

The training pipeline SHALL train a classifier head whose input shape, output shape, and per-frame window match the openWakeWord runtime contract assumed by `OpenWakeWordDetector` in the Mac Ear, and SHALL export the trained head to ONNX such that the existing detector loads it with no Swift-side changes.

Specifically, the exported head SHALL accept an input tensor of shape `[1, 16, 96]` of float32 embeddings and SHALL produce an output tensor whose first scalar value is a sigmoid score in `[0, 1]`. The exported file SHALL have a `.onnx` extension and SHALL be loadable by ONNX Runtime ≥1.16.

The training script SHALL accept a target output path on the command line and SHALL not write to `apps/mac-ear/Sources/VegaEar/Resources/` automatically; promotion of a trained head into the Mac Ear bundle SHALL be a deliberate, separate, manual step.

#### Scenario: Exported head loads in detector

- **WHEN** the training script's exported ONNX file is copied to `apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx` and the Mac Ear is launched
- **THEN** the detector SHALL initialize without throwing
- **AND** the app log SHALL record `OWW detector ready` with `Vega` in the candidate list

#### Scenario: Shape mismatch fails loudly

- **WHEN** the training script produces a head whose input or output shape diverges from `[1, 16, 96]` → `[…, 1]`
- **THEN** the first call to `session.run` in the Mac Ear detector SHALL surface the shape mismatch as an `OWW step error` log entry
- **AND** SHALL not produce false detections

### Requirement: Evaluation and threshold calibration

The training pipeline SHALL include an evaluation script that, given a trained head and a held-out labeled test set plus a long ambient-audio recording, produces a markdown report containing: per-threshold precision and recall on the test set, false-positives-per-hour on the ambient recording, and a recommended default threshold.

The report SHALL be written to `tools/wake-training/reports/<ISO-timestamp>.md`, SHALL identify the model file it evaluated by SHA256, and SHALL record the dataset versions used. Reports SHALL be committed.

#### Scenario: Evaluation produces a committed report

- **WHEN** the evaluation script runs to completion against a trained head
- **THEN** a new markdown file SHALL appear under `tools/wake-training/reports/`
- **AND** the file SHALL contain at minimum the precision/recall table, the FP/hour figure, the recommended default threshold, and the SHA256 of the evaluated head

#### Scenario: Default threshold is justified by a report

- **WHEN** the `Preferences.wakeThreshold` default value in the Mac Ear is changed as part of training-related work
- **THEN** the change SHALL reference (in commit message or PR description) a calibration report under `tools/wake-training/reports/` that justifies the new value

### Requirement: Training does not block runtime

The training pipeline and its Python dependencies SHALL live entirely under `tools/wake-training/` and SHALL NOT be required to build, test, or run the Mac Ear app. Python SHALL NOT become a runtime dependency of the Mac Ear.

#### Scenario: Mac Ear builds without Python tooling installed

- **WHEN** a contributor builds and runs the Mac Ear on a machine with no Python interpreter installed
- **THEN** the Swift build, the Swift tests, and the running app SHALL all succeed
- **AND** the wake-word detector SHALL load `Vega.onnx` from `Resources/` and operate normally
