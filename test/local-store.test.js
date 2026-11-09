import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalStore } from '../lib/local-store.js';

async function dataDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'x-engine-local-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('local store migrates legacy user and history files exactly once', async (t) => {
  const dataDir = await dataDirectory(t);
  const users = [{ id: '1', username: 'alice', xAccounts: ['alice'], groqApiKey: 'gsk_local' }];
  const history = [{ id: 'run-1', userId: '1', url: 'https://x.com/a/status/1' }];
  await writeFile(join(dataDir, 'user-db.json'), JSON.stringify(users), 'utf8');
  await writeFile(join(dataDir, 'history.json'), JSON.stringify(history), 'utf8');

  const store = createLocalStore(dataDir, { isTest: false });
  await store.ensure();

  const file = join(dataDir, 'data', 'db.json');
  const database = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(database.version, 1);
  assert.deepEqual(database.users, users);
  assert.deepEqual(database.history, history);
  assert.match(database.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  // Once db.json exists it is authoritative; later legacy edits are ignored in
  // production mode instead of silently overwriting the local database.
  await writeFile(join(dataDir, 'user-db.json'), JSON.stringify([{ id: '2', username: 'bob' }]), 'utf8');
  assert.deepEqual((await store.readUsers()).map((user) => user.id), ['1']);
  assert.deepEqual((await store.readHistory()).map((entry) => entry.id), ['run-1']);
});

test('local store writes accounts and history without legacy mirrors outside tests', async (t) => {
  const dataDir = await dataDirectory(t);
  const store = createLocalStore(dataDir, { isTest: false });
  const users = [{ id: '1', username: 'alice', groqApiKey: 'gsk_private' }];
  await store.writeUsers(users);
  await store.writeHistory(Array.from({ length: 60 }, (_, index) => ({ id: `run-${index}` })));

  assert.deepEqual(await store.readUsers(), users);
  assert.equal((await store.readHistory()).length, 50);
  assert.equal((await store.readHistory())[0].id, 'run-10');
  await assert.rejects(stat(join(dataDir, 'user-db.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(dataDir, 'history.json')), { code: 'ENOENT' });

  const database = JSON.parse(await readFile(join(dataDir, 'data', 'db.json'), 'utf8'));
  assert.deepEqual(database.users, users);
  assert.equal(database.history.length, 50);
});

test('local store mirrors legacy files in test mode and removes empty history', async (t) => {
  const dataDir = await dataDirectory(t);
  const store = createLocalStore(dataDir, { isTest: true });
  const users = [{ id: '1', username: 'alice' }];
  await store.writeUsers(users);
  await store.writeHistory([{ id: 'run-1', userId: '1' }]);

  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'user-db.json'), 'utf8')), users);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history.json'), 'utf8')), [{ id: 'run-1', userId: '1' }]);

  // A test fixture may append to the legacy history; test reads merge both
  // copies, while the authoritative db.json remains the write target.
  await writeFile(join(dataDir, 'history.json'), JSON.stringify([{ id: 'run-2', userId: '1' }]), 'utf8');
  assert.deepEqual((await store.readHistory()).map((entry) => entry.id), ['run-1', 'run-2']);

  await store.writeHistory([]);
  await assert.rejects(stat(join(dataDir, 'history.json')), { code: 'ENOENT' });
  assert.deepEqual(await store.readHistory(), []);
});

test('local store refuses to replace a malformed legacy database', async (t) => {
  const dataDir = await dataDirectory(t);
  await writeFile(join(dataDir, 'user-db.json'), '{"users":', 'utf8');
  const store = createLocalStore(dataDir, { isTest: false });
  await assert.rejects(store.ensure(), /JSON|Unexpected|Expected/);
  await assert.rejects(stat(join(dataDir, 'data', 'db.json')), { code: 'ENOENT' });
});

test('local store tolerates a BOM and normalizes non-object files', async (t) => {
  const dataDir = await dataDirectory(t);
  await mkdir(join(dataDir, 'data'), { recursive: true });
  await writeFile(join(dataDir, 'data', 'db.json'), `\uFEFF${JSON.stringify({ users: [{ id: '1' }] })}`, 'utf8');
  const store = createLocalStore(dataDir, { isTest: false });
  assert.deepEqual((await store.readUsers()).map((user) => user.id), ['1']);
  assert.deepEqual(await store.readHistory(), []);
});

test('local store keeps independent user and history writes under the same lock', async (t) => {
  const dataDir = await dataDirectory(t);
  const store = createLocalStore(dataDir, { isTest: false });
  await Promise.all([
    store.writeUsers([{ id: '1', username: 'alice' }]),
    store.writeHistory([{ id: 'run-1', userId: '1' }]),
  ]);
  const database = JSON.parse(await readFile(join(dataDir, 'data', 'db.json'), 'utf8'));
  assert.deepEqual(database.users, [{ id: '1', username: 'alice' }]);
  assert.deepEqual(database.history, [{ id: 'run-1', userId: '1' }]);
});
