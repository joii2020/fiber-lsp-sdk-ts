import { FiberLspError } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorage, BrowserStorage } from '../dist/index.js';
import { indexedDB } from 'fake-indexeddb';
import { Mutex } from '../dist/utils.js';
const id = '1'.repeat(64),
  key = new Uint8Array(32).fill(42);
test('memory transactions are atomic, CAS detects races and namespaces remain separate', async () => {
  const s = new MemoryStorage();
  await s.commit(
    [{ key: `tenant/${id}`, value: { n: 1 }, expected: null }],
    [{ tenantId: id, key }],
  );
  const copy = await s.getRootKey(id);
  copy.fill(0);
  assert.equal((await s.getRootKey(id))[0], 42);
  await assert.rejects(
    s.commit([
      { key: 'other', value: 2 },
      { key: `tenant/${id}`, value: 3, expected: null },
    ]),
    (e) => e instanceof FiberLspError && e.code === 'CONFLICT',
  );
  assert.equal(await s.get('other'), null);
  await s.commit([{ key: id, value: 'ordinary' }]);
  assert.equal((await s.getRootKey(id))[0], 42);
  let lockEvents = 0;
  s.onLock(() => lockEvents++);
  s.lock();
  assert.equal(lockEvents, 1);
  assert.deepEqual(await s.get(`tenant/${id}`), { n: 1 });
  await assert.rejects(s.getRootKey(id), (e) => e instanceof FiberLspError && e.code === 'LOCKED');
  s.unlock();
  let count = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      s.withLock('same', async () => {
        const prior = count;
        await Promise.resolve();
        count = prior + 1;
      }),
    ),
  );
  assert.equal(count, 20);
});
test('encrypted backup includes records and roots, rejects wrong password and preserves originals', async () => {
  const s = new MemoryStorage();
  await s.commit([{ key: `tenant/${id}`, value: { amount: 2n ** 100n } }], [{ tenantId: id, key }]);
  const backup = await s.exportBackup('backup-password');
  assert.ok(!backup.includes('2a'.repeat(32)));
  const restored = new MemoryStorage();
  await assert.rejects(restored.importBackup(backup, 'incorrect'));
  assert.deepEqual(await restored.list(''), []);
  await restored.importBackup(backup, 'backup-password');
  assert.deepEqual(await restored.get(`tenant/${id}`), { amount: 2n ** 100n });
  assert.deepEqual(await restored.getRootKey(id), key);
  await assert.rejects(
    restored.importBackup(backup, 'backup-password'),
    (e) => e instanceof FiberLspError && e.code === 'CONFLICT',
  );
  assert.deepEqual(await restored.getRootKey(id), key);
});
test('IndexedDB encrypts keys, unlocks after reopening, changes only the wrapping key, and coordinates two instances', async () => {
  globalThis.indexedDB = indexedDB;
  const locks = new Map<string, Mutex>();
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: <T>(name: string, callback: () => Promise<T>) => {
        if (!locks.has(name)) locks.set(name, new Mutex());
        return locks.get(name)!.run(callback);
      },
    },
  });
  const name = `fiber-test-${Date.now()}`;
  let prompts = 0;
  const storage = new BrowserStorage({
    name,
    onUnlock: () => {
      prompts++;
      return 'old-password';
    },
  });
  assert.equal(prompts, 0);
  await storage.commit([{ key: `tenant/${id}`, value: { n: 1 } }], [{ tenantId: id, key }]);
  assert.equal(prompts, 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const read = (store: string, k: IDBValidKey) =>
    new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(k);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const before = await read('roots', id);
  assert.ok(!JSON.stringify(before).includes('2a'.repeat(32)));
  assert.equal((await storage.getRootKey(id))[0], 42);
  await assert.rejects(
    storage.changePassword({ oldPassword: 'wrong', newPassword: 'new-password' }),
  );
  assert.equal((await storage.getRootKey(id))[0], 42);
  await storage.changePassword({ oldPassword: 'old-password', newPassword: 'new-password' });
  assert.deepEqual(await read('roots', id), before);
  assert.equal(storage.isLocked(), true);
  const reopened = new BrowserStorage({ name, onUnlock: () => 'new-password' });
  assert.deepEqual(await reopened.get(`tenant/${id}`), { n: 1 });
  assert.deepEqual(await reopened.getRootKey(id), key);
  const backup = await reopened.exportBackup('backup-pass');
  await assert.rejects(new MemoryStorage().importBackup(backup, 'old-password'));
  await Promise.all([
    storage.withLock('same', async () => {
      await storage.commit([{ key: 'a', value: 1 }]);
    }),
    reopened.withLock('same', async () => {
      assert.equal(await reopened.get('a'), 1);
    }),
  ]);
  db.close();
  await storage.close();
  await reopened.close();
});
