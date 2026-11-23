import { FiberLspError, RpcError, check, asError } from './errors.js';
import { RpcTransport, isInvoiceCreationRejected, isMissing } from './rpc.js';
import { SigningSubscription } from './subscription.js';
import type { ChannelSigningUpdate } from './subscription.js';
import { validateRecord } from './manager.js';
import { recordKey } from './state.js';
import {
  signerAction,
  parseInvoice,
  paymentHash,
  transactionHash,
  verifyInvoiceResponse,
  validatePublicKey,
} from './wasm/index.js';
import {
  verifyFunding,
  verifyInvoice,
  fundingConfirmed,
  makeClose,
  verifyCloseTransaction,
  sameRaw,
  stateName,
  settled,
  versions,
  reconcilePayment,
  rpcNetwork,
  latest,
} from './verification.js';
import {
  Mutex,
  clone,
  canonical,
  fromHex,
  toHex,
  hash,
  pubkey,
  bytesToHex,
  randomBytes,
} from './utils.js';
import { FiberLspEvent } from './types.js';
import type { TenantRecord, OpeningRecord, PaymentRecord, RecoverySummary } from './state.js';
import type { Hex } from './utils.js';
import type {
  FiberLspOptions,
  EventMap,
  ChannelInfo,
  PaymentInfo,
  ParsedInvoice,
  OpenChannelOptions,
  OpenResult,
  CreateInvoiceOptions,
  PayInvoiceOptions,
  KeysendOptions,
  ConfirmationRequest,
  NetworkConfig,
  ChainProvider,
} from './types.js';
const TAG = '0xffdc';
const MAX_INVOICE_DESCRIPTION_BYTES = 639;
function fundingCommitmentsExchanged(state: {
  state_name?: string;
  state_flags?: string;
}): boolean {
  if (stateName(state) !== 'SigningCommitment' || typeof state.state_flags !== 'string')
    return false;
  const flags = state.state_flags.split('|').map((flag) => flag.trim());
  return (
    flags.includes('OUR_COMMITMENT_SIGNED_SENT') && flags.includes('THEIR_COMMITMENT_SIGNED_SENT')
  );
}
interface InvoiceCreationResult extends Record<string, unknown> {
  invoice_address: string;
  invoice: { data?: { payment_hash?: Hex } };
}
type SignOutcome =
  | { type: 'idle' }
  | { type: 'confirmation'; review: Record<string, unknown> }
  | { type: 'submit'; params?: Record<string, unknown> };
