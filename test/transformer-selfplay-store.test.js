import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { atomicWrite, fileHash, acquireRunLock, updateReplay, promoteCheckpoint, MAX_REPLAY_LINE_BYTES } from '../scripts/transformer-selfplay-store.js';
import { positionKey } from '../src/rules.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vibe-selfplay-store-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  return name => join(directory, name);
}
const sample = (id, source = 'seed') => ({position:{action:0, board:[[[[id % 25, Math.floor(id / 25) % 25]]]], promotions:[]}, value:id, source});
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const recordsAt = async file => (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);

test('atomic writes replace complete text/binary files and incremental hash matches contents', async t => {
  const file = await fixture(t), active = file('nested/active.pt');
  await atomicWrite(active, 'first');
  const bytes = Buffer.from([0, 255, 128, 42]);
  await atomicWrite(active, bytes);
  assert.deepEqual(await readFile(active), bytes);
  assert.equal(await fileHash(active), createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readdir(file('nested')), ['active.pt']);
  await assert.rejects(atomicWrite(active, {invalid:true}), /text or a Buffer/);
  assert.deepEqual(await readFile(active), bytes);
});

test('failed atomic publication removes its temporary file and preserves destination', async t => {
  const file = await fixture(t);
  await mkdir(file('target'));
  await assert.rejects(atomicWrite(file('target'), 'data'));
  assert.deepEqual(await readdir(file('.')), ['target']);
});

test('run lock rejects a live owner, releases idempotently, and can then be reacquired', async t => {
  const file = await fixture(t);
  const release = await acquireRunLock(file('run'));
  await assert.rejects(acquireRunLock(file('run')), new RegExp(`already running under PID ${process.pid}`));
  await release(); await release();
  const releaseAgain = await acquireRunLock(file('run'));
  await releaseAgain();
});

test('stale/malformed locks explain manual recovery and release does not remove a replacement', async t => {
  const file = await fixture(t), lock = file('.selfplay.lock');
  await writeFile(lock, 'not JSON');
  await assert.rejects(acquireRunLock(file('.')), /Stale or malformed.*Verify no runner is active/);
  assert.equal(await readFile(lock, 'utf8'), 'not JSON');
  await rm(lock);
  const release = await acquireRunLock(file('.'));
  await writeFile(lock, JSON.stringify({pid:process.pid, token:'replacement'}));
  await assert.rejects(release(), /ownership changed/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'replacement');
});

test('large incoming batch retains half historical reservoir and half newest unique samples', async t => {
  const file = await fixture(t), seedData = file('seed.jsonl'), replayPath = file('replay.jsonl');
  await writeFile(seedData, jsonl(Array.from({length:100}, (_, i) => sample(i))));
  const newSamples = Array.from({length:400}, (_, i) => sample(i + 100, 'new'));
  const result = await updateReplay({replayPath, seedData, newSamples, maxSamples:10, seed:11});
  const stored = await recordsAt(replayPath);
  assert.equal(result.samples, 10);
  assert.deepEqual(result.sourceCounts, {seed:5, new:5});
  assert.deepEqual(stored.slice(-5).map(record => record.value), [495, 496, 497, 498, 499]);
  assert.equal(new Set(stored.map(record => positionKey(record.position))).size, 10);
  assert.equal(result.sha256, await fileHash(replayPath));
});

test('replay deduplicates latest labels/sources while retaining different sides and history', async t => {
  const file = await fixture(t), seedData = file('seed.jsonl'), replayPath = file('replay.jsonl');
  const white = sample(1), black = {...sample(1), position:{...sample(1).position, action:1}};
  const historyA = {...sample(2), position:{...sample(2).position, board:[[[[1, 0]], [[2, 0]]]]}};
  const historyB = {...sample(2), position:{...sample(2).position, board:[[[[3, 0]], [[2, 0]]]]}};
  await writeFile(seedData, jsonl([white, {...white, value:20, source:'old-update'}, black, historyA, historyB]));
  const updated = {...white, value:123, source:'new-update'};
  const result = await updateReplay({replayPath, seedData, newSamples:[updated, {...updated, value:456}], maxSamples:10});
  const stored = await recordsAt(replayPath);
  assert.equal(result.samples, 4);
  assert.deepEqual(result.sourceCounts, {seed:3, 'new-update':1});
  assert.equal(stored.find(record => positionKey(record.position) === positionKey(white.position)).value, 456);
  assert.equal(new Set(stored.map(record => positionKey(record.position))).size, 4);
});

