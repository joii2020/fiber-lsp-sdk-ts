import type { TenantRecord } from '../src/state.js';
import { FiberLspError } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FiberLspEvent, MemoryStorage, fiberlsp } from '../dist/index.js';
import {
  fetchRpc,
  make,
  register,
  key,
  config,
  fixture,
  seedFixture,
  result,
  script,
} from './helpers.ts';
import { signerAction } from '../dist/wasm/index.js';
const noChannels = (method: string) => {
  if (method === 'list_channels') return { channels: [] };
  throw Error(method);
};
test('concurrent queries share recovery; events are persisted, cleanup clears all listeners', async () => {
  const calls = [];
  let resolve!: () => void;
  const gate = new Promise<void>((r) => (resolve = r));
  const { lsp, storage } = make({
    fetch: fetchRpc(async (method) => {
      calls.push(method);
      if (calls.length === 1) await gate;
      return noChannels(method);
    }),
  });
  const info = await register(lsp);
  const c = lsp.createClient(info.tenantId);
  let events: string[] = [];
  const cancel = c.on(FiberLspEvent.ConnectionChanged, (v) => events.push(v.state));
  const a = c.listChannels(),
    b = c.listChannels();
  resolve();
  assert.deepEqual(await a, []);
  assert.deepEqual(await b, []);
  assert.equal(events.filter((e) => e === 'recovering').length, 1);
  await lsp.cleanup(info.tenantId);
  const count = events.length;
  cancel();
  cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.length, count);
  assert.ok((await storage.get<TenantRecord>(`tenant/${info.tenantId}`))!.info.ready);
});
test('direction is mandatory and missing record only maps to null for exact missing errors', async () => {
  const { lsp } = make({
    fetch: fetchRpc((m, p) => {
      if (m === 'list_channels') return { channels: [] };
      if (m === 'get_invoice') throw { rpcCode: -32000, message: 'invoice not found' };
      if (m === 'get_payment')
        throw {
          rpcCode: -32000,
          message: `Invalid parameter: Payment session not found: ${p.payment_hash}`,
        };
      throw Error(m);
    }),
  });
  const info = await register(lsp);
  const c = lsp.createClient(info.tenantId);
  const paymentHash = `0x${'33'.repeat(32)}` as const;
  await assert.rejects(
    // @ts-expect-error Deliberately omit direction to test runtime input validation.
    c.getPayment({ paymentHash }),
    (e) => e instanceof FiberLspError && e.code === 'INVALID_ARGUMENT',
  );
  assert.equal(await c.getPayment({ paymentHash, direction: 'incoming' }), null);
  assert.equal(await c.getPayment({ paymentHash, direction: 'outgoing' }), null);
  await lsp.cleanup(info.tenantId);
});
test('storage lock pauses active runtime, preserves tenant list and resumes original identity', async () => {
  const { lsp, storage } = make({ fetch: fetchRpc(noChannels) });
  const info = await register(lsp);
  const c = lsp.createClient(info.tenantId);
  await c.listChannels();
  assert.ok(storage instanceof MemoryStorage);
  storage.lock();
  assert.equal((await lsp.listTenants())[0].tenantId, info.tenantId);
  await assert.rejects(c.listChannels(), (e) => e instanceof FiberLspError && e.code === 'LOCKED');
  storage.unlock();
  assert.deepEqual(await c.listChannels(), []);
  await lsp.cleanup(info.tenantId);
});
test('locking storage interrupts startup queued by client creation', async (t) => {
  const storage = new MemoryStorage();
  let requests = 0;
  const { lsp } = make({
    storage,
    fetch: fetchRpc((method) => {
      requests++;
      return noChannels(method);
    }),
  });
  const { tenantId } = await register(lsp);
  const client = lsp.createClient(tenantId);
  t.after(() => lsp.cleanup(tenantId));
  const channels = client.listChannels();
  storage.lock();
  storage.unlock();
  await assert.rejects(channels, (e) => e instanceof FiberLspError && e.code === 'LOCKED');
  assert.equal(requests, 0);
  assert.deepEqual(await client.listChannels(), []);
});
test('credential refresh after a WebSocket URL change retains the binding and resumes the client', async (t) => {
  let rejected = true;
  const { lsp } = make({
    fetch: async (url, o) =>
      rejected ? new Response('', { status: 401 }) : fetchRpc(noChannels)(url, o),
    webSocketFactory: () => {
      throw Error('WebSocket unavailable');
    },
  });
  const info = await register(lsp);
  t.after(() => lsp.cleanup(info.tenantId));
  const wsUrl = 'ws://localhost:8119';
  await lsp.setWebSocketUrl(info.tenantId, wsUrl);
  const c = lsp.createClient(info.tenantId);
  await assert.rejects(c.listChannels(), (e) => e instanceof FiberLspError && e.code === 'AUTH');
  const [rejectedTenant] = await lsp.listTenants();
  assert.equal(rejectedTenant.ready, true);
  assert.equal(rejectedTenant.credentialStatus, 'refreshRequired');
  rejected = false;
  const refreshed = await lsp.setup({
    tenantId: info.tenantId,
    fiberLsp: config,
    registration: {
      register: async (p) => result(info.tenantId, p.root_signer_pubkey, 'new-token'),
    },
  });
  assert.equal(refreshed.publicKey, info.publicKey);
  assert.equal(refreshed.credentialStatus, 'available');
  assert.equal(refreshed.fiberLsp.wsUrl, wsUrl);
  assert.equal(lsp.createClient(info.tenantId), c);
  assert.deepEqual(await c.listChannels(), []);
});
test('cleanup interrupts an outstanding confirmation without waiting for the application', async () => {
  let confirming!: () => void;
  const begun = new Promise<void>((r) => (confirming = r));
  const { lsp } = make({
    fetch: fetchRpc(noChannels),
    onConfirm: () => {
      confirming();
      return new Promise(() => {});
    },
  });
  const info = await register(lsp);
  const c = lsp.createClient(info.tenantId);
  const operation = c.openChannel({
    wallet: {
      verifyFunding: async (tx) => tx.inputs.map((input) => input.previous_output),
      signFundingTransaction: async (tx) => tx,
      getFundingTerms: async () => ({
        shutdownScript: script,
        fundingLockScript: script,
        commitmentDelayEpoch: 1n,
        commitmentFeeRate: 1000n,
        fundingFeeRate: 1000n,
        fundingAmount: 100n,
        remoteFundingAmount: 100n,
        maxFundingFee: 10n,
        maxWalletDebit: 110n,
      }),
    },
  });
  const caught = assert.rejects(
    operation,
    (e) => e instanceof FiberLspError && e.code === 'CLOSED',
  );
  await begun;
  await Promise.race([
    lsp.cleanup(info.tenantId),
    new Promise((_, reject) => setTimeout(() => reject(Error('cleanup hung')), 1000)),
  ]);
  await caught;
});
test('real Rust invoice parser works offline and rejects invalid checksums', async () => {
  const f = await fixture();
  const { lsp } = make({
    fetch: async () => {
      throw Error('network prohibited');
    },
  });
  const c = lsp.createClient(f.tenantId);
  const parsed = c.parseInvoice(f.invoice);
  assert.equal(parsed.amount, 1000n);
  assert.equal(parsed.currency, 'Fibd');
  assert.match(parsed.paymentHash, /^0x[0-9a-f]{64}$/);
  assert.equal(parsed.signed, true);
  assert.ok(parsed.expiresAt > Date.now());
  assert.throws(
    () => c.parseInvoice(f.invoice.slice(0, -1) + 'x'),
    (e) => e instanceof FiberLspError && e.code === 'VERIFICATION',
  );
  await lsp.cleanup(f.tenantId);
});
test('Fiber Biscuit JSON-RPC authorization errors pause processing and require credential refresh', async () => {
  const { lsp, storage } = make({
    fetch: fetchRpc(() => {
      throw { rpcCode: -32999, message: 'Unauthorized' };
    }),
  });
  const info = await register(lsp);
  const client = lsp.createClient(info.tenantId);
  try {
    await assert.rejects(
      client.listChannels(),
      (e) => e instanceof FiberLspError && e.code === 'AUTH',
    );
    assert.equal((await storage.get<TenantRecord>(`tenant/${info.tenantId}`))!.authInvalid, true);
  } finally {
    await lsp.cleanup(info.tenantId);
  }
});
