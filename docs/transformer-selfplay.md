# Transformer self-play

The runner repeatedly plays the current transformer against itself, adds value
targets to a bounded replay buffer, trains a candidate on the local GPU, and
tests it against the incumbent. Only a passing candidate replaces the checkpoint
used by **Transformer · experimental** in the UI. Classical search and the
existing `npm run selfplay` diagnostic are separate.

## Run it

Run from the project directory in PowerShell. This workstation already has the
CUDA environment and a trained checkpoint. For a fresh installation, first run
`npm run transformer:setup`, `npm run transformer:data`, and
`npm run transformer:train`. Self-play requires a trained model to start.

One cycle with the default settings:

```powershell
npm run transformer:selfplay -- --iterations 1 --device cuda
```

Continuous operation until **Ctrl+C**:

```powershell
npm run transformer:selfplay -- --iterations 0 --device cuda
```

Rerun the same command to continue using the saved replay buffer and current
accepted model. Iteration numbers and seeds advance. Each cycle starts training
from the incumbent; rejected candidates are retained for inspection but are not
used as the next incumbent. An interrupted cycle is recorded and a new cycle
starts on the next invocation; partially completed training is not resumed.

A longer run with more games and a larger acceptance sample:

```powershell
npm run transformer:selfplay -- --iterations 0 --device cuda --games 16 --plies 64 --steps 1000 --batch-size 32 --nodes 40000 --time-ms 5000 --arena-pairs 12 --min-pairs 8 --arena-plies 128
```

These settings can take substantial time. Legal move generation runs on the
CPU, so low GPU utilization during games is expected. Training uses the existing
compact transformer and CUDA mixed precision. Reduce `--batch-size` to 8 if GPU
memory is shared with other applications. Use `--device cpu` without CUDA.
Avoid latency-sensitive UI analysis while training if response time matters.

For an isolated short pipeline check, copy the active checkpoint first:

```powershell
New-Item -ItemType Directory -Force artifacts/transformer/selfplay-check | Out-Null
Copy-Item artifacts/transformer/model.pt artifacts/transformer/selfplay-check/active.pt
npm run transformer:selfplay -- --iterations 1 --device cuda --checkpoint artifacts/transformer/selfplay-check/active.pt --run-dir artifacts/transformer/selfplay-check/run --games 2 --plies 4 --steps 16 --depth 1 --nodes 3000 --time-ms 1000 --arena-pairs 1 --min-pairs 1 --arena-plies 4 --replay-size 128
```

Short checks usually fail the promotion gate because games are unfinished or
tied. They verify the pipeline, not playing strength. Use a new check directory
if you want to preserve an earlier check's copied checkpoint.

## Defaults and learning targets

| Setting | Default |
| --- | --- |
| Cycles per invocation | 1; `--iterations 0` runs continuously |
| Self-play | 8 games, 40 complete turns/game |
| Search per turn | Depth 2, 20,000 work units, 3 seconds |
| Exploration | 20% probability during the first 12 turns |
| Training | 500 additional updates, batch 16, learning rate 0.0001 |
| Replay | At most 8,192 unique full-history positions |
| Arena | 8 distinct starts, 2 games/start with colors swapped, 80 turns/game |
| Promotion | At least 4 completed distinct pairs; candidate score at least 55% |
| Retention | Latest 5 iteration folders, replay, latest report and previous model |

See all options with `npm run transformer:selfplay -- --help`.
`--plies` counts submitted full player turns, including turns requiring moves
on multiple boards. Exploration samples from a bounded prefix of up to 32 legal
complete turns; it is not uniform over the entire 5D action space. Seeds control
case rotation and exploration, although wall-clock limits and CUDA kernels can
still affect reproducibility.

The model has a value head. This is search distillation with outcome targets,
not an AlphaZero policy/MCTS implementation. Every training score is relative
to White. A completed root search supplies `v = tanh(score / 1000)`:

- A certified finished game supplies `z = +1` for a White win, `-1` for a Black
  win, or `0` for stalemate. The default target is `0.5*v + 0.5*z`.
- A capped, timed-out, or otherwise unfinished game supplies only its completed
  search targets. It has no invented win/loss/draw target.
- Incomplete/nonfinite searches supply no target. An illegal action, bad PV,
  input mutation, or model error discards that game's samples and stops the cycle
  before training.

`--outcome-weight` changes the finished-game mixture. Targets are converted back
to the trainer's centipawn JSONL format. Search scores belong to the searched
root even when exploration plays another turn. Records preserve both actions,
the checkpoint hash, seed, game result and target provenance. Every played
action and PV is checked against the full rules. Only full-rules terminal
certification establishes checkmate/stalemate; there is no score-based
adjudication or repetition draw.

