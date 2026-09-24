import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { analyze } from '../src/parallel-search.js';
import { createPosition, formatAction, validateAction } from '../src/rules.js';

const HELP = `Compare classical search with 1, 2, and 4 CPU threads.

Usage: npm run benchmark:parallel -- [options]
  --time-ms N       Time budget per run (default: BENCH_TIME_MS or 1000)
  --repeat N        Repetitions per configuration (default: BENCH_REPEAT or 1)
  --threads LIST    Comma-separated counts (default: BENCH_THREADS or 1,2,4)
  --depth N         Override the fixed-depth targets
  --mode NAME       both (default), depth, or time
  --case NAME       standard, locked-king, or two-timelines (default: all)
  --json            Print machine-readable results
  --help            Show this message

Default targets: standard depth 4 / qdepth 2; locked king depth 3 / qdepth 2;
two timelines depth 2 / qdepth 1. The time mode searches up to depth 64.
Both modes respect the time budget. Fixed-depth speedups require reaching the
target depth with a depth-limit stop. Wall time includes starting and closing
workers; threadsUsed reports whether the parallel workers were actually started.
`;

function integer(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function settings(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--help' || key === '--json') parsed[key.slice(2)] = true;
    else if (['--time-ms', '--repeat', '--threads', '--depth', '--mode', '--case'].includes(key)
      && args[index + 1] !== undefined && !args[index + 1].startsWith('--')) parsed[key.slice(2)] = args[++index];
    else throw new Error(`Unknown option or missing value: ${key}`);
  }
  if (parsed.help) return { help: true };
  const threads = [...new Set(String(parsed.threads ?? process.env.BENCH_THREADS ?? '1,2,4').split(',')
    .map(value => integer(value.trim(), 1, 16, 'Threads')))];
  if (parsed.mode && !['both', 'depth', 'time'].includes(parsed.mode)) throw new Error('--mode must be both, depth, or time.');
  if (parsed.case && !['standard', 'locked-king', 'two-timelines'].includes(parsed.case)) throw new Error('Unknown benchmark case.');
  return {
    timeMs: integer(parsed['time-ms'] ?? process.env.BENCH_TIME_MS ?? 1000, 1, 3600000, 'Time budget'),
    repeat: integer(parsed.repeat ?? process.env.BENCH_REPEAT ?? 1, 1, 100, 'Repetitions'),
    threads: threads.sort((left, right) => left - right),
    depth: parsed.depth === undefined ? null : integer(parsed.depth, 1, 64, 'Depth'),
    modes: !parsed.mode || parsed.mode === 'both' ? ['depth', 'time'] : [parsed.mode],
    case: parsed.case ?? null,
    json: parsed.json === true,
  };
}

async function main() {
  const options = settings(process.argv.slice(2));
  if (options.help) { console.log(HELP); return; }
  const cases = [
    { name: 'standard', setup: { variant: 'standard' }, depth: 4, quiescenceDepth: 2 },
    { name: 'locked-king', setup: { pgn: await readFile(new URL('../examples/locked-king.5dpgn', import.meta.url), 'utf8') }, depth: 3, quiescenceDepth: 2 },
    { name: 'two-timelines', setup: { variant: 'two_timelines' }, depth: 2, quiescenceDepth: 1 },
  ].filter(item => !options.case || item.name === options.case);
  const rows = [];
  for (const fixture of cases) {
    const position = createPosition(fixture.setup), original = structuredClone(position);
    for (const mode of options.modes) {
      for (let repeat = 1; repeat <= options.repeat; repeat++) {
        // Rotate execution order between repeats to reduce warm-up/order bias.
        const offset = (repeat - 1) % options.threads.length;
        const threadOrder = [...options.threads.slice(offset), ...options.threads.slice(0, offset)];
        for (const threads of threadOrder) {
          const maxDepth = mode === 'depth' ? options.depth ?? fixture.depth : 64;
          const start = performance.now();
          const result = await analyze(position, {
            threads, timeMs: options.timeMs, maxDepth,
            quiescenceDepth: fixture.quiescenceDepth, maxNodes: 2000000, cacheMemoryMb: 128,
          });
          const wallMs = performance.now() - start;
          assert.deepEqual(position, original, `${fixture.name}: search modified the input position`);
          if (result.bestAction) validateAction(position, result.bestAction);
          let current = position;
          for (const action of result.pv ?? []) current = validateAction(current, action);
          assert.deepEqual(position, original, `${fixture.name}: PV validation modified the input position`);
          const targetReached = mode === 'depth' && result.stoppedReason === 'depth' && result.depth === maxDepth;
          rows.push({
            case: fixture.name, mode, repeat, threads, threadsUsed: result.threadsUsed ?? 1, targetDepth: maxDepth,
            depth: result.depth, quiescenceDepth: result.effectiveQuiescenceDepth ?? fixture.quiescenceDepth,
            completed: result.completed, targetReached: mode === 'depth' ? targetReached : null,
            score: result.score, scoreType: result.scoreType,
            nodes: result.nodes, searchMs: result.elapsedMs, wallMs,
            stoppedReason: result.stoppedReason ?? null, status: result.status,
            turn: result.bestAction ? formatAction(position, result.bestAction) : null,
          });
          if (!options.json) console.error(`${fixture.name} ${mode}, run ${repeat}, ${threads} requested / ${result.threadsUsed ?? 1} used thread(s): depth ${result.depth}, ${Math.round(wallMs)} ms${mode === 'depth' && !targetReached ? ' (target not reached)' : ''}`);
        }
      }
    }
  }
  for (const row of rows) {
    const baseline = rows.find(item => item.case === row.case && item.mode === row.mode && item.repeat === row.repeat && item.threads === 1);
    const comparable = Boolean(baseline?.completed && row.completed
      && baseline.depth === row.depth && baseline.quiescenceDepth === row.quiescenceDepth
      && (row.mode !== 'depth' || (baseline.targetReached && row.targetReached)));
    row.scoreMatchesOneThread = comparable ? row.score === baseline.score && row.scoreType === baseline.scoreType : null;
    row.speedup = comparable && row.mode === 'depth' ? baseline.wallMs / row.wallMs : null;
  }
  if (options.json) console.log(JSON.stringify({ options, results: rows }, null, 2));
  else {
    console.table(rows.map(row => ({
      case: row.case, mode: row.mode, run: row.repeat, threads: row.threads, used: row.threadsUsed,
      depth: row.depth, qdepth: row.quiescenceDepth, targetReached: row.targetReached ?? 'n/a',
      nodes: row.nodes, wallMs: Math.round(row.wallMs), searchMs: Math.round(row.searchMs),
      score: row.score, sameScore: row.scoreMatchesOneThread ?? 'n/a',
      speedup: row.speedup === null ? 'n/a' : `${row.speedup.toFixed(2)}x`, stop: row.stoppedReason,
    })));
    console.log('All returned turns and PVs passed legality checks; all input positions remained unchanged.');
    console.log('Wall time includes worker startup/cleanup. Compare fixed-time depths directly. Fixed-depth comparisons require both searches to reach their target with a depth-limit stop; score comparisons also require matching depth and quiescence horizon.');
  }
}

main().catch(error => { console.error(`Benchmark failed: ${error.message}`); process.exitCode = 1; });
