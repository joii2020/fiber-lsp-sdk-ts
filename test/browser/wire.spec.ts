import type { Script } from '../../src/types.js';
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
test('browser performs HTTP CORS and authenticates WebSocket using the two documented subprotocols', async ({
  page,
}) => {
  const protocols: (string | undefined)[] = [];
  const tokens: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173');
    res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    tokens.push(req.headers.authorization);
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { channels: [] } }));
  });
  const wss = new WebSocketServer({
    server,
    handleProtocols: (set) => (set.has('fiber-rpc') ? 'fiber-rpc' : false),
  });
  wss.on('connection', (socket, req) => {
    protocols.push(req.headers['sec-websocket-protocol']);
    socket.on('message', (bytes) => {
      const m = JSON.parse(String(bytes));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'subscription' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Missing test server port');
  const port = address.port;
  try {
    await page.goto('/');
    await page.evaluate(async (port) => {
      const { fiberlsp, MemoryStorage } = await import('/dist/index.js');
      const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      const script: Script = {
        code_hash: `0x${'11'.repeat(32)}` as const,
        hash_type: 'type',
        args: '0x',
      };
      const lsp = new fiberlsp({
        storage: new MemoryStorage(),
        chain: {
          getTransaction: async () => null,
          getLiveCell: async () => null,
          getCell: async () => null,
        },
        onConfirm: () => true,
      });
      const p = await lsp.beginRegistration({
        fiberLsp: {
          rpcUrl: `http://127.0.0.1:${port}`,
          wsUrl: `ws://127.0.0.1:${port}`,
          nodePublicKey: key,
          network: {
            currency: 'Fibd',
            fundingLock: script,
            commitmentLock: script,
            commitmentCellDeps: 1,
            epochDurationMs: 14400000,
            minimumShutdownFee: 100000000n,
            fundingCellDeps: [],
          },
        },
      });
      await lsp.finishRegistration(p.tenantId, {
        tenant: {
          tenant_id: p.tenantId,
          root_signer_pubkey: p.params.root_signer_pubkey,
          invoice_pubkey: key,
          channels: [],
          created_at: '0x1',
          runtime_status: 'cold',
        },
        access_token: 'browser-token',
      });
      await lsp.createClient(p.tenantId).listChannels();
      await lsp.cleanup(p.tenantId);
    }, port);
    expect(protocols[0]).toBe('fiber-rpc, base64url.bearer.authorization.fiber.browser-token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t === 'Bearer browser-token')).toBe(true);
  } finally {
    for (const s of wss.clients) s.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  }
});
