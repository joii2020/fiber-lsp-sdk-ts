import { fiberlsp, FiberLspEvent } from 'fiber-lsp-sdk';
import type {
  ChannelInfo,
  ConfirmationRequest,
  FiberLspClient,
  Hex,
  PaymentInfo,
  TenantInfo,
} from 'fiber-lsp-sdk';
import { fundingWallet, request } from './connection.ts';
import type { DevnetConnection } from './connection.ts';
import { jsonStringify } from '../shared/types.ts';
import type { PaymentJson, RegisterUserResult, User, WalletBalance } from '../shared/types.ts';
import { createExampleStorage } from './storage.ts';

interface TenantSession {
  tenant: TenantInfo;
  client?: FiberLspClient;
  channels: Map<string, ChannelInfo>;
  selectedChannel?: string;
  payments: Map<string, PaymentInfo>;
  historyKey: string;
}

/** Domain events let the UI choose its own messages without handling SDK subscriptions. */
export type AccountEvent =
  | { type: 'tenant-selected' | 'channel-selected' }
  | { type: 'channel-closed' }
  | { type: 'payment-complete'; payment: PaymentInfo }
  | { type: 'history-save-failed' }
  | { type: 'error'; error: unknown };

export interface AccountCallbacks {
  onChange(session: AccountSession): void;
  onEvent(session: AccountSession, event: AccountEvent): void;
  onConfirm(request: ConfirmationRequest): boolean | Promise<boolean>;
}

/**
 * Start here to learn the SDK: restore → register → attachClient → channel/payments → dispose.
 * One application user owns one persistent SDK manager; each tenant has its own client.
 * Rendering, confirmation dialogs and status messages belong to the caller.
 */
export class AccountSession {
  user: User;
  private readonly storage: ReturnType<typeof createExampleStorage>;
  private readonly lsp: fiberlsp;
  private readonly connection: DevnetConnection;
  private readonly baseUrl: string;
  private readonly historyKey: string;
  private readonly sessions = new Map<string, TenantSession>();
  private selected: TenantSession | undefined;
  get tenants(): TenantInfo[] {
    return [...this.sessions.values()].map((state) => state.tenant);
  }
  get tenant() {
    return this.selected?.tenant;
  }
  get channel() {
    const state = this.selected;
    return state?.selectedChannel ? state.channels.get(state.selectedChannel) : undefined;
  }
  get channels(): ChannelInfo[] {
    return [...(this.selected?.channels.values() ?? [])];
  }
  get payments(): ReadonlyMap<string, PaymentInfo> {
    return new Map(
      [...(this.selected?.payments ?? [])].filter(
        ([, payment]) => payment.channelId === this.channel?.channelId,
      ),
    );
  }
  balance: string | null = null;
  private operating = false;
  get busy(): boolean {
    return this.operating;
  }
  private refreshing = false;
  private balanceRefreshPending = false;