test('new-only initialization fills capacity, supports async input, and cap one retains newest', async t => {
  const file = await fixture(t);
  async function* incoming() { for (let index = 0; index < 20; index++) yield sample(index, 'selfplay'); }
  const result = await updateReplay({replayPath:file('replay.jsonl'), newSamples:incoming(), maxSamples:7});
  assert.equal(result.samples, 7);
  assert.deepEqual((await recordsAt(file('replay.jsonl'))).map(record => record.value), [13, 14, 15, 16, 17, 18, 19]);
  await updateReplay({replayPath:file('single.jsonl'), newSamples:[sample(0), sample(1)], maxSamples:1});
  assert.equal((await recordsAt(file('single.jsonl')))[0].value, 1);
});

test('arena exclusions remove seeded and incoming samples while preserving the other side and source counts', async t => {
  const file = await fixture(t), seedData = file('seed.jsonl'), replayPath = file('replay.jsonl');
  const excluded = sample(1);
  const opposite = {...sample(1), position:{...sample(1).position, action:1}};
  await writeFile(seedData, jsonl([excluded, opposite, sample(2)]));
  const excludedKey = positionKey(excluded.position);
  const result = await updateReplay({replayPath, seedData, newSamples:[excluded, sample(3, 'selfplay')], maxSamples:10, excludePositionKeys:new Set([excludedKey])});
  const stored = await recordsAt(replayPath);
  assert.equal(result.excludedSamples, 2);
  assert.equal(result.samples, 3);
  assert.deepEqual(result.sourceCounts, {seed:2, selfplay:1});
  assert.equal(stored.some(record => positionKey(record.position) === excludedKey), false);
  assert.equal(stored.some(record => positionKey(record.position) === positionKey(opposite.position)), true);
  const original = await fileHash(replayPath);
  await assert.rejects(updateReplay({replayPath, excludePositionKeys:new Set(stored.map(record => positionKey(record.position)))}), /at least one valid sample after exclusions/);
  assert.equal(await fileHash(replayPath), original);
});

test('JSONL input streams CRLF, multibyte chunk boundaries, and final line without newline', async t => {
  const file = await fixture(t), incoming = file('incoming.jsonl');
  const first = {...sample(1), note:'é'.repeat(40000)};
  await writeFile(incoming, `\r\n${JSON.stringify(first)}\r\n${JSON.stringify(sample(2))}`);
  await updateReplay({replayPath:file('replay.jsonl'), newSamples:incoming, maxSamples:5});
  const stored = await recordsAt(file('replay.jsonl'));
  assert.equal(stored.length, 2);
  assert.equal(stored[0].note, first.note);
});

test('seeded historical reservoir is reproducible, bounded, and duplicate frequency adds no weight', async t => {
  const file = await fixture(t);
  const originals = Array.from({length:100}, (_, i) => sample(i));
  await writeFile(file('seed.jsonl'), jsonl(originals));
  await writeFile(file('duplicates.jsonl'), jsonl([...originals, ...originals, ...originals]));
  const one = await updateReplay({replayPath:file('one.jsonl'), seedData:file('seed.jsonl'), maxSamples:9, seed:42});
  const two = await updateReplay({replayPath:file('two.jsonl'), seedData:file('duplicates.jsonl'), maxSamples:9, seed:42});
  assert.equal(one.sha256, two.sha256);
  const different = await updateReplay({replayPath:file('three.jsonl'), seedData:file('seed.jsonl'), maxSamples:9, seed:43});
  assert.notEqual(one.sha256, different.sha256);
  await updateReplay({replayPath:file('one.jsonl'), seedData:file('missing-ignored.jsonl'), maxSamples:9, seed:42});
  assert.equal(await fileHash(file('one.jsonl')), one.sha256);
});

