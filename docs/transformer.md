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

The transformer engine uses its own asynchronous search implementation. While
the rules engine assembles a turn, the transformer evaluates every distinct
partial-move successor at each visited prefix in GPU batches of at most 128.
It orders components by strength for the mover before applying the full-turn
candidate cap. Incomplete turns retain the mover's action; only successors the
rules engine permits submitting advance the action for evaluation. Scores are
cached by the complete resulting history during candidate assembly, so commuting
move orders reuse evaluations while different temporal branches remain distinct.

The rules engine shares the same legal traversal with classical search and
continues to enforce present advancement and royal safety on complete turns.
Complete successor evaluations are reused for candidate ranking, and proven
terminal outcomes override neural scores. White-relative neural scores are
converted to the mover's perspective for ordering and negamax alpha-beta search.
Iterative deepening retains the best completed result, or an explicitly partial
result if a time, work, or cancellation limit interrupts the search. A legal,
unscored fallback is retained before the first model request when the budget permits.

Defaults retain up to **64 candidates per position**, at the root and in
replies. Neural component ordering guides candidate membership; **every admitted candidate
is eligible for deeper search**, with no fixed best-four beam. Alpha-beta skips
branches only when the search bounds show that they cannot improve the choice
within this candidate tree. At depth one, every generated candidate receives a
value. Root candidates and a bounded cache of **128 inner expansions** can be
reused across iterations.

Candidate generation prioritizes complete turns using only currently required
boards. Turns that use optionally playable boards (future or inactive boards)
come afterward, with board status recalculated after each component move.
Optional moves remain legal candidates, including sequences that must play an
optional board first to create a later temporal branch.

Candidate generation uses a deterministic prefix of this neurally ordered
complete-turn generator. Scoring all components at a visited prefix does not
evaluate every combination of components: the cap can still omit strong full
turns, including optional or temporal continuations. Time and work limits can
also interrupt component scoring. This is selective search, so reaching a
requested depth does not mean all legal alternatives were evaluated. The analysis reports
`searchPolicy: transformer-bounded-alpha-beta`, candidate caps, and alpha-beta
`cutoffs`; `beamWidth` and `beamPruned` are no longer search options or result
fields. The UI's classical transposition-cache setting applies only to the
classical engine; transformer candidate storage has its own bounds.

Evaluating all component alternatives adds work and can require several dependent
inference batches while assembling multi-board turns. The search can complete
fewer turns of depth within the same time or work budget. This change uses the
existing value network and checkpoint; no
new training or move-policy head is required.

The default reply cap follows `candidateLimit`, so moving a position from a
continuation to the root keeps its candidate coverage. Advanced callers can
override `innerCandidateLimit`; a smaller reply cap can produce a different
line when that position is analyzed directly. To compare continuations, use the
same checkpoint and search settings, and compare completed depth **D** before
the move with completed depth **D − 1** after it. Max depth is only a ceiling;
time and work limits can stop either search earlier.

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
| Context | At most 4,096 tokens including CLS |
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

Positions within the budget retain every token. On overflow, selection drops
whole boards furthest from the nearest playable board first. Playable boards
are timeline frontiers whose side to move matches the action, including future
and inactive timelines. Distance is the sum of signed timeline separation and
half-turn separation divided by two. If no frontier matches the mover, all
frontiers serve as distance anchors. Ties prefer newer boards, then lower signed
timeline coordinates, so selection is deterministic.

Selected boards keep their marker and every occupied square. Selection stops
when the next closest board cannot fit; unused capacity does not admit a farther,
smaller board. Very small custom budgets may retain only CLS if no closest board
fits. Every prediction reports token counts, `truncated`, and
`frontierTruncated` (whether any latest board was omitted). Discarded context can
hide relevant tactics from evaluation; legal search still uses full history.
Training and inference share this selection policy.

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
mixed precision, and optimizer state at a fixed 512-token workload; these earlier
measurements do not describe the current 4,096-token maximum. Model data and
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
Run `node scripts/transformer-selfplay.js --iterations 0 --device cuda` after creating
a checkpoint; candidates are evaluated before they replace the UI's active model.
The shortcut `npm run transformer:selfplay:continuous` selects CUDA when available
and requires no forwarded arguments. Use direct `node` invocation for options:
PowerShell's `npm.ps1` wrapper can strip forwarded flag names.

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
`--width`, `--heads`, `--layers`, and `--feedforward` configure new models and
cannot change an existing model via resume. `--max-tokens` accepts 16–4,096 and
defaults to 4,096 for both new and resumed training. Training saves the effective
budget with the checkpoint. Inference and evaluation load existing weights with
the current 4,096-token budget, including older checkpoints trained with smaller
contexts; loading does not rewrite those files. Context length does not change
parameter shapes, so no weight conversion or retraining is required. Run training
during a separate period from latency-sensitive analysis for predictable GPU usage.

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
