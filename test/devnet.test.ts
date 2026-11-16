import type { TestContext } from 'node:test';
import type { IncomingMessage, RequestListener } from 'node:http';
import { devnetConfig } from './example-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createDevnetHandler } from '../examples/server/index.ts';
import { registerTenant } from '../examples/server/registration.ts';
import { UserStore } from '../examples/server/users.ts';
import { key, result, script } from './helpers.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const registrationProof = {
  root_signer_pubkey: key,
  request_id: '0x01' as const,
  signed_at: '0x1' as const,
  signature: 'signed-proof',
};

async function listen(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('browser RPC forwards only the tenant credential and preserves upstream errors', async (t) => {
  let forwarded = 0;
  const upstream = await listen(t, async (req, res) => {
    forwarded++;
    assert.equal(req.headers.authorization, 'Bearer tenant-token');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.method, 'list_channels');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'Tenant expired' },
      }),
    );
  });
  const handler = createDevnetHandler(devnetConfig(upstream), () => {
    assert.fail('Tenant RPC must never read the operator token');
  });
  const local = await listen(t, (req, res) => handler(req, res, '/devnet/rpc'));
  const headers = { 'Content-Type': 'application/json', Origin: local };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'list_channels', params: [{}] });
  assert.equal((await fetch(local, { method: 'POST', headers, body })).status, 401);
  assert.equal(forwarded, 0);
  const response = await fetch(local, {
    method: 'POST',
    headers: { ...headers, Authorization: 'Bearer tenant-token' },
    body,
  });
  assert.deepEqual(await response.json(), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32000, message: 'Tenant expired' },
  });
  assert.equal(forwarded, 1);
});

test('devnet accepts IP and domain hosts over HTTP or HTTPS while rejecting foreign origins', async (t) => {
  let forwarded = 0;
  const upstream = await listen(t, (_req, res) => {
    forwarded++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }));
  });
  const handler = createDevnetHandler(devnetConfig(upstream));
  const local = await listen(t, (req, res) => handler(req, res, '/devnet/chain'));
  const request = async (host: string, origin: string) => {
    const req = httpRequest(local, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: host, Origin: origin },
    });
    const response = once(req, 'response');
    req.end(JSON.stringify({ method: 'get_transaction', params: ['0x01'] }));
    const [res] = (await response) as [IncomingMessage];
    let body = '';
    for await (const chunk of res) body += chunk;
    return { status: res.statusCode, body: JSON.parse(body) };
  };
  for (const origin of [
    'http://192.0.2.10:8008',
    'http://devnet.example:8008',
    'https://devnet.example',
    'http://[2001:db8::1]:8008',
  ]) {
    const response = await request(new URL(origin).host, origin);
    assert.equal(response.status, 200, origin);
    assert.deepEqual(response.body, { result: null });
  }
  assert.equal((await request('devnet.example:8008', 'http://other.example:8008')).status, 403);
  assert.equal((await request('devnet.example:8008', 'http://devnet.example:9000')).status, 403);
  assert.equal(forwarded, 4);
});

