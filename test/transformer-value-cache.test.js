import test from 'node:test';
import assert from 'node:assert/strict';
import { createPosition, positionKey } from '../src/rules.js';
import { createValueCache } from '../src/transformer-value-cache.js';

test('neural cache reuses exact histories across objects and isolates model-visible action numbers', () => {
  const cache = createValueCache(positionKey), position = createPosition();
  cache.set(position, 123);
  assert.equal(cache.get(structuredClone(position)), 123);
  assert.equal(cache.hits, 1);
  assert.equal(cache.get({ ...position, action: position.action + 2 }), undefined);
  const changed = structuredClone(position);
  changed.board[0][0][1][0] = 0;
  assert.equal(cache.get(changed), undefined);
  assert.equal(createValueCache(positionKey).get(position), undefined, 'another model/search owns a separate cache');
});

test('history cache obeys entry and byte bounds while preserving object-local evaluations', () => {
  const position = createPosition(), other = { ...position, action: 2 };
  const cache = createValueCache(positionKey, { maxEntries: 1, maxBytes: 100000 });
  cache.set(position, 1); cache.set(other, 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get(structuredClone(position)), undefined);
  assert.equal(cache.get(position), 1);
  const small = createValueCache(positionKey, { maxBytes: 8 });
  small.set(position, 3);
  assert.equal(small.size, 0);
  assert.equal(small.bytes, 0);
  assert.equal(small.get(position), 3);
});
