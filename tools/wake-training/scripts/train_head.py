"""Train a tiny openWakeWord classifier head from cached embeddings.

Input: [B, 16, 96] float32. Output: sigmoid scalar. Loss: BCE. Early-stop on val loss.

Usage:
    python scripts/train_head.py --cache embeddings_cache --device cpu --run-id v0
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

from _common import sha256_file


class Head(nn.Module):
    """Lightweight head matching the published openWakeWord topology family.

    Input: [B, 16, 96] -> flatten -> Linear(1536 -> 128) -> ReLU -> Dropout
                                  -> Linear(128 -> 64)  -> ReLU
                                  -> Linear(64 -> 1)    -> sigmoid (applied outside or via exported graph)
    """

    def __init__(self, in_frames: int = 16, in_dim: int = 96, hidden: int = 128):
        super().__init__()
        self.flatten = nn.Flatten()
        self.l1 = nn.Linear(in_frames * in_dim, hidden)
        self.act1 = nn.ReLU()
        self.drop = nn.Dropout(0.2)
        self.l2 = nn.Linear(hidden, hidden // 2)
        self.act2 = nn.ReLU()
        self.l3 = nn.Linear(hidden // 2, 1)
        self.sig = nn.Sigmoid()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.flatten(x)
        x = self.drop(self.act1(self.l1(x)))
        x = self.act2(self.l2(x))
        return self.sig(self.l3(x))


def load_split(cache_dir: Path, split: str):
    import pandas as pd
    path = cache_dir / f"{split}.parquet"
    if not path.exists():
        return None, None
    df = pd.read_parquet(path)
    x = np.stack(df["window"].apply(lambda l: np.asarray(l, dtype=np.float32)).values, axis=0)
    x = x.reshape(-1, 16, 96)
    y = df["label"].to_numpy(dtype=np.float32).reshape(-1, 1)
    return torch.from_numpy(x), torch.from_numpy(y)


def class_weighted_sampler(y: torch.Tensor) -> torch.utils.data.WeightedRandomSampler:
    yi = y.squeeze(-1).long().numpy()
    counts = np.bincount(yi, minlength=2).astype(np.float64)
    w_per_cls = 1.0 / np.maximum(counts, 1.0)
    weights = w_per_cls[yi]
    return torch.utils.data.WeightedRandomSampler(weights=weights.tolist(), num_samples=len(weights), replacement=True)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--cache", type=Path, required=True,
                   help="Path to embeddings_cache (parent of sha-keyed dirs).")
    p.add_argument("--cache-sha", default=None,
                   help="Specific sha-keyed subdir name; default: the only one in --cache.")
    p.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    p.add_argument("--run-id", required=True)
    p.add_argument("--epochs", type=int, default=40)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--patience", type=int, default=6)
    p.add_argument("--out", type=Path, default=Path("checkpoints"))
    args = p.parse_args()

    if args.cache_sha:
        cache_dir = args.cache / args.cache_sha
    else:
        candidates = [d for d in args.cache.iterdir() if d.is_dir() and len(d.name) == 64]
        if len(candidates) != 1:
            print(f"ERROR pick --cache-sha; found {[c.name for c in candidates]}", file=sys.stderr)
            return 1
        cache_dir = candidates[0]

    meta = json.loads((cache_dir / "meta.json").read_text())
    print(f"using cache {cache_dir.name}, counts={meta.get('counts')}")

    xtr, ytr = load_split(cache_dir, "train")
    xv, yv = load_split(cache_dir, "val")
    if xtr is None or xv is None:
        print("ERROR train/val parquet missing", file=sys.stderr)
        return 1

    device = torch.device(args.device)
    model = Head().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    loss_fn = nn.BCELoss()

    train_ds = torch.utils.data.TensorDataset(xtr, ytr)
    sampler = class_weighted_sampler(ytr)
    train_loader = torch.utils.data.DataLoader(train_ds, batch_size=args.batch_size, sampler=sampler)
    val_ds = torch.utils.data.TensorDataset(xv, yv)
    val_loader = torch.utils.data.DataLoader(val_ds, batch_size=args.batch_size, shuffle=False)

    run_dir = args.out / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    best_val = float("inf")
    best_epoch = -1
    no_improve = 0
    started = time.time()

    for epoch in range(args.epochs):
        model.train()
        tr_loss = 0.0
        n = 0
        for xb, yb in train_loader:
            xb = xb.to(device)
            yb = yb.to(device)
            opt.zero_grad()
            out = model(xb)
            loss = loss_fn(out, yb)
            loss.backward()
            opt.step()
            tr_loss += float(loss) * xb.size(0)
            n += xb.size(0)
        tr_loss /= max(1, n)

        model.eval()
        v_loss = 0.0
        v_n = 0
        correct = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                xb = xb.to(device)
                yb = yb.to(device)
                out = model(xb)
                v_loss += float(loss_fn(out, yb)) * xb.size(0)
                v_n += xb.size(0)
                pred = (out > 0.5).float()
                correct += int((pred == yb).sum())
        v_loss /= max(1, v_n)
        v_acc = correct / max(1, v_n)
        print(f"epoch {epoch:02d} train_loss={tr_loss:.4f} val_loss={v_loss:.4f} val_acc={v_acc:.4f}")

        if v_loss < best_val - 1e-4:
            best_val = v_loss
            best_epoch = epoch
            no_improve = 0
            torch.save(model.state_dict(), run_dir / "best.pt")
        else:
            no_improve += 1
            if no_improve >= args.patience:
                print(f"early stop at epoch {epoch} (best {best_epoch} val_loss {best_val:.4f})")
                break

    elapsed = time.time() - started

    manifest = {
        "run_id": args.run_id,
        "cache_dir": cache_dir.name,
        "embedding_model_sha256": meta.get("embedding_model_sha256"),
        "mel_model_sha256": meta.get("mel_model_sha256"),
        "device": args.device,
        "best_val_loss": best_val,
        "best_epoch": best_epoch,
        "epochs_run": epoch + 1,
        "lr": args.lr,
        "batch_size": args.batch_size,
        "elapsed_s": round(elapsed, 1),
        "data_counts": meta.get("counts"),
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"OK best.pt + manifest under {run_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