/** A tenant-scoped runtime that starts recovery in the background when created. */
export class FiberLspClient {
  private listeners = new Map<FiberLspEvent, Set<(value: any) => void>>();
  private queue = new Mutex();
  private recovery: Promise<void> | undefined;
  private restored = false;
  private stopped = false;
  private paused = false;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private roundRunning = false;
  private wakePending = false;
  private progressing = false;
  private nextSigningPollAt = 0;
  private signingUpdates = new Map<Hex, ChannelSigningUpdate>();
  private socket: SigningSubscription | undefined;
  private socketToken: string | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private unlisten: () => void;
  private chain: ChainProvider;
  private reconnectAt = 0;
  private reconnectDelay = 500;
  private keyGeneration = 0;
  constructor(
    readonly tenantId: string,
    private readonly options: FiberLspOptions,
    private readonly onCleanup?: (completion: Promise<void>) => void,
  ) {
    this.chain = {
      getCell: (p, n) => this.wait(options.chain.getCell(p, n)),
      getLiveCell: (p, n) => this.wait(options.chain.getLiveCell(p, n)),
      getTransaction: (h, n) => this.wait(options.chain.getTransaction(h, n)),
    };
    this.unlisten = options.storage.onLock((ids) => {
      if (ids === null || ids.includes(tenantId)) {
        this.keyGeneration++;
        this.paused = true;
        this.restored = false;
        this.controller.abort();
        this.socket?.close();
        this.socket = undefined;
        this.signingUpdates.clear();
        this.clearTimer();
        this.emit(FiberLspEvent.ConnectionChanged, { tenantId, state: 'paused' });
      }
    });
    void this.ensureRecovery().catch((error) => this.report(error));
  }
  private wait<T>(value: T | Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    if (signal.aborted)
      return Promise.resolve(value).then(
        () => {
          throw new FiberLspError(
            this.paused ? 'LOCKED' : 'CLOSED',
            'Tenant operation interrupted',
          );
        },
        () => {
          throw new FiberLspError(
            this.paused ? 'LOCKED' : 'CLOSED',
            'Tenant operation interrupted',
          );
        },
      );
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(
          new FiberLspError(this.paused ? 'LOCKED' : 'CLOSED', 'Tenant operation interrupted'),
        );
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(value)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private assertActive(): void {
    check(!this.stopped, 'CLOSED', 'This tenant client has been cleaned up');
  }
  private guard(): void {
    this.assertActive();
    check(!this.paused && !this.controller.signal.aborted, 'LOCKED', 'Tenant processing is paused');
  }
  private emit<E extends FiberLspEvent>(event: E, value: EventMap[E]): void {
    if (this.stopped) return;
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      if (this.stopped) break;
      try {
        listener(value instanceof Error ? value : clone(value));
      } catch (error) {
        if (event !== FiberLspEvent.Error)
          queueMicrotask(() => this.emit(FiberLspEvent.Error, asError(error)));
      }
    }
  }
  on<E extends FiberLspEvent>(event: E, listener: (value: EventMap[E]) => void): () => void {
    this.assertActive();
    check(
      Object.values(FiberLspEvent).includes(event) && typeof listener === 'function',
      'INVALID_ARGUMENT',
      'Invalid event listener',
    );
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const registered = (value: EventMap[E]) => listener(value);
    set.add(registered);
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      set!.delete(registered);
    };
  }
  private report(error: unknown): void {
    this.pauseForError(error);
    if (!this.stopped) this.emit(FiberLspEvent.Error, asError(error));
  }
  private pauseForError(error: unknown): void {
    if (
      error instanceof FiberLspError &&
      [
        'LOCKED',
        'AUTH',
        'CORRUPT_DATA',
        'STORAGE',
        'VERIFICATION',
        'NOT_FOUND',
        'NOT_READY',
        'REJECTED',
      ].includes(error.code)
    ) {
      this.paused = true;
      this.restored = false;
      this.clearTimer();
    }
  }
  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private schedule(
    delay = this.socket?.connected && !this.progressing
      ? (this.options.webSocketPollIntervalMs ?? 15_000)
      : (this.options.pollIntervalMs ?? 1500),
  ): void {
    if (this.stopped || this.paused) return;
    if (this.roundRunning) {
      if (delay === 0) this.wakePending = true;
      return;
    }
    const at = Date.now() + delay;
    if (this.timer !== undefined) {
      if (this.timerAt <= at) return;
      this.clearTimer();
    }
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.roundRunning = true;
      void this.round()
        .catch((e) => this.report(e))
        .finally(() => {
          this.roundRunning = false;
          const next = this.wakePending ? 0 : undefined;
          this.wakePending = false;
          this.schedule(next);
        });
    }, delay);
  }
  private async load(): Promise<TenantRecord> {
    const r = await this.options.storage.get<TenantRecord>(recordKey(this.tenantId));
    validateRecord(r, this.tenantId);
    check(r.info.ready, 'NOT_READY', 'Complete tenant setup before using the client');
    check(!r.authInvalid, 'AUTH', 'Refresh the tenant credential with the original identity');
    return r;
  }
  private async save(r: TenantRecord): Promise<void> {
    const previous = await this.options.storage.get<TenantRecord>(recordKey(this.tenantId));
    check(previous?.revision === r.revision, 'CONFLICT', 'Tenant state changed');
    r.revision++;
    r.info.updatedAt = this.now();
    await this.options.storage.commit([
      { key: recordKey(this.tenantId), value: r, expected: previous },
    ]);
  }
  private async action<T = unknown>(r: TenantRecord, command: Record<string, unknown>): Promise<T> {
    this.guard();
    const root = await this.wait(this.options.storage.getRootKey(this.tenantId));
    const generation = this.keyGeneration;
    try {
      this.guard();
      const result = await signerAction<T>(root, r.signer, command);
      check(this.keyGeneration === generation, 'LOCKED', 'Storage was locked during signing');
      this.guard();
      r.signer = { snapshot: result.snapshot, session: result.session };
      await this.save(r);
      this.guard();
      return result.value;
    } finally {
      root.fill(0);
    }
  }
  private async rpc<T>(r: TenantRecord, method: string, params: unknown): Promise<T> {
    this.guard();
    check(r.token, 'NOT_READY', 'Missing tenant credential');
    try {
      // Never resend a failed WebSocket request over HTTP: a write may already have reached the server.
      const result = await this.wait(
        this.socket?.connected && this.socketToken === r.token
          ? this.socket.call<T>(
              method,
              params,
              this.options.requestTimeoutMs,
              this.controller.signal,
            )
          : new RpcTransport(
              r.info.fiberLsp.rpcUrl,
              this.options.fetch,
              this.options.requestTimeoutMs,
            ).call<T>(method, params, r.token, this.controller.signal),
      );
      this.guard();
      return result;
    } catch (error) {
      if (error instanceof FiberLspError && error.code === 'AUTH') {
        r.authInvalid = true;
        await this.save(r);
        this.paused = true;
        this.restored = false;
        this.socket?.close();
        this.socket = undefined;
        this.signingUpdates.clear();
        this.clearTimer();
        this.emit(FiberLspEvent.ConnectionChanged, { tenantId: this.tenantId, state: 'paused' });
      }
      throw error;
    }
  }
  private async confirm(request: ConfirmationRequest): Promise<void> {
    this.guard();
    check(
      await this.wait(this.options.onConfirm(clone(request))),
      'REJECTED',
      'Operation was declined',
    );
    this.guard();
  }
  private async connect(r: TenantRecord): Promise<void> {
    const url = r.info.fiberLsp.wsUrl;
    if (
      !url ||
      !r.token ||
      (this.socket && this.socketToken === r.token) ||
      this.now() < this.reconnectAt
    )
      return;
    this.socket?.close();
    this.emit(FiberLspEvent.ConnectionChanged, { tenantId: this.tenantId, state: 'connecting' });
    const socket = new SigningSubscription(
      (update) => {
        if (this.socket !== socket || this.stopped || this.paused) return;
        check(
          this.signingUpdates.has(update.channel_id) || this.signingUpdates.size < 1024,
          'NETWORK',
          'Too many pending signing updates',
        );
        this.signingUpdates.set(update.channel_id, update);
        this.schedule(0);
      },
      (error) => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.signingUpdates.clear();
          this.nextSigningPollAt = 0;
          this.restored = false;
          this.reconnectAt = this.now() + this.reconnectDelay;
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
          this.emit(FiberLspEvent.ConnectionChanged, {
            tenantId: this.tenantId,
            state: 'disconnected',
          });
          this.report(error);
          this.schedule();
        }
      },
    );
    this.socket = socket;
    this.socketToken = r.token;
    try {
      await socket.connect(
        url,
        r.token,
        this.options.webSocketFactory,
        this.options.requestTimeoutMs,
      );
      this.guard();
      this.reconnectDelay = 500;
      this.nextSigningPollAt = 0;
    } catch (error) {
      socket.close();
      if (this.socket === socket) this.socket = undefined;
      if (error instanceof FiberLspError && error.code === 'AUTH') {
        r.authInvalid = true;
        await this.save(r);
        throw error;
      }
      this.reconnectAt = this.now() + this.reconnectDelay;
      this.report(error);
    }
  }
  private ensureRecovery(): Promise<void> {
    this.assertActive();
    if (this.restored && !this.paused) return Promise.resolve();
    if (this.recovery) return this.recovery;
    const generation = this.keyGeneration;
    this.recovery = this.queue
      .run(() =>
        this.options.storage.withLock(`tenant/${this.tenantId}`, async () => {
          this.assertActive();
          const r = await this.load();
          this.assertActive();
          check(this.keyGeneration === generation, 'LOCKED', 'Storage was locked during recovery');
          if (this.controller.signal.aborted) this.controller = new AbortController();
          // Recovery may invoke the application's unlock interface.
          const root = await this.wait(this.options.storage.getRootKey(this.tenantId));
          try {
            this.assertActive();
            check(
              this.keyGeneration === generation,
              'LOCKED',
              'Storage was locked during recovery',
            );
            this.paused = false;
            const identity = await signerAction<{ tenantId: string; publicKey: string }>(
              root,
              r.signer,
              { action: 'identity' },
            );
            check(
              identity.value.tenantId === this.tenantId &&
                identity.value.publicKey === r.info.publicKey,
              'CORRUPT_DATA',
              'Tenant identity does not match stored root key',
            );
          } finally {
            root.fill(0);
          }
          this.guard();
          await this.connect(r);
          this.guard();
          this.emit(FiberLspEvent.ConnectionChanged, {
            tenantId: this.tenantId,
            state: 'recovering',
          });
          await this.sync(r);
          this.guard();
          this.restored = true;
          this.emit(FiberLspEvent.ConnectionChanged, {
            tenantId: this.tenantId,
            state: 'connected',
          });
        }),
      )
      .catch((error) => {
        this.pauseForError(error);
        throw error;
      })
      .finally(() => {
        this.recovery = undefined;
        this.schedule();
      });
    return this.recovery;
  }
  private async run<T>(action: (r: TenantRecord) => Promise<T>): Promise<T> {
    await this.ensureRecovery();
    this.assertActive();
    return this.queue
      .run(() =>
        this.options.storage.withLock(`tenant/${this.tenantId}`, async () => {
          this.guard();
          return action(await this.load());
        }),
      )
      .catch((error) => {
        this.pauseForError(error);
        throw error;
      })
      .finally(() => this.schedule());
  }
  private async round(): Promise<void> {
    if (this.stopped || this.paused) return;
    if (!this.restored) {
      await this.ensureRecovery();
      return;
    }
    await this.queue.run(() =>
      this.options.storage.withLock(`tenant/${this.tenantId}`, async () => {
        this.guard();
        const r = await this.load();
        await this.connect(r);
        await this.sync(r);
      }),
    );
  }
  private opening(r: TenantRecord, id: Hex): OpeningRecord {
    hash(id);
    const o = r.openings.find((o) => o.proposal?.channel_id === id);
    check(o, 'NOT_FOUND', 'Channel is not owned by this local session');
    return o;
  }
  private async records(r: TenantRecord, id: Hex): Promise<RecoverySummary[]> {
    return this.action(r, { action: 'records', channelId: id });
  }
  private async queryChannels(r: TenantRecord): Promise<Record<string, any>[]> {
    const result = await this.rpc<{ channels: Record<string, any>[] }>(r, 'list_channels', {
      include_closed: true,
    });
    check(Array.isArray(result.channels), 'VERIFICATION', 'Invalid channel list');
    const known = new Set<string>();
    for (const c of result.channels) {
      hash(c.channel_id);
      check(!known.has(c.channel_id), 'VERIFICATION', 'Duplicate channel ID');
      known.add(c.channel_id);
      check(
        c.pubkey === r.info.fiberLsp.nodePublicKey && c.is_public === false,
        'VERIFICATION',
        'Unexpected channel peer or visibility',
      );
    }
    return result.channels;
  }
  private invoiceChannelConflict(
    channels: Record<string, unknown>[],
    channelId: Hex,
    asset: unknown,
  ): string | undefined {
    const expectedAsset = canonical(asset ?? null);
    const matching = channels.filter((channel) => {
      if (canonical(channel.funding_udt_type_script ?? null) !== expectedAsset) return false;
      // The LSP may select a channel that comes online after the invoice is created.
      const state = stateName(channel.state);
      return state !== 'Closed' && state !== 'ShuttingDown';
    });
    if (!matching.some((channel) => channel.channel_id === channelId))
      return 'The selected channel is unavailable for invoice delivery';
    if (matching.length > 1)
      return 'Cannot create an invoice while multiple channels for the same asset can receive payments';
    return undefined;
  }
  private async updateChannels(r: TenantRecord, raw: Record<string, any>[]): Promise<void> {
    const next: ChannelInfo[] = [];
    for (const o of r.openings) {
      const c = raw.find((c) => c.channel_id === o.proposal?.channel_id);
      let localBalance = 0n,
        remoteBalance = 0n;
      let state = o.stage,
        ready = false,
        closed = false;
      if (c) {
        check(
          canonical(c.funding_udt_type_script ?? null) === canonical(o.terms.udtTypeScript ?? null),
          'VERIFICATION',
          'Remote channel asset changed',
        );
        const name = stateName(c.state);
        state = name as typeof state;
        if (o.proposal && JSON.parse(r.signer.session).bindings[o.proposal.channel_id]) {
          const records = await this.records(r, o.proposal.channel_id);
          const local = latest(records, false);
          if (local?.complete) {
            const context = o.proposal.opening_context;
            localBalance =
              fromHex(local.localAmount) -
              (o.terms.udtTypeScript ? 0n : fromHex(context.local_reserved_ckb_amount));
            remoteBalance =
              fromHex(local.remoteAmount) -
              (o.terms.udtTypeScript ? 0n : fromHex(context.remote_reserved_ckb_amount));
            check(
              localBalance >= 0n && remoteBalance >= 0n,
              'VERIFICATION',
              'Signed balance is below the channel reserve',
            );
          }
        }
        if (c.failure_detail) {
          o.stage = 'failed';
          o.failureReason = String(c.failure_detail);
          state = 'failed';
        } else if (name === 'ChannelReady' && o.proposal) {
          ready = await fundingConfirmed(this.chain, o, r.info.fiberLsp.network);
          if (ready) {
            const records = await this.records(r, o.proposal.channel_id);
            ready =
              !!latest(records, false)?.complete &&
              !!latest(records, true) &&
              localBalance === fromHex(c.local_balance) &&
              remoteBalance === fromHex(c.remote_balance);
          }
          if (ready && o.stage !== 'closing') o.stage = 'ready';
        } else if (name === 'Closed' && o.close && o.proposal && c.shutdown_transaction_hash) {
          const tx = await this.chain.getTransaction(
            c.shutdown_transaction_hash,
            r.info.fiberLsp.network,
          );
          if (tx) {
            check(
              transactionHash(tx) === c.shutdown_transaction_hash,
              'VERIFICATION',
              'Close hash differs from committed transaction',
            );
            const expected = makeClose(
              o,
              [o.close.localAmount, o.close.remoteAmount],
              r.info.fiberLsp.network,
            );
            check(fromHex(expected.fee) === o.close.fee, 'CORRUPT_DATA', 'Close fee changed');
            verifyCloseTransaction(tx, expected.transaction);
            o.close.hash = c.shutdown_transaction_hash;
            o.stage = 'closed';
            closed = true;
            localBalance = 0n;
            remoteBalance = 0n;
          }
        }
      }
      const old = o.info;
      const candidate: ChannelInfo = {
        tenantId: this.tenantId,
        operationId: o.operationId,
        channelId: o.proposal?.channel_id ?? null,
        state,
        ready,
        closed,
        localBalance,
        remoteBalance,
        version: old.version,
      };
      if (!o.signedTransaction && ['intent', 'proposed'].includes(o.stage))
        candidate.needsWallet = true;
      if (o.failureReason) candidate.failureReason = o.failureReason;
      if (c) candidate.raw = clone(c);
      if (canonical(candidate) !== canonical(old)) candidate.version++;
      o.info = candidate;
      next.push(candidate);
    }
    for (const c of raw)
      if (!r.openings.some((o) => o.proposal?.channel_id === c.channel_id)) {
        // Preserve remote orphan records for diagnosis; they cannot be signed or
        // treated as spendable without the corresponding local key/baseline.
        const old = r.channels.find((o) => o.channelId === c.channel_id);
        next.push({
          tenantId: this.tenantId,
          operationId: `unbound/${c.channel_id}`,
          channelId: c.channel_id,
          state: stateName(c.state),
          ready: false,
          closed: false,
          localBalance: 0n,
          remoteBalance: 0n,
          version: (old?.version ?? 0) + 1,
          failureReason: 'Missing local opening/signing records',
          raw: clone(c),
        });
      }
    const previous = r.channels;
    r.channels = next;
    await this.save(r);
    for (const c of next) {
      const old = previous.find((o) => o.operationId === c.operationId);
      if (!old || c.version !== old.version) {
        this.emit(FiberLspEvent.ChannelChanged, c);
        if (!old || old.localBalance !== c.localBalance || old.remoteBalance !== c.remoteBalance)
          this.emit(FiberLspEvent.BalanceChanged, c);
      }
    }
  }
  private async processSignatures(r: TenantRecord, pushedOnly = false): Promise<void> {
    const poll = !pushedOnly && (!this.socket?.connected || this.now() >= this.nextSigningPollAt);
    if (poll)
      this.nextSigningPollAt = this.now() + (this.options.webSocketPollIntervalMs ?? 15_000);
    for (const opening of r.openings) await this.processChannelSignature(r, opening, poll);
  }
  private async processChannelSignature(
    r: TenantRecord,
    o: OpeningRecord,
    poll: boolean,
  ): Promise<boolean> {
    const id = o.proposal?.channel_id;
    if (
      !id ||
      o.stage === 'failed' ||
      o.stage === 'closed' ||
      !JSON.parse(r.signer.session).bindings[id]
    )
      return false;
    const pushed = this.signingUpdates.get(id);
    if (!pushed && !poll) return false;
    this.guard();
    if (o.close) await this.action(r, { action: 'close', channelId: id, fee: toHex(o.close.fee) });
    const result =
      pushed ??
      (await this.rpc<ChannelSigningUpdate>(r, 'get_channel_signing_status', { channel_id: id }));
    check(
      result.channel_id === id,
      'VERIFICATION',
      'Signing status belongs to a different channel',
    );
    if (result.status?.type !== 'SignatureRequired') {
      if (this.signingUpdates.get(id) === pushed) this.signingUpdates.delete(id);
      return false;
    }
    const requestId = String(result.status.request_id);
    hash(requestId);
    const previous = r.submissions[requestId];
    if (previous) {
      check(
        previous.channelId === id && previous.statusHash === canonical(result.status),
        'VERIFICATION',
        'Signing request ID reused with different content',
      );
      if (pushed && previous.done) {
        if (this.signingUpdates.get(id) === pushed) this.signingUpdates.delete(id);
        return false;
      }
      await this.rpc(r, 'submit_channel_signature', previous.params);
      previous.done = true;
      await this.save(r);
      if (this.signingUpdates.get(id) === pushed) this.signingUpdates.delete(id);
      return true;
    }
    const command = {
      action: 'sign',
      channelId: id,
      status: result.status,
      now: toHex(this.now()),
      manual: this.options.signingPolicy === 'manual',
    };
    let outcome = await this.action<SignOutcome>(r, command);
    if (outcome.type === 'confirmation') {
      await this.confirm({
        tenantId: this.tenantId,
        kind: 'sign',
        channelId: id,
        details: { requestId, review: outcome.review },
      });
      outcome = await this.action<SignOutcome>(r, {
        ...command,
        now: toHex(this.now()),
        confirm: true,
      });
    }
    if (outcome.type === 'submit') {
      check(outcome.params, 'VERIFICATION', 'Signer returned no submission');
      r.submissions[requestId] = {
        channelId: id,
        params: outcome.params,
        statusHash: canonical(result.status),
        done: false,
      };
      await this.save(r);
      await this.rpc(r, 'submit_channel_signature', outcome.params);
      r.submissions[requestId]!.done = true;
      await this.save(r);
    }
    if (this.signingUpdates.get(id) === pushed) this.signingUpdates.delete(id);
    return outcome.type === 'submit';
  }
  private async findUnknownKeysend(r: TenantRecord, p: PaymentRecord): Promise<void> {
    const tag = (p.request.custom_records as Record<string, string> | undefined)?.[TAG];
    if (!tag) return;
    let after: Hex | undefined;
    const matches: Record<string, any>[] = [];
    const cursors = new Set<string>();
    do {
      const result = await this.rpc<{ payments: Record<string, any>[]; last_cursor: Hex | null }>(
        r,
        'list_payments',
        { limit: '0x1f4', ...(after ? { after } : {}) },
      );
      check(Array.isArray(result.payments), 'VERIFICATION', 'Invalid payment list');
      matches.push(...result.payments.filter((v) => v.custom_records?.[TAG] === tag));
      if (!result.last_cursor || !result.payments.length) break;
      check(!cursors.has(result.last_cursor), 'VERIFICATION', 'Payment pagination cursor repeated');
      cursors.add(result.last_cursor);
      after = result.last_cursor;
    } while (true);
    check(matches.length <= 1, 'VERIFICATION', 'Ambiguous interrupted keysend result');
    if (matches[0]) await this.bindKeysend(r, p, matches[0]);
  }
  private async bindKeysend(
    r: TenantRecord,
    p: PaymentRecord,
    result: Record<string, any>,
  ): Promise<void> {
    hash(result.payment_hash);
    check(
      !r.payments.some(
        (v) =>
          v !== p && v.info.direction === 'outgoing' && v.info.paymentHash === result.payment_hash,
      ),
      'VERIFICATION',
      'Keysend hash collides with a previous payment',
    );
    p.info.paymentHash = result.payment_hash;
    p.info.version++;
    p.raw = clone(result);
    await this.authorizeKeysend(r, p, result.payment_hash);
    this.emit(FiberLspEvent.PaymentChanged, p.info);
  }
  private async authorizeKeysend(
    r: TenantRecord,
    p: PaymentRecord,
    paymentHash: Hex,
  ): Promise<void> {
    const authorization = p.authorization;
    check(
      authorization &&
        (authorization.payment_hash === null || authorization.payment_hash === paymentHash),
      'CORRUPT_DATA',
      'Missing or mismatched keysend authorization terms',
    );
    authorization.payment_hash = paymentHash;
    p.keysendAuthorized = true;
    // The signer action commits the payment record and signer snapshot together.
    await this.action(r, {
      action: 'authorizePayment',
      channelId: p.info.channelId,
      authorization,
    });
  }
  private async finishUnissuedInvoice(
    r: TenantRecord,
    p: PaymentRecord,
    paymentHash: Hex,
    status: 'Failed' | 'Expired',
    failureReason?: string,
  ): Promise<void> {
    p.info.status = status;
    p.info.complete = true;
    p.info.version++;
    if (failureReason !== undefined) p.info.failureReason = failureReason;
    p.resolution = 'cancel';
    await this.action(r, { action: 'cancel', channelId: p.info.channelId, paymentHash });
    this.emit(FiberLspEvent.InvoiceChanged, p.info);
  }
  private async submitInvoice(
    r: TenantRecord,
    p: PaymentRecord,
  ): Promise<InvoiceCreationResult | RpcError> {
    const paymentHash = p.info.paymentHash;
    check(paymentHash, 'CORRUPT_DATA', 'Missing invoice payment hash');
    p.sent = true;
    await this.save(r);
    try {
      return await this.rpc<InvoiceCreationResult>(r, 'new_invoice', p.request);
    } catch (error) {
      if (!isInvoiceCreationRejected(error)) throw error;
      await this.finishUnissuedInvoice(r, p, paymentHash, 'Failed', error.message);
      return error;
    }
  }
  private async refreshPayment(
    r: TenantRecord,
    p: PaymentRecord,
    channels: Record<string, any>[],
  ): Promise<PaymentInfo | null> {
    // Later channel updates can change the balances used for reconciliation.
    if (p.info.complete) return p.info;
    if (!p.info.paymentHash) {
      await this.findUnknownKeysend(r, p);
      if (!p.info.paymentHash) return p.info;
    } else if (p.request.keysend === true && !p.keysendAuthorized) {
      // Older records could persist the hash before authorizing it in the signer.
      await this.authorizeKeysend(r, p, p.info.paymentHash);
    }
    const id = p.info.paymentHash;
    const incoming = p.info.direction === 'incoming';
    let result: Record<string, any>;
    try {
      result = await this.rpc(r, incoming ? 'get_invoice' : 'get_payment', { payment_hash: id });
    } catch (error) {
      if (!isMissing(error, p.info.direction)) throw error;
      if (
        incoming &&
        p.sent &&
        p.info.status === 'Creating' &&
        !p.info.invoice &&
        p.authorization &&
        fromHex(p.authorization.expires_at_ms) <= BigInt(this.now())
      ) {
        const records = await this.records(r, p.info.channelId);
        if (
          latest(records, false) &&
          latest(records, true) &&
          !records.some((record) => record.tlcs.some((tlc) => tlc.paymentHash === id))
        ) {
          await this.finishUnissuedInvoice(r, p, id, 'Expired');
          return p.info;
        }
      }
      return null;
    }
    if (incoming) {
      check(
        result.invoice?.data?.payment_hash === id,
        'VERIFICATION',
        'Invoice query returned a different payment hash',
      );
      verifyInvoiceResponse(result.invoice_address, result.invoice);
      const parsed = parseInvoice(result.invoice_address);
      const opening = this.opening(r, p.info.channelId);
      check(
        parsed.paymentHash === id &&
          parsed.amount === p.info.amount &&
          parsed.payeePublicKey === r.tenant?.invoice_pubkey,
        'VERIFICATION',
        'Stored invoice identity or amount changed',
      );
      check(
        parsed.hashAlgorithm === p.authorization?.hash_algorithm &&
          parsed.currency === r.info.fiberLsp.network.currency &&
          parsed.trampolineHint === r.info.fiberLsp.nodePublicKey &&
          parsed.expirySeconds === Number(fromHex(p.request.expiry)) &&
          parsed.finalTlcExpiryDelta === Number(fromHex(p.request.final_expiry_delta)),
        'VERIFICATION',
        'Invoice terms changed',
      );
      if (p.info.invoice)
        check(
          result.invoice_address === p.info.invoice,
          'VERIFICATION',
          'Invoice contents changed',
        );
      if (!p.info.invoice) p.info.invoice = result.invoice_address;
      check(
        canonical(parsed.udtTypeScript ?? null) === canonical(opening.terms.udtTypeScript ?? null),
        'VERIFICATION',
        'Invoice asset changed',
      );
    } else
      check(
        result.payment_hash === id,
        'VERIFICATION',
        'Payment query returned a different payment hash',
      );
    const allowed = incoming
      ? ['Open', 'Received', 'Paid', 'Expired', 'Cancelled']
      : ['Created', 'Inflight', 'Success', 'Failed'];
    check(allowed.includes(result.status), 'VERIFICATION', 'Unexpected payment status');
    p.raw = clone(result);
    const opening = this.opening(r, p.info.channelId);
    const c = channels.find((c) => c.channel_id === p.info.channelId);
    if (!incoming && result.payment_preimage && !p.resolution) {
      await this.action(r, {
        action: 'fulfill',
        channelId: p.info.channelId,
        paymentHash: id,
        preimage: result.payment_preimage,
      });
      p.resolution = 'fulfill';
      await this.save(r);
    }
    if (!incoming && result.status === 'Failed' && !p.resolution) {
      await this.action(r, { action: 'cancel', channelId: p.info.channelId, paymentHash: id });
      p.resolution = 'cancel';
      await this.save(r);
    }
    if (incoming && ['Cancelled', 'Expired'].includes(result.status) && !p.resolution) {
      await this.action(r, { action: 'cancel', channelId: p.info.channelId, paymentHash: id });
      p.resolution = 'cancel';
      await this.save(r);
    }
    if (incoming && result.status === 'Received' && !p.releaseStarted && p.preimage) {
      const records = await this.records(r, p.info.channelId);
      const local = latest(records, false);
      if (local?.complete && local.tlcs.some((t) => t.paymentHash === id)) {
        check(
          await fundingConfirmed(this.chain, opening, r.info.fiberLsp.network),
          'VERIFICATION',
          'Funding must be confirmed and live before releasing a preimage',
        );
        const point = {
          tx_hash: transactionHash(opening.proposal!.unsigned_funding_tx),
          index: '0x0' as const,
        };
        const cell = await this.chain.getLiveCell(point, r.info.fiberLsp.network);
        check(cell, 'VERIFICATION', 'Funding is not live');
        await this.action(r, {
          action: 'release',
          channelId: p.info.channelId,
          paymentHash: id,
          preimage: p.preimage,
          now: toHex(this.now()),
          medianTime: await this.chainMedianTime(r),
          outPoint: point,
          cell,
        });
        p.releaseStarted = true;
        p.resolution = 'fulfill';
        await this.save(r);
      }
    }
    if (incoming && p.releaseStarted && result.status === 'Received') {
      // Recheck the live cell and recovery window even when retrying a release
      // after a lost RPC response. The Rust method is idempotent.
      const point = {
        tx_hash: transactionHash(opening.proposal!.unsigned_funding_tx),
        index: '0x0' as const,
      };
      const cell = await this.chain.getLiveCell(point, r.info.fiberLsp.network);
      check(cell, 'VERIFICATION', 'Funding is not live');
      await this.action(r, {
        action: 'release',
        channelId: p.info.channelId,
        paymentHash: id,
        preimage: p.preimage,
        now: toHex(this.now()),
        medianTime: await this.chainMedianTime(r),
        outPoint: point,
        cell,
      });
      await this.rpc(r, 'settle_invoice', { payment_hash: id, payment_preimage: p.preimage });
    }
    const old = clone(p.info);
    p.info.status = result.status;
    if (!incoming) {
      p.info.fee = fromHex(result.fee);
      check(
        p.info.fee <= fromHex(p.request.max_fee_amount),
        'VERIFICATION',
        'Reported payment fee exceeds the approved budget',
      );
      if (result.failed_error) p.info.failureReason = String(result.failed_error);
    }
    const success = incoming ? result.status === 'Paid' : result.status === 'Success';
    const failed = incoming
      ? ['Expired', 'Cancelled'].includes(result.status)
      : result.status === 'Failed';
    if ((success || failed) && c) {
      const records = await this.records(r, p.info.channelId);
      if (
        success ||
        (p.resolution === 'cancel' && records.some((v) => v.tlcs.some((t) => t.paymentHash === id)))
      ) {
        p.info.complete =
          reconcilePayment(p, records, c, opening) &&
          (await fundingConfirmed(this.chain, opening, r.info.fiberLsp.network));
      } else if (failed) {
        p.info.complete = !records.some((v) => v.tlcs.some((t) => t.paymentHash === id));
      }
    }
    if (canonical(old) !== canonical(p.info)) {
      p.info.version++;
      await this.save(r);
      this.emit(incoming ? FiberLspEvent.InvoiceChanged : FiberLspEvent.PaymentChanged, p.info);
    } else await this.save(r);
    return p.info;
  }
  private async chainMedianTime(r: TenantRecord): Promise<Hex> {
    const chain = this.options.chain;
    check(
      chain.getMedianTime,
      'VERIFICATION',
      'A trusted chain median time is required to release a preimage',
    );
    const time = await this.wait(chain.getMedianTime(r.info.fiberLsp.network));
    check(fromHex(time) > 0n, 'VERIFICATION', 'Invalid chain median time');
    return time;
  }
  private async advanceFunding(
    r: TenantRecord,
    opening: OpeningRecord,
    channel: Record<string, any>,
  ): Promise<void> {
    const { proposal, signedTransaction: signed } = opening;
    check(
      proposal && signed && sameRaw(signed, proposal.unsigned_funding_tx),
      'CORRUPT_DATA',
      'Stored funding transaction changed',
    );
    if (fundingCommitmentsExchanged(channel.state)) {
      const result = await this.rpc<{ channel_id: Hex; funding_tx_hash: Hex }>(
        r,
        'submit_signed_funding_tx',
        { channel_id: proposal.channel_id, signed_funding_tx: signed },
      );
      check(
        result.channel_id === proposal.channel_id && result.funding_tx_hash === opening.fundingHash,
        'VERIFICATION',
        'Funding submission response changed the channel or transaction',
      );
    } else if (
      !['AwaitingTxSignatures', 'AwaitingChannelReady', 'ChannelReady'].includes(
        stateName(channel.state),
      )
    ) {
      return;
    }
    opening.stage = 'submitted';
    await this.save(r);
  }
  private async resume(r: TenantRecord, channels: Record<string, any>[]): Promise<void> {
    for (const o of r.openings)
      if (o.stage === 'signed' && o.proposal && o.signedTransaction) {
        const c = channels.find((c) => c.channel_id === o.proposal!.channel_id);
        if (!c || c.failure_detail) continue;
        await this.advanceFunding(r, o, c);
      }
    for (const p of r.payments)
      if (!p.sent && !p.info.complete && p.authorization) {
        if (fromHex(p.authorization.expires_at_ms) <= BigInt(this.now())) {
          p.info.status = 'Expired';
          p.info.complete = true;
          p.info.version++;
          await this.save(r);
          continue;
        }
        await this.action(r, {
          action: p.info.direction === 'incoming' ? 'authorizeInvoice' : 'authorizePayment',
          channelId: p.info.channelId,
          authorization: p.authorization,
          ...(p.preimage ? { preimage: p.preimage } : {}),
        });
        if (p.info.direction === 'incoming') {
          const conflict = this.invoiceChannelConflict(
            channels,
            p.info.channelId,
            p.request.udt_type_script,
          );
          if (conflict) {
            const paymentHash = p.info.paymentHash;
            check(paymentHash, 'CORRUPT_DATA', 'Missing invoice payment hash');
            await this.finishUnissuedInvoice(r, p, paymentHash, 'Failed', conflict);
            continue;
          }
          const result = await this.submitInvoice(r, p);
          if (result instanceof RpcError) continue;
          p.raw = clone(result);
        } else {
          p.sent = true;
          await this.save(r);
          const result = await this.rpc<Record<string, unknown>>(r, 'send_payment', p.request);
          check(
            result.payment_hash === p.info.paymentHash,
            'VERIFICATION',
            'Resumed payment response changed hash',
          );
          p.raw = clone(result);
        }
        await this.save(r);
      }
  }
  private async sync(r: TenantRecord): Promise<void> {
    // Opening/closing pushes can be signed before snapshot queries. Payments first
    // refresh the preimage or cancellation authorization required by the signer.
    if (!r.payments.some((p) => !p.info.complete)) await this.processSignatures(r, true);
    let channels = await this.queryChannels(r);
    await this.updateChannels(r, channels);
    const revision = r.revision;
    await this.resume(r, channels);
    for (const p of r.payments.filter((p) => !p.info.complete))
      await this.refreshPayment(r, p, channels);
    await this.processSignatures(r);
    if (r.revision !== revision) {
      channels = await this.queryChannels(r);
      await this.updateChannels(r, channels);
      for (const p of r.payments.filter((p) => !p.info.complete))
        await this.refreshPayment(r, p, channels);
    }
    // A persisted shutdown request may have been interrupted before transport.
    for (const o of r.openings)
      if (
        o.stage === 'closing' &&
        o.proposal &&
        channels.some(
          (c) => c.channel_id === o.proposal!.channel_id && stateName(c.state) === 'ChannelReady',
        )
      )
        await this.requestClose(r, o);
    this.progressing =
      r.payments.some((p) => !p.info.complete) ||
      r.openings.some(
        (o) => !['ready', 'closed', 'failed'].includes(o.stage) && !o.info.needsWallet,
      );
  }
  async listChannels(): Promise<ChannelInfo[]> {
    return this.run(async (r) => {
      await this.sync(r);
      return clone(r.channels);
    });
  }
  /** Read locally saved payments and invoices, including payments awaiting a hash. */
  async listPayments(): Promise<PaymentInfo[]> {
    this.assertActive();
    const r = await this.options.storage.get<TenantRecord>(recordKey(this.tenantId));
    this.assertActive();
    validateRecord(r, this.tenantId);
    return r.payments.map(({ info }) => clone(info));
  }
  async getPayment({
    paymentHash: payment,
    direction,
  }: {
    paymentHash: Hex;
    direction: 'incoming' | 'outgoing';
  }): Promise<PaymentInfo | null> {
    hash(payment);
    check(
      direction === 'incoming' || direction === 'outgoing',
      'INVALID_ARGUMENT',
      'Payment direction is required',
    );
    return this.run(async (r) => {
      await this.sync(r);
      const channels = await this.queryChannels(r);
      const p = r.payments.find(
        (p) => p.info.paymentHash === payment && p.info.direction === direction,
      );
      if (p) return clone(await this.refreshPayment(r, p, channels));
      try {
        const result = await this.rpc<Record<string, any>>(
          r,
          direction === 'incoming' ? 'get_invoice' : 'get_payment',
          { payment_hash: payment },
        );
        check(
          (direction === 'incoming' ? result.invoice?.data?.payment_hash : result.payment_hash) ===
            payment,
          'VERIFICATION',
          'Query returned a different payment hash',
        );
        // Remote-only records lack the authorization, baseline and recovery
        // evidence needed to report a locally verified result.
        throw new FiberLspError(
          'CORRUPT_DATA',
          'Payment exists remotely but its local authorization/recovery record is missing',
        );
      } catch (error) {
        if (isMissing(error, direction)) return null;
        throw error;
      }
    });
  }
  parseInvoice(invoice: string): ParsedInvoice {
    this.assertActive();
    return parseInvoice(invoice);
  }
  async openChannel({ wallet, newChannel = false }: OpenChannelOptions): Promise<ChannelInfo> {
    check(
      wallet && typeof wallet.getFundingTerms === 'function',
      'INVALID_ARGUMENT',
      'A funding wallet is required',
    );
    return this.run(async (r) => {
      const channels = await this.queryChannels(r);
      // Only one opening can use the pending signer at a time. Retry it before allocating
      // another signer, even when the caller asked to add a channel after a lost response.
      let opening = r.openings.find(
        (entry) => !['ready', 'closing', 'closed', 'failed'].includes(entry.stage),
      );
      if (!opening && !newChannel) opening = r.openings.at(-1);
      if (opening && ['closed', 'failed'].includes(opening.stage)) opening = undefined;
      if (!opening) {
        check(
          !channels.some(
            (c) =>
              stateName(c.state) !== 'Closed' &&
              !c.failure_detail &&
              !r.openings.some((entry) => entry.proposal?.channel_id === c.channel_id),
          ),
          'CONFLICT',
          'Tenant has an unbound channel; restore its local records before opening another',
        );
        const terms = await this.wait(wallet.getFundingTerms(r.info.fiberLsp.network));
        for (const field of [
          'fundingAmount',
          'remoteFundingAmount',
          'maxFundingFee',
          'maxWalletDebit',
          'commitmentDelayEpoch',
          'commitmentFeeRate',
          'fundingFeeRate',
        ] as const) {
          check(
            typeof terms[field] === 'bigint' && terms[field] >= 0n,
            'INVALID_ARGUMENT',
            `Funding ${field} must be a nonnegative bigint`,
          );
        }
        check(
          terms.fundingAmount > 0n &&
            terms.remoteFundingAmount >= 0n &&
            terms.maxFundingFee >= 0n &&
            terms.maxWalletDebit >= 0n,
          'INVALID_ARGUMENT',
          'Invalid funding limits',
        );
        const operationId = bytesToHex(randomBytes());
        await this.confirm({
          tenantId: this.tenantId,
          kind: 'openChannel',
          operationId,
          details: { terms },
        });
        if (r.openings.length) await this.action(r, { action: 'discardPending' });
        const material = await this.action(r, { action: 'allocateChannel' });
        const request: Record<string, unknown> = {
          pubkey: r.info.fiberLsp.nodePublicKey,
          funding_amount: toHex(terms.fundingAmount),
          public: false,
          shutdown_script: terms.shutdownScript,
          funding_lock_script: terms.fundingLockScript,
          commitment_delay_epoch: toHex(terms.commitmentDelayEpoch),
          commitment_fee_rate: toHex(terms.commitmentFeeRate),
          funding_fee_rate: toHex(terms.fundingFeeRate),
          external_channel_signer: material,
        };
        if (terms.udtTypeScript) request.funding_udt_type_script = terms.udtTypeScript;
        if (terms.fundingLockScriptCellDeps)
          request.funding_lock_script_cell_deps = terms.fundingLockScriptCellDeps;
        if (terms.tlcExpiryDeltaMs !== undefined)
          request.tlc_expiry_delta = toHex(terms.tlcExpiryDeltaMs);
        opening = {
          operationId,
          terms: clone(terms),
          request,
          stage: 'intent',
          info: {
            tenantId: this.tenantId,
            operationId,
            channelId: null,
            state: 'intent',
            ready: false,
            closed: false,
            localBalance: 0n,
            remoteBalance: 0n,
            version: 1,
          },
        };
        r.openings.push(opening);
        await this.action(r, {
          action: 'beginOpening',
          request,
          network: rpcNetwork(r.info.fiberLsp.network),
        });
      }
      if (opening.stage === 'ready' || opening.stage === 'closing') {
        await this.sync(r);
        return clone(opening.info);
      }
      if (!opening.proposal) {
        const proposal = await this.rpc<OpenResult>(
          r,
          'open_channel_with_external_funding',
          opening.request,
        );
        hash(proposal.channel_id);
        check(
          proposal.opening_context && proposal.unsigned_funding_tx,
          'VERIFICATION',
          'Missing frozen tenant opening proposal',
        );
        opening.proposal = clone(proposal);
        opening.stage = 'proposed';
        await this.save(r);
      }
      const proposal = opening.proposal;
      if (!opening.signedTransaction) {
        const approved = await this.wait(
          wallet.verifyFunding(
            clone(proposal.unsigned_funding_tx),
            clone(opening.terms),
            clone(r.info.fiberLsp.network),
          ),
        );
        await verifyFunding(this.chain, proposal, opening.terms, r.info.fiberLsp.network, approved);
        await this.action(r, {
          action: 'finishOpening',
          request: opening.request,
          result: proposal,
          inputs: approved,
          network: rpcNetwork(r.info.fiberLsp.network),
        });
        // Each opening lane can become available as soon as the previous one is submitted.
        for (let lane = 0; lane < 2; lane++) {
          if (!(await this.processChannelSignature(r, opening, true))) break;
        }
        const channels = await this.queryChannels(r);
        const current = channels.find((c) => c.channel_id === proposal.channel_id);
        check(
          current &&
            !current.failure_detail &&
            ['NegotiatingFunding', 'SigningCommitment'].includes(stateName(current.state)),
          'VERIFICATION',
          'Server no longer accepts this funding proposal',
        );
        if (
          !fundingCommitmentsExchanged(current.state) ||
          !(await this.action<boolean>(r, {
            action: 'openingExitVerified',
            channelId: proposal.channel_id,
          }))
        ) {
          await this.updateChannels(r, channels);
          return clone(opening.info);
        }
        const signed = await this.wait(
          wallet.signFundingTransaction(clone(proposal.unsigned_funding_tx)),
        );
        this.guard();
        check(
          sameRaw(signed, proposal.unsigned_funding_tx),
          'VERIFICATION',
          'Wallet changed the raw funding transaction',
        );
        opening.signedTransaction = clone(signed);
        opening.fundingHash = transactionHash(signed);
        opening.stage = 'signed';
        await this.save(r);
      }
      if (opening.stage === 'signed') {
        const current = (await this.queryChannels(r)).find(
          (c) => c.channel_id === proposal.channel_id,
        );
        check(
          current && !current.failure_detail,
          'VERIFICATION',
          'Funding operation failed or is no longer available',
        );
        await this.advanceFunding(r, opening, current);
      }
      await this.sync(r);
      return clone(opening.info);
    });
  }
  private async requestClose(r: TenantRecord, o: OpeningRecord): Promise<void> {
    await this.rpc(r, 'shutdown_channel', {
      channel_id: o.proposal!.channel_id,
      close_script: o.terms.shutdownScript,
      fee_rate: toHex(o.terms.closeFeeRate ?? o.terms.fundingFeeRate),
      force: false,
    });
    o.close!.requested = true;
    await this.save(r);
  }
  async closeChannel(channelId: Hex): Promise<ChannelInfo> {
    hash(channelId);
    return this.run(async (r) => {
      await this.sync(r);
      const o = this.opening(r, channelId);
      if (o.stage === 'closed') return clone(o.info);
      if (!o.close) {
        check(
          o.stage === 'ready' && o.info.ready,
          'NOT_READY',
          'Channel is not ready for cooperative close',
        );
        const balances = settled(await this.records(r, channelId));
        check(balances, 'NOT_READY', 'Both commitment lanes must be fully settled');
        check(
          await fundingConfirmed(this.chain, o, r.info.fiberLsp.network),
          'VERIFICATION',
          'Funding must be live before cooperative close',
        );
        const template = makeClose(o, balances, r.info.fiberLsp.network);
        const fee = fromHex(template.fee);
        check(fee <= o.terms.maxFundingFee, 'VERIFICATION', 'Close fee exceeds approved limit');
        await this.confirm({
          tenantId: this.tenantId,
          kind: 'closeChannel',
          channelId,
          operationId: o.operationId,
          details: {
            fee,
            localAmount: balances[0],
            remoteAmount: balances[1],
            shutdownScript: o.terms.shutdownScript,
            udtTypeScript: o.terms.udtTypeScript ?? null,
          },
        });
        o.close = { fee, localAmount: balances[0], remoteAmount: balances[1], requested: false };
        o.stage = 'closing';
        await this.save(r);
        await this.action(r, { action: 'close', channelId, fee: toHex(fee) });
      }
      await this.requestClose(r, o);
      await this.sync(r);
      return clone(o.info);
    });
  }
  private async paymentContext(
    r: TenantRecord,
    channelId: Hex,
  ): Promise<{ opening: OpeningRecord; records: RecoverySummary[]; balances: [bigint, bigint] }> {
    const opening = this.opening(r, channelId);
    check(
      opening.stage === 'ready' && opening.info.ready,
      'NOT_READY',
      'Selected channel is not ready',
    );
    check(
      !r.payments.some((p) => !p.info.complete),
      'CONFLICT',
      'Resolve the existing payment or invoice before starting another operation',
    );
    const records = await this.records(r, channelId);
    const balances = settled(records);
    check(balances, 'NOT_READY', 'Commitment lanes are not fully settled');
    check(
      await fundingConfirmed(this.chain, opening, r.info.fiberLsp.network),
      'VERIFICATION',
      'Funding is not confirmed and live',
    );
    return { opening, records, balances };
  }
  private authorization(
    network: NetworkConfig,
    paymentHash: Hex | null,
    amount: bigint,
    inbound: boolean,
    expiresAt: number,
    finalDelta: number,
  ): Record<string, unknown> {
    const limit = network.tlcExpiryLimitMs ?? 14 * 86400_000;
    const now = this.now();
    const authorizationExpiry = inbound
      ? expiresAt
      : Math.min(expiresAt, now + Math.min(3_600_000, limit - 1));
    check(
      finalDelta > 0 && finalDelta <= limit,
      'INVALID_ARGUMENT',
      'TLC expiry exceeds approved time limit',
    );
    return {
      payment_hash: paymentHash,
      hash_algorithm: 'ckb_hash',
      inbound,
      amount: toHex(amount),
      expires_at_ms: toHex(authorizationExpiry),
      min_tlc_expiry_delta_ms: toHex(network.minTlcExpiryDeltaMs ?? finalDelta),
      max_tlc_expiry_ms: toHex(inbound ? authorizationExpiry + limit : now + limit),
    };
  }
  async createInvoice(
    options: CreateInvoiceOptions,
  ): Promise<PaymentInfo & { paymentHash: Hex; invoice: string }> {
    hash(options.channelId);
    check(options.amount > 0n, 'INVALID_ARGUMENT', 'Invoice amount must be positive');
    const description = options.description;
    if (description !== undefined)
      check(
        typeof description === 'string' &&
          new TextEncoder().encode(description).length <= MAX_INVOICE_DESCRIPTION_BYTES,
        'INVALID_ARGUMENT',
        `Invoice description must be at most ${MAX_INVOICE_DESCRIPTION_BYTES} UTF-8 bytes`,
      );
    return this.run(async (r) => {
      const { opening, records, balances } = await this.paymentContext(r, options.channelId);
      const network = r.info.fiberLsp.network;
      check(
        options.amount <= opening.info.remoteBalance,
        'INVALID_ARGUMENT',
        'Insufficient inbound channel liquidity',
      );
      const expiry = options.expirySeconds ?? 3600,
        final = options.finalTlcExpiryDeltaMs ?? network.minTlcExpiryDeltaMs ?? 9_600_000;
      check(
        Number.isSafeInteger(expiry) && expiry > 0,
        'INVALID_ARGUMENT',
        'Invoice expiry must be a positive integer',
      );
      const conflict = this.invoiceChannelConflict(
        await this.queryChannels(r),
        options.channelId,
        opening.terms.udtTypeScript,
      );
      if (conflict) throw new FiberLspError('CONFLICT', conflict);
      const preimage = randomBytes();
      const algorithm = options.hashAlgorithm ?? 'ckb_hash';
      const payment = paymentHash(preimage, algorithm);
      const preimageHex = bytesToHex(preimage);
      preimage.fill(0);
      const authorization = this.authorization(
        network,
        payment,
        options.amount,
        true,
        this.now() + expiry * 1000,
        final,
      );
      authorization.hash_algorithm = algorithm;
      const request: Record<string, unknown> = {
        amount: toHex(options.amount),
        currency: network.currency,
        payment_hash: payment,
        expiry: toHex(expiry),
        final_expiry_delta: toHex(final),
        hash_algorithm: algorithm,
        allow_mpp: false,
        allow_trampoline_routing: true,
      };
      if (description) request.description = description;
      if (opening.terms.udtTypeScript) request.udt_type_script = opening.terms.udtTypeScript;
      const p: PaymentRecord = {
        info: {
          tenantId: this.tenantId,
          operationId: bytesToHex(randomBytes()),
          channelId: options.channelId,
          paymentHash: payment,
          direction: 'incoming',
          status: 'Creating',
          complete: false,
          amount: options.amount,
          version: 1,
        },
        request,
        authorization,
        preimage: preimageHex,
        startVersions: versions(records),
        startBalances: [toHex(balances[0]), toHex(balances[1])],
        sent: false,
      };
      r.payments.push(p);
      await this.save(r);
      await this.action(r, {
        action: 'authorizeInvoice',
        channelId: options.channelId,
        authorization,
        preimage: preimageHex,
      });
      const result = await this.submitInvoice(r, p);
      if (result instanceof RpcError) throw result;
      verifyInvoiceResponse(result.invoice_address, result.invoice);
      const parsed = parseInvoice(result.invoice_address);
      verifyInvoice(parsed, network, opening.terms.udtTypeScript, this.now());
      check(
        parsed.paymentHash === payment &&
          parsed.amount === options.amount &&
          parsed.hashAlgorithm === algorithm &&
          parsed.payeePublicKey === r.tenant?.invoice_pubkey &&
          parsed.trampolineHint === r.info.fiberLsp.nodePublicKey &&
          parsed.expirySeconds === expiry &&
          parsed.finalTlcExpiryDelta === final,
        'VERIFICATION',
        'Created invoice differs from local authorization',
      );
      check(
        result.invoice?.data?.payment_hash === payment,
        'VERIFICATION',
        'Invoice response body differs from encoded invoice',
      );
      p.info.invoice = result.invoice_address;
      p.info.status = 'Open';
      p.info.version++;
      await this.save(r);
      this.emit(FiberLspEvent.InvoiceChanged, p.info);
      return clone(p.info) as PaymentInfo & { paymentHash: Hex; invoice: string };
    });
  }
  async payInvoice(options: PayInvoiceOptions): Promise<PaymentInfo> {
    hash(options.channelId);
    check(options.maxFee >= 0n, 'INVALID_ARGUMENT', 'Maximum fee must not be negative');
    const parsed = parseInvoice(options.invoice);
    return this.run(async (r) => {
      const { opening, records, balances } = await this.paymentContext(r, options.channelId);
      const network = r.info.fiberLsp.network;
      verifyInvoice(parsed, network, opening.terms.udtTypeScript, this.now());
      check(
        !r.payments.some(
          (p) => p.info.direction === 'outgoing' && p.info.paymentHash === parsed.paymentHash,
        ),
        'CONFLICT',
        'This invoice already has a payment record; query its payment hash',
      );
      const rate = options.maxFeeRate ?? 5n;
      check(rate >= 0n, 'INVALID_ARGUMENT', 'Invalid fee rate');
      const rateFee = (parsed.amount * rate + 999n) / 1000n;
      const fee =
        parsed.payeePublicKey === r.info.fiberLsp.nodePublicKey
          ? 0n
          : rateFee < options.maxFee
            ? rateFee
            : options.maxFee;
      const amount = parsed.amount + fee;
      check(
        amount <= opening.info.localBalance,
        'INVALID_ARGUMENT',
        'Insufficient spendable channel balance',
      );
      const operationId = bytesToHex(randomBytes());
      await this.confirm({
        tenantId: this.tenantId,
        kind: 'payInvoice',
        channelId: options.channelId,
        operationId,
        details: { invoice: parsed, amount: parsed.amount, feeBudget: fee, maxFeeRate: rate },
      });
      const authorization = this.authorization(
        network,
        parsed.paymentHash,
        amount,
        false,
        parsed.expiresAt,
        parsed.finalTlcExpiryDelta,
      );
      authorization.hash_algorithm = parsed.hashAlgorithm;
      const request: Record<string, unknown> = {
        invoice: options.invoice,
        payment_hash: parsed.paymentHash,
        max_parts: '0x1',
        max_fee_amount: toHex(fee),
        max_fee_rate: toHex(rate),
        tlc_expiry_limit: toHex(network.tlcExpiryLimitMs ?? 14 * 86400_000),
      };
      if (parsed.payeePublicKey !== r.info.fiberLsp.nodePublicKey)
        request.trampoline_hops = [r.info.fiberLsp.nodePublicKey];
      const p: PaymentRecord = {
        info: {
          tenantId: this.tenantId,
          operationId,
          channelId: options.channelId,
          paymentHash: parsed.paymentHash,
          direction: 'outgoing',
          status: 'Created',
          complete: false,
          amount: parsed.amount,
          invoice: options.invoice,
          version: 1,
        },
        request,
        authorization,
        startVersions: versions(records),
        startBalances: [toHex(balances[0]), toHex(balances[1])],
        sent: false,
      };
      r.payments.push(p);
      await this.save(r);
      await this.action(r, {
        action: 'authorizePayment',
        channelId: options.channelId,
        authorization,
      });
      p.sent = true;
      await this.save(r);
      const result = await this.rpc<Record<string, any>>(r, 'send_payment', request);
      check(
        result.payment_hash === parsed.paymentHash,
        'VERIFICATION',
        'Payment response hash differs from authorized invoice',
      );
      p.raw = clone(result);
      await this.save(r);
      await this.sync(r);
      return clone(p.info);
    });
  }
  async keysend(options: KeysendOptions): Promise<PaymentInfo> {
    hash(options.channelId);
    pubkey(options.targetPublicKey);
    validatePublicKey(options.targetPublicKey);
    check(
      options.amount > 0n && options.maxFee >= 0n,
      'INVALID_ARGUMENT',
      'Invalid keysend amount or fee',
    );
    return this.run(async (r) => {
      const { opening, records, balances } = await this.paymentContext(r, options.channelId);
      const network = r.info.fiberLsp.network;
      const rate = options.maxFeeRate ?? 5n;
      check(rate >= 0n, 'INVALID_ARGUMENT', 'Invalid fee rate');
      const rateFee = (options.amount * rate + 999n) / 1000n;
      const fee =
        options.targetPublicKey === r.info.fiberLsp.nodePublicKey
          ? 0n
          : rateFee < options.maxFee
            ? rateFee
            : options.maxFee;
      check(
        options.amount + fee <= opening.info.localBalance,
        'INVALID_ARGUMENT',
        'Insufficient spendable channel balance',
      );
      const operationId = bytesToHex(randomBytes());
      await this.confirm({
        tenantId: this.tenantId,
        kind: 'keysend',
        channelId: options.channelId,
        operationId,
        details: {
          targetPublicKey: options.targetPublicKey,
          amount: options.amount,
          feeBudget: fee,
          udtTypeScript: opening.terms.udtTypeScript ?? null,
        },
      });
      const authorization = this.authorization(
        network,
        null,
        options.amount + fee,
        false,
        this.now() + 3600_000,
        network.minTlcExpiryDeltaMs ?? 86400_000,
      );
      const request: Record<string, unknown> = {
        keysend: true,
        target_pubkey: options.targetPublicKey,
        amount: toHex(options.amount),
        max_parts: '0x1',
        max_fee_amount: toHex(fee),
        max_fee_rate: toHex(rate),
        tlc_expiry_limit: toHex(network.tlcExpiryLimitMs ?? 14 * 86400_000),
        custom_records: { [TAG]: operationId },
      };
      if (options.targetPublicKey !== r.info.fiberLsp.nodePublicKey)
        request.trampoline_hops = [r.info.fiberLsp.nodePublicKey];
      if (opening.terms.udtTypeScript) request.udt_type_script = opening.terms.udtTypeScript;
      const p: PaymentRecord = {
        info: {
          tenantId: this.tenantId,
          operationId,
          channelId: options.channelId,
          paymentHash: null,
          direction: 'outgoing',
          status: 'Unknown',
          complete: false,
          amount: options.amount,
          version: 1,
        },
        request,
        authorization,
        startVersions: versions(records),
        startBalances: [toHex(balances[0]), toHex(balances[1])],
        sent: true,
      };
      r.payments.push(p);
      await this.save(r);
      const result = await this.rpc<Record<string, any>>(r, 'send_payment', request);
      await this.bindKeysend(r, p, result);
      await this.sync(r);
      return clone(p.info);
    });
  }
  credentialsChanged(): void {
    if (this.stopped) return;
    this.controller.abort();
    this.controller = new AbortController();
    this.socket?.close();
    this.socket = undefined;
    this.signingUpdates.clear();
    this.nextSigningPollAt = 0;
    this.socketToken = undefined;
    this.paused = false;
    this.restored = false;
    this.reconnectAt = 0;
    this.schedule(0);
  }
  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.stopped = true;
    this.controller.abort();
    this.clearTimer();
    this.socket?.close();
    this.socket = undefined;
    this.signingUpdates.clear();
    this.listeners.clear();
    this.unlisten();
    // Every externally visible mutation was already committed before transport;
    // waiting for the queue also waits for in-flight wallet/confirmation work.
    this.cleanupPromise = this.queue
      .run(async () => {})
      .catch((error) => {
        this.cleanupPromise = undefined;
        throw error;
      });
    this.onCleanup?.(this.cleanupPromise);
    return this.cleanupPromise;
  }
}
