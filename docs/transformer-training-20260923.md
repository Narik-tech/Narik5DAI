# Transformer training run — September 23, 2026

The Transformer engine now uses the validation-selected checkpoint at **4,000
total optimizer steps**. The previous 1,000-step bootstrap is preserved at
`artifacts/transformer/runs/20260923-training/baseline-1000.pt`.

## Data and training

Generated 4,096 additional classical-teacher examples using seeds 11, 17, 23,
and 29, each with a 5,000-work-node / 750 ms teacher budget. Combined with the
original 256 examples and deduplicated by full-history position key, the final
training set contains **4,019 positions**, including 2,594 multi-timeline
positions and both colors. The default `artifacts/transformer/training.jsonl`
now contains this expanded set; the original data is saved as
`bootstrap-training.jsonl` in the run directory.

Validation started from the separate designated match-validation positions,
using seed 20260923 and a 10,000-node / 750 ms teacher budget. Two exact overlaps
with training were removed, leaving **510 validation positions**. Validation
positions never contributed gradient updates, but validation scores were used
to select the checkpoint. This is a model-selection set, not an untouched test
set. Labels are approximate classical evaluations: 2,258 training positions and
317 validation positions had at least one completed teacher search iteration;
many searches subsequently reached a resource limit.

Continued the original checkpoint for **5,000 additional updates**, batch 32,
learning rate 0.0001, shuffle buffer 512, seed 42, CUDA mixed precision, with
validation and checkpoint saving every 250 updates. The run reached 6,000 total
steps, but the checkpoint at 4,000 steps had the lowest validation MSE and was
selected. GPU training took **378.5 seconds** on the RTX 3060, with **384.2 MiB
peak PyTorch allocation / 430 MiB reserved**, excluding driver and other
applications' memory.

## Results

All rows were evaluated on the same 510-position dataset with CUDA, batch 32.

| Checkpoint | Total steps | Normalized value MSE | Clipped centipawn MAE |
| --- | ---: | ---: | ---: |
| Original bootstrap | 1,000 | 0.305814 | 787.80 |
| Selected checkpoint | 4,000 | 0.092284 | 507.14 |
| Final training state | 6,000 | 0.099726 | 516.83 |

The selected checkpoint lowers normalized MSE by about **70%** and clipped
centipawn MAE by about **36%**. MSE measures error against `tanh(teacherCp/1000)`;
the centipawn metric clips targets and predictions to the model's approximately
±3,800 cp range. These numbers measure teacher agreement, not Elo or measured
match strength. Historical model context was truncated in 119 validation
positions; no current-board features were truncated.

Both old and selected checkpoints passed **10 of 12** fixed tactical target
checks, with no lost baseline passes. These use depth 2, 20,000 work nodes,
1,500 ms, completed-iteration checks, and legal recommendation/PV validation.
`poisoned-pawn` and `locked-king` exactly match training positions, so the suite
is explicitly a development diagnostic rather than independent validation.

After installation, the real CUDA HTTP smoke check passed standard and
two-timeline analysis, legal Play best, input immutability, and cancellation.
The new best-checkpoint/evaluation code also passed all 10 Python tests.

## Artifacts and reproduction

The complete run is in `artifacts/transformer/runs/20260923-training/`:

- `report.json`, `comparison.json`, `dataset-report.json`: metrics, hashes, and selection.
- `best.pt`, `latest.pt`, `baseline-1000.pt`: selected, final, and original weights.
- `training-expanded.jsonl`, `validation-heldout.jsonl`: exact evaluation inputs.
- `train.log`, shard logs/statistics, `tactical-comparison.json`, `gpu-smoke.json`: verification.
- `generate-holdout.mjs`, `prepare-data.mjs`, `compare-tactics.mjs`: local data and diagnostic scripts.

Training data SHA256:
`b148a538a2fcd4be9054fbabf9b34c8719e854f915edf6a1372b1d80f4a72cdf`.
Validation data SHA256:
`d16af88bb4bd51a4e35f1827900fa2be1d5959c9b23482b528905d2dc83ff195`.

To reproduce the checkpoint comparison against the archived dataset:

```powershell
npm run transformer:evaluate -- --data artifacts/transformer/runs/20260923-training/validation-heldout.jsonl --checkpoints artifacts/transformer/runs/20260923-training/baseline-1000.pt artifacts/transformer/runs/20260923-training/best.pt artifacts/transformer/runs/20260923-training/latest.pt --device cuda --batch-size 32
```

See [the training guide](transformer.md) for continuation, checkpoint selection,
and architecture settings. Regenerating labels under time budgets can produce
different results; the archived JSONL files and hashes preserve this run.
