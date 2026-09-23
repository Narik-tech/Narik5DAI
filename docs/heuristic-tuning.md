# Heuristic experiments — September 2026

**No heuristic change was retained.** The experiments did not establish a reliable improvement over the current engine. The initially promising king-safety change failed fresh replication and was reverted; search-order changes had mixed performance or tied matches. The baseline is commit `c3185db068bf80bd47b8c5e587556082f1a9ddd6` with `5d-chess-js` 1.2.1. Production search and evaluation remain at that baseline.

The retained implementation is the reproducible comparison infrastructure: isolated revision snapshots, a weight-sweep runner with per-position tactical regression checks, paired matches, fixed starting histories, and replayable results. The evidence does not establish an Elo gain. Many ordinary-board games remained unresolved.

## What was tried

We screened **54 alternatives** to the baseline:

| Group | Alternatives | Examples |
| --- | ---: | --- |
| Evaluation weights | 24 | Activity, king safety, temporal pressure, branch reserves, travel opportunities, pawn advancement, passed pawns, piece values, development, combinations |
| New evaluation features | 14 | Pawn-safe mobility, loose-piece threats, early queen development, king phase scaled to board size, spatial king-zone attacks, nonlinear mobility |
| Search heuristics | 16 | Aspiration widths, capture priority, temporal ordering, history updates, piece-dependent and board-dependent quiet ordering |

The weight screen used all 12 tactical fixtures at 1,000, 5,000, and 20,000 work nodes. Removing the timeline-reserve score and doubling the travel bonus failed that gate. Most other weight changes tied the baseline tactically, making actual matches necessary.

Pawn-safe mobility lost 4–12 in its 16-game miniature screen; its less aggressive version lost 5–11. Neither was retained. Removing quiet centralization ordering reduced one dual-evasion fixture from 10,278 to 3,961 nodes, but increased work by 1.53% across 15 other completed fixed-depth positions and tied its completed validation pairs. That isolated speedup was rejected.

## Match protocol

Every start is played twice, with the engines' colors exchanged. Both engines receive identical search/generation work limits, depth 4, quiescence depth 1, and a 60-second safety cap. Games stop after 40 submitted turns. Legal fallback moves from an interrupted iteration may play, as they do in the application; the report records incomplete iterations.

Every move and principal variation is checked through the rules layer, and engine inputs are checked for mutation. A validated legal action proves the position is nonterminal. If there is no action, a terminal claim, or a turn cap, an independent generator with search-policy restrictions and pruning disabled checks for checkmate or stalemate. Its 20,000-work cap leaves difficult cases unfinished. No evaluation score, lack of search depth, repetition, or timeout awards a result.

**Scores among complete color-swapped pairs are the primary comparison.** Counting just whichever games finish can favor a candidate that leaves more losing games unresolved. Even complete pairs are a censored, small sample; they are reported alongside all unfinished games, not extrapolated into a rating.

The original diagnostic runner redundantly certified every intermediate position, and an earlier version stopped at incomplete searches despite a legal fallback. Those early screens helped narrow the candidates but are not the final acceptance evidence. Final comparisons use the corrected runner. A 20-game self-match produced matching move and search traces in all ten pairs, six wins per engine, and eight unfinished games.

## Candidate selection and rejection

King safety ×1.5 was locked before evaluating the validation results. The six-position development rerun at 2,000 nodes gave it 7 wins, 4 losses, and 1 unfinished game; its five complete pairs scored **6–4**. A separate four-opening standard-board screen was neutral in its three complete pairs.

At **5,000 nodes**, the initial 16-position validation produced **12 wins, 7 losses, 1 stalemate draw, and 12 unfinished games**. The eight complete pairs scored **9.5–6.5 (59.4%)**: two favorable pairs, six ties, and no adverse pairs. Both favorable pairs were miniature positions. One start, `queens-pawn`, overlapped the earlier standard-board screen; the other 15 starts were unseen in evaluation selection. Excluding that overlapping start leaves the complete-pair score unchanged. Three randomly generated starts were already checkmated and were excluded before scoring.

That apparent gain did not survive verification:

