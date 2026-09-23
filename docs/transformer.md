# Transformer engine

The UI's **Transformer · experimental** engine uses a separately trained neural
value evaluator and bounded search over complete legal turns. The existing
classical engine remains available. Move generation and legality always use the
complete 5D position, including its history; the neural model receives a bounded
representation of that position.

This is an experimental trainable engine. Bootstrap checkpoints imitate
approximate scores from the classical engine; a small dataset does not establish
playing strength. There is no random-weight or classical-evaluation fallback
when a transformer checkpoint is missing or incompatible.

## Setup and use

From the project directory with Python 3.10+ installed:

```powershell
npm run transformer:setup
npm run transformer:data
npm run transformer:train
npm run transformer:doctor
npm start
```

Then choose the Transformer engine in the analysis controls. Setup creates the
project-local `.venv-transformer` environment and installs the tested PyTorch
2.14.0 CUDA 12.6 wheel from the official PyTorch package index. The NVIDIA driver
must support that CUDA runtime; a separate CUDA toolkit is unnecessary for the
wheel. `npm run transformer:setup -- --cpu` installs the CPU wheel instead.

If Python is not on PATH, pass its executable to setup:

```powershell
npm run transformer:setup -- --python "C:\path\to\python.exe"
```

Use `TRANSFORMER_PYTHON` to select a different Python environment,
`TRANSFORMER_CHECKPOINT` to select a different checkpoint, and
`TRANSFORMER_DEVICE=auto|cuda|cpu` for analysis device selection. `auto` uses CUDA
when available and otherwise runs the same model on CPU. An explicit `cuda`
request fails if CUDA is unavailable. Training and doctor also accept `--device`.

The default checkpoint is `artifacts/transformer/model.pt`. Artifacts and the
virtual environment are local generated files, excluded from version control.
The service loads a state dictionary with `torch.load(weights_only=True)`, checks
architecture/encoding versions and finite weights, and rejects checkpoints with
zero completed training steps.

The command-line interface selects the same engine:

```powershell
npm run analyze -- --engine transformer --time 3 --depth 3
```

## Search architecture

The transformer engine uses its own asynchronous search implementation. It
generates complete legal turns with the same full rules as the classical engine,
then evaluates their successor positions in GPU batches. White-relative neural
scores are converted to the side-to-move perspective for ranking and negamax
backups. Iterative deepening retains the best completed result, or an explicitly
partial result if a time, work, or cancellation limit interrupts the search.

Defaults retain the first **64 root candidates**, the first **16 candidates per
inner position**, and deepen the best **4** ranked continuations at each node.
At depth one, every generated candidate receives a value. Root candidates and
a bounded cache of **128 inner expansions** can be reused across iterations.
Candidate generation uses a deterministic prefix of the complete-turn generator;
the cap can omit temporal moves, and beam pruning can discard a winning line.
This is selective search, so reaching a requested depth does not mean all legal
alternatives were evaluated. The analysis reports candidate caps and beam
pruning. The UI's classical transposition-cache setting applies only to the
classical engine; transformer candidate storage has its own bounds.

Terminal checks use full legal generation. Mate is certified only where the
necessary continuations and opposing replies have been proved: a single
certified winning continuation suffices, but a claimed forced loss requires all
legal replies to be exhausted. A capped or pruned losing subtree cannot certify
mate. Neural values alone never certify terminal status or playing strength.

## Architecture and GPU budget

| Component | Default |
| --- | --- |
| Transformer blocks | 4, pre-normalization |
| Hidden width / attention heads | 128 / 4 |
| Feed-forward width | 384, GELU |
| Parameters | 694,017 |
| Context | At most 512 tokens including CLS |
| Training | AdamW, batch 16, CUDA float16 AMP, gradient norm clipped to 1 |
| Prediction | CLS value head, scalar white-relative score |

Tokens represent occupied squares and board markers. Piece identity/color,
signed unmoved flags, board side to move, and frontier status have categorical
embeddings. Coordinates encode timeline, absolute half-turn, rank, file, age
relative to that timeline's frontier, and board dimensions, using sinusoidal
features plus signed logarithmic coordinates. Global features include action
side, action number, history/timeline sizes, even-timeline mode, available
promotion pieces, and context coverage. Empty board markers preserve board
existence even without pieces. In even-timeline variants, the two zero-labelled
timelines receive adjacent distinct coordinates, matching rule-engine movement.

Selection first retains frontier board markers, frontier royals, and other
frontier pieces; remaining capacity samples historical tokens at deterministic
even intervals spanning oldest to newest history. Positions within the budget
retain every token. Very large frontiers can themselves overflow. Every
prediction reports token counts, `truncated`, and `frontierTruncated`. Discarded
history can hide relevant tactics from evaluation; legal search still uses it.

On this workstation's **NVIDIA GeForce RTX 3060, 12 GiB**, PyTorch
2.14.0+cu126 completed three full-length training updates at batch 16 × 512
tokens in **0.379 seconds**, with **206.4 MiB peak allocated** and **262 MiB
peak reserved** CUDA memory. These allocator figures exclude driver/context and
other applications. This is a synthetic architecture feasibility measurement,
not a playing-strength benchmark. Reproduce it with:

```powershell
npm run transformer:doctor -- --benchmark --device cuda
```

The benchmark creates no checkpoint. It exercises forward/backward passes,
mixed precision, and optimizer state at the full token limit. Model data and
optimizer memory are small relative to this GPU's capacity; sparse encoding and
JavaScript legal move generation may dominate end-to-end search time.

