import type { RegisterLspTenantParams } from '../src/types.js';
import type { RpcParams, RpcRequestOptions } from './fixture-types.ts';
import type { TenantRecord } from '../src/state.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MemoryStorage,
  fiberlsp,
  FiberLspEvent,
  debugRegisterTenant,
  FiberLspError,
  toHex,
  fromHex,
} from '../dist/index.js';
import { make, register, result, config, chain, fetchRpc, key } from './helpers.ts';
test('registration proof, result validation and client caching', async () => {
  let fetches = 0;
  const { lsp, storage } = make({
    fetch: async () => {
      fetches++;
      throw Error('no');
    },
  });
  assert.deepEqual(await lsp.listTenants(), []);
  assert.equal(fetches, 0);
  const p = await lsp.beginRegistration({ fiberLsp: config });
  assert.match(p.tenantId, /^[0-9a-f]{64}$/);
  assert.match(p.params.signature, /^[0-9a-f]{128}$/);
  assert.match(p.params.request_id, /^0x[0-9a-f]{64}$/);
  assert.equal(typeof p.params.signed_at, 'string');
  const [pending] = await lsp.listTenants();
  assert.equal(pending.ready, false);
  assert.equal(pending.credentialStatus, 'unregistered');
  assert.equal((await storage.list<Record<string, unknown>>(''))[0].value.root, undefined);
  await assert.rejects(
    lsp.finishRegistration(p.tenantId, result('f'.repeat(64), p.params.root_signer_pubkey)),
    /identity/,
  );
  await assert.rejects(
    lsp.finishRegistration(p.tenantId, result(p.tenantId, p.params.root_signer_pubkey, '')),
    /empty/,
  );
  await assert.rejects(lsp.finishRegistration(p.tenantId, result(p.tenantId, key)), /identity/);
  const info = await lsp.finishRegistration(
    p.tenantId,
    result(p.tenantId, p.params.root_signer_pubkey),
  );
  assert.equal(info.ready, true);
  assert.equal(info.credentialStatus, 'available');
  const a = lsp.createClient(info.tenantId);
  assert.equal(a, lsp.createClient(info.tenantId));
  const clean = lsp.cleanup(info.tenantId);
  assert.throws(
    () => lsp.createClient(info.tenantId),
    (e) => e instanceof FiberLspError && e.code === 'CLEANING_UP',
  );
  await clean;
  const b = lsp.createClient(info.tenantId);
  assert.notEqual(b, a);
  await assert.rejects(a.listChannels(), (e) => e instanceof FiberLspError && e.code === 'CLOSED');
  const directCleanup = b.cleanup();
  assert.equal(lsp.cleanup(info.tenantId), directCleanup);
  assert.throws(
    () => lsp.createClient(info.tenantId),
    (e) => e instanceof FiberLspError && e.code === 'CLEANING_UP',
  );
  await directCleanup;
  assert.notEqual(lsp.createClient(info.tenantId), b);
  await lsp.cleanup(info.tenantId);
  await lsp.cleanup(info.tenantId);
  assert.equal((await lsp.listTenants()).length, 1);
});
test('failed registration retains identity, fresh proof and immutable provider binding', async () => {
  const { lsp } = make();
  let observed: RegisterLspTenantParams;
  await assert.rejects(
    lsp.setup({
      fiberLsp: config,
      registration: {
        register: async (params) => {
          observed = params;
          throw Error('backend unavailable');
        },
      },
    }),
    /backend/,
  );
  const [saved] = await lsp.listTenants();
  assert.equal(saved.ready, false);
  const p = await lsp.beginRegistration({ tenantId: saved.tenantId, fiberLsp: config });
  assert.equal(p.params.root_signer_pubkey, observed!.root_signer_pubkey);
  assert.notEqual(p.params.request_id, observed!.request_id);
  await assert.rejects(
    lsp.beginRegistration({
      tenantId: saved.tenantId,
      fiberLsp: { ...config, rpcUrl: 'http://localhost:8999' },
    }),
    /cannot change/,
  );
  const ready = await lsp.setup({
    tenantId: saved.tenantId,
    fiberLsp: config,
    registration: { register: async (params) => result(saved.tenantId, params.root_signer_pubkey) },
  });
  assert.equal(ready.tenantId, saved.tenantId);
  let called = false;
  await lsp.setup({
    tenantId: saved.tenantId,
    fiberLsp: config,
    registration: {
      register: async () => {
        called = true;
        throw Error();
      },
    },
  });
  assert.equal(called, false);
});
test('storage failure prevents registration backend invocation', async () => {
  class FailingStorage extends MemoryStorage {
    async commit() {
      throw new Error('disk full');
    }
  }
  const { lsp } = make({ storage: new FailingStorage() });
  let called = false;
  await assert.rejects(
    lsp.setup({
      fiberLsp: config,
      registration: {
        register: async () => {
          called = true;
          throw Error();
        },
      },
    }),
    /disk full/,
  );
  assert.equal(called, false);
});
test('debug registration uses explicit admin bearer, validates response and does not retain it', async () => {
  let seen: { method: string; p: RpcParams; options: RpcRequestOptions };
  const params: RegisterLspTenantParams = {
    root_signer_pubkey: key,
    request_id: `0x${'00'.repeat(32)}` as const,
    signed_at: '0x1',
    signature: '00'.repeat(64),
  };
  const expected = result('1'.repeat(64), key);
  const response = await debugRegisterTenant({
    rpcUrl: config.rpcUrl,
    token: 'admin-secret',
    params,
    fetch: fetchRpc((method, p, options) => {
      seen = { method, p, options };
      return expected;
    }),
  });
  assert.deepEqual(response, expected);
  assert.equal(seen!.method, 'lsp_register_tenant');
  assert.equal(seen!.options.headers.authorization, 'Bearer admin-secret');
  assert.deepEqual(seen!.p, params);
  await assert.rejects(debugRegisterTenant({ rpcUrl: config.rpcUrl, token: ' ', params }), /empty/);
});
test('corrupt records and mismatched root keys never create a replacement identity', async () => {
  const { lsp, storage } = make();
  const tenant = await register(lsp);
  const records = await storage.list<TenantRecord>('tenant/');
  records[0].value.signer.snapshot = 'broken';
  await storage.commit(records);
  const client = lsp.createClient(tenant.tenantId);
  await assert.rejects(
    client.listChannels(),
    (e) => e instanceof FiberLspError && e.code === 'VERIFICATION',
  );
  await lsp.cleanup(tenant.tenantId);
  assert.equal((await lsp.listTenants())[0].tenantId, tenant.tenantId);
});
test('bigint RPC integers preserve precision and reject unsafe numbers', () => {
  const value = (1n << 127n) + 7n;
  assert.equal(fromHex(toHex(value)), value);
  assert.throws(() => toHex(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => fromHex('0x01'));
  assert.throws(() => toHex(-1n));
});
test('invalid curve points are rejected before allocating a tenant identity', async () => {
  const { lsp } = make();
  await assert.rejects(
    lsp.beginRegistration({ fiberLsp: { ...config, nodePublicKey: '02' + 'ff'.repeat(32) } }),
    (e) => e instanceof FiberLspError && e.code === 'VERIFICATION',
  );
  assert.deepEqual(await lsp.listTenants(), []);
});