| Candidate / cohort | Wins | Losses | Draws | Unfinished | Complete-pair points |
| --- | ---: | ---: | ---: | ---: | --- |
| King safety ×1.5, initial 5k validation | 12 | 7 | 1 | 12 | 9.5–6.5 |
| King safety ×1.5, same starts at 10k | 12 | 13 | 0 | 7 | 10–10 |
| King safety ×1.5, 22 fresh starts at 5k | 15 | 20 | 1 | 8 | **12.5–17.5** |
| Travel ×1.5, original 16 starts | 9 | 11 | 0 | 12 | 9–9 |
| Travel ×1.5, existing fresh 22 starts | 16 | 15 | 1 | 12 | 14.5–15.5 |
| Board-size-aware ordering, 16 miniature starts | 12 | 12 | 0 | 8 | 12–12 |

The king-safety replication had three adverse complete pairs and no favorable ones. The multiplier was removed. Travel weighting was tested afterward as a fixed candidate on already-used cohorts, so those games are screening evidence, not a new independent holdout. It also failed to improve the paired score.

Correcting the ordering bonus's hardcoded 8×8 center preserved all measured 8×8 moves and work counts. It reduced work by 5.31% on six independent miniature positions but increased work by 45.14% when the two multiboard tactical diagnostics were included; dual-evasion rose from 10,278 to 21,706 nodes. Its twelve complete miniature match pairs all tied. That mixed result was not promoted as an improvement.

Development and early-queen penalties received a final standard-board screen because ordinary miniature FENs omit the unmoved-piece flags those terms need. The moderate version scored 9–6 with 5 unfinished games, or 7–5 in six complete pairs (three favorable, two adverse). The stronger version scored 5–7 with 8 unfinished games, or 3–5 in four complete pairs. The moderate version has only a screening result on existing starts and no independent confirmation. Neither was installed as a default heuristic.

Budget repetitions and reused starts must be read separately; they do not create new independent samples. Every reported final game passed legality, PV, work-accounting, and input-preservation checks, with no clock safety cutoff.

The baseline and rejected king-safety evaluator both solve **9/12, 10/12, 12/12, and 12/12** tactical fixtures at 1,000, 5,000, 20,000, and 50,000 work nodes. Two repetitions at each budget validate determinism, all actions/PVs, and input immutability. Passing tactical regressions alone was not sufficient for acceptance.

Final verification: **163 tests passed**, the diff passed whitespace checks, and the production search/evaluation/rules/cache files are byte-identical to the frozen baseline.

## Reproduce

Create an isolated baseline from the recorded commit. The destination must be new; the helper refuses to overwrite an existing snapshot. Keep it below the repository so the pinned installed dependency resolves.

```sh
node scripts/snapshot-engine.js c3185db068bf80bd47b8c5e587556082f1a9ddd6 artifacts/baseline-c3185db
node scripts/tune-weights.js --baseline artifacts/baseline-c3185db --output artifacts/king-safety-reproduction --profiles kingSafety-1.5 --tactics-only
node scripts/match.js --engine-a artifacts/king-safety-reproduction/kingSafety-1.5/search.js --engine-b artifacts/baseline-c3185db/search.js --suite examples/matches/validation.json --nodes 5000 --plies 40 --depth 4 --qdepth 1 --time-ms 60000 --terminal-work 20000 --output artifacts/validation-5000.json
node scripts/match.js --engine-a artifacts/king-safety-reproduction/kingSafety-1.5/search.js --engine-b artifacts/baseline-c3185db/search.js --suite examples/matches/replication.json --nodes 5000 --plies 40 --depth 4 --qdepth 1 --time-ms 60000 --terminal-work 20000 --output artifacts/replication-5000.json
node scripts/strength.js --nodes 1000,5000,20000,50000 --repeat 2
node --test
```

Reproduce the weight sweep, or select one profile for a shorter run:

```sh
node scripts/tune-weights.js --baseline artifacts/baseline-c3185db --output artifacts/weight-sweep --profiles kingSafety-1.5 --suite examples/matches/training.json --nodes 2000 --plies 40
```

Omit `--profiles` for all 25 profiles including the baseline. The script first rejects tactical regressions, then runs paired development matches. It only writes isolated copies and reports; it never edits production source. Profiles in `examples/matches/weight-profiles.json` are relative to the supplied baseline, so use the recorded revision to reproduce this experiment. Use `--tactics-only` to omit matches.

Exact starting histories are retained in the three JSON suites. Local full traces and rejected-candidate experiment scripts are under `artifacts/heuristic-tuning/`; retained summary evidence and replayable final move traces are in `docs/experiments/heuristic-tuning.json`.
