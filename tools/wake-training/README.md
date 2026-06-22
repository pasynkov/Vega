# Wake-word training (`Vega.onnx`)

Reproducible pipeline for training the Russian "Вега" openWakeWord classifier head shipped in `apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx`. The shared `melspectrogram.onnx` + `embedding_model.onnx` front-end is reused unchanged — only the per-keyword head is trained here.

## Platform

Apple Silicon macOS (M1/M2/M3). CPU is enough; PyTorch MPS is available as opt-in (`--device mps`). No CUDA, no Linux assumed.

## Runtime estimate

End-to-end on a clean checkout, excluding dataset downloads:

| Step | Wall time |
|---|---|
| `gen_synthetic_positives.py` (~2000 utt over ~5 voices) | 10–20 min |
| `fetch_negatives.py` (Common Voice ru subset + background) | 20–60 min (network) |
| `augment.py` → ~10k positives | 5–10 min |
| `build_embedding_cache.py` | 10–20 min |
| `train_head.py` | 1–3 min |
| `export_onnx.py` + `eval_threshold.py` | <1 min |

Total: ~1 h once datasets are cached locally.

## Setup

```bash
cd tools/wake-training
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# verify
python -c "import torch, onnxruntime, librosa, piper; print('ok')"
```

System deps: `brew install ffmpeg`.

## End-to-end command sequence

```bash
# 1. Synthetic positives (Piper TTS, ru_RU-* voices)
python scripts/gen_synthetic_positives.py --out data/positives/synthetic --count 2000

# 2. Real positives (user recordings already collected under recordings/ or a custom dir)
python scripts/import_real_positives.py --src ../../recordings --out data/positives/real

# 3. Negatives (Common Voice ru + openWakeWord background + near-miss words)
python scripts/fetch_negatives.py --out data/negatives

# 4. Augment positives to ~10k
python scripts/augment.py --in data/positives --out data/positives --target 10000 --seed 42

# 5. Build embedding cache (96-dim windows, parquet per split)
python scripts/build_embedding_cache.py \
  --embedding-model ../../apps/mac-ear/Sources/VegaEar/Resources/embedding_model.onnx \
  --mel-model      ../../apps/mac-ear/Sources/VegaEar/Resources/melspectrogram.onnx \
  --data data --cache embeddings_cache

# 6. Train head
python scripts/train_head.py --cache embeddings_cache --device cpu --run-id v0

# 7. Export to ONNX
python scripts/export_onnx.py --run-id v0 --out checkpoints/v0/Vega.onnx

# 8. Calibrate threshold + emit report
python scripts/eval_threshold.py --onnx checkpoints/v0/Vega.onnx \
  --ambient data/eval/ambient_soak --report reports/

# 9. Ship (manual): copy to mac-ear bundle
cp checkpoints/v0/Vega.onnx ../../apps/mac-ear/Sources/VegaEar/Resources/Vega.onnx
```

## Dataset layout

```
data/
  positives/
    synthetic/         # Piper TTS-generated "Вега" utterances
    real/              # user-recorded "Вега" (16 kHz mono int16 wav)
  negatives/
    common_voice/      # Common Voice ru subset
    background/        # openWakeWord-published room/TV/music audio
    near_miss/         # Бега, Мега, Вена, Бега-бега, …
  eval/
    ambient_soak/      # ≥1h continuous typical-environment audio for FP/hour
```

`data/` is gitignored. Scripts produce `manifest.json` per dataset directory matching `data/manifest.example.json`.

Real-positive recordings the project already has live under repo-root `recordings/<ISO-timestamp>/audio.ogg`. The Ear records 48 kHz mono Opus; `import_real_positives.py` resamples to 16 kHz int16 wav.

## Reports

`reports/` is tracked even when empty. Each calibration run writes `reports/<ISO-timestamp>.md` with: model sha256, dataset snapshot hash, precision/recall per threshold {0.3–0.9}, FP/hour, recommended `Preferences.wakeThreshold`.
