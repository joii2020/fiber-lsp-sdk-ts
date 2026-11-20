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
test('native WebSocket carries queries, processes pushes before the poll deadline and reconnects', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let connections = 0,
    queries = 0,
    httpQueries = 0;
  const sockets: WebSocket[] = [];
  server.on('connection', (socket, request) => {
    connections++;
    sockets.push(socket);
    assert.equal(request.headers.authorization, 'Bearer tenant-token');
    assert.equal(request.headers['sec-websocket-protocol'], undefined);
    socket.on('message', (bytes) => {
      const msg = JSON.parse(String(bytes));
      if (msg.method === 'subscribe') {
        assert.deepEqual(msg.params, ['channel_signing', {}]);
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: `sub-${connections}` }));
      } else {
        assert.equal(msg.method, 'list_channels');
        assert.deepEqual(msg.params, [{ include_closed: true }]);
        queries++;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { channels: [] } }));
      }
    });
  });
  const { lsp } = make({
    pollIntervalMs: 30,
    webSocketPollIntervalMs: 60000,
    requestTimeoutMs: 2000,
    fetch: fetchRpc((method) => {
      assert.equal(method, 'list_channels');
      httpQueries++;
      return { channels: [] };
    }),
  });
  const info = await register(lsp, { ...config, wsUrl: `ws://127.0.0.1:${address.port}` });
  const client = lsp.createClient(info.tenantId);
  let errors = [];
  client.on(FiberLspEvent.Error, (e) => errors.push(e));
  try {
    await client.listChannels();
    assert.equal(connections, 1);
    assert.equal(httpQueries, 0);
    const before = queries;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(queries, before, 'idle connections use the slower reconciliation interval');
    sockets[0].send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscription',
        params: {
          subscription: 'sub-1',
          result: {
            type: 'channel_signing',
            data: { channel_id: `0x${'11'.repeat(32)}`, status: { type: 'NoSignatureRequired' } },
          },
        },
      }),
    );
    await until(() => queries > before);
    assert.equal(httpQueries, 0);
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
