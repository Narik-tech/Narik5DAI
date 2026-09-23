import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TransformerRuntime, forwardInference } from '../src/transformer-runtime.js';
import { createApp } from '../src/server.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vibe-transformer-runtime-'));
  const checkpoint = path.join(directory, 'model.pt');
  await writeFile(checkpoint, 'test checkpoint');
  const children = [];
  const runtime = new TransformerRuntime({
    python:process.execPath, checkpoint, startupMs:1000, requestMs:1000, ...options,
    spawnProcess() {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on('data', data => child.emit('request', JSON.parse(data.toString())));
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit('exit', 0)); };
      child.respond = message => child.stdout.write(`${JSON.stringify(message)}\n`);
      children.push(child);
      return child;
    },
  });
  t.after(async () => { runtime.close(); await rm(directory, {recursive:true, force:true}); });
  async function ready() {
    const starting = runtime.start();
    children.at(-1).respond({ready:true, device:'cpu', model:{trainedSteps:1}});
    await starting;
    return children.at(-1);
  }
  return {runtime, children, checkpoint, ready};
}

test('closing during shared startup rejects every caller and kills its process', async t => {
  const {runtime, children} = await fixture(t);
  const first = assert.rejects(runtime.start(), /stopped/);
  const second = assert.rejects(runtime.start(), /stopped/);
  assert.equal(children.length, 1);
  runtime.close();
  await Promise.all([first, second]);
  assert.equal(children[0].killed, true);
  assert.equal(runtime.starting, null);
  assert.equal(runtime.state, 'closed');
  await assert.rejects(runtime.start(), /closed/);
});

test('malformed protocol objects and ready messages fail without uncaught callbacks', async t => {
  for (const message of [null, [], {ready:'yes'}, {ready:true, device:'cpu', model:[]}, {id:1, values:[0]}]) {
    const {runtime, children} = await fixture(t);
    const failure = assert.rejects(runtime.start(), /invalid/);
    children[0].respond(message);
    await failure;
    assert.equal(runtime.state, 'error');
    assert.equal(children[0].killed, true);
  }
});

test('closing between ready and evaluate continuation leaves no pending requests', async t => {
  const {runtime, ready} = await fixture(t);
  await ready();
  const evaluation = assert.rejects(runtime.evaluate([{}]), /stopped/);
  runtime.close();
  await evaluation;
  assert.equal(runtime.pending.size, 0);
});

test('invalid evaluation shape stops the process and rejects every pending request', async t => {
  const {runtime, ready} = await fixture(t);
  const child = await ready();
  const next = once(child, 'request');
  const evaluation = assert.rejects(runtime.evaluate([{}]), /invalid evaluations/);
  const [request] = await next;
  child.respond({id:request.id, values:[1], context:{truncated:true}});
  await evaluation;
  assert.equal(runtime.pending.size, 0);
  assert.equal(child.killed, true);
});

test('checkpoint reload rejects old requests and ignores old ready/exit messages', async t => {
  const {runtime, children, checkpoint, ready} = await fixture(t);
  const old = await ready();
  const next = once(old, 'request');
  const oldEvaluation = assert.rejects(runtime.evaluate([{}]), /Checkpoint changed/);
  await next;
  const changed = new Date(Date.now() + 10000);
  await utimes(checkpoint, changed, changed);
  const starting = runtime.start();
  await oldEvaluation;
  assert.equal(children.length, 2);
  assert.equal(old.killed, true);
  old.respond({ready:true, device:'stale', model:{trainedSteps:1}});
  children[1].respond({ready:true, device:'cpu', model:{trainedSteps:2}});
  await starting;
  old.emit('exit', 1);
  assert.equal(runtime.info.device, 'cpu');
  assert.equal(runtime.info.model.trainedSteps, 2);
  const nextRequest = once(children[1], 'request');
  const evaluated = runtime.evaluate([{}]);
  const [request] = await nextRequest;
  children[1].respond({id:request.id, values:[42]});
  assert.deepEqual((await evaluated).values, [42]);
});

test('inference timeout clears pending requests and allows a fresh process', async t => {
  const {runtime, children, ready} = await fixture(t, {requestMs:20});
  await ready();
  await assert.rejects(runtime.evaluate([{}]), /timed out/);
  assert.equal(runtime.pending.size, 0);
  assert.equal(children[0].killed, true);
  await ready();
  assert.equal(children.length, 2);
  assert.equal(runtime.state, 'ready');
});

test('server close interrupts an HTTP request waiting for model startup', async t => {
  const {runtime} = await fixture(t);
  let didStart;
  const started = new Promise(resolve => { didStart = resolve; });
  const start = runtime.start.bind(runtime);
  runtime.start = () => { const promise = start(); didStart(); return promise; };
  const server = createApp({transformerRuntime:runtime});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({engine:'transformer'}),
  });
  await started;
  const closed = new Promise(resolve => server.close(resolve));
  const response = await request;
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /stopped/);
  await closed;
  assert.equal(runtime.closed, true);
});

test('inference completion after worker disposal does not create an unhandled rejection', async () => {
  await forwardInference({postMessage() { throw new Error('disposed'); }}, {evaluate:async () => ({values:[0]})}, {type:'evaluate', id:1, positions:[{}]});
});
