# Narik 5D AI

A local analysis and play workbench, command-line engine, and JavaScript library for **5D Chess with Multiverse Time Travel**.

The engine searches **complete submitted turns**, including turns that require moves on several timelines. It uses iterative deepening, principal variation alpha-beta search, transposition caching, capture/promotion quiescence, and a multiverse evaluation. The rules layer supports historical travel, branching, inactive timelines, castling, en passant, promotions, and the variant pieces supported by the pinned rules dependency.

This is a working classical search engine, not a trained neural model. It has **no established Elo or claim to be the world's strongest 5D engine**. The search budget, completed depth, principal variation, and incomplete results are visible so its behavior can be measured and improved.

## Run

Install [Node.js 22 or newer](https://nodejs.org/) and run from this directory:

```sh
npm ci
npm start
```

Open **http://127.0.0.1:5173**. Everything runs on your computer. No API key, cloud service, account, or GPU is required. Set `PORT` to use a different local port.

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

Scores are centipawns from **White's** perspective. A `null` score means the budget found a legal fallback but did not finish evaluating it. `completed: true` means at least one full depth iteration finished, not that the game has been solved. A later interrupted iteration does not replace the last completed iteration. `status: incomplete` never means checkmate. `mateIn` is measured in complete-turn plies and is signed by the winning color. Search first completes depth-one passes with capture extensions increasing from zero to the configured limit, then deepens the complete-turn search. `effectiveQuiescenceDepth` records what the completed pass used.

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
npm run selfplay
```

Tests cover temporal geometry, history immutability, present shifting, complete-turn legality, optional inactive boards, tactical search, interruption, game export/import, and HTTP integration. The benchmark reports local throughput and verifies returned actions. Self-play is a diagnostic and stops at a turn limit; it does not assign an Elo or count an unfinished game as a draw.

The locked-king puzzle in `examples/locked-king.5dpgn` is a performance regression: depth three with two capture-extension plies must complete within 20,000 search/generation work nodes. The original search stalled at depth one because it explored already-lost partial turns and lengthy sequences of checks at the tactical horizon. Search now rejects irreversible royal attacks early, reuses unchanged move geometry within a turn, and directly generates tactical actions during quiescence. The app reports live work counts and the depth currently being searched separately from completed depth.

For longer diagnostics, set `BENCH_TIME_MS`, `SELFPLAY_TIME_MS`, or `SELFPLAY_PLIES` in your shell. Increase think time before increasing depth: requested depth is only a ceiling, and the full-turn branching factor can grow rapidly.

## Design and limits

- **Immutable history:** search shares unchanged past boards, but position keys include all history. Identical current boards with different pasts are different positions.
- **Legal complete turns:** move generation is lazy and deduplicates equivalent partial states. A king may be exposed during a partial turn; every king must be safe on submission. The search includes optional moves even after the present has shifted.
- **No false mate from a timer:** mate/stalemate is classified only after exhaustive legal-action enumeration. The upstream eager action enumerator and timeout-based mate getters are bypassed.
- **Evaluation:** weighted frontier material, development, mobility, pawn structure, king exposure, temporal geometry, and weaknesses across timelines. Historical material is not repeatedly counted. Weights are hand tuned and not statistically calibrated.
- **Search:** no beam cap or chess null-move assumption in normal-depth search. Spatial continuations are ordered before unforced timeline branching; this changes order, not the set of legal turns. Quiescence searches captures/promotions up to its configured limit. If checked at that limit, it evaluates actual legal evasions for one further turn instead of standing still in check. This finite horizon can miss longer tactics. Time budgets can expire before depth one on a large multiverse.
- **Compatibility:** the pinned community rules implementation is not an official Thunkspace engine. Regression coverage is substantial but cannot certify every Steam variant. There is no live Steam integration, opening book, tablebase, repetition adjudication, learned policy, or distributed search.

For stronger play, the next measurable work is a larger 5D tactical suite and paired engine matches, then profile-guided optimization and evaluation tuning. More search time is useful, but no finite setting guarantees optimal play.

## Sources and license

Movement and notation are based on [5D Chess JS](https://gitlab.com/5d-chess/5d-chess-js), pinned to npm version **1.2.1**, by Shaun Wu and its contributors. Additional primary implementation and notation references are recorded in [docs/rules.md](docs/rules.md). The included temporal-attack example follows the opening illustrated by [ftxi's 5D Chess engine](https://ftxi.github.io/5dchess_engine/).

This project is **AGPL-3.0-or-later**, consistent with the rules dependency. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). It is an independent project and is not affiliated with Thunkspace.
