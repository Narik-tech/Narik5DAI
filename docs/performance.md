# Search performance and GPU assessment

The search policy allows ordinary, same-board moves only on boards currently
required to advance the present. On inactive timelines and boards ahead of the
present, search considers only moves to another board (another timeline or
another time). This also excludes ordinary captures, promotions, en passant,
and castling from optional boards. The policy is recalculated after each move
of a partial turn, because branching can change the present and active set.
Preferred turns, fallback recommendations, and tactical continuations use the
same policy. Manual play and the rules validator retain all legal moves.

This is a selective search policy. In particular, advancing an optional board
can make a later arrival branch instead of merge. The rules tests preserve
that distinction even though search deliberately omits such spatial moves.
If the restricted action tree is empty, the engine checks for one unrestricted
legal turn solely to distinguish a policy limit from actual mate or stalemate.
It does not evaluate or recommend that excluded turn. A root policy limit
returns `status: incomplete`, `stoppedReason: policy`, and no recommendation;
an internal policy limit uses static evaluation. Results identify the policy
with `searchPolicy: present-spatial` and count internal limits in `policyLeaves`.
Multi-turn mating lines remain subject to the selected search policy; the
tactical suite checks its expected mates against unrestricted legal replies.

## CPU improvements

- Exact position keys reuse encodings of immutable historical boards within
  each search. The complete history, side, and promotion set remain in the
  key; this introduces no hash-collision risk. Public `positionKey` calls still
  observe edits to caller-owned boards, and each search starts a fresh cache.
- Temporal attacks use small integer lookup tables instead of allocating and
  serializing vectors for every piece/royal pair. Directional pawn and brawn
  royal threats are included. Geometry is checked against the pinned rules
  implementation, including missing boards, blockers, and even timelines.
- Tactical search reuses a searched capture as evidence that a legal turn
  exists, avoiding duplicate generation. Quiet-only positions and terminal
  positions still receive legality checks.
- Mate-distance bounds avoid searching scores that cannot improve an already
  found mate. Iterative search uses a 60-centipawn aspiration window starting
  at depth two, with a full-window retry whenever the estimate falls outside.

These changes target deeper completed searches within a fixed budget. They
do not establish an Elo gain. `node scripts/strength.js --nodes
1000,5000,20000,50000 --repeat 2 --json` reports deterministic work-budget
results; `--engine PATH` permits comparison with an earlier search module.

Compared with commit `34c712b`, the local checks produced these work counts
(search visits plus generation ticks). Both engines used quiescence depth two
and a 100,000-node ceiling. Each case was repeated three times; elapsed times
below are medians and vary by hardware and load.

| Position and requested depth | Previous nodes | Current nodes | Completed depth, previous → current | Median ms, previous → current |
| --- | ---: | ---: | --- | --- |
| Standard opening, depth 4 | 22,333 | 17,306 | 4 → 4 | 479 → 311 |
| Locked king, depth 3 | 8,713 | 3,654 | 3 → 3 | 85 → 33 |
| Temporal queen mate, depth 2 | 283 | 222 | 1 → 1, immediate mate | 10 → 4 |
| Defended pawn opening, depth 2 | 38,849 | 100,000, limit reached | 2 → 1 | 952 → 4,058 |

The last case is a regression from the requested optional-board policy:
omitting spatial continuations can remove cheap cutoffs and leave expensive
temporal branches. The change is not a universal speed or strength gain.
The curated 12-case tactical suite improves from 9 to 10 solved at 5,000 work
nodes, and retains 12/12 at 20,000 and 50,000. Two repeats at each budget
produced identical search results and no invalid principal variations or
false terminal certificates. The suite's defended-pawn case requires depth
one with recapture analysis; the deeper depth-two experiment above is a
separate diagnostic.

## GPU feasibility

A local check found an NVIDIA GeForce RTX 3060 with 12 GiB of VRAM. A CPU
profile of the five benchmark positions, with 1.5 seconds per search, found:

| Work | Sampled CPU self time |
| --- | ---: |
| Rule generation and upstream move geometry | 59.2% |
| Position evaluation | 15.0% |
| Search orchestration | 13.9% |
| Garbage collection | 10.1% |

Full-history serialization alone accounted for 16.5% of the samples and
temporal-attack evaluation for 9.6%. These are observations from the previous
implementation on this machine, not portable performance guarantees.

Even a hypothetically free GPU evaluator could improve that workload by at
most about 1.18 times before accounting for transfers and synchronization.
The current alpha-beta search consumes one child score before deciding which
branch to visit next. Its small, hand-written evaluations provide little
parallel arithmetic per dispatch. NVIDIA's
[CUDA best-practices guidance](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#what-runs-on-a-cuda-enabled-device)
recommends substantial parallel work and minimizing host/device transfers.

GPU support is feasible through a compute runtime such as
[Dawn's Node WebGPU bindings](https://github.com/dawn-gpu/node-webgpu), but is
not enabled in this implementation. A promising future use is training and
batched inference for a learned policy/value model, which requires training
data, a validated model, and search designed to batch evaluations. The current
engine has none of those prerequisites. It continues to use CPU and RAM;
raising the search-cache limit does not allocate GPU VRAM.