The initial local bootstrap trained for 1,000 updates on 256 teacher positions
in **41.213 seconds**, reaching **206.4 MiB peak allocated / 264 MiB reserved**.
An end-to-end HTTP smoke check on this workstation completed standard-position
analysis in about 650 ms and a two-timeline position in about 85 ms, and verified
legal principal variations, Play best, and cancellation. These timings are
small smoke cases with bounded candidate search; they are not a general speed
or strength estimate. The bootstrap has no held-out validation claim.

## Training

For iterative training from the model's own games, see [continuous self-play](transformer-selfplay.md).
Run `npm run transformer:selfplay -- --iterations 0 --device cuda` after creating
a checkpoint; candidates are evaluated before they replace the UI's active model.

[The September 23 expanded training report](transformer-training-20260923.md)
records the locally installed checkpoint, validation comparison, and backups.

The data generator writes bounded classical-teacher examples from development
positions and legal continuations. It excludes designated match validation and
tactical regression suites. Labels remain approximate classical search scores,
not game outcomes. A larger example run is:

```powershell
npm run transformer:data -- --samples 4096 --nodes 2000 --seed 7
npm run transformer:train -- --steps 5000 --batch-size 16 --device cuda
```

Training defaults to 1,000 optimizer updates, learning rate 0.0003, weight decay
0.01, seed 42, dropout 0.1, and a shuffle buffer of 128 encoded positions. The
JSONL file is streamed and repeated as needed; it is never loaded in full.
Each line has this shape, with the raw rules-library position representation:

```json
{"position":{"board":[[[[12,0],[0,11]]]],"action":0,"promotions":[9,10]},"value":125}
```

`value` is always finite **white-relative centipawns**, regardless of the side to
move. The network minimizes MSE against `tanh(value / 1000)`; inference converts
back using `1000 * atanh(clamp(output, -0.999, 0.999))`. Neural scores are bounded
to about ±3,800 cp and do not claim mate. Legal terminal detection belongs to
search. Additional row fields such as teacher provenance are allowed.

Supply separate held-out JSONL data to measure generalization:

```powershell
npm run transformer:train -- --data artifacts/transformer/train.jsonl --validation-data artifacts/transformer/validation.jsonl --steps 1000
npm run transformer:train -- --resume artifacts/transformer/model.pt --steps 1000
```

With `--resume`, steps are additional completed updates and the checkpoint's
architecture and optimizer state are reused. Shuffle order and AMP scaler state
restart from the provided seed, so resumption is not bit-for-bit equivalent to
an uninterrupted run. CUDA kernels may also be nondeterministic.

To keep the best validation checkpoint while also saving the latest training
state, pass `--best-output` with a different path from `--output`. A resumed
model is evaluated before training and remains the best checkpoint if no later
checkpoint improves validation MSE. Use enough `--validation-batches` to cover
the entire validation file. For example:

```powershell
npm run transformer:train -- --resume artifacts/transformer/model.pt --data artifacts/transformer/train.jsonl --validation-data artifacts/transformer/validation.jsonl --steps 5000 --validation-batches 64 --output artifacts/transformer/latest.pt --best-output artifacts/transformer/best.pt
npm run transformer:evaluate -- --data artifacts/transformer/validation.jsonl --checkpoints artifacts/transformer/model.pt artifacts/transformer/best.pt --device cuda --output artifacts/transformer/comparison.json
```

The evaluator streams every validation row and reports normalized value MSE,
centipawn MAE with both targets and predictions clipped to the model's output
range, and context truncation counts. This measures agreement with the teacher;
it does not by itself measure playing strength. Keep exact duplicate positions
out of both training and validation, and use separate games or starting histories
where possible.

Checkpoints save every 100 updates and on normal completion through an atomic
file replacement. They include architecture, encoding version, parameters,
optimizer, trained-step count, examples seen, data path and SHA256, seed, loss,
optional validation MSE, and a human-readable experimental label. Validation
measures up to 16 batches by default (`--validation-batches`); it does not test
playing strength. Logs report elapsed time and truncation; completion reports
peak CUDA allocator memory. An interrupted run can resume from the last saved
checkpoint.

Use `--batch-size 8` if available memory is constrained by other applications.
`--width`, `--heads`, `--layers`, `--feedforward`, and `--max-tokens` configure
new models, are saved with the checkpoint, and cannot change an existing model
via resume. The service reads the saved configuration. Run training during a
separate period from latency-sensitive analysis for predictable GPU usage.

## Validation and worker protocol

```powershell
npm run transformer:test
npm run transformer:smoke
npm test
```

Python tests cover history and movement coordinates, signed piece flags,
deterministic context selection, frontier overflow reporting, loss reduction,
padding invariance, checkpoint round trips, training resumption, and worker
protocol errors. These verify implementation behavior; they do not establish
chess strength.

The persistent worker accepts one JSON object per line on stdin; stdout contains
only JSONL protocol messages. It is launched as:

```text
python -u neural/service.py --checkpoint artifacts/transformer/model.pt --device auto
```

Startup emits `{ "ready": true, "device": "cuda", "model": { ... } }` or
`{ "ready": false, "error": "..." }` followed by a nonzero exit. Each request
`{ "id": 1, "positions": [position] }` returns `{ "id": 1, "values": [125.0],
"context": [{ "tokens": 34, "totalTokens": 34, "truncated": false,
"frontierTruncated": false }], "device": "cuda" }`. Requests accept 1–128
positions and are internally evaluated in batches of 16. Invalid requests
return `{ "id": 1, "error": "..." }`. Input lines are limited to 32 MiB.

Implementation references: [PyTorch TransformerEncoder](https://docs.pytorch.org/docs/2.14/generated/torch.nn.TransformerEncoder.html),
[mixed precision](https://docs.pytorch.org/docs/2.14/amp.html), and
[safe state-dictionary loading](https://docs.pytorch.org/docs/2.14/notes/serialization.html).
