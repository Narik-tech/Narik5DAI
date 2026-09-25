import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, MATE_SCORE } from '../src/transformer-search.js';
import { createPosition, formatAction, generateActions, positionKey, validateAction } from '../src/rules.js';

const limits = { timeMs: 10000, maxNodes: 100000, maxDepth: 3, candidateLimit: 12, innerCandidateLimit: 3 };
const zero = async positions => positions.map(() => 0);

test('rank snapshots expose ten entries per depth with stable IDs and legal contextual lines for either color', async () => {
  for (const position of [createPosition(), createPosition({ pgn: '1. e4' })]) {
    const result = await analyze(position, { ...limits, evaluateBatch: zero });
    assert.equal(result.progressIntervalMs, 100);
    assert.equal(result.rankings.length, 3);
    const ids = new Set();
    for (const level of result.rankings) {
      assert.equal(level.entries.length, 10);
      assert(level.total >= level.entries.length);
      assert.equal(level.side, (position.action + level.depth - 1) % 2 ? 'black' : 'white');
      for (const [index, entry] of level.entries.entries()) {
        assert.equal(entry.rank, index + 1);
        assert(!ids.has(entry.id)); ids.add(entry.id);
        assert.equal(entry.evaluationType, 'true');
        assert.equal(entry.score, 0);
        assert.equal(entry.scoreType, 'cp');
        assert.equal(entry.mateIn, null);
        assert.equal(entry.line[level.depth - 1], entry.notation);
        let current = position;
        for (const move of entry.line) current = validateAction(current, [move]);
        assert.equal('position' in entry, false, 'snapshots must not serialize the search tree');
      }
    }
    assert.equal(result.rankings[0].entries[0].notation, formatAction(position, result.bestAction));
    assert.equal(new Set(result.rankings[1].entries.map(entry => entry.line[0])).size > 1, true,
      'reply rankings must distinguish paths from different root moves');
    assert.doesNotThrow(() => JSON.stringify(result.rankings));
  }
});

test('live rank snapshots show a Candidate overtaking the former True leader after a reply changes its score', async () => {
  const position = createPosition();
  const favorite = generateActions(position).next().value;
  const wanted = positionKey(favorite.position);
  const replies = new Set([...generateActions(favorite.position)].map(candidate => positionKey(candidate.position)));
  const reports = [];
  let stop = false;
  const result = await analyze(position, { ...limits, candidateLimit: 4,
    shouldStop: () => stop,
    evaluateBatch: async positions => positions.map(pos => positionKey(pos) === wanted ? 1000
      : replies.has(positionKey(pos)) ? -400 : 500),
    onProgress: report => { reports.push(report); if (report.depth === 2) stop = true; },
  });
  const first = reports.find(report => report.depth === 1).rankings[0];
  const next = reports.find(report => report.depth === 2).rankings[0];
  assert.equal(first.entries[0].evaluationType, 'true');
  assert.equal(first.entries[0].score, 1000);
  assert.equal(next.entries[0].evaluationType, 'candidate');
  assert.equal(next.entries[0].score, 500);
  assert.notEqual(next.entries[0].id, first.entries[0].id);
  assert.equal(next.entries.find(entry => entry.id === first.entries[0].id).score, -400);
  assert.equal(first.entries[0].score, 1000, 'previous snapshots must remain immutable');
  assert.deepEqual(result.bestAction, favorite.moves, 'a live heuristic leader must not replace the playable True result');
});

test('progress continues at the 100ms cadence while the next inference batch is pending', async t => {
  let now = 0, batches = 0, stop = false;
  t.mock.method(performance, 'now', () => now);
  const reports = [];
  const result = await analyze(createPosition(), { ...limits, candidateLimit: 4,
    shouldStop: () => stop,
    evaluateBatch: positions => {
      if (++batches === 1) return Promise.resolve(positions.map(() => 0));
      now = 100;
      return new Promise(() => {});
    },
    onProgress: report => {
      reports.push(report);
      if (report.elapsedMs === 100) stop = true;
    },
  });
  assert.equal(batches, 2);
  assert.deepEqual(reports.map(report => report.elapsedMs), [0, 100]);
  assert.equal(reports[1].rankings[0].entries[0].evaluationType, 'true');
  assert.equal(result.stoppedReason, 'cancelled');
  assert.equal(result.depth, 1);
});

test('rank entries display mate only for a certified True evaluation', async () => {
  const position = createPosition({ pgn: '[Board "Custom"]\n[Size "4x4"]\n[1q1k/4/4/K3:0:1:w]\n[1q1k/4/4/K3:0:1:b]\n[3k/4/1N2/K3:0:2:w]' });
  const result = await analyze(position, { ...limits, maxDepth: 1, candidateLimit: 64, evaluateBatch: zero });
  const first = result.rankings[0].entries[0];
  assert.equal(first.evaluationType, 'true');
  assert.equal(first.score, MATE_SCORE - 1);
  assert.equal(first.scoreType, 'mate');
  assert.equal(first.mateIn, 1);
  for (const entry of result.rankings[0].entries.filter(entry => entry.evaluationType === 'candidate')) {
    assert.equal(entry.scoreType, 'cp');
    assert.equal(entry.mateIn, null);
  }
});
