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

Select **Dynamic (0)** in the analysis depth control, or pass `--depth 0`, to
let the search increase its depth ceiling as the leading evaluations become
ready. Fixed depths from 1 through 64 remain available.

## Search architecture

The transformer engine uses its own asynchronous search with rankings at every
complete-turn depth. It distinguishes two kinds of evaluation:

- A **Candidate Evaluation** is the average White-relative score of the partial
  successors along a complete legal turn, including its final submitted
  successor. Each partial successor receives a shallow neural evaluation with no
  continuation search. A turn containing several component moves therefore uses
  every prefix's score, not just the final board's score.
- A **True Evaluation** starts with the neural value of the complete submitted
  successor. When the scheduler selects a candidate, it reuses that value if
  candidate generation already scored the successor. Once True continuations
  exist, the value resolves to the best True continuation for the player acting
  in that position. Candidate-only continuations do not replace its True value.
  Proven terminal outcomes override neural scores.

At each depth, Candidate and resolved True Evaluations share a ranking. At
depth 1, moves rank strongest to weakest for the player making that turn.
At later depths, continuations of a higher-ranked parent move come first;
continuations sharing a parent rank by their own evaluation for the mover.
For example, all generated replies to the first-ranked depth-1 move precede
replies to the second-ranked move. Depth 3 follows the resulting depth-2 parent
order, and this priority continues through the tree. As backed-up values change
parent rankings, their continuation groups move with them.

**Searched Moves** counts the consecutive True Evaluations ahead of the first
Candidate Evaluation in this order. Rankings and their prefix counts are
recomputed as continuation values propagate back through the tree. The search
scheduler, dynamic-depth readiness check, and displayed depth tabs all use the
same order.

The scheduler repeats the following while time and work remain:

1. Find the smallest Searched Moves count across depths that still have
   Candidate Evaluations. This is the current common True prefix; a depth with
   no remaining candidates does not hold it back.
2. If a nonterminal True Evaluation within that prefix has no generated
   continuations and can expand below Max depth, generate its candidates. Choose
   the strongest eligible rank across depths, then the shallower depth on a tie.
3. Otherwise, select the highest-ranked candidate at the depth with the fewest
   Searched Moves and give it a True Evaluation. Shallower depth wins ties.

There is no fixed `n` or `searchWidth` setting. When every pending depth has a
True Evaluation in first place, rank one becomes eligible for expansion. When
every pending depth has two leading True Evaluations, the top two ranks become
eligible. Eligibility is recalculated whenever the rankings change. When no candidates remain,
the scheduler can expand any remaining eligible True Evaluation. Max depth is
a ceiling on complete turns and supports fixed values from **1 through 64**.

**Dynamic depth (`maxDepth: 0`)** starts with a ceiling of one complete turn.
It raises that ceiling by exactly one when the current top **20** entries at
every searched depth are True Evaluations. This uses the ranked True prefix,
not the total number of evaluations performed. A depth with fewer than 20
generated entries qualifies when all of them are True. Each new ceiling must
acquire its own ranked entries before the ceiling can increase again; changes
to backed-up scores are reflected in the next readiness check. The ceiling
never decreases and remains capped at 64. Time, node, and cancellation limits
still apply.

During candidate construction, the transformer evaluates every distinct
partial-move successor eligible at each visited prefix in batches of at most
128. It orders components by strength for the mover before applying the
full-turn candidate cap. Incomplete turns retain the mover's action; only
successors the rules engine permits submitting advance the action for
evaluation. Scores are cached by the complete resulting history during candidate
assembly, so commuting move orders reuse evaluations while different temporal
branches remain distinct. The shared rules traversal enforces present
advancement and royal safety on complete turns.

During candidate construction, each preliminary terminal check uses at most
64 generation work nodes. A check that cannot finish leaves terminal status
unknown and uses the shallow neural score for candidate ordering. The selected
True Evaluation performs the full legal terminal check under the remaining
search budget. This keeps expensive mate proofs for speculative component
successors from blocking deeper search; an unfinished check never certifies
mate, stalemate, or the existence of a legal reply.

