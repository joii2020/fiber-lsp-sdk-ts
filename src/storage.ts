import { FiberLspError, check } from './errors.js';
import { Mutex, bytesToHex, hexToBytes, randomBytes, canonical, clone, tenantId } from './utils.js';
export interface StorageEntry<T = unknown> {
  key: string;
  value: T;
}
export interface StorageChange {
  key: string;
  value?: unknown;
  /** When set, the old record must match. null means absent. */ expected?: unknown;
}
export interface RootKeyWrite {
  tenantId: string;
  key: Uint8Array;
}
export type LockListener = (tenantIds: readonly string[] | null) => void;
/** Implementations must make commit atomic and withLock exclusive across all users
 * of the same backend (processes/tabs included). Ordinary record keys and root keys
 * occupy separate namespaces. Do not emulate transactions with separate writes. */
export interface Storage {
  get<T>(key: string): Promise<T | null>;
  list<T>(prefix: string): Promise<StorageEntry<T>[]>;
  commit(changes: readonly StorageChange[], roots?: readonly RootKeyWrite[]): Promise<void>;
  getRootKey(tenantId: string): Promise<Uint8Array>;
  withLock<T>(name: string, action: () => Promise<T>): Promise<T>;
  onLock(listener: LockListener): () => void;
  readonly lockVersion: number;
  isLocked(tenantId?: string): boolean;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
interface Cipher {
  iv: string;
  ciphertext: string;
}
interface WrappedKey {
  format: 1;
  salt: string;
  iterations: number;
  wrapped: Cipher;
}
interface Backup {
  format: 'fiber-lsp-sdk-backup';
  version: 1;
  key: WrappedKey;
  payload: Cipher;
}
const ITERATIONS = 600_000;
const keyAad = 'fiber-lsp-sdk/storage-key/v1';
function buffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
async function aes(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buffer(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(key: CryptoKey, data: Uint8Array, aad: string): Promise<Cipher> {
  const iv = randomBytes(12);
  const result = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(encoder.encode(aad)) },
    key,
    buffer(data),
  );
  return { iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(result)) };
}
async function decrypt(key: CryptoKey, data: Cipher, aad: string): Promise<Uint8Array> {
  check(
    data && typeof data.iv === 'string' && typeof data.ciphertext === 'string',
    'CORRUPT_DATA',
    'Invalid encrypted record',
  );
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: buffer(hexToBytes(data.iv)),
          additionalData: buffer(encoder.encode(aad)),
        },
        key,
        buffer(hexToBytes(data.ciphertext)),
      ),
    );
  } catch (cause) {
    throw new FiberLspError('LOCKED', 'Incorrect password or damaged encrypted data', { cause });
  }
}
async function passwordKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  check(
    typeof password === 'string' && password.length > 0,
    'INVALID_ARGUMENT',
    'Password must not be empty',
  );
  check(
    Number.isInteger(iterations) && iterations >= 100_000 && iterations <= 10_000_000,
    'CORRUPT_DATA',
    'Invalid password derivation parameters',
  );
  const material = await crypto.subtle.importKey(
    'raw',
    buffer(encoder.encode(password)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
async function wrap(raw: Uint8Array, password: string): Promise<WrappedKey> {
  const salt = randomBytes(32);
  return {
    format: 1,
    salt: bytesToHex(salt),
    iterations: ITERATIONS,
    wrapped: await encrypt(await passwordKey(password, salt, ITERATIONS), raw, keyAad),
  };
}
async function unwrap(meta: WrappedKey, password: string): Promise<Uint8Array> {
  check(meta?.format === 1, 'CORRUPT_DATA', 'Unsupported storage encryption format');
  const raw = await decrypt(
    await passwordKey(password, hexToBytes(meta.salt), meta.iterations),
    meta.wrapped,
    keyAad,
  );
  check(raw.length === 32, 'CORRUPT_DATA', 'Invalid storage encryption key');
  return raw;
}
async function encodeBackup(
  records: StorageEntry[],
  roots: { tenantId: string; key: string }[],
  password: string,
): Promise<string> {
  const raw = randomBytes();
  try {
    const result: Backup = {
      format: 'fiber-lsp-sdk-backup',
      version: 1,
      key: await wrap(raw, password),
      payload: await encrypt(
        await aes(raw),
        encoder.encode(
          JSON.stringify({ records, roots }, (_, v: unknown) =>
            typeof v === 'bigint' ? { $fiberBigint: v.toString() } : v,
          ),
        ),
        'fiber-lsp-sdk/backup/v1',
      ),
    };
    return JSON.stringify(result);
  } finally {
    raw.fill(0);
  }
}
async function decodeBackup(
  backup: string,
  password: string,
): Promise<{ records: StorageEntry[]; roots: RootKeyWrite[] }> {
  const b = JSON.parse(backup) as Backup;
  check(
    b.format === 'fiber-lsp-sdk-backup' && b.version === 1,
    'CORRUPT_DATA',
    'Unsupported backup format',
  );
  const raw = await unwrap(b.key, password);
  let clear: Uint8Array | undefined;
  try {
    clear = await decrypt(await aes(raw), b.payload, 'fiber-lsp-sdk/backup/v1');
    const data = JSON.parse(decoder.decode(clear), (_, v: unknown) =>
      v && typeof v === 'object' && '$fiberBigint' in v ? BigInt(String(v.$fiberBigint)) : v,
    ) as { records: StorageEntry[]; roots: { tenantId: string; key: string }[] };
    check(
      Array.isArray(data.records) && Array.isArray(data.roots),
      'CORRUPT_DATA',
      'Invalid backup contents',
    );
    check(
      new Set(data.records.map((r) => r.key)).size === data.records.length &&
        new Set(data.roots.map((r) => r.tenantId)).size === data.roots.length,
      'CORRUPT_DATA',
      'Duplicate backup records',
    );
    for (const r of data.records)
      check(
        typeof r.key === 'string' && r.key.startsWith('tenant/'),
        'CORRUPT_DATA',
        'Invalid backup record key',
      );
    return {
      records: data.records,
      roots: data.roots.map((r) => {
        tenantId(r.tenantId);
        const key = hexToBytes(r.key);
        check(key.length === 32, 'CORRUPT_DATA', 'Invalid root key in backup');
        return { tenantId: r.tenantId, key };
      }),
    };
  } finally {
    raw.fill(0);
    clear?.fill(0);
  }
}
function checkChanges(changes: readonly StorageChange[], current: Map<string, unknown>): void {
  check(
    new Set(changes.map((c) => c.key)).size === changes.length,
    'INVALID_ARGUMENT',
    'Duplicate record in transaction',
  );
  for (const c of changes) {
    check(typeof c.key === 'string' && c.key.length > 0, 'INVALID_ARGUMENT', 'Empty storage key');
    if ('expected' in c)
      check(
        canonical(current.get(c.key) ?? null) === canonical(c.expected),
        'CONFLICT',
        `Record changed: ${c.key}`,
      );
  }
}
/** Ephemeral storage. Keys are copied on access and never returned by get/list. */
export class MemoryStorage implements Storage {
  private records = new Map<string, unknown>();
  private roots = new Map<string, Uint8Array>();
  private locks = new Map<string, Mutex>();
  private listeners = new Set<LockListener>();
  private locked = false;
  lockVersion = 0;
  async get<T>(key: string): Promise<T | null> {
    return clone((this.records.get(key) ?? null) as T | null);
  }
  async list<T>(prefix: string): Promise<StorageEntry<T>[]> {
    return [...this.records]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value: clone(value as T) }));
  }
  async commit(
    changes: readonly StorageChange[],
    roots: readonly RootKeyWrite[] = [],
  ): Promise<void> {
    checkChanges(changes, this.records);
    check(
      new Set(roots.map((r) => r.tenantId)).size === roots.length,
      'INVALID_ARGUMENT',
      'Duplicate root key in transaction',
    );
    for (const r of roots) {
      tenantId(r.tenantId);
      check(r.key.length === 32, 'INVALID_ARGUMENT', 'Invalid root key');
      check(!this.roots.has(r.tenantId), 'CONFLICT', 'Root key already exists');
      check(!this.locked, 'LOCKED', 'Storage is locked');
    }
    const records = new Map(this.records),
      keys = new Map(this.roots);
    for (const c of changes) {
      if (c.value === undefined) records.delete(c.key);
      else records.set(c.key, clone(c.value));
    }
    for (const r of roots) keys.set(r.tenantId, r.key.slice());
    this.records = records;
    this.roots = keys;
  }
  async getRootKey(id: string): Promise<Uint8Array> {
    check(!this.locked, 'LOCKED', 'Storage is locked');
    const key = this.roots.get(id);
    check(key, 'NOT_FOUND', 'Root key not found');
    return key.slice();
  }
  withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(name);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(name, lock);
    }
    return lock.run(action);
  }
  onLock(listener: LockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  isLocked(): boolean {
    return this.locked;
  }
  lock(): void {
    this.locked = true;
    this.lockVersion++;
    for (const l of this.listeners) l(null);
  }
  unlock(): void {
    this.locked = false;
  }
  async exportBackup(password: string): Promise<string> {
    check(!this.locked, 'LOCKED', 'Storage is locked');
    return encodeBackup(
      [...this.records].map(([key, value]) => ({ key, value: clone(value) })),
      [...this.roots].map(([id, key]) => ({ tenantId: id, key: bytesToHex(key) })),
      password,
    );
  }
  async importBackup(backup: string, password: string): Promise<void> {
    const data = await decodeBackup(backup, password);
    try {
      await this.commit(
        data.records.map((r) => ({ ...r, expected: null })),
        data.roots,
      );
    } finally {
      data.roots.forEach((r) => r.key.fill(0));
    }
  }
}
export interface BrowserStorageOptions {
  name?: string;
  onUnlock: (request: { reason: 'create' | 'unlock' }) => string | Promise<string>;
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(new FiberLspError('STORAGE', req.error?.message ?? 'IndexedDB request failed'));
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(new FiberLspError('STORAGE', tx.error?.message ?? 'IndexedDB transaction aborted'));
    tx.onerror = () => {};
  });
}
/** IndexedDB + AES-256-GCM envelope encryption; Web Locks coordinate all tabs. */
export class BrowserStorage implements Storage {
  private dbPromise: Promise<IDBDatabase> | undefined;
  private dataKey: CryptoKey | undefined;
  private unlocking: Promise<CryptoKey> | undefined;
  private listeners = new Set<LockListener>();
  private channel: BroadcastChannel | undefined;
  private readonly name: string;
  lockVersion = 0;
  constructor(private readonly options: BrowserStorageOptions) {
    this.name = options.name ?? 'fiber-lsp-sdk';
  }
  private async db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      check(typeof indexedDB !== 'undefined', 'STORAGE', 'IndexedDB is unavailable');
      this.dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => {
          for (const s of ['records', 'roots', 'meta']) r.result.createObjectStore(s);
        };
        r.onsuccess = () => {
          r.result.onversionchange = () => r.result.close();
          resolve(r.result);
        };
        r.onerror = () =>
          reject(new FiberLspError('STORAGE', r.error?.message ?? 'Cannot open IndexedDB'));
        r.onblocked = () => reject(new FiberLspError('STORAGE', 'IndexedDB upgrade is blocked'));
      });
      if (typeof BroadcastChannel !== 'undefined') {
        this.channel = new BroadcastChannel(`fiber-lsp-sdk/${this.name}`);
        this.channel.onmessage = () => this.lock(false);
      }
    }
    return this.dbPromise;
  }
  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    check(
      typeof navigator !== 'undefined' && navigator.locks,
      'STORAGE',
      'BrowserStorage requires the Web Locks API (use HTTPS or localhost)',
    );
    return navigator.locks.request(`fiber-lsp-sdk/${this.name}/${name}`, action);
  }
  private async read<T>(store: string, key: string): Promise<T | null> {
    const db = await this.db();
    const tx = db.transaction(store, 'readonly');
    const completion = done(tx);
    const value = await request(tx.objectStore(store).get(key));
    await completion;
    return (value ?? null) as T | null;
  }
  async get<T>(key: string): Promise<T | null> {
    return this.read<T>('records', key);
  }
  async list<T>(prefix: string): Promise<StorageEntry<T>[]> {
    const db = await this.db();
    const tx = db.transaction('records', 'readonly');
    const completion = done(tx);
    const s = tx.objectStore('records');
    const [keys, values] = await Promise.all([request(s.getAllKeys()), request(s.getAll())]);
    await completion;
    return keys.flatMap((k, i) =>
      typeof k === 'string' && k.startsWith(prefix) ? [{ key: k, value: values[i] as T }] : [],
    );
  }
  private async ensureKey(): Promise<CryptoKey> {
    if (this.dataKey) return this.dataKey;
    if (!this.unlocking) {
      const generation = this.lockVersion;
      this.unlocking = this.withLock('encryption', async () => {
        const meta = await this.read<WrappedKey>('meta', 'encryption');
        const password = await this.options.onUnlock({ reason: meta ? 'unlock' : 'create' });
        const raw = meta ? await unwrap(meta, password) : randomBytes();
        try {
          const key = await aes(raw);
          check(this.lockVersion === generation, 'LOCKED', 'Storage was locked during unlock');
          if (!meta) {
            const wrapped = await wrap(raw, password);
            check(this.lockVersion === generation, 'LOCKED', 'Storage was locked during unlock');
            const db = await this.db();
            const tx = db.transaction('meta', 'readwrite');
            const completion = done(tx);
            tx.objectStore('meta').add(wrapped, 'encryption');
            await completion;
          }
          this.dataKey = key;
          return key;
        } finally {
          raw.fill(0);
        }
      }).finally(() => {
        this.unlocking = undefined;
      });
    }
    return this.unlocking;
  }
  async commit(
    changes: readonly StorageChange[],
    roots: readonly RootKeyWrite[] = [],
  ): Promise<void> {
    const generation = this.lockVersion;
    const encrypted: { tenantId: string; cipher: Cipher }[] = [];
    if (roots.length) {
      const key = await this.ensureKey();
      for (const r of roots) {
        tenantId(r.tenantId);
        check(r.key.length === 32, 'INVALID_ARGUMENT', 'Invalid root key');
        encrypted.push({
          tenantId: r.tenantId,
          cipher: await encrypt(key, r.key, `fiber-lsp-sdk/root/v1/${r.tenantId}`),
        });
      }
      check(this.lockVersion === generation, 'LOCKED', 'Storage was locked during key save');
    }
    const db = await this.db();
    const tx = db.transaction(['records', 'roots'], 'readwrite');
    const completion = done(tx);
    try {
      const s = tx.objectStore('records');
      const current = new Map<string, unknown>();
      const values = await Promise.all(changes.map((c) => request(s.get(c.key))));
      changes.forEach((c, i) => current.set(c.key, values[i]));
      checkChanges(changes, current);
      for (const c of changes) {
        if (c.value === undefined) s.delete(c.key);
        else s.put(c.value, c.key);
      }
      for (const r of encrypted) tx.objectStore('roots').add(r.cipher, r.tenantId);
      await completion;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await completion.catch(() => {});
      throw error;
    }
  }
  async getRootKey(id: string): Promise<Uint8Array> {
    tenantId(id);
    const key = await this.ensureKey();
    const generation = this.lockVersion;
    const cipher = await this.read<Cipher>('roots', id);
    check(cipher, 'NOT_FOUND', 'Root key not found');
    const raw = await decrypt(key, cipher, `fiber-lsp-sdk/root/v1/${id}`);
    if (this.lockVersion !== generation) {
      raw.fill(0);
      throw new FiberLspError('LOCKED', 'Storage was locked during key access');
    }
    check(raw.length === 32, 'CORRUPT_DATA', 'Invalid root key');
    return raw;
  }
  onLock(listener: LockListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  isLocked(): boolean {
    return !this.dataKey;
  }
  lock(broadcast = true): void {
    this.dataKey = undefined;
    this.lockVersion++;
    for (const l of this.listeners) l(null);
    if (broadcast) this.channel?.postMessage('lock');
  }
  async unlock(): Promise<void> {
    await this.ensureKey();
  }
  async changePassword({
    oldPassword,
    newPassword,
  }: {
    oldPassword: string;
    newPassword: string;
  }): Promise<void> {
    await this.withLock('encryption', async () => {
      const previous = await this.read<WrappedKey>('meta', 'encryption');
      check(previous, 'NOT_READY', 'Storage encryption has not been initialized');
      const raw = await unwrap(previous, oldPassword);
      try {
        const replacement = await wrap(raw, newPassword);
        const db = await this.db();
        const tx = db.transaction('meta', 'readwrite');
        const completion = done(tx);
        tx.objectStore('meta').put(replacement, 'encryption');
        await completion;
        this.lock();
      } finally {
        raw.fill(0);
      }
    });
  }
  async exportBackup(password: string): Promise<string> {
    const key = await this.ensureKey();
    const generation = this.lockVersion;
    const db = await this.db();
    const tx = db.transaction(['records', 'roots'], 'readonly');
    const completion = done(tx);
    const [recordKeys, values, ids, ciphers] = await Promise.all([
      request(tx.objectStore('records').getAllKeys()),
      request(tx.objectStore('records').getAll()),
      request(tx.objectStore('roots').getAllKeys()),
      request(tx.objectStore('roots').getAll()),
    ]);
    await completion;
    const records = recordKeys.map((k, i) => {
      check(typeof k === 'string', 'CORRUPT_DATA', 'Invalid record key');
      return { key: k, value: values[i] };
    });
    const roots: { tenantId: string; key: string }[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      check(typeof id === 'string', 'CORRUPT_DATA', 'Invalid root key ID');
      const raw = await decrypt(key, ciphers[i] as Cipher, `fiber-lsp-sdk/root/v1/${id}`);
      try {
        roots.push({ tenantId: id, key: bytesToHex(raw) });
      } finally {
        raw.fill(0);
      }
    }
    check(generation === this.lockVersion, 'LOCKED', 'Storage was locked during backup');
    return encodeBackup(records, roots, password);
  }
  async importBackup(backup: string, password: string): Promise<void> {
    const data = await decodeBackup(backup, password);
    try {
      await this.withLock('backup', () =>
        this.commit(
          data.records.map((r) => ({ ...r, expected: null })),
          data.roots,
        ),
      );
    } finally {
      data.roots.forEach((r) => r.key.fill(0));
    }
  }
  async close(): Promise<void> {
    this.lock();
    this.channel?.close();
    if (this.dbPromise) (await this.dbPromise).close();
    this.dbPromise = undefined;
  }
}
