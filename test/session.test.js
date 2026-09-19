import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../src/session.js';
import { positionKey, createPosition } from '../src/rules.js';

test('move, submit, export/import and undo preserve the exact historical position', () => {
  const game = new GameSession();
  const initial = positionKey(game.position);
  game.move('e4');
  assert.equal(game.position.action, 0);
  assert.equal(game.snapshot().canSubmit, true);
  game.submit();
  assert.equal(game.position.action, 1);
  game.move('e5');
  game.submit();
  const imported = createPosition({ pgn: game.chess.export() });
  assert.equal(positionKey(imported), positionKey(game.position));
  game.undo();
  assert.equal(game.position.action, 1);
  game.undo();
  assert.equal(positionKey(game.position), initial);
});

test('a bad move/action and stale analysis cannot mutate the live game', () => {
  const game = new GameSession();
  const before = positionKey(game.position);
  assert.throws(() => game.move('e5'));
  assert.throws(() => game.play([[[0, 0, 0, 0], [0, 0, 4, 4]]]));
  assert.throws(() => game.assertRevision(game.revision - 1), /changed/);
  assert.equal(positionKey(game.position), before);
});

test('pending moves are undone individually and invalid imports are transactional', () => {
  const game = new GameSession();
  const before = positionKey(game.position);
  game.move('Nf3');
  game.undo();
  assert.equal(positionKey(game.position), before);
  assert.throws(() => game.reset({ pgn: '[Board "Standard"]\n1. e5' }));
  assert.equal(positionKey(game.position), before);
});