Defaults retain up to **64 candidates per position**, at the root and in
replies; each cap supports values up to **256**. Every admitted candidate remains
eligible for True Evaluation and deeper search within the budget. A separate
cache defaults to **128 inner candidate-generation results**. This metadata
cache limit does not bound the retained search tree: the tree retains generated
nodes and is constrained by the work budget, candidate caps, and Max depth.

Candidate generation prioritizes complete turns using only currently required
boards. Turns that use optionally playable boards (future or inactive boards)
come afterward, with board status recalculated after each component move.
During the required-board pass, optional components are filtered before applying,
probing or evaluating them. Once a required-only turn can be submitted, this pass
does no evaluation of optional extensions. Optional components are scored when
the unrestricted pass actually reaches them.
Optional moves remain legal candidates, including sequences that must play an
optional board first to create a later temporal branch.

Candidate generation uses a deterministic prefix of this neurally ordered
complete-turn generator. Scoring all components at a visited prefix does not
evaluate every combination of components: the cap can still omit strong full
turns, including optional or temporal continuations. Time and work limits can
also interrupt component scoring. This is selective search, so reaching a
requested depth does not mean all legal alternatives were evaluated. The
analysis reports `searchPolicy: transformer-ranked-depth` and candidate caps.
`depth` is the deepest True Evaluation reached, `pvDepth` is the length of the
selected principal variation, and `selectiveDepth` is the deepest generated or
probed turn, including work in interrupted generation. These can differ.
`depthMode` distinguishes `fixed` and `dynamic`, while `currentMaxDepth` reports
the active ceiling. Dynamic results preserve `limits.maxDepth: 0` and report
`dynamicDepthThreshold: 20`. The analysis UI shows the active dynamic ceiling.
`depthStats` reports each depth's candidate
count, True Evaluation count, Searched Moves, and highest candidate rank;
`searchedMoves: null` means the depth has no pending candidates. `expansionRank`
reports the common True prefix, or `null` when no candidates remain and there
is no finite rank cap on expansion. The UI's classical transposition-cache
setting applies only to the classical engine.

During analysis, progress and UI polling use a 100 ms cadence. The leading
continuation shows the current first-ranked root entry, including its **True**
or **Candidate** label and White-relative score. When analysis finishes, the
main recommendation shows the evaluated result that **Play best** will use.
The **Continuations by depth** tabs retain the top ten entries at each depth,
with their evaluation types, scores, and expandable complete lines from the
root. Arrow keys, Home, and End navigate the tabs; new progress preserves the
selected depth. The `rankings` result field carries these bounded display
snapshots, and `progressIntervalMs` records the update cadence. Notation is
cached, and unchanged continuation content is retained in the UI.

`completed: true` means a True root evaluation is available or the root was
proved terminal; it does not mean a full-depth iteration finished. Interruption
retains the latest backed-up True values. Before that point, a legal unscored
fallback is retained when the budget permits. During root candidate generation,
complete submitted successors with known values can replace that fallback even
if a later component batch is interrupted. This provisional result reports
depth zero and `completed: false`; incomplete component turns never become
playable recommendations.

Evaluating all component alternatives adds work and can require several dependent
inference batches while assembling multi-board turns. The search can reach
fewer turns of depth within the same time or work budget. This search uses the
existing value network and checkpoint; no new training or move-policy head is
required.

The default reply cap follows `candidateLimit`, so moving a position from a
continuation to the root keeps its candidate coverage. Advanced callers can
override `innerCandidateLimit`; a smaller reply cap can produce a different
line when that position is analyzed directly. To compare continuations, use the
same checkpoint and search settings and inspect the principal variation and
per-depth statistics. Reaching depth **D** before a move and **D − 1** after it
does not imply equal coverage: the dynamic rankings may allocate work
differently. Time and work limits can stop either search below Max depth.

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
