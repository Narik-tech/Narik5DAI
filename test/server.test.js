import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';

async function fixture(t) {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  return { base, request };
}

test('HTTP game flow supports legal moves, stale revision rejection and undo', async t => {
  const { request } = await fixture(t);
  const initial = (await request('/api/game')).data;
  assert.equal(initial.moves.length, 20);
  const move = initial.moves.find(m => m.raw[0][2] === 1 && m.raw[0][3] === 4 && m.raw[1][2] === 3);
  const played = await request('/api/move', { move: move.raw, revision: initial.revision });
  assert.equal(played.status, 200);
  assert.equal(played.data.canSubmit, true);
  const stale = await request('/api/submit', { revision: initial.revision });
  assert.equal(stale.status, 409);
  const submitted = await request('/api/submit', { revision: played.data.revision });
  assert.equal(submitted.data.position.action, 1);
  const undone = await request('/api/undo', {});
  assert.deepEqual(undone.data.position.board, initial.position.board);
});

test('analysis runs separately, produces a legal action, and can be played', async t => {
  const { request } = await fixture(t);
  const initial = (await request('/api/game')).data;
  const created = await request('/api/analyze', { timeMs: 150, maxDepth: 2, quiescenceDepth: 0 });
  assert.equal(created.status, 202);
  assert.equal((await request('/api/game')).status, 200);
  let job;
  const deadline = Date.now() + 8000;
  do {
    await delay(20);
    job = (await request(`/api/analysis/${created.data.jobId}`)).data;
  } while (job.status === 'running' && Date.now() < deadline);
  assert.equal(job.status, 'done', job.error);
  assert.ok(Array.isArray(job.result.bestAction));
  const played = await request('/api/play', { jobId: created.data.jobId, revision: initial.revision });
  assert.equal(played.status, 200, played.data.error);
  assert.equal(played.data.position.action, 1);
});

test('local server rejects foreign origins and invalid analysis budgets', async t => {
  const { base, request } = await fixture(t);
  const denied = await fetch(base + '/api/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}',
  });
  assert.equal(denied.status, 403);
  assert.equal((await request('/api/analyze', { timeMs: -1 })).status, 400);
  assert.equal((await request('/api/new', { variant: 'does-not-exist' })).status, 400);
});
