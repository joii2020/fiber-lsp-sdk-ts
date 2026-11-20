import type { PaymentInfo } from '../src/types.js';
import type { ChannelHarness } from './channel-helpers.ts';
import type { RpcParams } from './fixture-types.ts';
import type { TenantRecord } from '../src/state.js';
import { FiberLspError, FiberLspEvent, MemoryStorage } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelHarness } from './channel-helpers.ts';
import { fiberlsp } from '../dist/index.js';
import { paymentHash } from '../dist/wasm/index.js';
test('invoice hash and authorization are durable before send; a timeout never resends payment', async () => {
  let h: ChannelHarness;
  h = await channelHarness({
    handler: async (method, params) => {
      if (method === 'send_payment') {
        const record = (await h.storage.get<TenantRecord>(`tenant/${h.f.tenantId}`))!;
        const op = record.payments[0];
        assert.equal(op.info.paymentHash, params.payment_hash);
        assert.equal(op.sent, true);
        assert.equal(op.authorization!.amount, '0x3e8');
        assert.equal(params.max_parts, '0x1');
        assert.equal(params.trampoline_hops, undefined);
        throw Error('response lost');
      }
    },
  });
  try {
    await h.client.openChannel({ wallet: h.wallet });
    await h.client.listChannels();
    await assert.rejects(
      h.client.payInvoice({
        channelId: h.f.proposal.channel_id,
        invoice: h.f.invoice,
        maxFee: 100n,
      }),
      (e) => e instanceof FiberLspError && e.code === 'NETWORK',
    );
    const payment = h.client.parseInvoice(h.f.invoice).paymentHash;
    assert.equal(await h.client.getPayment({ paymentHash: payment, direction: 'outgoing' }), null);
    await assert.rejects(
      h.client.payInvoice({
        channelId: h.f.proposal.channel_id,
        invoice: h.f.invoice,
        maxFee: 100n,
      }),
      (e) => e instanceof FiberLspError && e.code === 'CONFLICT',
    );
    assert.equal(h.calls.filter(([m]) => m === 'send_payment').length, 1);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('server Success alone never reports a completed payment without TLC/recovery evidence', async () => {
  let sent = false;
  let h: ChannelHarness;
  h = await channelHarness({
    handler: (method, params) => {
      if (method === 'send_payment') {
        sent = true;
        return {
          payment_hash: params.payment_hash,
          status: 'Success',
          fee: '0x0',
          payment_preimage: `0x${'09'.repeat(32)}` as const,
        };
      }
      if (method === 'get_payment' && sent)
        return {
          payment_hash: h.client.parseInvoice(h.f.invoice).paymentHash,
          status: 'Success',
          fee: '0x0',
          payment_preimage: `0x${'09'.repeat(32)}` as const,
        };
    },
  });
  try {
    await h.client.openChannel({ wallet: h.wallet });
    await h.client.listChannels();
    const payment = await h.client.payInvoice({
      channelId: h.f.proposal.channel_id,
      invoice: h.f.invoice,
      maxFee: 0n,
    });
    assert.equal(payment.status, 'Success');
    assert.equal(payment.complete, false);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('querying a completed payment preserves the saved result and allows another payment', async (t) => {
  const historicalHash = `0x${'11'.repeat(32)}` as const;
  const nextHash = `0x${'22'.repeat(32)}` as const;
  const h = await channelHarness({
    handler(method, params) {
      if (method === 'send_payment')
        return { payment_hash: nextHash, status: 'Inflight', fee: '0x0' };
      if (method === 'get_payment')
        return {
          payment_hash: params.payment_hash,
          status: params.payment_hash === historicalHash ? 'Success' : 'Inflight',
          fee: '0x0',
        };
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  await h.client.openChannel({ wallet: h.wallet });
  assert.equal((await h.client.listChannels())[0].ready, true);
  const channelId = h.f.proposal.channel_id;
  const key = `tenant/${h.f.tenantId}`;
  const previous = (await h.storage.get<TenantRecord>(key))!;
  const info: PaymentInfo = {
    tenantId: h.f.tenantId,
    operationId: historicalHash,
    channelId,
    paymentHash: historicalHash,
    direction: 'outgoing',
    status: 'Success',
    complete: true,
    amount: 1000n,
    fee: 0n,
    version: 2,
  };
  const record = structuredClone(previous);
  record.payments.push({
    info,
    request: { max_fee_amount: '0x0' },
    authorization: { amount: '0x3e8' },
    startVersions: ['0x0', '0x0'],
    startBalances: ['0xba43b7400', '0xba43b7400'],
    resolution: 'fulfill',
    sent: true,
  });
  await h.storage.commit([{ key, value: record, expected: previous }]);

  assert.deepEqual(
    await h.client.getPayment({ paymentHash: historicalHash, direction: 'outgoing' }),
    info,
  );
  assert.deepEqual(await h.client.listPayments(), [info]);
  assert.equal(
    h.calls.some(([method]) => method === 'get_payment'),
    false,
  );
  const next = await h.client.keysend({
    channelId,
    targetPublicKey: h.f.nodePublicKey,
    amount: 1000n,
    maxFee: 0n,
  });
  assert.equal(next.paymentHash, nextHash);
});
test('hold invoice keeps its preimage local and rejects an invoice with mismatched terms', async () => {
  let h: ChannelHarness;
  h = await channelHarness({
    handler: async (method, params) => {
      if (method === 'new_invoice') {
        assert.equal(params.payment_preimage, undefined);
        assert.equal(params.allow_mpp, false);
        assert.equal(params.allow_trampoline_routing, true);
        const r = (await h.storage.get<TenantRecord>(`tenant/${h.f.tenantId}`))!;
        assert.match(r.payments[0].preimage!, /^0x[0-9a-f]{64}$/);
        assert.equal(
          params.payment_hash,
          paymentHash(
            Uint8Array.from(Buffer.from(r.payments[0].preimage!.slice(2), 'hex')),
            'ckb_hash',
          ),
        );
        return { invoice_address: h.f.invoice, invoice: h.f.invoiceObject };
      }
    },
  });
  try {
    await h.client.openChannel({ wallet: h.wallet });
    await h.client.listChannels();
    await assert.rejects(
      h.client.createInvoice({ channelId: h.f.proposal.channel_id, amount: 1000n }),
      (e) => e instanceof FiberLspError && e.code === 'VERIFICATION',
    );
    assert.equal(
      h.calls.some(([m]) => m === 'settle_invoice'),
      false,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('invoice creation checks all delivery channels for the same asset before sending', async (t) => {
  let channels: Record<string, unknown>[] | undefined;
  const rejection =
    'Node does not support trampoline routing, please enable trampoline routing feature';
  const h = await channelHarness({
    handler(method) {
      if (method === 'list_channels' && channels) return { channels };
      if (method === 'new_invoice') throw { rpcCode: -32000, message: rejection };
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  await h.client.openChannel({ wallet: h.wallet });
  const [selected] = await h.client.listChannels();
  assert.equal(selected.ready, true);
  assert.ok(selected.raw);
  const options = { channelId: h.f.proposal.channel_id, amount: 1000n };
  const other = { ...selected.raw, channel_id: `0x${'42'.repeat(32)}` };
  channels = [selected.raw, { ...other, enabled: false }];

  await assert.rejects(h.client.createInvoice(options), {
    code: 'CONFLICT',
    message: /multiple channels for the same asset/,
  });
  assert.deepEqual(await h.client.listPayments(), []);
  assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 0);

  channels = [{ ...selected.raw, state: { state_name: 'ShuttingDown' } }];
  await assert.rejects(h.client.createInvoice(options), {
    code: 'CONFLICT',
    message: /selected channel is unavailable/,
  });
  assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 0);

  channels = [
    selected.raw,
    { ...other, funding_udt_type_script: h.f.script },
    {
      ...other,
      channel_id: `0x${'43'.repeat(32)}`,
      state: { state_name: 'ShuttingDown' },
    },
    {
      ...other,
      channel_id: `0x${'44'.repeat(32)}`,
      state: { state_name: 'Closed' },
    },
  ];
  await assert.rejects(h.client.createInvoice(options), { name: 'RpcError', message: rejection });
  assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 1);
});

test('recovery cancels an unsent invoice when another channel can receive the same asset', async (t) => {
  const storage = new MemoryStorage();
  const commit = storage.commit.bind(storage);
  let interrupt = true;
  storage.commit = async (changes, roots) => {
    const invoice = (changes[0]?.value as TenantRecord | undefined)?.payments[0];
    if (interrupt && invoice?.info.status === 'Creating' && invoice.sent) {
      interrupt = false;
      throw new Error('interrupted before submission');
    }
    await commit(changes, roots);
  };
  let channels: Record<string, unknown>[] | undefined;
  const h = await channelHarness({
    storage,
    handler(method) {
      if (method === 'list_channels' && channels) return { channels };
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  await h.client.openChannel({ wallet: h.wallet });
  const [selected] = await h.client.listChannels();
  assert.equal(selected.ready, true);
  assert.ok(selected.raw);
  await assert.rejects(
    h.client.createInvoice({ channelId: h.f.proposal.channel_id, amount: 1000n }),
    /interrupted before submission/,
  );
  const [pending] = await h.client.listPayments();
  await h.lsp.cleanup(h.f.tenantId);
  channels = [selected.raw, { ...selected.raw, channel_id: `0x${'42'.repeat(32)}` }];

  const restored = h.lsp.createClient(h.f.tenantId);
  await restored.listChannels();
  const [failed] = await restored.listPayments();
  assert.equal(failed.operationId, pending.operationId);
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.complete, true);
  assert.match(failed.failureReason!, /multiple channels for the same asset/);
  assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 0);
});

test('invoice validation and confirmed RPC rejection leave the tenant available for another invoice', async (t) => {
  const rejection = 'final_expiry_delta must be greater than or equal to 9600000';
  const requests: RpcParams[] = [];
  const h = await channelHarness({
    handler(method, params) {
      if (method !== 'new_invoice') return;
      requests.push(params);
      if (requests.length === 1) throw { rpcCode: -32000, message: rejection };
      throw Error('response lost');
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  await h.client.openChannel({ wallet: h.wallet });
  assert.equal((await h.client.listChannels())[0].ready, true);
  const options = { channelId: h.f.proposal.channel_id, amount: 1000n };
  await assert.rejects(
    h.client.createInvoice({ ...options, description: '字'.repeat(214) }),
    (error) => error instanceof FiberLspError && error.code === 'INVALID_ARGUMENT',
  );
  assert.deepEqual(await h.client.listPayments(), []);
  assert.equal(requests.length, 0);

  const events: PaymentInfo[] = [];
  h.client.on(FiberLspEvent.InvoiceChanged, (invoice) => events.push(invoice));
  await assert.rejects(h.client.createInvoice({ ...options, finalTlcExpiryDeltaMs: 1 }), {
    name: 'RpcError',
    message: rejection,
  });
  const [failed] = await h.client.listPayments();
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.complete, true);
  assert.equal(failed.failureReason, rejection);
  assert.equal(failed.paymentHash, requests[0].payment_hash);
  assert.deepEqual(events, [failed]);

  await h.lsp.cleanup(h.f.tenantId);
  const restored = h.lsp.createClient(h.f.tenantId);
  assert.deepEqual(
    await restored.getPayment({ paymentHash: failed.paymentHash!, direction: 'incoming' }),
    failed,
  );
  const description = '字'.repeat(213);
  await assert.rejects(
    restored.createInvoice({ ...options, description }),
    (error) => error instanceof FiberLspError && error.code === 'NETWORK',
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].description, description);
  assert.notEqual(requests[1].payment_hash, failed.paymentHash);
});

test('recovery finishes a pre-write rejection for an invoice interrupted before submission', async (t) => {
  const storage = new MemoryStorage();
  const commit = storage.commit.bind(storage);
  let interrupt = true;
  storage.commit = async (changes, roots) => {
    const invoice = (changes[0]?.value as TenantRecord | undefined)?.payments[0];
    if (interrupt && invoice?.info.status === 'Creating' && invoice.sent) {
      interrupt = false;
      throw new Error('interrupted before submission');
    }
    await commit(changes, roots);
  };
  const rejection =
    'Node does not support trampoline routing, please enable trampoline routing feature';
  const h = await channelHarness({
    storage,
    handler(method) {
      if (method === 'new_invoice') throw { rpcCode: -32000, message: rejection };
    },
  });
  t.after(() => h.lsp.cleanup(h.f.tenantId));
  await h.client.openChannel({ wallet: h.wallet });
  await h.client.listChannels();
  await assert.rejects(
    h.client.createInvoice({ channelId: h.f.proposal.channel_id, amount: 1000n }),
    /interrupted before submission/,
  );
  assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 0);
  const [pending] = await h.client.listPayments();

  await h.lsp.cleanup(h.f.tenantId);
  const restored = h.lsp.createClient(h.f.tenantId);
  await restored.listChannels();
  assert.deepEqual(await restored.listPayments(), [
    {
      ...pending,
      status: 'Failed',
      complete: true,
      failureReason: rejection,
      version: pending.version + 1,
    },
  ]);
  const requests = h.calls.filter(([method]) => method === 'new_invoice');
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].payment_hash, pending.paymentHash);
});

for (const submissionError of [
  { error: Error('response lost'), code: 'NETWORK' },
  { error: { rpcCode: -32000, message: 'failed to parse generated hosted invoice' }, code: 'RPC' },
]) {
  test(`a ${submissionError.code} error leaves invoice creation pending until an expired authorization is reconciled`, async (t) => {
    let now = Date.now();
    let submittedHash: unknown;
    const h = await channelHarness({
      sdk: { now: () => now },
      handler(method, params) {
        if (method === 'new_invoice') {
          submittedHash = params.payment_hash;
          throw submissionError.error;
        }
        if (method === 'get_invoice') {
          assert.equal(params.payment_hash, submittedHash);
          throw { rpcCode: -32000, message: 'invoice not found' };
        }
      },
    });
    t.after(() => h.lsp.cleanup(h.f.tenantId));
    await h.client.openChannel({ wallet: h.wallet });
    assert.equal((await h.client.listChannels())[0].ready, true);
    await assert.rejects(
      h.client.createInvoice({
        channelId: h.f.proposal.channel_id,
        amount: 1000n,
        expirySeconds: 1,
      }),
      (error) => error instanceof FiberLspError && error.code === submissionError.code,
    );
    await h.lsp.cleanup(h.f.tenantId);
    const restored = h.lsp.createClient(h.f.tenantId);
    await restored.listChannels();
    const [pending] = await restored.listPayments();
    assert.equal(pending.paymentHash, submittedHash);
    assert.equal(pending.status, 'Creating');
    assert.equal(pending.complete, false);

    now += 1_000;
    const events: PaymentInfo[] = [];
    restored.on(FiberLspEvent.InvoiceChanged, (invoice) => events.push(invoice));
    const expired = await restored.getPayment({
      paymentHash: pending.paymentHash!,
      direction: 'incoming',
    });
    assert.deepEqual(expired, {
      ...pending,
      status: 'Expired',
      complete: true,
      version: pending.version + 1,
    });
    assert.deepEqual(await restored.listPayments(), [expired]);
    assert.deepEqual(events, [expired]);
    assert.equal(h.calls.filter(([method]) => method === 'new_invoice').length, 1);
  });
}
test(
  'client creation recovers a lost keysend response by its original operation ID',
  { timeout: 5000 },
  async (t) => {
    let h: ChannelHarness;
    let request: RpcParams | undefined;
    let startedLookup!: () => void;
    let releaseLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => (startedLookup = resolve));
    const lookupGate = new Promise<void>((resolve) => (releaseLookup = resolve));
    const preimage = new Uint8Array(32).fill(9),
      hash = paymentHash(preimage, 'ckb_hash');
    h = await channelHarness({
      handler: async (method, params) => {
        if (method === 'send_payment') {
          request = params;
          assert.equal(params.invoice, undefined);
          assert.equal(params.payment_hash, undefined);
          throw Error('response lost');
        }
        if (method === 'list_payments') {
          startedLookup();
          await lookupGate;
          return {
            payments: request
              ? [
                  {
                    payment_hash: hash,
                    status: 'Inflight',
                    fee: '0x0',
                    custom_records: request.custom_records,
                  },
                ]
              : [],
            last_cursor: null,
          };
        }
        if (method === 'get_payment' && request)
          return { payment_hash: hash, status: 'Inflight', fee: '0x0' };
      },
    });
    t.after(async () => {
      releaseLookup();
      await h.lsp.cleanup(h.f.tenantId);
    });
    await h.client.openChannel({ wallet: h.wallet });
    await h.client.listChannels();
    await assert.rejects(
      h.client.keysend({
        channelId: h.f.proposal.channel_id,
        targetPublicKey: h.f.nodePublicKey,
        amount: 1000n,
        maxFee: 0n,
      }),
      (e) => e instanceof FiberLspError && e.code === 'NETWORK',
    );
    const [pending] = await h.client.listPayments();
    assert.equal(pending.paymentHash, null);
    assert.equal(pending.status, 'Unknown');
    await h.lsp.cleanup(h.f.tenantId);
    const restored = h.lsp.createClient(h.f.tenantId);
    await lookupStarted;
    assert.deepEqual(await restored.listPayments(), [pending]);

    const changed = new Promise<PaymentInfo>((resolve) => {
      restored.on(FiberLspEvent.PaymentChanged, resolve);
    });
    releaseLookup();
    const payment = await changed;
    assert.equal(payment.operationId, pending.operationId);
    assert.equal(payment.paymentHash, hash);
    assert.ok(payment.version > pending.version);
    await restored.listChannels();
    const [reconciled] = await restored.listPayments();
    assert.equal(reconciled.operationId, pending.operationId);
    assert.equal(reconciled.paymentHash, hash);
    assert.equal(reconciled.status, 'Inflight');
    assert.equal(h.calls.filter(([m]) => m === 'send_payment').length, 1);
  },
);
for (const legacy of [false, true]) {
  test(
    legacy
      ? 'recovers legacy keysend records with a saved hash and missing signer authorization'
      : 'recovers keysend when the combined hash and signer authorization commit fails',
    async (t) => {
      const preimage = Buffer.alloc(32, 9);
      const hash = paymentHash(preimage, 'ckb_hash');
      const response = {
        payment_hash: hash,
        payment_preimage: `0x${preimage.toString('hex')}`,
        status: 'Success',
        fee: '0x0',
      };
      const storage = new MemoryStorage();
      const commit = storage.commit.bind(storage);
      let interrupt = true;
      storage.commit = async (changes, roots) => {
        const change = changes[0];
        const record = change?.value as TenantRecord | undefined;
        const payment = record?.payments[0];
        if (interrupt && record && payment?.info.paymentHash === hash) {
          interrupt = false;
          const previous = change.expected as TenantRecord;
          if (legacy) {
            // Reproduce the old first commit without writing the signer authorization.
            const oldRecord = structuredClone(record);
            oldRecord.signer = previous.signer;
            delete oldRecord.payments[0].keysendAuthorized;
            await commit([{ ...change, value: oldRecord }], roots);
          } else {
            assert.notEqual(record.signer.snapshot, previous.signer.snapshot);
          }
          throw new Error('interrupted during keysend binding');
        }
        await commit(changes, roots);
      };
      let request: RpcParams | undefined;
      const h = await channelHarness({
        storage,
        handler(method, params) {
          if (method === 'send_payment') {
            request = params;
            return response;
          }
          if (method === 'list_payments') {
            assert.ok(request);
            return {
              payments: [{ ...response, custom_records: request.custom_records }],
              last_cursor: null,
            };
          }
          if (method === 'get_payment') {
            assert.equal(params.payment_hash, hash);
            return response;
          }
        },
      });
      t.after(() => h.lsp.cleanup(h.f.tenantId));
      await h.client.openChannel({ wallet: h.wallet });
      assert.equal((await h.client.listChannels())[0].ready, true);
      await assert.rejects(
        h.client.keysend({
          channelId: h.f.proposal.channel_id,
          targetPublicKey: h.f.nodePublicKey,
          amount: 1000n,
          maxFee: 0n,
        }),
        /interrupted during keysend binding/,
      );
      const [pending] = await h.client.listPayments();
      assert.equal(pending.paymentHash, legacy ? hash : null);

      await h.lsp.cleanup(h.f.tenantId);
      const restored = h.lsp.createClient(h.f.tenantId);
      const payment = await restored.getPayment({ paymentHash: hash, direction: 'outgoing' });
      assert.equal(payment?.operationId, pending.operationId);
      assert.equal(payment?.status, 'Success');
      const saved = await storage.get<TenantRecord>(`tenant/${h.f.tenantId}`);
      assert.equal(saved?.payments[0].resolution, 'fulfill');
      assert.equal(h.calls.filter(([method]) => method === 'send_payment').length, 1);
      assert.equal(h.calls.filter(([method]) => method === 'list_payments').length, legacy ? 0 : 1);
    },
  );
}
test('wallet interruption recovers original operation and key material in a new SDK instance', async () => {
  const h = await channelHarness();
  const sign = h.wallet.signFundingTransaction;
  h.wallet.signFundingTransaction = async () => {
    throw Error('wallet disconnected');
  };
  try {
    await assert.rejects(h.client.openChannel({ wallet: h.wallet }), /wallet disconnected/);
    const saved = (await h.storage.get<TenantRecord>(`tenant/${h.f.tenantId}`))!;
    const operationId = saved.openings[0].operationId;
    await h.lsp.cleanup(h.f.tenantId);
    const next = new fiberlsp(h.sdkOptions);
    h.wallet.signFundingTransaction = sign;
    try {
      const client = next.createClient(h.f.tenantId);
      const resumed = await client.openChannel({ wallet: h.wallet });
      assert.equal(resumed.operationId, operationId);
      assert.equal(h.calls.filter(([m]) => m === 'open_channel_with_external_funding').length, 1);
    } finally {
      await next.cleanup(h.f.tenantId);
    }
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
