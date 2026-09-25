import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { TransformerRuntime, forwardInference } from '../src/transformer-runtime.js';

async function fixture(t, runtime) {
  const server = createApp({ transformerRuntime: runtime });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const wait = async id => {
    for (let i = 0; i < 300; i++) {
      const { data } = await request(`/api/analysis/${id}`);
      if (data.status !== 'running') return data;
      await delay(10);
    }
    throw new Error('Analysis did not finish.');
  };
  return { request, wait };
}

function mockRuntime() {
  return {
    requests: 0, closed: false,
    describe() { return { id: 'transformer', available: true, status: 'ready' }; },
    async start() { return { device: 'test', model: { device: 'test', trainedSteps: 1 } }; },
    async evaluate(positions) {
      this.requests++;
      return { id: this.requests + 100, values: positions.map((_, i) => i * 10), context: positions.map(() => ({ truncated: true })) };
    },
    close() { this.closed = true; },
  };
}

test('engine catalog is lazy; missing model fails explicitly and classical remains usable', async t => {
  const runtime = new TransformerRuntime({ checkpoint: 'artifacts/nonexistent-test-model.pt' });
  const { request, wait } = await fixture(t, runtime);
  const catalog = (await request('/api/engines')).data;
  assert.equal(catalog.engines[0].id, 'classical');
  assert.equal(catalog.engines[1].available, false);
  assert.equal(runtime.child, undefined);
  assert.equal((await request('/api/analyze', { engine: 'bogus' })).status, 400);
  const missing = await request('/api/analyze', { engine: 'transformer' });
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /checkpoint/);
  const created = await request('/api/analyze', { engine: 'classical', timeMs: 200, maxDepth: 1 });
  assert.equal(created.status, 202);
  assert.equal((await wait(created.data.jobId)).result.engine, 'classical');
});

test('transformer routes batched evaluation through server, supports repeated workers and Play best', async t => {
  const runtime = mockRuntime();
  const { request, wait } = await fixture(t, runtime);
  for (let i = 0; i < 2; i++) {
    const game = (await request('/api/game')).data;
    const created = await request('/api/analyze', { engine: 'transformer', timeMs: 1000, maxDepth: 1 });
    assert.equal(created.status, 202, created.data.error);
    const job = await wait(created.data.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.engine, 'transformer');
    assert.equal(job.result.contextTruncated, true);
    assert.equal(job.result.model.device, 'test');
    assert.ok(job.result.bestAction.length);
    assert.equal(job.result.progressIntervalMs, 100);
    assert.equal(job.result.rankings[0].entries.length, 10);
    assert.equal(job.result.rankings[0].entries[0].evaluationType, 'true');
    assert.equal(job.result.rankings[0].entries[0].notation, job.result.notation);
    const played = await request('/api/play', { jobId: created.data.jobId, revision: game.revision });
    assert.equal(played.status, 200, played.data.error);
  }
  assert.ok(runtime.requests >= 2);
});

test('inference error is surfaced, never converted into a classical result', async t => {
  const runtime = mockRuntime();
  runtime.evaluate = async () => { throw new Error('CUDA test failure'); };
  const { request, wait } = await fixture(t, runtime);
  const created = await request('/api/analyze', { engine: 'transformer', timeMs: 1000 });
  const job = await wait(created.data.jobId);
  assert.equal(job.status, 'error');
  assert.match(job.error, /CUDA test failure/);
  assert.equal(job.result, undefined);
});

test('transformer accepts dynamic and deeper depth while classical retains its depth range', async t => {
  const { request, wait } = await fixture(t, mockRuntime());
  for (const body of [
    { engine: 'transformer', maxDepth: 65 },
    { engine: 'transformer', maxDepth: -1 },
    { engine: 'classical', maxDepth: 0 },
    { engine: 'classical', maxDepth: -1 },
    { engine: 'classical', maxDepth: 17 },
  ]) assert.equal((await request('/api/analyze', body)).status, 400, JSON.stringify(body));
  const created = await request('/api/analyze', { engine: 'transformer', timeMs: 1000, maxNodes: 1, maxDepth: 64 });
  assert.equal(created.status, 202, created.data.error);
  const job = await wait(created.data.jobId);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.limits.maxDepth, 64);
  const dynamic = await request('/api/analyze', { engine: 'transformer', timeMs: 1000, maxNodes: 1, maxDepth: 0 });
  assert.equal(dynamic.status, 202, dynamic.data.error);
  const dynamicJob = await wait(dynamic.data.jobId);
  assert.equal(dynamicJob.status, 'done', dynamicJob.error);
  assert.equal(dynamicJob.result.limits.maxDepth, 0);
  assert.equal(dynamicJob.result.depthMode, 'dynamic');
  assert.equal(dynamicJob.result.currentMaxDepth, 1);
  assert.equal(dynamicJob.result.dynamicDepthThreshold, 20);
});

test('model loading cannot attach a search to a position that changed while loading', async t => {
  const runtime = mockRuntime();
  let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  runtime.start = () => new Promise(resolve => { finish = resolve; started(); });
  const { request } = await fixture(t, runtime);
  const analysis = request('/api/analyze', { engine: 'transformer' });
  await waiting;
  await request('/api/new', {});
  finish({ model: {} });
  assert.equal((await analysis).status, 409);
});

test('inference bridge preserves worker request IDs across the shared process', async () => {
  let message;
  await forwardInference({ postMessage: value => { message = value; } }, mockRuntime(), { type: 'evaluate', id: 7, positions: [{}] });
  assert.equal(message.id, 7);
  assert.deepEqual(message.values, [0]);
});
