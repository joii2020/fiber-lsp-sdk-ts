import { FiberLspClient } from './client.js';
import { check } from './errors.js';
import {
  canonical,
  clone,
  hexToBytes,
  randomBytes,
  bytesToHex,
  tenantId,
  pubkey,
  toHex,
} from './utils.js';
import { createIdentity, signerAction, packScript, validatePublicKey } from './wasm.js';
import { recordKey } from './state.js';
import type { TenantRecord } from './state.js';
import type {
  FiberLspOptions,
  FiberLspConfig,
  SetupConfig,
  BeginRegistrationConfig,
  RegisterLspTenantParams,
  RegisterLspTenantResult,
  TenantInfo,
} from './types.js';
export function validateConfig(config: FiberLspConfig): void {
  const url = new URL(config.rpcUrl);
  check(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
    'INVALID_ARGUMENT',
    'Invalid RPC URL',
  );
  pubkey(config.nodePublicKey);
  validatePublicKey(config.nodePublicKey);
  if (config.wsUrl) {
    const ws = new URL(config.wsUrl);
    check(
      ['ws:', 'wss:'].includes(ws.protocol) &&
        !ws.username &&
        !ws.password &&
        !ws.searchParams.has('token'),
      'INVALID_ARGUMENT',
      'Invalid WebSocket URL',
    );
  }
  const n = config.network;
  check(
    ['Fibb', 'Fibt', 'Fibd'].includes(n.currency),
    'INVALID_ARGUMENT',
    'Invalid network currency',
  );
  check(
    n.fundingLock.args === '0x' && n.commitmentLock.args === '0x',
    'INVALID_ARGUMENT',
    'Contract script args must be empty',
  );
  check(
    Number.isSafeInteger(n.epochDurationMs) &&
      n.epochDurationMs > 0 &&
      Number.isSafeInteger(n.commitmentCellDeps) &&
      n.commitmentCellDeps > 0,
    'INVALID_ARGUMENT',
    'Invalid trusted network parameters',
  );
  check(
    typeof n.minimumShutdownFee === 'bigint' &&
      n.minimumShutdownFee >= 0n &&
      n.minimumShutdownFee <= BigInt(Number.MAX_SAFE_INTEGER) &&
      Array.isArray(n.fundingCellDeps),
    'INVALID_ARGUMENT',
    'Missing network fee/dependency configuration',
  );
  packScript(n.fundingLock);
  packScript(n.commitmentLock);
  for (const duration of [n.minTlcExpiryDeltaMs, n.tlcExpiryLimitMs]) {
    check(
      duration === undefined || (Number.isSafeInteger(duration) && duration > 1),
      'INVALID_ARGUMENT',
      'TLC durations must be positive integer milliseconds',
    );
  }
}
export function validateRecord(r: TenantRecord | null, id: string): asserts r is TenantRecord {
  check(r, 'NOT_FOUND', 'Tenant record does not exist');
  check(
    r.schema === 1 &&
      r.info?.tenantId === id &&
      Number.isSafeInteger(r.revision) &&
      r.signer &&
      typeof r.signer.snapshot === 'string' &&
      typeof r.signer.session === 'string' &&
      Array.isArray(r.openings) &&
      Array.isArray(r.payments) &&
      Array.isArray(r.channels) &&
      r.submissions,
    'CORRUPT_DATA',
    'Invalid tenant record',
  );
  validateConfig(r.info.fiberLsp);
  if (r.info.ready)
    check(
      r.token && r.tenant?.tenant_id === id && r.tenant.root_signer_pubkey === r.info.publicKey,
      'CORRUPT_DATA',
      'Tenant credential or identity is missing',
    );
}
/** SDK manager. Construction and createClient never connect or request passwords. */
export class fiberlsp {
  private clients = new Map<string, FiberLspClient>();
  private cleaning = new Map<string, Promise<void>>();
  readonly options: FiberLspOptions;
  constructor(options: FiberLspOptions) {
    check(
      options?.storage && options.chain && typeof options.onConfirm === 'function',
      'INVALID_ARGUMENT',
      'storage, chain and onConfirm are required',
    );
    check(
      options.pollIntervalMs === undefined ||
        (Number.isSafeInteger(options.pollIntervalMs) && options.pollIntervalMs >= 10),
      'INVALID_ARGUMENT',
      'Invalid poll interval',
    );
    this.options = options;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  async listTenants(): Promise<TenantInfo[]> {
    const entries = await this.options.storage.list<TenantRecord>('tenant/');
    return entries.map(({ key, value }) => {
      const id = key.slice(7);
      tenantId(id);
      validateRecord(value, id);
      return clone(value.info);
    });
  }
  private async save(r: TenantRecord): Promise<void> {
    const previous = await this.options.storage.get<TenantRecord>(recordKey(r.info.tenantId));
    check(previous?.revision === r.revision, 'CONFLICT', 'Tenant state changed');
    r.revision++;
    r.info.updatedAt = this.now();
    await this.options.storage.commit([
      { key: recordKey(r.info.tenantId), value: r, expected: previous },
    ]);
  }
  async beginRegistration(
    config: BeginRegistrationConfig,
  ): Promise<{ tenantId: string; params: RegisterLspTenantParams }> {
    validateConfig(config.fiberLsp);
    let id = config.tenantId;
    if (id === undefined) {
      const created = await createIdentity();
      id = created.value.tenantId;
      const root = hexToBytes(created.value.root);
      try {
        const now = this.now();
        const r: TenantRecord = {
          schema: 1,
          revision: 0,
          info: {
            tenantId: id,
            publicKey: created.value.publicKey,
            fiberLsp: clone(config.fiberLsp),
            ready: false,
            createdAt: now,
            updatedAt: now,
          },
          signer: { snapshot: created.snapshot, session: created.session },
          openings: [],
          payments: [],
          channels: [],
          submissions: {},
        };
        await this.options.storage.commit(
          [{ key: recordKey(id), value: r, expected: null }],
          [{ tenantId: id, key: root }],
        );
      } finally {
        root.fill(0);
      }
    }
    tenantId(id);
    const selected = id;
    return this.options.storage.withLock(`tenant/${selected}`, async () => {
      const r = await this.options.storage.get<TenantRecord>(recordKey(selected));
      validateRecord(r, selected);
      check(
        canonical(r.info.fiberLsp) === canonical(config.fiberLsp),
        'CONFLICT',
        'A tenant cannot change its LSP or network',
      );
      const root = await this.options.storage.getRootKey(selected);
      let locked = false;
      const stopWatching = this.options.storage.onLock((ids) => {
        if (ids === null || ids.includes(selected)) locked = true;
      });
      try {
        const identity = await signerAction<{ tenantId: string; publicKey: string }>(
          root,
          r.signer,
          { action: 'identity' },
        );
        check(
          identity.value.tenantId === selected && identity.value.publicKey === r.info.publicKey,
          'CORRUPT_DATA',
          'Root key does not match tenant identity',
        );
        const result = await signerAction<RegisterLspTenantParams>(root, r.signer, {
          action: 'beginRegistration',
          nodePublicKey: config.fiberLsp.nodePublicKey,
          requestId: bytesToHex(randomBytes()),
          now: toHex(this.now()),
        });
        check(!locked, 'LOCKED', 'Storage was locked during registration');
        r.signer = { snapshot: result.snapshot, session: result.session };
        r.registration = { params: result.value, startedAt: this.now() };
        await this.save(r);
        return { tenantId: selected, params: clone(result.value) };
      } finally {
        stopWatching();
        root.fill(0);
      }
    });
  }
  async finishRegistration(id: string, result: RegisterLspTenantResult): Promise<TenantInfo> {
    tenantId(id);
    const info = await this.options.storage.withLock(`tenant/${id}`, async () => {
      const r = await this.options.storage.get<TenantRecord>(recordKey(id));
      validateRecord(r, id);
      check(r.registration, 'NOT_READY', 'No pending registration for this tenant');
      check(
        result?.tenant?.tenant_id === id && result.tenant.root_signer_pubkey === r.info.publicKey,
        'VERIFICATION',
        'Registration identity does not match',
      );
      pubkey(result.tenant.invoice_pubkey);
      validatePublicKey(result.tenant.invoice_pubkey);
      check(
        typeof result.access_token === 'string' &&
          result.access_token.trim().length > 0 &&
          !/[\r\n]/.test(result.access_token),
        'VERIFICATION',
        'Registration returned an empty or malformed access token',
      );
      if (r.tenant)
        check(
          r.tenant.invoice_pubkey === result.tenant.invoice_pubkey,
          'VERIFICATION',
          'Tenant invoice identity changed',
        );
      const root = await this.options.storage.getRootKey(id);
      let locked = false;
      const stopWatching = this.options.storage.onLock((ids) => {
        if (ids === null || ids.includes(id)) locked = true;
      });
      try {
        const next = await signerAction(root, r.signer, { action: 'finishRegistration', result });
        check(!locked, 'LOCKED', 'Storage was locked during registration');
        r.signer = { snapshot: next.snapshot, session: next.session };
        r.token = result.access_token;
        r.tenant = clone(result.tenant);
        r.info.ready = true;
        r.authInvalid = false;
        delete r.registration;
        await this.save(r);
        return clone(r.info);
      } finally {
        stopWatching();
        root.fill(0);
      }
    });
    this.clients.get(id)?.credentialsChanged();
    return info;
  }
  async setup(config: SetupConfig): Promise<TenantInfo> {
    check(
      config.registration && typeof config.registration.register === 'function',
      'INVALID_ARGUMENT',
      'A registration object is required',
    );
    validateConfig(config.fiberLsp);
    if (config.tenantId) {
      const r = await this.options.storage.get<TenantRecord>(recordKey(config.tenantId));
      validateRecord(r, config.tenantId);
      check(
        canonical(r.info.fiberLsp) === canonical(config.fiberLsp),
        'CONFLICT',
        'A tenant cannot change its LSP or network',
      );
      if (r.info.ready && !r.authInvalid && !config.refresh) return clone(r.info);
    }
    const pending = await this.beginRegistration(config);
    const result = await config.registration.register(pending.params);
    return this.finishRegistration(pending.tenantId, result);
  }
  createClient(id: string): FiberLspClient {
    tenantId(id);
    check(!this.cleaning.has(id), 'CLEANING_UP', 'Tenant client is being cleaned up');
    let client = this.clients.get(id);
    if (!client) {
      client = new FiberLspClient(id, this.options);
      this.clients.set(id, client);
    }
    return client;
  }
  cleanup(id: string): Promise<void> {
    tenantId(id);
    const running = this.cleaning.get(id);
    if (running) return running;
    const client = this.clients.get(id);
    if (!client) return Promise.resolve();
    const promise = client
      .cleanup()
      .then(() => {
        this.clients.delete(id);
      })
      .finally(() => {
        this.cleaning.delete(id);
      });
    this.cleaning.set(id, promise);
    return promise;
  }
}
