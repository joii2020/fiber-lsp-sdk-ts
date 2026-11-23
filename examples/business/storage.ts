import { BrowserStorage, FiberLspError } from 'fiber-lsp-sdk';
import type {
  Storage,
  StorageChange,
  StorageEntry,
  RootKeyWrite,
  LockListener,
} from 'fiber-lsp-sdk';

export const plaintextStorage = !globalThis.isSecureContext && location.protocol === 'http:';

export function createExampleStorage(name: string, userId: string) {
  return plaintextStorage
    ? new PlaintextExampleStorage(name)
    : new BrowserStorage({ name, onUnlock: () => `offckb-example:${userId}` });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(new FiberLspError('STORAGE', tx.error?.message ?? 'Transaction aborted'));
    tx.onerror = () => {};
  });
}

function open(name: string, stores: string[]): Promise<IDBDatabase> {
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => stores.forEach((store) => req.result.createObjectStore(store));
  return request(req).then((db) => {
    db.onversionchange = () => db.close();
    return db;
  });
}

// Match the SDK's structural CAS comparison, including BigInt and unordered object fields.
function canonical(value: unknown): string | undefined {
  if (typeof value === 'bigint') return JSON.stringify(`0x${value.toString(16)}`);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

/** HTTP devnet example only. Root keys are deliberately stored WITHOUT encryption. */
export class PlaintextExampleStorage implements Storage {
  private database: Promise<IDBDatabase> | undefined;
  private closed = false;
  private listeners = new Set<LockListener>();
  lockVersion = 0;

  constructor(private readonly name: string) {}

  private assertOpen() {
    if (this.closed) throw new FiberLspError('CLOSED', 'Example storage is closed');
  }

  private async db() {
    this.assertOpen();
    // Never interpret an encrypted BrowserStorage database as plaintext.
    const db = await (this.database ??= open(`${this.name}-plaintext`, ['records', 'roots']));
    this.assertOpen();
    return db;
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.db();
    return (
      (await request<T | undefined>(db.transaction('records').objectStore('records').get(key))) ??
      null
    );
  }

  async list<T>(prefix: string): Promise<StorageEntry<T>[]> {
    const db = await this.db();
    const store = db.transaction('records').objectStore('records');
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    return keys.flatMap((key, i) =>
      typeof key === 'string' && key.startsWith(prefix) ? [{ key, value: values[i] as T }] : [],
    );
  }

  async commit(changes: readonly StorageChange[], roots: readonly RootKeyWrite[] = []) {
    if (new Set(changes.map((c) => c.key)).size !== changes.length || changes.some((c) => !c.key))
      throw new FiberLspError('INVALID_ARGUMENT', 'Duplicate or empty record key');
    if (roots.some((r) => !/^[0-9a-f]{64}$/.test(r.tenantId) || r.key.length !== 32))
      throw new FiberLspError('INVALID_ARGUMENT', 'Invalid root key');
    const db = await this.db();
    const tx = db.transaction(['records', 'roots'], 'readwrite');
    const done = completion(tx);
    try {
      const records = tx.objectStore('records');
      const values = await Promise.all(changes.map((c) => request(records.get(c.key))));
      changes.forEach((change, i) => {
        if ('expected' in change && canonical(values[i] ?? null) !== canonical(change.expected))
          throw new FiberLspError('CONFLICT', `Record changed: ${change.key}`);
      });
      this.assertOpen();
      for (const change of changes) {
        if (change.value === undefined) records.delete(change.key);
        else records.put(change.value, change.key);
      }
      for (const root of roots) tx.objectStore('roots').add(root.key.slice(), root.tenantId);
      await done;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Transaction may already have aborted. */
      }
      await done.catch(() => {});
      throw error;
    }
  }

  async getRootKey(id: string): Promise<Uint8Array> {
    const db = await this.db();
    const key = await request(db.transaction('roots').objectStore('roots').get(id));
    this.assertOpen();
    if (!key) throw new FiberLspError('NOT_FOUND', 'Root key not found');
    if (!(key instanceof Uint8Array) || key.length !== 32)
      throw new FiberLspError('CORRUPT_DATA', 'Invalid plaintext root key');
    return key.slice();
  }

  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    // A separate database per lock avoids blocking data transactions or nested locks.
    // IndexedDB serializes readwrite transactions across tabs. Keep one request pending
    // while the async action runs; closing/crashing the tab releases the transaction.
    // This request loop is a devnet fallback, not a replacement for production Web Locks.
    const db = await open(`${this.name}-plaintext-lock/${name}`, ['lock']);
    try {
      this.assertOpen();
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('lock', 'readwrite');
        let started = false;
        let settled = false;
        let outcome: { value: T } | { error: unknown };
        tx.oncomplete = () => {
          if ('error' in outcome) reject(outcome.error);
          else resolve(outcome.value);
        };
        tx.onabort = () => {
          // Prevent a suspended action from writing after losing its lock.
          void this.close();
          reject(
            new FiberLspError('STORAGE', 'Example storage lock was interrupted; reload the page'),
          );
        };
        tx.onerror = () => {};
        const keepAlive = () => {
          tx.objectStore('lock').get('held').onsuccess = () => {
            if (!started) {
              started = true;
              void Promise.resolve()
                .then(() => {
                  this.assertOpen();
                  return action();
                })
                .then(
                  (value) => {
                    outcome = { value };
                    settled = true;
                  },
                  (error: unknown) => {
                    outcome = { error };
                    settled = true;
                  },
                );
            }
            if (!settled) keepAlive();
          };
        };
        keepAlive();
      });
    } finally {
      db.close();
    }
  }

  onLock(listener: LockListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  isLocked() {
    return this.closed;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lockVersion++;
    for (const listener of this.listeners) listener(null);
    if (this.database) (await this.database).close();
  }
}
