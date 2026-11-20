import type { TestContext } from 'node:test';
import type { RpcParams } from './fixture-types.ts';
import type { ChannelHarness } from './channel-helpers.ts';
import type { TenantRecord } from '../src/state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { FiberLspError, FiberLspEvent, RpcError } from '../dist/index.js';
import { SigningSubscription } from '../dist/subscription.js';
import { transactionHash } from '../dist/wasm/index.js';
import { channelHarness } from './channel-helpers.ts';
import { make, register, fetchRpc } from './helpers.ts';

async function until(f: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!f()) {
    if (Date.now() > deadline) throw Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function wire(
  t: TestContext,
  handler: (method: string, params: RpcParams, socket: WebSocket) => unknown | Promise<unknown>,
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sockets: WebSocket[] = [];
  const subscriptions: WebSocket[] = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', async (bytes) => {
      const msg = JSON.parse(String(bytes));
      try {
        const result =
          msg.method === 'subscribe' ? 'sub' : await handler(msg.method, msg.params[0], socket);
        if (result !== undefined && socket.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        if (msg.method === 'subscribe') subscriptions.push(socket);
      } catch (error) {
        const failure = error as { rpcCode?: number; message?: string };
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: failure.rpcCode ?? -32000, message: failure.message ?? String(error) },
            }),
          );
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${address.port}`, sockets, subscriptions };
}

function push(socket: WebSocket, channelId: string, status: unknown) {
  socket.send(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'subscribe',
      params: {
        subscription: 'sub',
        result: { type: 'channel_signing', data: { channel_id: channelId, status } },
      },
    }),
  );
}

test('opening and closing consume verified signing pushes without HTTP or signing-status queries', async (t) => {
  let h: ChannelHarness;
  let closing = false,
    closed = false;
  const requests: string[] = [];
  const transport = await wire(t, async (method, params, socket) => {
    requests.push(method);
    assert.notEqual(method, 'get_channel_signing_status');
    const result = await h.handleRpc(method, params);
    if (method === 'submit_signed_funding_tx' || method === 'submit_channel_signature')
      push(
        socket,
        h.f.proposal.channel_id,
        closing
          ? { type: 'NoSignatureRequired' }
          : (h.f.statuses[h.getIndex()] ?? { type: 'NoSignatureRequired' }),
      );
    if (method === 'shutdown_channel') push(socket, h.f.proposal.channel_id, h.f.closeStatus);
    return result;
  });
  h = await channelHarness({
    wsUrl: transport.url,
    sdk: { fetch: async () => assert.fail('HTTP is not needed with a healthy WebSocket') },
    handler(method) {
      if (method === 'shutdown_channel') {
        closing = true;
        return {};
      }
      if (method === 'submit_channel_signature' && closing) {
        closed = true;
        return { type: 'Submitted' };
      }
      if (method === 'list_channels' && closing)
        return {
          channels: [
            {
              channel_id: h.f.proposal.channel_id,
              pubkey: h.f.nodePublicKey,
              is_public: false,
              state: { state_name: closed ? 'Closed' : 'ShuttingDown', state_flags: '' },
              local_balance: `0x${(50000000000n - BigInt(h.f.reserve)).toString(16)}`,
              remote_balance: `0x${(50000000000n - BigInt(h.f.reserve)).toString(16)}`,
              shutdown_transaction_hash: closed ? transactionHash(h.f.closeTransaction) : null,
            },
          ],
        };
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  const original = h.provider.getTransaction;
  h.provider.getTransaction = async (hash, network) =>
    hash === transactionHash(h.f.closeTransaction) ? h.f.closeTransaction : original(hash, network);
  const changes: { ready: boolean; closed: boolean }[] = [];
  const errors: Error[] = [];
  h.client.on(FiberLspEvent.Error, (error) => errors.push(error));
  h.client.on(FiberLspEvent.ChannelChanged, (channel) => changes.push(channel));
  await h.client.openChannel({ wallet: h.wallet });
  await until(() => changes.some((c) => c.ready));
  assert.deepEqual(errors, []);
  assert.equal(h.getIndex(), 2);
  const count = requests.filter((method) => method === 'submit_channel_signature').length;
  push(transport.sockets[0]!, h.f.proposal.channel_id, h.f.statuses[1]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.filter((method) => method === 'submit_channel_signature').length, count);
  await h.client.closeChannel(h.f.proposal.channel_id);
  await until(() => changes.some((c) => c.closed));
  assert.deepEqual(errors, []);
  assert.equal(requests.filter((method) => method === 'shutdown_channel').length, 1);
});

test('a tampered pushed signing request cannot submit a signature', async (t) => {
  let h: ChannelHarness;
  const transport = await wire(t, (method, params) => h.handleRpc(method, params));
  h = await channelHarness({ wsUrl: transport.url });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  const errors: Error[] = [];
  h.client.on(FiberLspEvent.Error, (error) => errors.push(error));
  await h.client.openChannel({ wallet: h.wallet });
  const status = structuredClone(h.f.statuses[0]!);
  status.settlement.local_amount = `0x${(BigInt(status.settlement.local_amount) + 1n).toString(16)}`;
  push(transport.sockets[0]!, h.f.proposal.channel_id, status);
  await until(() => errors.some((e) => e instanceof FiberLspError && e.code === 'VERIFICATION'));
  assert.equal(h.calls.filter(([method]) => method === 'submit_channel_signature').length, 0);
});

test('a silent WebSocket subscription still reconciles pending signatures', async (t) => {
  let h: ChannelHarness;
  const transport = await wire(t, (method, params) => h.handleRpc(method, params));
  h = await channelHarness({
    wsUrl: transport.url,
    sdk: {
      pollIntervalMs: 20,
      webSocketPollIntervalMs: 40,
      fetch: async () => assert.fail('Fallback reconciliation should reuse WebSocket'),
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  let ready = false;
  h.client.on(FiberLspEvent.ChannelChanged, (channel) => {
    ready ||= channel.ready;
  });
  await h.client.openChannel({ wallet: h.wallet });
  await until(() => ready);
  assert.equal(h.getIndex(), 2);
  assert.ok(h.calls.some(([method]) => method === 'get_channel_signing_status'));
});

test('reconnecting replays and verifies pending signing requests', async (t) => {
  let h: ChannelHarness;
  let replay = false;
  const transport = await wire(t, async (method, params, socket) => {
    if (method === 'get_channel_signing_status')
      return {
        channel_id: h.f.proposal.channel_id,
        status: { type: 'NoSignatureRequired' },
      };
    const result = await h.handleRpc(method, params);
    if (replay && method === 'submit_channel_signature')
      push(
        socket,
        h.f.proposal.channel_id,
        h.f.statuses[h.getIndex()] ?? { type: 'NoSignatureRequired' },
      );
    return result;
  });
  h = await channelHarness({
    wsUrl: transport.url,
    sdk: {
      pollIntervalMs: 20,
      webSocketPollIntervalMs: 60000,
      fetch: fetchRpc((method, params) =>
        method === 'get_channel_signing_status'
          ? { channel_id: h.f.proposal.channel_id, status: { type: 'NoSignatureRequired' } }
          : h.handleRpc(method, params),
      ),
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  let ready = false;
  h.client.on(FiberLspEvent.ChannelChanged, (channel) => {
    ready ||= channel.ready;
  });
  await h.client.openChannel({ wallet: h.wallet });
  assert.equal(h.getIndex(), 0);
  transport.sockets[0]!.terminate();
  await until(() => transport.subscriptions.length === 2);
  assert.equal(h.getIndex(), 0, 'signing waits for the pending request replay');
  replay = true;
  push(transport.sockets[1]!, h.f.proposal.channel_id, h.f.statuses[h.getIndex()]);
  await until(() => ready);
  assert.equal(h.getIndex(), 2);
  assert.equal(
    h.calls.filter(([method]) => method === 'open_channel_with_external_funding').length,
    1,
  );
});

for (const failure of ['disconnect', 'timeout'] as const) {
  test(`a WebSocket write ${failure} is not replayed through HTTP`, async (t) => {
    let h: ChannelHarness;
    let writes = 0,
      http = 0;
    const transport = await wire(t, async (method, params, socket) => {
      const result = await h.handleRpc(method, params);
      if (method === 'open_channel_with_external_funding') {
        writes++;
        if (failure === 'disconnect') socket.terminate();
        return undefined;
      }
      return result;
    });
    h = await channelHarness({
      wsUrl: transport.url,
      sdk: {
        requestTimeoutMs: 100,
        fetch: async () => {
          http++;
          throw Error('Unexpected HTTP');
        },
      },
    });
    t.after(() => h.lsp.cleanup(h.f.tenantId));
    await assert.rejects(
      h.client.openChannel({ wallet: h.wallet }),
      (error) => error instanceof FiberLspError && error.code === 'NETWORK',
    );
    assert.equal(writes, 1);
    assert.equal(http, 0);
  });
}

test('WebSocket RPC correlates concurrent responses and preserves missing-record errors', async (t) => {
  const transport = await wire(t, async (method, params) => {
    if (method === 'missing') throw { rpcCode: -32000, message: 'invoice not found' };
    if (method === 'bigint') return params.amount;
    if (method === 'slow') await new Promise((resolve) => setTimeout(resolve, 50));
    return method;
  });
  const subscription = new SigningSubscription(
    () => {},
    () => {},
  );
  t.after(() => subscription.close());
  await subscription.connect(transport.url, 'tenant-token');
  assert.deepEqual(
    await Promise.all([subscription.call('slow', {}), subscription.call('fast', {})]),
    ['slow', 'fast'],
  );
  await assert.rejects(
    subscription.call('missing', {}),
    (error) =>
      error instanceof RpcError &&
      error.rpcCode === -32000 &&
      error.message === 'invoice not found',
  );
  assert.equal(
    await subscription.call('bigint', { amount: 2n ** 100n }),
    `0x${(2n ** 100n).toString(16)}`,
  );
});

test('WebSocket authorization errors pause the tenant until its credential is refreshed', async (t) => {
  const transport = await wire(t, () => {
    throw { rpcCode: -32999, message: 'Unauthorized' };
  });
  const { lsp, storage } = make({
    fetch: async () => assert.fail('AUTH must not fall back to HTTP'),
  });
  const info = await register(lsp);
  t.after(() => lsp.cleanup(info.tenantId));
  await lsp.setWebSocketUrl(info.tenantId, transport.url);
  await assert.rejects(
    lsp.createClient(info.tenantId).listChannels(),
    (error) => error instanceof FiberLspError && error.code === 'AUTH',
  );
  assert.equal((await storage.get<TenantRecord>(`tenant/${info.tenantId}`))!.authInvalid, true);
});

test('existing HTTP tenants can enable WebSocket without registering again, and fall back when offline', async (t) => {
  const { lsp, storage } = make({
    requestTimeoutMs: 100,
    fetch: fetchRpc((method) => {
      assert.equal(method, 'list_channels');
      return { channels: [] };
    }),
  });
  const info = await register(lsp);
  t.after(() => lsp.cleanup(info.tenantId));
  const client = lsp.createClient(info.tenantId);
  await client.listChannels();
  const before = (await storage.get<TenantRecord>(`tenant/${info.tenantId}`))!;
  await assert.rejects(lsp.setWebSocketUrl(info.tenantId, 'https://invalid.example'));
  await lsp.setWebSocketUrl(info.tenantId, 'ws://127.0.0.1:1');
  assert.deepEqual(await client.listChannels(), []);
  const after = (await storage.get<TenantRecord>(`tenant/${info.tenantId}`))!;
  assert.equal(after.token, before.token);
  assert.equal(after.info.publicKey, before.info.publicKey);
  await lsp.setWebSocketUrl(info.tenantId);
  assert.equal((await lsp.listTenants())[0]!.fiberLsp.wsUrl, undefined);
});
