import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { attachDevnetWebSocket } from '../examples/server/websocket.ts';

test('same-origin WebSocket proxy forwards tenant subprotocols, RPC and pushes, and rejects foreign origins', async (t) => {
  const upstream = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) => (protocols.has('fiber-rpc') ? 'fiber-rpc' : false),
  });
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress !== 'string');
  let connections = 0;
  upstream.on('connection', (socket, request) => {
    connections++;
    assert.equal(request.headers.authorization, undefined);
    assert.equal(
      request.headers['sec-websocket-protocol'],
      'fiber-rpc,base64url.bearer.authorization.fiber.tenant-token',
    );
    socket.on('message', (bytes) => {
      const body = JSON.parse(String(bytes));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'sub' }));
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'subscribe',
          params: {
            subscription: 'sub',
            result: {
              type: 'channel_signing',
              data: {
                channel_id: `0x${'11'.repeat(32)}`,
                status: { type: 'NoSignatureRequired' },
              },
            },
          },
        }),
      );
    });
  });
  const server = createServer();
  const relay = attachDevnetWebSocket(server, `ws://127.0.0.1:${upstreamAddress.port}`);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const localAddress = server.address();
  assert.ok(localAddress && typeof localAddress !== 'string');
  const origin = `http://127.0.0.1:${localAddress.port}`;
  const url = `ws://127.0.0.1:${localAddress.port}/devnet/ws`;
  const protocols = ['fiber-rpc', 'base64url.bearer.authorization.fiber.tenant-token'];
  t.after(async () => {
    for (const socket of relay.clients) socket.terminate();
    for (const socket of upstream.clients) socket.terminate();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });
  for (const [requestOrigin, requestProtocols] of [
    ['https://foreign.example', protocols],
    [origin, ['fiber-rpc']],
  ] as const) {
    const denied = new WebSocket(url, [...requestProtocols], { origin: requestOrigin });
    await assert.rejects(once(denied, 'open'), /403/);
  }
  assert.equal(connections, 0);
  const client = new WebSocket(url, protocols, { origin });
  t.after(() => client.terminate());
  const messages: any[] = [];
  client.on('message', (bytes) => messages.push(JSON.parse(String(bytes))));
  await once(client, 'open');
  assert.equal(client.protocol, 'fiber-rpc');
  client.send(
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'subscribe', params: ['channel_signing', {}] }),
  );
  const deadline = Date.now() + 2000;
  while (messages.length < 2) {
    assert.ok(Date.now() < deadline, 'proxy did not forward the response and push');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(messages[0].id, 7);
  assert.equal(messages[1].params.result.type, 'channel_signing');
  assert.equal(connections, 1);
});
