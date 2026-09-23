#!/usr/bin/env node
// Optional integration check requiring the local Python environment and checkpoint.
// Uses an isolated game/server and closes its owned GPU process when finished.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { validateAction } from '../src/rules.js';

const server = createApp();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, body) {
  const response = await fetch(base + route, { ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), signal: AbortSignal.timeout(70000) });
  const result = await response.json();
  assert.ok(response.ok, result.error);
  return result;
}
async function finished(id) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = await request(`/api/analysis/${id}`);
    if (job.status !== 'running') return job;
    await delay(25);
  }
  throw new Error('Transformer job did not finish.');
}
try {
  const reports = [];
  for (const variant of ['standard', 'two_timelines']) {
    const before = await request('/api/new', { variant });
    const created = await request('/api/analyze', { engine: 'transformer', timeMs: 5000, maxDepth: 1, maxNodes: 100000 });
    const job = await finished(created.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.engine, 'transformer');
    assert.equal(job.result.completed, true);
    assert.ok(job.result.evaluations > 0);
    assert.ok(Number.isFinite(job.result.score));
    let position = before.position;
    for (const action of job.result.pv) position = validateAction(position, action);
    assert.deepEqual((await request('/api/game')).position, before.position);
    const played = await request('/api/play', { jobId: created.jobId, revision: before.revision });
    assert.equal(played.position.action, before.position.action + 1);
    reports.push({ variant, device: job.result.model.device, trainedSteps: job.result.model.trainedSteps,
      depth: job.result.depth, evaluations: job.result.evaluations, elapsedMs: job.result.elapsedMs,
      contextTruncated: job.result.contextTruncated, notation: job.result.notation });
  }
  const created = await request('/api/analyze', { engine: 'transformer', timeMs: 60000, maxDepth: 16 });
  await request(`/api/analysis/${created.jobId}/stop`, {});
  const stopped = await finished(created.jobId);
  assert.equal(stopped.status, 'done', stopped.error);
  assert.equal(stopped.result.stoppedReason, 'cancelled');
  console.log(JSON.stringify({ passed: true, reports, cancellation: 'passed' }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
