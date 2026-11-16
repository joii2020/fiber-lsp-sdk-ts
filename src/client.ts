import { FiberLspError, check, asError } from './errors.js';
import { RpcTransport, isMissing } from './rpc.js';
import { SigningSubscription } from './subscription.js';
import { validateRecord } from './manager.js';
import { recordKey } from './state.js';
import {
  signerAction,
  parseInvoice,
  paymentHash,
  transactionHash,
  verifyInvoiceResponse,
  validatePublicKey,
} from './wasm.js';
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
interface SignOutcome {
  type: 'idle' | 'confirmation' | 'submit';
  review?: Record<string, unknown>;
  params?: Record<string, unknown>;
}
/** A lazily started, tenant-scoped runtime. Obtain instances with createClient. */
export class FiberLspClient {
  private listeners = new Map<FiberLspEvent, Set<(value: any) => void>>();
  private queue = new Mutex();
  private recovery: Promise<void> | undefined;
  private restored = false;
  private stopped = false;
  private paused = false;
  private controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private socket: SigningSubscription | undefined;
  private socketToken: string | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private unlisten: () => void;
  private started = false;
  private chain: ChainProvider;
  private reconnectAt = 0;
  private reconnectDelay = 500;
  private keyGeneration = 0;
  constructor(
    readonly tenantId: string,
    private readonly options: FiberLspOptions,
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
        this.clearTimer();
        this.emit(FiberLspEvent.ConnectionChanged, { tenantId, state: 'paused' });
      }
    });
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
    void this.ensureRecovery().catch((error) => this.report(error));
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
  private schedule(delay = this.options.pollIntervalMs ?? 1500): void {
    if (this.stopped || this.paused || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.round()
        .catch((e) => this.report(e))
        .finally(() => this.schedule());
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
      const result = await this.wait(
        new RpcTransport(
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
        this.clearTimer();
        this.emit(FiberLspEvent.ConnectionChanged, { tenantId: this.tenantId, state: 'paused' });
      }
      throw error;
    }
  }
  private async confirm(
    kind: ConfirmationRequest['kind'],
    details: Record<string, unknown>,
    channelId?: Hex,
    operationId?: string,
  ): Promise<void> {
    this.guard();
    const request: ConfirmationRequest = { tenantId: this.tenantId, kind, details: clone(details) };
    if (channelId) request.channelId = channelId;
    if (operationId) request.operationId = operationId;
    check(await this.wait(this.options.onConfirm(request)), 'REJECTED', 'Operation was declined');
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
      () => this.schedule(0),
      (error) => {
        if (this.socket === socket) {
          this.socket = undefined;
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
    this.started = true;
    if (this.restored && !this.paused) return Promise.resolve();
    if (this.recovery) return this.recovery;
    this.recovery = this.queue
      .run(() =>
        this.options.storage.withLock(`tenant/${this.tenantId}`, async () => {
          this.assertActive();
          const r = await this.load();
          if (this.controller.signal.aborted) this.controller = new AbortController();
          // Key access is lazy and may invoke the application's unlock interface.
          const root = await this.wait(this.options.storage.getRootKey(this.tenantId));
          try {
            this.assertActive();
            this.paused = false;
            if (this.controller.signal.aborted) this.controller = new AbortController();
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
  private async processSignatures(r: TenantRecord): Promise<void> {
    for (const o of r.openings) {
      const id = o.proposal?.channel_id;
      if (
        !id ||
        o.stage === 'failed' ||
        o.stage === 'closed' ||
        !JSON.parse(r.signer.session).bindings[id]
      )
        continue;
      this.guard();
      if (o.close)
        await this.action(r, { action: 'close', channelId: id, fee: toHex(o.close.fee) });
      const result = await this.rpc<{ channel_id: Hex; status: Record<string, unknown> }>(
        r,
        'get_channel_signing_status',
        { channel_id: id },
      );
      check(
        result.channel_id === id,
        'VERIFICATION',
        'Signing status belongs to a different channel',
      );
      if (result.status?.type !== 'SignatureRequired') continue;
      const requestId = String(result.status.request_id);
      hash(requestId);
      const previous = r.submissions[requestId];
      if (previous) {
        check(
          previous.channelId === id && previous.statusHash === canonical(result.status),
          'VERIFICATION',
          'Signing request ID reused with different content',
        );
        await this.rpc(r, 'submit_channel_signature', previous.params);
        previous.done = true;
        await this.save(r);
        continue;
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
        await this.confirm('sign', { requestId, review: outcome.review }, id);
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
    }
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
    p.raw = clone(result);
    p.outcomeUnknown = false;
    const a = p.authorization!;
    a.payment_hash = result.payment_hash;
    await this.save(r);
    await this.action(r, {
      action: 'authorizePayment',
      channelId: p.info.channelId,
      authorization: a,
    });
  }
  private async refreshPayment(
    r: TenantRecord,
    p: PaymentRecord,
    channels: Record<string, any>[],
  ): Promise<PaymentInfo | null> {
    if (!p.info.paymentHash) {
      await this.findUnknownKeysend(r, p);
      if (!p.info.paymentHash) return p.info;
    }
    const id = p.info.paymentHash;
    const incoming = p.info.direction === 'incoming';
    let result: Record<string, any>;
    try {
      result = await this.rpc(r, incoming ? 'get_invoice' : 'get_payment', { payment_hash: id });
    } catch (error) {
      if (isMissing(error, p.info.direction)) return null;
      throw error;
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
  private async resume(r: TenantRecord, channels: Record<string, any>[]): Promise<void> {
    for (const o of r.openings)
      if (o.stage === 'signed' && o.proposal && o.signedTransaction) {
        const c = channels.find((c) => c.channel_id === o.proposal!.channel_id);
        if (!c || c.failure_detail) continue;
        check(
          sameRaw(o.signedTransaction, o.proposal.unsigned_funding_tx),
          'CORRUPT_DATA',
          'Stored funding transaction changed',
        );
        if (stateName(c.state) === 'NegotiatingFunding') {
          const result = await this.rpc<{ channel_id: Hex; funding_tx_hash: Hex }>(
            r,
            'submit_signed_funding_tx',
            { channel_id: o.proposal.channel_id, signed_funding_tx: o.signedTransaction },
          );
          check(
            result.channel_id === o.proposal.channel_id && result.funding_tx_hash === o.fundingHash,
            'VERIFICATION',
            'Resumed funding response changed identity',
          );
        }
        o.stage = 'submitted';
        await this.save(r);
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
        p.sent = true;
        await this.save(r);
        const result = await this.rpc<Record<string, any>>(
          r,
          p.info.direction === 'incoming' ? 'new_invoice' : 'send_payment',
          p.request,
        );
        if (p.info.direction === 'outgoing')
          check(
            result.payment_hash === p.info.paymentHash,
            'VERIFICATION',
            'Resumed payment response changed hash',
          );
        p.raw = clone(result);
        await this.save(r);
      }
  }
  private async sync(r: TenantRecord): Promise<void> {
    let channels = await this.queryChannels(r);
    await this.updateChannels(r, channels);
    await this.resume(r, channels);
    for (const p of r.payments.filter((p) => !p.info.complete))
      await this.refreshPayment(r, p, channels);
    await this.processSignatures(r);
    channels = await this.queryChannels(r);
    await this.updateChannels(r, channels);
    for (const p of r.payments.filter((p) => !p.info.complete))
      await this.refreshPayment(r, p, channels);
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
  }
  async listChannels(): Promise<ChannelInfo[]> {
    return this.run(async (r) => {
      await this.sync(r);
      return clone(r.channels);
    });
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
        await this.confirm('openChannel', { terms }, undefined, operationId);
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
        const current = (await this.queryChannels(r)).find(
          (c) => c.channel_id === proposal.channel_id,
        );
        check(
          current && !current.failure_detail && stateName(current.state) === 'NegotiatingFunding',
          'VERIFICATION',
          'Server no longer accepts this funding proposal',
        );
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
        if (stateName(current.state) === 'NegotiatingFunding') {
          const result = await this.rpc<{ channel_id: Hex; funding_tx_hash: Hex }>(
            r,
            'submit_signed_funding_tx',
            { channel_id: proposal.channel_id, signed_funding_tx: opening.signedTransaction },
          );
          check(
            result.channel_id === proposal.channel_id &&
              result.funding_tx_hash === opening.fundingHash,
            'VERIFICATION',
            'Funding submission response changed the channel or transaction',
          );
        }
        opening.stage = 'submitted';
        await this.save(r);
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
        await this.confirm(
          'closeChannel',
          {
            fee,
            localAmount: balances[0],
            remoteAmount: balances[1],
            shutdownScript: o.terms.shutdownScript,
          },
          channelId,
          o.operationId,
        );
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
      if (options.description) request.description = options.description;
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
      p.sent = true;
      await this.save(r);
      const result = await this.rpc<{ invoice_address: string; invoice: Record<string, any> }>(
        r,
        'new_invoice',
        request,
      );
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
      const rateFee = (parsed.amount! * rate + 999n) / 1000n;
      const fee =
        parsed.payeePublicKey === r.info.fiberLsp.nodePublicKey
          ? 0n
          : rateFee < options.maxFee
            ? rateFee
            : options.maxFee;
      const amount = parsed.amount! + fee;
      check(
        amount <= opening.info.localBalance,
        'INVALID_ARGUMENT',
        'Insufficient spendable channel balance',
      );
      const operationId = bytesToHex(randomBytes());
      await this.confirm(
        'payInvoice',
        { invoice: parsed, amount: parsed.amount, feeBudget: fee, maxFeeRate: rate },
        options.channelId,
        operationId,
      );
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
          amount: parsed.amount!,
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
      await this.confirm(
        'keysend',
        { targetPublicKey: options.targetPublicKey, amount: options.amount, feeBudget: fee },
        options.channelId,
        operationId,
      );
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
        outcomeUnknown: true,
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
    this.socketToken = undefined;
    this.paused = false;
    this.restored = false;
    this.reconnectAt = 0;
    if (this.started) this.schedule(0);
  }
  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.stopped = true;
    this.controller.abort();
    this.clearTimer();
    this.socket?.close();
    this.socket = undefined;
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
    return this.cleanupPromise;
  }
}
