import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createInferenceQueue } from '../scripts/transformer-selfplay-inference.js';

function controlledRuntime() {
  const requests = [];
  let active = 0, peak = 0;
  const runtime = {
    evaluate(positions) {
      active++;
      peak = Math.max(peak, active);
      return new Promise((resolve, reject) => {
        requests.push({ positions, resolve, reject });
      }).finally(() => { active--; });
    },
  };
  return { queue: createInferenceQueue(runtime), requests, get active() { return active; }, get peak() { return peak; } };
}

function submit(queue, id, controller = new AbortController()) {
  return { controller, promise: queue.evaluate([{ id }], { signal: controller.signal }) };
}

test('policy ordering shares the value queue and cancelled policy requests never dispatch', async () => {
  const requests = [];
  const run = (kind, input) => new Promise((resolve, reject) => requests.push({kind, input, resolve, reject}));
  const queue = createInferenceQueue({evaluate: positions => run('value', positions),
    orderMoves: (position, moves) => run('policy', {position, moves})});
  const signal = new AbortController().signal, cancelled = new AbortController();
  const value = queue.evaluate([{id:1}], {signal});
  const policy = queue.orderMoves({id:2}, ['a', 'b'], {signal});
  const dropped = assert.rejects(queue.orderMoves({id:3}, ['c'], {signal:cancelled.signal}), {name:'AbortError'});
  cancelled.abort();
  await dropped;
  assert.deepEqual(requests.map(request => request.kind), ['value']);
  requests[0].resolve({values:[42]});
  await value;
  assert.deepEqual(requests.map(request => request.kind), ['value', 'policy']);
  assert.deepEqual(requests[1].input, {position:{id:2}, moves:['a', 'b']});
  requests[1].resolve([-1, 2]);
  assert.deepEqual(await policy, [-1, 2]);
  await nextTurn();
  assert.equal(requests.length, 2);
});

test('self-play inference dispatches one runtime request at a time in arrival order', async () => {
  const fixture = controlledRuntime();
  const first = submit(fixture.queue, 1), second = submit(fixture.queue, 2), third = submit(fixture.queue, 3);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0].positions, [{ id: 1 }]);
  fixture.requests[0].resolve({ values: [10] });
  assert.deepEqual(await first.promise, { values: [10] });
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].positions, [{ id: 2 }]);
  fixture.requests[1].resolve({ values: [20] });
  assert.deepEqual(await second.promise, { values: [20] });
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(fixture.requests[2].positions, [{ id: 3 }]);
  fixture.requests[2].resolve({ values: [30] });
  assert.deepEqual(await third.promise, { values: [30] });
  assert.equal(fixture.active, 0);
  assert.equal(fixture.peak, 1);
});

test('queued cancellations settle before active inference finishes and are never dispatched', async () => {
  const fixture = controlledRuntime();
  const first = submit(fixture.queue, 1), cancelled = submit(fixture.queue, 2), last = submit(fixture.queue, 3);
  const rejected = assert.rejects(cancelled.promise, { name: 'AbortError' });
  cancelled.controller.abort();
  await rejected;
  assert.equal(fixture.active, 1);
  assert.equal(fixture.requests.length, 1);
  fixture.requests[0].resolve({ values: [10] });
  await first.promise;
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].positions, [{ id: 3 }]);
  fixture.requests[1].resolve({ values: [30] });
  assert.deepEqual(await last.promise, { values: [30] });
  assert.equal(fixture.peak, 1);
});

test('cancelling active inference retains its runtime slot until the underlying request settles', async () => {
  const fixture = controlledRuntime();
  const first = submit(fixture.queue, 1), second = submit(fixture.queue, 2);
  const rejected = assert.rejects(first.promise, { name: 'AbortError' });
  first.controller.abort();
  await rejected;
  await nextTurn();
  assert.equal(fixture.active, 1);
  assert.equal(fixture.requests.length, 1, 'Cancellation cannot start concurrent Python inference.');
  fixture.requests[0].resolve({ values: [10] });
  await nextTurn();
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].positions, [{ id: 2 }]);
  fixture.requests[1].resolve({ values: [20] });
  assert.deepEqual(await second.promise, { values: [20] });
  assert.equal(fixture.active, 0);
  assert.equal(fixture.peak, 1);
});

test('runtime errors and late failures after cancellation do not strand the queue or reject unhandled', async () => {
  const fixture = controlledRuntime();
  const first = submit(fixture.queue, 1), abandoned = submit(fixture.queue, 2), last = submit(fixture.queue, 3);
  const firstFailure = new Error('Inference failed');
  const rejectedFirst = assert.rejects(first.promise, error => error === firstFailure);
  fixture.requests[0].reject(firstFailure);
  await rejectedFirst;
  assert.equal(fixture.requests.length, 2);
  const rejectedAbandoned = assert.rejects(abandoned.promise, { name: 'AbortError' });
  abandoned.controller.abort();
  await rejectedAbandoned;
  fixture.requests[1].reject(new Error('Late failure after worker disposal'));
  await nextTurn();
  assert.equal(fixture.requests.length, 3);
  fixture.requests[2].resolve({ values: [30] });
  assert.deepEqual(await last.promise, { values: [30] });
  // node:test reports any unhandled rejection; let the event loop expose late ones.
  await nextTurn();
  assert.equal(fixture.active, 0);
  assert.equal(fixture.peak, 1);
});

test('an already-aborted search never enters the inference queue', async () => {
  const fixture = controlledRuntime(), controller = new AbortController();
  controller.abort();
  await assert.rejects(submit(fixture.queue, 1, controller).promise, { name: 'AbortError' });
  assert.equal(fixture.requests.length, 0);
  const next = submit(fixture.queue, 2);
  fixture.requests[0].resolve({ values: [20] });
  assert.deepEqual(await next.promise, { values: [20] });
});
