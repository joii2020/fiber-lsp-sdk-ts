import type { WebSocket } from 'ws';
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { FiberLspEvent } from '../dist/index.js';
import { make, register, config, fetchRpc } from './helpers.ts';
const until = async (f: () => boolean) => {
  for (let i = 0; i < 150; i++) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Timed out');
};
test('native WebSocket uses bearer headers, reconnects, and queries state after subscription', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let connections = 0,
    queries = 0;
  const sockets: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    connections++;
    sockets.push(socket);
    assert.equal(request.headers.authorization, 'Bearer tenant-token');
    assert.equal(request.headers['sec-websocket-protocol'], undefined);
    socket.on('message', (bytes) => {
      const msg = JSON.parse(String(bytes));
      assert.equal(msg.method, 'subscribe');
      assert.deepEqual(msg.params, ['channel_signing', {}]);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: `sub-${connections}` }));
    });
  });
  const { lsp } = make({
    pollIntervalMs: 30,
    requestTimeoutMs: 2000,
    fetch: fetchRpc((method) => {
      if (method === 'list_channels') {
        queries++;
        return { channels: [] };
      }
      throw Error(method);
    }),
  });
  const info = await register(lsp, { ...config, wsUrl: `ws://127.0.0.1:${address.port}` });
  const client = lsp.createClient(info.tenantId);
  let errors = [];
  client.on(FiberLspEvent.Error, (e) => errors.push(e));
  try {
    await client.listChannels();
    assert.equal(connections, 1);
    const before = queries;
    sockets[0].send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscription',
        params: { subscription: 'sub-1', result: { type: 'channel_signing' } },
      }),
    );
    await until(() => queries > before);
    sockets[0].terminate();
    await until(() => connections >= 2);
    assert.ok(errors.length);
    assert.equal(lsp.createClient(info.tenantId), client);
  } finally {
    await lsp.cleanup(info.tenantId);
    for (const s of sockets) s.terminate();
    await new Promise((r) => server.close(r));
  }
});
