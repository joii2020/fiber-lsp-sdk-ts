import type { ChannelHarness } from './channel-helpers.ts';
import type { RpcParams } from './fixture-types.ts';
import type { TenantRecord } from '../src/state.js';
import { FiberLspError } from '../dist/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelHarness } from './channel-helpers.ts';
import { fiberlsp } from '../dist/index.js';
import { paymentHash } from '../dist/wasm.js';
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
test('keysend response loss is correlated through custom records without a second send', async () => {
  let h: ChannelHarness;
  let request: RpcParams | undefined;
  const preimage = new Uint8Array(32).fill(9),
    hash = paymentHash(preimage, 'ckb_hash');
  h = await channelHarness({
    handler: (method, params) => {
      if (method === 'send_payment') {
        request = params;
        assert.equal(params.invoice, undefined);
        assert.equal(params.payment_hash, undefined);
        throw Error('response lost');
      }
      if (method === 'list_payments')
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
      if (method === 'get_payment' && request)
        return { payment_hash: hash, status: 'Inflight', fee: '0x0' };
    },
  });
  try {
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
    await h.client.listChannels();
    const state = (await h.storage.get<TenantRecord>(`tenant/${h.f.tenantId}`))!;
    assert.equal(state.payments[0].info.paymentHash, hash);
    assert.equal(state.payments[0].outcomeUnknown, false);
    assert.equal(h.calls.filter(([m]) => m === 'send_payment').length, 1);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
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