The first replay buffer also samples `artifacts/transformer/training.jsonl`.
Use `--seed-data FILE` for another seed dataset, or `--seed-data none` to learn
only from self-play. Later cycles read existing replay instead. New unique
positions reserve up to half the buffer; historical positions fill the other
share, and spare capacity is filled when one source is small. Deduplication
includes side to move, promotions and the full multiverse history. New labels
replace old labels for duplicated positions. JSONL is streamed with a 4 MiB
per-record limit; malformed examples fail the update without partial replacement.

## Acceptance and the UI

Default self-play starts come from `examples/matches/training.json`; arena starts
come from `examples/matches/validation.json`. Exact overlapping starts are rejected
between suites, and exact arena-start positions are excluded from seed, existing
and newly generated replay. Use `--suite` and `--arena-suite` for custom JSON
files in the same fixture format.

Candidate and incumbent play identical arena starts with colors swapped and
equal search limits. Both games in a pair must finish legally with certified
results and meaningful play. Duplicate or already-terminal starts do not count.
An unfinished game excludes its whole pair; any invalid game vetoes promotion.
The candidate must exceed 50% and meet `--promotion-score`, after at least
`--min-pairs` complete distinct pairs. The default threshold is 55%.

If too few pairs finish, inspect the recorded reasons and increase `--arena-plies`,
`--nodes` or `--time-ms`, or supply suitable nonterminal miniature starts. A time
cap in the arena ends the game as unfinished; a node-budget fallback can still
play if legal. Do not count unfinished games as draws to force acceptance.

This is a conservative operational gate, not a guarantee of improvement or an
Elo estimate. A small or repeatedly used selection suite can be overfit. The
existing bootstrap checkpoint has already seen at least one default arena start
in teacher training; excluding it from future replay cannot undo that exposure.
Use separate unseen suites for independent strength measurement. Falling replay
loss alone does not establish stronger play.

Promotion preserves the previous model and atomically replaces
`artifacts/transformer/model.pt` by default. The server reloads changed weights
on the next transformer analysis; the Classical option remains available.
Custom `--checkpoint` paths must match the server's `TRANSFORMER_CHECKPOINT` if
you want those weights in the UI. Generation and arena use immutable checkpoint
snapshots. Two runners cannot share either a run directory or active checkpoint.
An external checkpoint change during a cycle prevents promotion; avoid manually
training over the active file while this loop is running.

## Files, stopping and recovery

Under `artifacts/transformer/selfplay/` by default:

- `latest.json`: most recent cycle, data counts, hashes and acceptance decision.
- `replay.jsonl`: bounded training buffer; retained across invocations.
- `run.json`: run identity and next iteration number.
- `previous-model.pt`: previous incumbent after the latest promotion.
- `iteration-00000001/` and subsequent folders: immutable incumbent,
  trained candidate, game traces, sample JSONL files, `train.log`, the exact
  Python command, `arena.json` and `report.json`.

Only the latest `--keep-iterations` managed folders remain. Copy any candidate
or report elsewhere before it ages out. An untouched unrelated folder is not
part of retention. Runs and checkpoints are ignored by Git.

Ctrl+C closes owned inference/search/training processes, saves an interrupted
report, and releases locks. Existing replay survives; completed game files from
an interrupted generation phase remain in its folder but are not automatically
merged on restart. Training or arena failures leave the active model intact.

A forced process kill or machine crash can leave `.selfplay.lock` in the run
directory and/or `model.pt.selfplay-lock/`. The error reports the exact path and
owner PID. Verify that process is no longer running, then remove only the named
lock file and rerun. An abrupt crash immediately after atomic model publication
can leave the report at `evaluated`; compare the active model hash with the
recorded candidate hash and inspect its saved arena decision and `previous.pt`.

To roll back after stopping the loop and current analysis:

```powershell
Copy-Item -Force artifacts/transformer/selfplay/previous-model.pt artifacts/transformer/model.pt
```

To inspect progress from another PowerShell window:

```powershell
Get-Content artifacts/transformer/selfplay/latest.json
Get-Content artifacts/transformer/selfplay/iteration-00000001/train.log -Tail 10
```

The runner prints JSON events after each game and phase, plus a heartbeat during
long training. Search runs in terminable workers with a hard safety deadline;
exploration and full-rules terminal verification use cooperative work/time caps.

## Verification

`node --test` covers game legality, outcomes for both colors, target blending,
unfinished games, exploration, invalid-result rejection, cancellation, replay
deduplication/mixing, atomic checkpoint replacement, locks, and the paired gate.
The implementation was also exercised on this machine's CUDA GPU through actual
self-play, candidate training, rejection of unfinished/tied arenas, and a resumed
run using persisted replay. Four short CUDA cycles completed, plus a deliberate
interruption during training followed by successful restart; retention and
recovery from an empty interrupted iteration folder were checked. None of the
smoke candidates passed promotion, so the active UI checkpoint was preserved.
These are functional checks, not strength claims.