  private constructor(
    user: User,
    connection: DevnetConnection,
    baseUrl: string,
    private readonly callbacks: AccountCallbacks,
  ) {
    this.user = user;
    this.connection = connection;
    this.baseUrl = baseUrl;
    const name = `${connection.storageName}-user-${user.id}`;
    this.historyKey = `${name}-payments`;
    // Convenience for local devnet only. A production application supplies a real unlock UI.
    this.storage = createExampleStorage(name, user.id);
    this.lsp = new fiberlsp({
      storage: this.storage,
      chain: connection.chain,
      pollIntervalMs: 1000,
      onConfirm: callbacks.onConfirm,
    });
  }
  static async restore(
    user: User,
    connection: DevnetConnection,
    baseUrl: string,
    callbacks: AccountCallbacks,
  ): Promise<AccountSession> {
    const session = new AccountSession(user, connection, baseUrl, callbacks);
    try {
      await session.loadTenants();
      if (
        user.rootPublicKeys.some(
          (key) => !session.tenants.some((tenant) => tenant.publicKey === key),
        )
      )
        throw Error(
          'Tenant keys are missing from this browser. Use the browser and site address where you created the tenant.',
        );
      const selected = sessionStorage.getItem(`${session.historyKey}-tenant`);
      const tenant =
        session.tenants.find((entry) => entry.tenantId === selected) ?? session.tenants[0];
      if (tenant) session.selectTenant(tenant.tenantId);
      for (const state of session.sessions.values()) {
        if (state.tenant.ready) session.attachClient(state);
      }
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }
  private async loadTenants(): Promise<void> {
    for (let tenant of await this.lsp.listTenants()) {
      if (tenant.fiberLsp.wsUrl !== this.connection.fiberLsp.wsUrl)
        tenant = await this.lsp.setWebSocketUrl(tenant.tenantId, this.connection.fiberLsp.wsUrl);
      const existing = this.sessions.get(tenant.tenantId);
      if (existing) {
        existing.tenant = tenant;
        continue;
      }
      const historyKey = `${this.historyKey}-${tenant.tenantId}`;
      const history = JSON.parse(localStorage.getItem(historyKey) ?? '[]') as PaymentJson[];
      const state: TenantSession = {
        tenant,
        historyKey,
        payments: new Map(),
        channels: new Map(),
        selectedChannel: sessionStorage.getItem(`${historyKey}-channel`) ?? undefined,
      };
      for (const entry of history) {
        const { fee, ...rest } = entry;
        const payment: PaymentInfo = {
          ...rest,
          amount: BigInt(entry.amount),
          ...(fee === undefined ? {} : { fee: BigInt(fee) }),
        };
        state.payments.set(this.paymentKey(payment), payment);
      }
      this.sessions.set(tenant.tenantId, state);
    }
  }
  selectTenant(id: string): void {
    const state = this.sessions.get(id);
    if (!state) throw Error('Tenant not found');
    this.selected = state;
    sessionStorage.setItem(`${this.historyKey}-tenant`, id);
    this.emit({ type: 'tenant-selected' });
    if (state.tenant.ready) this.attachClient(state);
    this.callbacks.onChange(this);
  }
  selectChannel(operationId: string): void {
    const state = this.selected;
    if (!state?.channels.has(operationId)) throw Error('Channel not found');
    state.selectedChannel = operationId;
    sessionStorage.setItem(`${state.historyKey}-channel`, operationId);
    this.emit({ type: 'channel-selected' });
    this.callbacks.onChange(this);
  }
  private emit(event: AccountEvent): void {
    this.callbacks.onEvent(this, event);
  }
  /** Ignore duplicate user actions and suspend new refreshes while an action is in progress. */
  async run(task: () => Promise<void>): Promise<void> {
    if (this.operating) return;
    this.operating = true;
    this.callbacks.onChange(this);
    try {
      await task();
    } finally {
      this.operating = false;
      this.callbacks.onChange(this);
      if (this.balanceRefreshPending) this.queueBalanceRefresh();
    }
  }
  private queueBalanceRefresh(): void {
    this.balanceRefreshPending = true;
    if (!this.busy && !this.refreshing) void this.refresh(false);
  }
  private paymentKey(payment: PaymentInfo): string {
    return `${payment.direction}:${payment.paymentHash ?? payment.operationId}`;
  }
  private updatePayment(payment: PaymentInfo, state = this.selected!): void {
    const key = this.paymentKey(payment),
      prior = state.payments.get(key);
    if (prior && prior.version > payment.version) return;
    state.payments.set(key, payment);
    if (prior && payment.complete && !prior.complete) this.queueBalanceRefresh();
    if (
      state === this.selected &&
      payment.channelId === this.channel?.channelId &&
      payment.complete &&
      !prior?.complete
    )
      this.emit({ type: 'payment-complete', payment });
    try {
      localStorage.setItem(state.historyKey, jsonStringify([...state.payments.values()]));
    } catch {
      this.emit({ type: 'history-save-failed' });
    }
    this.callbacks.onChange(this);
  }
  private updateChannel(channel: ChannelInfo, state = this.selected!): void {
    const prior = state.channels.get(channel.operationId);
    if (prior && prior.version > channel.version) return;
    state.channels.set(channel.operationId, channel);
    if (prior && ((channel.ready && !prior.ready) || (channel.closed && !prior.closed)))
      this.queueBalanceRefresh();
    if (
      state === this.selected &&
      state.selectedChannel === channel.operationId &&
      channel.closed &&
      !prior?.closed
    )
      this.emit({ type: 'channel-closed' });
    this.callbacks.onChange(this);
  }
  private attachClient(state = this.selected): FiberLspClient {
    if (state?.client) return state.client;
    if (!state?.tenant.ready) throw Error('Register a tenant first');
    const client = this.lsp.createClient(state.tenant.tenantId);
    state.client = client;
    // Subscribe before the first query so initial state and subsequent changes cannot race.
    client.on(FiberLspEvent.ChannelChanged, (channel) => this.updateChannel(channel, state));
    client.on(FiberLspEvent.BalanceChanged, (channel) => this.updateChannel(channel, state));
    client.on(FiberLspEvent.PaymentChanged, (payment) => this.updatePayment(payment, state));
    client.on(FiberLspEvent.InvoiceChanged, (payment) => this.updatePayment(payment, state));
    client.on(FiberLspEvent.Error, (error) => this.emit({ type: 'error', error }));
    return client;
  }
  private channelId(): Hex {
    if (!this.channel?.channelId || !this.channel.ready || this.channel.closed)
      throw Error('Wait for the channel to be ready');
    return this.channel.channelId;
  }
  async register(newTenant = false): Promise<void> {
    await this.loadTenants();
    // Retry unfinished registration with its original identity, including after a lost response.
    let existing = newTenant
      ? this.tenants.find((tenant) => !tenant.ready)
      : (this.tenant ?? this.tenants.find((tenant) => !tenant.ready));
    if (!existing) {
      const pending = await this.lsp.beginRegistration({ fiberLsp: this.connection.fiberLsp });
      await this.loadTenants();
      existing = this.sessions.get(pending.tenantId)!.tenant;
    }
    this.selectTenant(existing.tenantId);
    try {
      await this.lsp.setup({
        tenantId: existing.tenantId,
        refresh: existing.ready,
        fiberLsp: this.connection.fiberLsp,
        registration: {
          register: (params) =>
            request<RegisterUserResult>(this.baseUrl, '/devnet/register', {
              ...params,
              userId: this.user.id,
            }),
        },
      });
    } finally {
      await this.loadTenants();
    }
    this.attachClient();
  }
  async openChannel(fundingAmount?: bigint): Promise<void> {
    const state = this.selected!;
    try {
      const channel = await this.attachClient(state).openChannel({
        wallet: fundingWallet(this.user.id, this.baseUrl, fundingAmount),
        newChannel: true,
      });
      this.updateChannel(channel, state);
      if (state === this.selected) this.selectChannel(channel.operationId);
    } catch (error) {
      // An interrupted opening may already be persisted. Show it so the next action resumes it.
      await this.refreshChannels(state).catch(() => {});
      throw error;
    }
  }
  async createInvoice(amount: bigint): Promise<string> {
    const payment = await this.attachClient().createInvoice({
      channelId: this.channelId(),
      amount,
      expirySeconds: 3600,
      description: `Recipient: ${this.user.display}`,
    });
    this.updatePayment(payment);
    return payment.invoice;
  }
  async payInvoice(invoice: string): Promise<PaymentInfo> {
    const client = this.attachClient();
    const parsed = client.parseInvoice(invoice);
    if (this.selected!.payments.has(`outgoing:${parsed.paymentHash}`))
      throw Error(
        'This invoice has already been submitted for payment. Check its status; do not pay again.',
      );
    const payment = await client.payInvoice({
      channelId: this.channelId(),
      invoice,
      maxFee: 100_000_000n,
    });
    this.updatePayment(payment);
    return payment;
  }
  async closeChannel(): Promise<void> {
    await this.attachClient().closeChannel(this.channelId());
  }
  private async refreshChannels(state: TenantSession): Promise<void> {
    const channels = await state.client!.listChannels();
    for (const channel of channels) this.updateChannel(channel, state);
    if (!state.selectedChannel || !state.channels.has(state.selectedChannel)) {
      const channel = channels.find((entry) => !entry.closed) ?? channels.at(-1);
      if (channel) {
        state.selectedChannel = channel.operationId;
        sessionStorage.setItem(`${state.historyKey}-channel`, channel.operationId);
      }
    }
  }
  async refresh(queryState = true): Promise<void> {
    if (this.refreshing || this.busy) return;
    this.refreshing = true;
    this.balanceRefreshPending = false;
    try {
      this.balance = (
        await request<WalletBalance>(this.baseUrl, '/devnet/wallet', {
          userId: this.user.id,
          action: 'balance',
        })
      ).capacity;
      for (const state of this.sessions.values()) {
        if (!queryState) break;
        if (!state.client) continue;
        await this.refreshChannels(state);
        for (const entry of [...state.payments.values()]) {
          if (entry.complete || !entry.paymentHash) continue;
          const payment = await state.client.getPayment({
            paymentHash: entry.paymentHash,
            direction: entry.direction,
          });
          if (payment) this.updatePayment(payment, state);
        }
      }
      this.callbacks.onChange(this);
    } catch (error) {
      this.emit({ type: 'error', error });
    } finally {
      this.refreshing = false;
      if (this.balanceRefreshPending) this.queueBalanceRefresh();
    }
  }
  /** Explicit teardown, not a panel logout: cleanup stops processing for all of this user’s tenants. */
  async dispose(): Promise<void> {
    await Promise.all(this.tenants.map((tenant) => this.lsp.cleanup(tenant.tenantId)));
    await this.storage.close();
  }
}
