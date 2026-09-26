import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { TransformerRuntime, DEFAULT_CHECKPOINT } from '../src/transformer-runtime.js';
import { createPosition, pseudoMoves, validateAction, positionKey } from '../src/rules.js';
import { assessTactic, loadTactics } from './strength.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i];
  if (!['--time-ms', '--nodes', '--depth', '--checkpoint', '--device', '--search-module', '--output'].includes(name)
    || process.argv[i + 1] === undefined) throw new Error('Usage: node scripts/benchmark-transformer.js [--time-ms 1000] [--nodes 20000] [--depth 3] [--checkpoint FILE] [--device auto|cuda|cpu] [--search-module FILE] [--output FILE]');
  args[name.slice(2)] = process.argv[i + 1];
}
const numeric = (name, fallback, min, max) => {
  const value = args[name] === undefined ? fallback : Number(args[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid --' + name);
  return value;
};
const limits = { timeMs: numeric('time-ms', 1000, 50, 60000), maxNodes: numeric('nodes', 20000, 1, 1e9), maxDepth: numeric('depth', 3, 0, 64) };
const checkpoint = resolve(args.checkpoint || DEFAULT_CHECKPOINT);
const runtime = new TransformerRuntime({ checkpoint, device: args.device || 'auto' });
const { analyze } = await import(args['search-module'] ? pathToFileURL(resolve(args['search-module'])).href : '../src/transformer-search.js');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function targetMet(fixture, result) {
  const expected = fixture.expected;
  if (!expected) return null;
  if (expected.status && result.status !== expected.status) return false;
  if (expected.mateIn !== undefined && (!result.mateProven || result.mateIn !== expected.mateIn)) return false;
  if (expected.scoreSign !== undefined && (result.score === null || Math.sign(result.score) !== expected.scoreSign)) return false;
  if (expected.action || expected.allowedActions) {
    if (!result.bestAction) return false;
    const key = positionKey(validateAction(fixture.position, result.bestAction));
    if (!(expected.allowedActions || [expected.action]).some(action => positionKey(validateAction(fixture.position, action)) === key)) return false;
  }
  if (expected.forbiddenMoves?.some(move => result.bestAction?.some(played => same(move, played)))) return false;
  if (expected.temporal && !result.bestAction?.some(([from, to]) => from[0] !== to[0] || from[1] !== to[1])) return false;
  return result.completed;
}
try {
  const model = await runtime.start();
  // Warm process, encoder and inference before starting any per-position timer.
  const generation = { runtimeGeneration: model.model.runtimeGeneration };
  const warmup = createPosition();
  await runtime.evaluate([warmup], generation);
  if (model.model.policyAvailable) await runtime.orderMoves(warmup, pseudoMoves(warmup), generation);
  const suite = await loadTactics();
  const fixtures = [
    { id: 'standard', position: createPosition() },
    { id: 'two-timelines', position: createPosition({ variant: 'two_timelines' }) },
    ...suite.cases,
  ];
  const reports = [];
  for (const fixture of fixtures) {
    // A search deadline can leave a model request finishing in the serial
    // service. Drain it before the next position's timer begins.
    await runtime.evaluate([warmup], generation);
    let firstTargetMs = null;
    const before = positionKey(fixture.position);
    const result = await analyze(fixture.position, { ...limits,
      evaluateBatch: async positions => (await runtime.evaluate(positions, generation)).values,
      scoreMoves: (position, moves) => runtime.orderMoves?.(position, moves, generation) ?? null,
      onProgress: result => { if (firstTargetMs === null && targetMet(fixture, result)) firstTargetMs = result.elapsedMs; },
    });
    let current = fixture.position;
    for (const action of result.pv) current = validateAction(current, action);
    if (result.bestAction) validateAction(fixture.position, result.bestAction);
    if (positionKey(fixture.position) !== before) throw new Error('Search mutated ' + fixture.id);
    // Independently verify final mate/terminal claims outside the search timer.
    const assessment = fixture.expected ? assessTactic({ ...fixture, expected: {
      ...fixture.expected, minDepth: undefined, minQuiescenceDepth: undefined,
    } }, result, before) : null;
    if (assessment && !assessment.valid) throw new Error(fixture.id + ': ' + assessment.errors.join('; '));
    const met = assessment?.solved ?? null;
    if (met && firstTargetMs === null) firstTargetMs = result.elapsedMs;
    reports.push({ id: fixture.id, targetMet: met, firstTargetMs, verifiedMate: assessment?.verifiedMate ?? false,
      depth: result.depth, pvDepth: result.pv.length, evaluatedRoots: result.rootActionsSearched,
      nodes: result.nodes, evaluations: result.evaluations, inferenceBatches: result.inferenceBatches,
      wideningSteps: result.wideningSteps, valueCacheHits: result.valueCacheHits,
      elapsedMs: result.elapsedMs, stoppedReason: result.stoppedReason, timings: result.timings,
      bestAction: result.bestAction, mateProven: result.mateProven,
    });
  }
  const report = { description: 'Fixed tactical development diagnostics at equal time/work limits; not Elo or an independent strength estimate. Targets omit classical depth/quiescence assertions. Final mate/terminal claims are independently checked. firstTargetMs is first observed target selection, not proof of refutation.',
    limits, model, checkpointSha256: createHash('sha256').update(await readFile(checkpoint)).digest('hex'),
    searchModule: args['search-module'] || 'src/transformer-search.js',
    tacticalTargetsMet: reports.filter(row => row.targetMet).length,
    tacticalTargets: reports.filter(row => row.targetMet !== null).length, reports };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (args.output) { await mkdir(dirname(resolve(args.output)), { recursive: true }); await writeFile(args.output, text); }
  console.log(text);
} finally { runtime.close(); }
