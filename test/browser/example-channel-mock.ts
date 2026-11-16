import type { Page } from '@playwright/test';
import type { fiberlsp, FiberLspClient, ChannelInfo, PaymentInfo } from '../../src/index.js';

declare global {
  var updateExampleChannel: (
    tenantId: string,
    operationId: string,
    patch: Partial<ChannelInfo>,
  ) => void;
  var exampleChannelActions: { kind: string; channelId: string | null }[];
  var failNextExampleOpening: boolean;
}

// Replace only the SDK client boundary; exercise real account state, storage, and UI.
function installChannelMock(Manager: typeof fiberlsp) {
  const clients = new Map<string, (id: string, patch: Partial<ChannelInfo>) => void>();
  window.exampleChannelActions = [];
  window.updateExampleChannel = (tenantId, id, patch) => clients.get(tenantId)!(id, patch);
  Manager.prototype.createClient = function (tenantId: string) {
    const key = `test-channels-${tenantId}`;
    const channels: ChannelInfo[] = JSON.parse(localStorage.getItem(key) ?? '[]').map(
      (entry: ChannelInfo) => ({
        ...entry,
        localBalance: BigInt(entry.localBalance),
        remoteBalance: BigInt(entry.remoteBalance),
      }),
    );
    const listeners = new Map<string, ((value: unknown) => void)[]>();
    const save = () =>
      localStorage.setItem(
        key,
        JSON.stringify(channels, (_key, value) =>
          typeof value === 'bigint' ? String(value) : value,
        ),
      );
    const emit = (channel: ChannelInfo) => {
      for (const cb of listeners.get('channelChanged') ?? []) cb({ ...channel });
    };
    clients.set(tenantId, (id, patch) => {
      const channel = channels.find((entry) => entry.operationId === id)!;
      Object.assign(channel, patch);
      save();
      emit(channel);
    });
    return {
      on(event: string, cb: (value: unknown) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        return () => {};
      },
      async listChannels() {
        return channels.map((channel) => ({ ...channel }));
      },
      async openChannel(options: { newChannel?: boolean }) {
        if (!options.newChannel) throw Error('Additional opening must be explicit');
        let channel = channels.find((entry) => entry.needsWallet);
        if (!channel) {
          const index = channels.length + 1;
          channel = {
            tenantId,
            operationId: `opening-${index}`,
            channelId: `0x${String(index).padStart(64, '0')}`,
            state: 'ChannelReady',
            ready: true,
            closed: false,
            localBalance: BigInt(index) * 100000000n,
            remoteBalance: BigInt(index) * 200000000n,
            version: 1,
          };
          channels.push(channel);
        } else {
          Object.assign(channel, { ready: true, needsWallet: false, state: 'ChannelReady' });
          channel.version++;
        }
        if (window.failNextExampleOpening) {
          window.failNextExampleOpening = false;
          Object.assign(channel, {
            ready: false,
            needsWallet: true,
            state: 'intent',
            channelId: null,
          });
          save();
          throw Error('Opening response lost');
        }
        channel.channelId ??= `0x${String(channels.length).padStart(64, '0')}`;
        save();
        emit(channel);
        return { ...channel };
      },
      async createInvoice({
        channelId,
        amount,
      }: {
        channelId: ChannelInfo['channelId'];
        amount: bigint;
      }) {
        window.exampleChannelActions.push({ kind: 'invoice', channelId });
        return {
          tenantId,
          channelId,
          operationId: `invoice-${channelId}`,
          paymentHash: channelId,
          amount,
          direction: 'incoming',
          status: 'Paid',
          complete: true,
          invoice: `invoice-${channelId}`,
          version: 1,
        } as PaymentInfo;
      },
      parseInvoice() {
        return { paymentHash: `0x${'ab'.repeat(32)}` };
      },
      async payInvoice({ channelId, invoice }: { channelId: string; invoice: string }) {
        window.exampleChannelActions.push({ kind: 'pay', channelId });
        return {
          tenantId,
          channelId,
          invoice,
          operationId: 'payment',
          paymentHash: `0x${'ab'.repeat(32)}`,
          direction: 'outgoing',
          status: 'Success',
          complete: true,
          amount: 100000000n,
          version: 1,
        } as PaymentInfo;
      },
      async closeChannel(id: string) {
        window.exampleChannelActions.push({ kind: 'close', channelId: id });
        const channel = channels.find((entry) => entry.channelId === id)!;
        Object.assign(channel, { ready: false, closed: true, state: 'Closed' });
        channel.version++;
        save();
        emit(channel);
        return { ...channel };
      },
    } as unknown as FiberLspClient;
  };
}

export async function mockExampleChannels(page: Page) {
  await page.route('**/example/browser/account-session.js', async (route) => {
    const url = new URL(route.request().url());
    url.hostname = '127.0.0.1';
    const response = await route.fetch({ url: url.href });
    await route.fulfill({
      response,
      body: `${await response.text()}\n(${installChannelMock.toString()})(fiberlsp);`,
    });
  });
}