test('devnet browser backend keeps operator credentials local and rejects foreign origins and chain writes', async (t) => {
  let forwarded = 0;
  const upstream = await listen(t, async (req, res) => {
    forwarded++;
    assert.equal(req.headers.authorization, 'Bearer local-operator-secret');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.method, 'lsp_register_tenant');
    assert.equal(body.params.length, 1);
    assert.equal(body.params[0].rpcUrl, undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { access_token: 'tenant-token' } }),
    );
  });
  let tokenReads = 0;
  const config = devnetConfig(upstream);
  const handler = createDevnetHandler(config, async () => {
    tokenReads++;
    return 'local-operator-secret';
  });
  const local = await listen(t, async (req, res) => {
    if (!(await handler(req, res, new URL(req.url ?? '/', 'http://localhost').pathname))) {
      res.writeHead(404);
      res.end();
    }
  });
  const publicConfig = await (await fetch(`${local}/devnet/config`)).text();
  assert.deepEqual(JSON.parse(publicConfig), config);
  assert.equal(publicConfig.includes('local-operator-secret'), false);
  const proof = {
    root_signer_pubkey: 'key',
    request_id: '0x01',
    signed_at: '0x1',
    signature: 'sig',
    rpcUrl: 'http://untrusted.invalid',
  };
  const request = (path: string, input: unknown, origin = local) =>
    fetch(`${local}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(input),
    });
  assert.equal((await request('/devnet/register', proof, 'https://untrusted.invalid')).status, 403);
  assert.equal(
    (await request('/devnet/chain', { method: 'send_transaction', params: [] })).status,
    400,
  );
  assert.equal(tokenReads, 0);
  assert.equal(forwarded, 0);
  const registered = await request('/devnet/register', proof);
  assert.equal(registered.status, 200);
  assert.deepEqual(await registered.json(), { access_token: 'tenant-token' });
  assert.equal(tokenReads, 1);
  assert.equal(forwarded, 1);
  assert.equal(
    (await request('/devnet/register', { ...proof, signature: 'x'.repeat(17_000) })).status,
    413,
  );
  assert.equal(tokenReads, 1);
});

test('server registration works without HTTP routes or user storage and reads fresh operator credentials', async (t) => {
  let calls = 0;
  const upstream = await listen(t, async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer operator-${calls}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.method, 'lsp_register_tenant');
    assert.deepEqual(request.params, [registrationProof]);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: result('tenant-a', key, `tenant-token-${calls}`),
      }),
    );
  });
  let tokenReads = 0;
  const options = {
    rpcUrl: upstream,
    readToken: async () => ` operator-${++tokenReads}\n`,
  };
  for (const attempt of [1, 2]) {
    // Extra application fields must not be forwarded to the LSP.
    const proof = { ...registrationProof, userId: 'alice', rpcUrl: 'http://untrusted.invalid' };
    assert.deepEqual(
      await registerTenant(proof, options),
      result('tenant-a', key, `tenant-token-${attempt}`),
    );
  }
  assert.equal(tokenReads, 2);
  assert.equal(calls, 2);
});

test('server registration retains the user identity after an upstream failure and deduplicates retry bindings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fiber-example-registration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'users.json');
  const users = new UserStore(file, 'chain:lsp');
  const user = await users.create({ name: 'alice', display: 'Alice', accountIndex: 6 }, [
    { index: 6, address: 'alice-address', lockScript: script },
  ]);
  let calls = 0;
  const upstream = await listen(t, async (req, res) => {
    calls++;
    assert.deepEqual((await users.get(user.id)).rootPublicKeys, [key]);
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.deepEqual(request.params, [registrationProof]);
    if (calls === 1) {
      res.writeHead(503);
      res.end('Registration response unavailable');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result('tenant-a', key) }));
  });
  const options = {
    rpcUrl: upstream,
    readToken: async () => 'operator-secret',
    user: { id: user.id, store: users },
  };
  await assert.rejects(
    registerTenant(registrationProof, { ...options, user: { id: 'missing-user', store: users } }),
    /User not found/,
  );
  assert.equal(calls, 0);
  await assert.rejects(registerTenant(registrationProof, options));
  assert.deepEqual((await users.get(user.id)).rootPublicKeys, [key]);
  assert.deepEqual((await users.get(user.id)).tenantIds, []);
  for (const _ of [1, 2])
    assert.deepEqual(await registerTenant(registrationProof, options), result('tenant-a', key));
  const saved = await new UserStore(file, 'chain:lsp').get(user.id);
  assert.deepEqual(saved.rootPublicKeys, [key]);
  assert.deepEqual(saved.tenantIds, ['tenant-a']);
  const json = await readFile(file, 'utf8');
  assert.equal(json.includes('operator-secret'), false);
  assert.equal(json.includes('tenant-token'), false);
  assert.equal(calls, 3);
});