test('invalid/empty samples, missing seed, oversize lines, and path collisions preserve existing replay', async t => {
  const file = await fixture(t), replayPath = file('replay.jsonl');
  await atomicWrite(replayPath, jsonl([sample(1)]));
  const original = await fileHash(replayPath);
  for (const invalid of [{...sample(2), value:Infinity}, {...sample(2), position:{}}, {...sample(2), position:{action:0, board:[]}}, {...sample(2), position:{action:0, board:[[[[999]]]]}}]) {
    await assert.rejects(updateReplay({replayPath, newSamples:[invalid]}), /Invalid replay sample/);
    assert.equal(await fileHash(replayPath), original);
  }
  await assert.rejects(updateReplay({replayPath:file('empty.jsonl')}), /at least one valid/);
  await assert.rejects(updateReplay({replayPath:file('new.jsonl'), seedData:file('missing.jsonl')}), /Seed data file not found.*transformer:data/);
  await assert.rejects(updateReplay({replayPath, newSamples:replayPath}), /different files/);
  await writeFile(file('bad.jsonl'), '{broken JSON}\n');
  await assert.rejects(updateReplay({replayPath, newSamples:file('bad.jsonl')}), /Invalid replay JSON/);
  await writeFile(file('oversize.jsonl'), ' '.repeat(MAX_REPLAY_LINE_BYTES + 1));
  await assert.rejects(updateReplay({replayPath, newSamples:file('oversize.jsonl')}), /4 MiB limit/);
  assert.equal(await fileHash(replayPath), original);
});

test('promotion keeps complete prior checkpoint and installs candidate with expected hash', async t => {
  const file = await fixture(t), activePath = file('model.pt'), candidatePath = file('candidate.pt'), backupPath = file('backup/previous.pt');
  const original = Buffer.from([1, 2, 3]), candidate = Buffer.from([9, 8, 7, 0]);
  await writeFile(activePath, original); await writeFile(candidatePath, candidate);
  const expectedHash = await fileHash(activePath);
  const result = await promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath});
  assert.equal(result.previousHash, expectedHash);
  assert.equal(result.sha256, await fileHash(activePath));
  assert.deepEqual(await readFile(activePath), candidate);
  assert.deepEqual(await readFile(backupPath), original);
  assert.deepEqual(await readFile(candidatePath), candidate);
});

test('promotion refuses changed active hash, existing backup, and aliases without modifying files', async t => {
  const file = await fixture(t), activePath = file('model.pt'), candidatePath = file('candidate.pt'), backupPath = file('previous.pt');
  await writeFile(activePath, 'old'); await writeFile(candidatePath, 'new');
  const expectedHash = await fileHash(activePath);
  await writeFile(activePath, 'external edit');
  await assert.rejects(promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath}), /Active checkpoint changed/);
  assert.equal(await readFile(activePath, 'utf8'), 'external edit');
  await writeFile(activePath, 'old'); await writeFile(backupPath, 'preserve me');
  await assert.rejects(promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath}), /Backup already exists/);
  assert.equal(await readFile(backupPath, 'utf8'), 'preserve me');
  await assert.rejects(promoteCheckpoint({candidatePath:activePath, activePath, expectedHash, backupPath}), /different files/);
  await assert.rejects(promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath:activePath}), /different files/);
  await link(activePath, file('alias.pt'));
  await assert.rejects(promoteCheckpoint({candidatePath:file('alias.pt'), activePath, expectedHash, backupPath}), /different files/);
  assert.equal(await fileHash(activePath), expectedHash);
  assert.deepEqual((await readdir(file('.'))).sort(), ['alias.pt', 'candidate.pt', 'model.pt', 'previous.pt']);
});

test('cancelled promotion never changes the active model, including cancellation after backup', async t => {
  const file = await fixture(t), activePath = file('model.pt'), candidatePath = file('candidate.pt'), backupPath = file('previous.pt');
  await writeFile(activePath, 'old'); await writeFile(candidatePath, 'new');
  const expectedHash = await fileHash(activePath);
  await assert.rejects(promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath, shouldStop:() => true}), {name:'AbortError'});
  assert.equal(existsSync(backupPath), false);
  assert.equal(await fileHash(activePath), expectedHash);
  await assert.rejects(promoteCheckpoint({candidatePath, activePath, expectedHash, backupPath, shouldStop:() => existsSync(backupPath)}), {name:'AbortError'});
  assert.equal(await fileHash(activePath), expectedHash);
  assert.equal(await readFile(backupPath, 'utf8'), 'old');
  assert.deepEqual((await readdir(file('.'))).sort(), ['candidate.pt', 'model.pt', 'previous.pt']);
});
