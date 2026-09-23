This corpus measures specific tactical decisions, complete-turn legality, and
search horizons. It is a small, curated regression suite used during engine
development. Its solve rate is not an Elo rating, a blind test, or a substitute
for games against independently rated opponents.

Run `node scripts/strength.js` for results at 1,000, 10,000, and 50,000 work
nodes. Work includes both search visits and action-generation ticks. Each case
has an explicit full-turn depth and quiescence depth in `suite.json`; the node
budgets override its regression-test allowance. The 30-second wall-clock cap
is a safety limit, and time-limited results are marked as unsuitable for
deterministic comparison. Actual elapsed time and work are reported separately.

Useful commands:

```sh
node scripts/strength.js --nodes 50000 --repeat 2 --strict
node scripts/strength.js --nodes 1000,10000,50000 --json
node scripts/strength.js --case temporal-knight-mate,knight-underpromotion
node scripts/strength.js --engine ./path/to/baseline/search.js --json
```

The default command exits unsuccessfully for an invalid action, illegal PV,
mutated input, inconsistent work counters, false terminal claim, or differing
repeated deterministic results. `--strict` additionally fails on an unsolved
case. A legal fallback or a lucky move from an incomplete horizon does not
count as a solve. Each PV is replayed through the rules validator. Mate-in-one
and terminal claims are checked by enumerating replies with generator caching
and unsafe-subtree pruning disabled; these checks are outside search timing.
The forced-loss case additionally checks every defender turn and a winning
reply to each, rather than treating a single mating PV as a forced-mate proof.

Expected decisions are explicit coordinate arrays in `suite.json`. The actual
action and expected action must reach the same full historical state. This
accepts interchangeable independent move orders while preserving the ordering
of moves whose branch semantics differ. Each action must validate in its
reported order. Numeric evaluations are deliberately not frozen.

| Case | Required behavior |
| --- | --- |
| `white-queen`, `black-queen` | Capture the undefended queen, with the score expressed from White's perspective. |
| `dual-queens` | Capture on both active timelines in one submitted action. |
| `dual-evasion` | Move both kings off the rook files; a single move cannot complete the turn. |
| `temporal-knight-mate` | Jump from b2 on T2 to b4 on T1, capturing the queen and creating a mating branch. |
| `knight-underpromotion` | Promote b4 to a knight for immediate mate; queen, rook, and bishop promotions all allow replies. |
| `poisoned-pawn` | Reject Nxe5 after completing capture search; this tests one trap, not the optimality of every alternative. |
| `temporal-queen-mate` | Find Qh5 and prove that the temporal king threat leaves no complete legal reply. |
| `locked-king` | Find Bg1 while completing depth three with quiescence depth two. |
| `evasion-mate` | At depth one and quiescence zero, recognize that either White move permits a Black evasion that mates. |
| `checkmate`, `stalemate` | Exhaust the complete-turn tree and classify check correctly. |

The small custom boards are composed positions, including explicit history in
the temporal-knight fixture. They are not asserted to be reachable from the
standard opening. All PGNs import through the same validated rules path as the
application. Spatial captures, mate, and no-move states are present alongside
5D cases so a specialized optimization cannot silently break simpler play.
