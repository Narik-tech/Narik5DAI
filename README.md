# Vibe-D AI

A local analysis and play workbench, command-line engine, and JavaScript library for **5D Chess with Multiverse Time Travel**.

The engine searches **complete submitted turns**, including turns that require moves on several timelines. Ordinary moves are considered only on boards currently required to advance the present; optional boards contribute only cross-board moves. It uses iterative deepening, principal variation alpha-beta search, full-turn move ordering, transposition caching in both normal and tactical search, capture/promotion quiescence, and a multiverse evaluation. The rules layer supports historical travel, branching, inactive timelines, castling, en passant, promotions, and the variant pieces supported by the pinned rules dependency.

This is a working classical search engine, not a trained neural model. It has **no established Elo or claim to be the world's strongest 5D engine**. The search budget, completed depth, principal variation, and incomplete results are visible so its behavior can be measured and improved.

## Run

Install [Node.js 22 or newer](https://nodejs.org/) and run from this directory:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:5173**. Everything runs on your computer. No API key, cloud service, account, or GPU is required. Set `PORT` to use a different local port.

The Engine panel includes **Max nodes** (1–1,000,000,000) and **Search cache (RAM)** (Off or 16 MiB–4 GiB), alongside think time and depth. Settings are saved in your browser and apply to analysis and automatic engine replies. Search stops at the time, node, or depth limit; reaching the node limit is shown below the results. A full cache evicts old entries while search continues.

This CPU engine does not allocate GPU VRAM. Profiling found rule generation and history handling to dominate runtime; its small, sequential evaluations do not currently provide enough batched work to justify GPU transfers. See [the performance and GPU assessment](docs/performance.md). The cache control caps estimated RAM retained for saved search results, including full position-history keys and move arrays; total process memory is higher. The selected amount is a budget, not an up-front allocation. Results display estimated cache usage against that budget. Choose Off to disable the cache.

Select a piece on a playable board, then a highlighted destination on any board. A time-travel move can create a new timeline. Continue until the turn can be submitted, then choose **Submit turn**. **Analyze** recommends an entire remaining turn; **Play best** applies it and submits. The opponent selector enables automatic engine replies. Undo removes one pending move, or a whole submitted turn when no moves are pending.

Import/export uses **5DPGN** and **5DFEN**, not ordinary chess FEN. An import preserves the history needed for time-travel moves. Export records submitted turns; submit or undo pending moves before saving a complete game. Undo history starts at the imported position.

## Command line

```sh
node src/cli.js --time 30 --depth 10
node src/cli.js --file examples/opening.5dpgn --time 10 --json
node src/cli.js --variant two_timelines --time 10 --play
node src/cli.js --help
```

`--time` is seconds. `--nodes` bounds search and action-generation work together. `--depth` counts **complete player turns**, not individual piece moves. `--qdepth` controls tactical continuation at the horizon. Ctrl+C requests cancellation and returns the best available legal turn. A worker protects the command line and web server from long searches; a hard deadline backs up cooperative cancellation.

Scores are centipawns from **White's** perspective. A `null` score means no evaluation is available yet. `completed: true` means at least one full depth iteration finished under the search policy, not that the game has been solved. A later interrupted iteration does not replace the last completed iteration. `status: incomplete` never means checkmate. `mateIn` is measured in complete-turn plies and is signed by the winning color; multi-turn mating lines are subject to the optional-board search restriction. Search first completes depth-one passes with capture extensions increasing from zero to the configured limit, then deepens the complete-turn search. `effectiveQuiescenceDepth` records what the completed pass used.

## Engine API

```js
import { createPosition, validateAction } from './src/rules.js';
import { analyze } from './src/search.js';

const position = createPosition({ variant: 'standard' });
const result = analyze(position, {
  timeMs: 5000,
  maxDepth: 8,
  maxNodes: 2_000_000,
  quiescenceDepth: 2,
  cacheMemoryMb: 128, // MiB of estimated search-cache RAM; 0 disables the cache
  onProgress: info => console.log(info.depth, info.score),
});
if (result.bestAction !== null) {
  const next = validateAction(position, result.bestAction);
}
```

`analyze` is synchronous; call it in a worker if your application has an event loop to keep responsive. `src/worker.js` shows cancellation with shared memory. An action is an ordered array of raw piece moves. Coordinates are `[timelineIndex, halfTurnIndex, rankIndex, fileIndex]`. Read [the rules and compatibility notes](docs/rules.md) before using raw coordinates.

## Verification

```sh
npm test
npm run benchmark
npm run strength -- --nodes 50000 --repeat 2 --strict
npm run match -- --engine-a src/search.js --engine-b path/to/baseline/search.js --nodes 10000 --plies 40 --output artifacts/match.json
npm run selfplay
```

Tests cover temporal geometry, history immutability, present shifting, complete-turn legality, optional inactive boards, tactical search, interruption, game export/import, and HTTP integration. The benchmark reports local throughput and verifies returned actions. Self-play is a diagnostic and stops at a turn limit; it does not assign an Elo or count an unfinished game as a draw.

The tactical suite in `examples/tactics/` measures captures for both colors, coordinated multi-board captures and evasions, temporal mates, knight underpromotion, defended captures, and terminal positions. `npm run strength -- --nodes 1000,5000,20000,50000 --repeat 2 --json` reports results at fixed work budgets. Each run validates the full principal variation and checks that the input history is unchanged; repeats check deterministic search results. `--strict` exits with failure if a selected case is unsolved or invalid. Use `--case ID` to inspect one case and `--engine PATH` to compare an earlier compatible search module. These are curated regressions, not an independent rating.

Paired matches use the independent miniature and opening positions in `examples/matches/suite.json`, giving each engine both colors under equal search/generation work limits. `--suite FILE`, `--case ID,ID`, `--depth N`, and `--qdepth N` control the comparison; alternate modules must export `analyze`. `--seed 1,2 --opening-plies 2` adds reproducible legal opening variations. Seeds without opening plies repeat the same starts and do not add independent evidence. Reports preserve full move traces, validate actions and principal variations, check input immutability, and expose deterministic self-match discrepancies when both engine paths are identical.

Only exhaustive full-rule verification awards a checkmate win or stalemate draw. Verification can become expensive on large multiverses; `--terminal-work N` and `--time-ms N` bound it, and reaching either cap leaves the game `UNFINISHED`. Turn caps, missing moves, time stops and search-policy boundaries also stay unfinished; a legal fallback from an incomplete node-limited search can continue. There is no repetition or evaluation-based draw adjudication. Reports include scores among finished games and separately among complete color-swapped pairs: prefer the paired figure, because differing unfinished rates can bias the former. The suite is a development diagnostic, not an Elo rating or broad strength guarantee.

[The heuristic experiment report](docs/heuristic-tuning.md) records 54 alternatives, paired matches, rejected changes, and reproduction commands. `scripts/snapshot-engine.js` freezes a Git revision for comparison, and `scripts/tune-weights.js` screens isolated evaluation profiles before matches. No candidate established a reliable improvement in this experiment, so the production heuristics were retained.

Search retains the exact order of a preferred full turn, including optional moves after a legal submission. Quiet-move history transfers across half-turns, so useful ordering survives as the search deepens. Tactical cache entries are isolated by horizon and share the configured table-size limit; `qTtHits` reports their reuse. The checked-horizon boundary also verifies whether an evasion itself ends the game before assigning a static score. Immutable board encodings are reused within each search while keeping exact, complete-history position keys. Temporal evaluation uses allocation-free integer geometry and includes pawn and brawn royal threats.

The locked-king puzzle in `examples/locked-king.5dpgn` is a performance regression: depth three with two capture-extension plies must complete within 20,000 search/generation work nodes. The original search stalled at depth one because it explored already-lost partial turns and lengthy sequences of checks at the tactical horizon. Search now rejects irreversible royal attacks early, reuses unchanged move geometry within a turn, and directly generates tactical actions during quiescence. The app reports live work counts and the depth currently being searched separately from completed depth.

For longer diagnostics, set `BENCH_TIME_MS`, `SELFPLAY_TIME_MS`, or `SELFPLAY_PLIES` in your shell. Increase think time before increasing depth: requested depth is only a ceiling, and the full-turn branching factor can grow rapidly.

## Design and limits

- **Immutable history:** search shares unchanged past boards, but position keys include all history. Identical current boards with different pasts are different positions.
- **Legal complete turns:** move generation is lazy and deduplicates equivalent partial states. A king may be exposed during a partial turn; every king must be safe on submission. Search allows cross-board moves on optional boards, including after the present has shifted, but excludes ordinary same-board moves there. The required boards are recomputed after each component move. Manual play retains every legal move.
- **No false mate from a timer:** mate/stalemate is classified only after exhaustive legal-action enumeration. The upstream eager action enumerator and timeout-based mate getters are bypassed.
- **Evaluation:** weighted frontier material, development, mobility, pawn structure, king exposure, temporal pressure, and weaknesses across timelines. Temporal pressure follows the pinned movement vectors, including directional pawn/brawn captures and royal and fairy pieces, respects historical blockers and missing boards, and connects only matching half-turn colors. Historical material is not repeatedly counted. Direct royal pressure samples six past snapshots; king-zone protection also retains the first snapshot of each half-turn color. Weights are hand tuned and not statistically calibrated.
- **Search:** no beam cap or chess null-move assumption in normal-depth search. Ordinary moves on optional boards are deliberately excluded, including captures, promotions, and castling. Quiescence uses the same policy and searches captures/promotions up to its configured limit. If checked at that limit, it evaluates permitted legal evasions for one further turn, including terminal detection after the evasion. An exhausted restricted tree is checked against full rules before classifying mate/stalemate; a policy-limited root returns no recommendation and `stoppedReason: policy`. This selective search and finite horizon can miss tactics. Time budgets can expire before depth one on a large multiverse.
- **Compatibility:** the pinned community rules implementation is not an official Thunkspace engine. Regression coverage is substantial but cannot certify every Steam variant. There is no live Steam integration, opening book, tablebase, repetition adjudication, learned policy, or distributed search.

For further strength measurement, expand the tactical suite and run paired engine matches before tuning evaluation weights. More search time is useful, but no finite setting guarantees optimal play.

King safety includes potential time-travel corridors toward kings and adjacent friendly pawns. Pawns with few nonroyal defenders receive more protection priority, which makes the early f2/f7 pawns especially important. The heuristic follows same-timeline time/rank and time/rank/file rays through recorded history, then projects the current arrangement beyond the frontier for up to six steps. It considers compatible opposing sliders, fades with material phase, and uses the worst sampled exposure instead of summing historical copies. This rewards Nf3 closing the f2–f3 route, d4 closing the f2–e3–d4 route, and c3 closing the e1–d2–c3 route after d4 vacates d2. The geometry applies to both colors and custom king placements; it is a development heuristic, not an opening book or a proof of future safety. Tactical search and direct royal pressure still handle concrete attacks and other travel directions.

Timeline evaluation values unused capacity to create active branches. If White has used W timeline slots and Black B, their remaining active-branch capacities are `max(0, B + 1 - W)` and `max(0, W + 1 - B)`. Slots follow each side's outermost timeline index, including inactive branches, to match the rules for sparse and even layouts. The first unreciprocated branch costs 180 centipawns of reserve advantage; further overextension adds a penalty. Travel to an existing frontier spends no branch reserve. These bounded evaluation costs require compensation from the resulting position while allowing forced defenses, material wins, and mating travel.

The `travel` evaluation component rewards an unobstructed route from a frontier piece to a historical pawn beside an enemy royal when the pawn has no nonroyal spatial defender and the attacker can still create an active branch. The strongest such opportunity receives up to 140 centipawns per color, with reduced weight for inactive timelines and low-value attackers. A setup that depends on the opponent's reply leaving the arrangement intact receives half credit. Historical blockers, missing boards, and half-turn parity still apply; copied targets and multiple attackers do not multiply the bonus. This is potential attacking value, with complete-turn legality and the strength of an actual capture determined by search.

## Sources and license

Movement and notation are based on [5D Chess JS](https://gitlab.com/5d-chess/5d-chess-js), pinned to npm version **1.2.1**, by Shaun Wu and its contributors. Additional primary implementation and notation references are recorded in [docs/rules.md](docs/rules.md). The included temporal-attack example follows the opening illustrated by [ftxi's 5D Chess engine](https://ftxi.github.io/5dchess_engine/).

This project is **AGPL-3.0-or-later**, consistent with the rules dependency. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is an independent project and is not affiliated with Thunkspace.
