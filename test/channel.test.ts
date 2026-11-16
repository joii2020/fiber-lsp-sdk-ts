import type { ChannelHarness } from './channel-helpers.ts';
import type { RpcParams } from './fixture-types.ts';
import type { TenantRecord } from '../src/state.js';
import { FiberLspError } from '../dist/index.js';
import test from 'node:test';
import { fiberlsp } from '../dist/index.js';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { transactionHash } from '../dist/wasm.js';
import { channelHarness } from './channel-helpers.ts';
test('opens a frozen proposal, verifies/signs real MuSig2 requests, and saves before submit', async () => {
  const h = await channelHarness();
  try {
    const opened = await h.client.openChannel({ wallet: h.wallet });
    assert.equal(opened.channelId, h.f.proposal.channel_id);
    const channels = await h.client.listChannels();
    assert.equal(channels.length, 1);
    assert.equal(channels[0].ready, true);
    assert.equal(h.getIndex(), 2);
    assert.equal(h.calls.filter(([m]) => m === 'submit_signed_funding_tx').length, 1);
    const again = await h.client.openChannel({ wallet: h.wallet });
    assert.equal(again.operationId, opened.operationId);
    assert.equal(h.calls.filter(([m]) => m === 'open_channel_with_external_funding').length, 1);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('additional opening uses a new signer and resumes the same intent after recovery', async () => {
  let attempts = 0;
  const h = await channelHarness({
    handler(method) {
      if (method === 'open_channel_with_external_funding' && ++attempts > 1)
        throw Error('Additional proposal response lost');
    },
  });
  let recovered: fiberlsp | undefined;
  try {
    const first = await h.client.openChannel({ wallet: h.wallet });
    assert.equal((await h.client.listChannels())[0].ready, true);
    await assert.rejects(
      h.client.openChannel({ wallet: h.wallet, newChannel: true }),
      /RPC request failed/,
    );
    const key = `tenant/${h.f.tenantId}`;
    const saved = (await h.storage.get<TenantRecord>(key))!;
    assert.equal(saved.openings.length, 2);
    assert.equal(saved.openings[0].stage, 'ready');
    assert.equal(saved.openings[1].stage, 'intent');
    assert.notDeepEqual(
      saved.openings[0].request.external_channel_signer,
      saved.openings[1].request.external_channel_signer,
    );
    const pendingId = saved.openings[1].operationId;
    const channels = await h.client.listChannels();
    assert.equal(channels.length, 2);
    assert.equal(channels.find((c) => c.operationId === first.operationId)?.ready, true);
    assert.equal(channels.find((c) => c.operationId === pendingId)?.needsWallet, true);
    await h.lsp.cleanup(h.f.tenantId);
    recovered = new fiberlsp(h.sdkOptions);
    const client = recovered.createClient(h.f.tenantId);
    await assert.rejects(
      client.openChannel({ wallet: h.wallet, newChannel: true }),
      /RPC request failed/,
    );
    const restored = (await h.storage.get<TenantRecord>(key))!;
    assert.equal(restored.openings.length, 2);
    assert.equal(restored.openings[1].operationId, pendingId);
    assert.deepEqual(restored.openings[1].request, saved.openings[1].request);
    const requests = h.calls.filter(([method]) => method === 'open_channel_with_external_funding');
    assert.deepEqual(requests[1][1], requests[2][1]);
    assert.equal(
      (await client.listChannels()).find((c) => c.operationId === first.operationId)?.ready,
      true,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
    await recovered?.cleanup(h.f.tenantId);
  }
});

test('lists multiple remote channels without trusting an unbound channel for spending', async () => {
  let additional = false;
  const f = await fixture();
  const h = await channelHarness({
    handler(method) {
      if (method === 'list_channels' && additional)
        return {
          channels: ['11', '22'].map((byte) => ({
            channel_id: `0x${byte.repeat(32)}`,
            pubkey: f.nodePublicKey,
            is_public: false,
            state: { state_name: 'ChannelReady' },
          })),
        };
    },
  });
  try {
    additional = true;
    const channels = await h.client.listChannels();
    assert.equal(channels.length, 2);
    assert.ok(channels.every((c) => !c.ready && c.failureReason?.includes('Missing local')));
    await assert.rejects(
      h.client.openChannel({ wallet: h.wallet, newChannel: true }),
      /unbound channel/,
    );
    assert.equal(
      h.calls.some(([method]) => method === 'open_channel_with_external_funding'),
      false,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});

test('rejects a wallet that changes raw funding outputs before submission', async () => {
  const h = await channelHarness();
  try {
    h.wallet.signFundingTransaction = async (tx) => ({
      ...tx,
      outputs: [{ ...tx.outputs[0], capacity: '0x1' }],
    });
    await assert.rejects(h.client.openChannel({ wallet: h.wallet }), /raw funding/);
    assert.equal(
      h.calls.some(([m]) => m === 'submit_signed_funding_tx'),
      false,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('rejects server changes to opening reserves before wallet signing', async () => {
  let proposal;
  const f = await fixture();
  proposal = structuredClone(f.proposal);
  proposal.opening_context.local_reserved_ckb_amount = '0x1';
  const h = await channelHarness({
    handler: (m) => (m === 'open_channel_with_external_funding' ? proposal : undefined),
  });
  let signed = false;
  try {
    h.wallet.signFundingTransaction = async (tx) => {
      signed = true;
      return tx;
    };
    await assert.rejects(h.client.openChannel({ wallet: h.wallet }), /reserve/);
    assert.equal(signed, false);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('rejects a malicious signing settlement even when its transaction hash is valid', async () => {
  const f = await fixture();
  const status = structuredClone(f.statuses[0]);
  status.settlement.local_amount = '0x1';
  const h = await channelHarness({
    handler: (m) =>
      m === 'get_channel_signing_status'
        ? { channel_id: f.proposal.channel_id, status }
        : undefined,
  });
  try {
    await assert.rejects(
      h.client.openChannel({ wallet: h.wallet }),
      (e) => e instanceof FiberLspError && e.code === 'VERIFICATION',
    );
    assert.equal(
      h.calls.some(([m]) => m === 'submit_channel_signature'),
      false,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('cooperative close requires no funding wallet and verifies the committed refunds', async () => {
  let h: ChannelHarness;
  let closing = false,
    closed = false;
  h = await channelHarness({
    handler: (m, p) => {
      if (m === 'shutdown_channel') {
        assert.equal(p.force, false);
        assert.deepEqual(p.close_script, h.f.script);
        closing = true;
        return {};
      }
      if (m === 'list_channels' && closing)
        return {
          channels: [
            {
              channel_id: h.f.proposal.channel_id,
              is_public: false,
              pubkey: h.f.nodePublicKey,
              state: { state_name: closed ? 'Closed' : 'ShuttingDown', state_flags: '' },
              shutdown_transaction_hash: closed ? transactionHash(h.f.closeTransaction) : null,
              local_balance: `0x${(50000000000n - BigInt(h.f.reserve)).toString(16)}`,
              remote_balance: `0x${(50000000000n - BigInt(h.f.reserve)).toString(16)}`,
              pending_tlcs: [],
              offered_tlc_balance: '0x0',
              received_tlc_balance: '0x0',
            },
          ],
        };
      if (m === 'get_channel_signing_status' && closing)
        return {
          channel_id: h.f.proposal.channel_id,
          status: closed ? { type: 'NoSignatureRequired' } : h.f.closeStatus,
        };
      if (m === 'submit_channel_signature' && closing) {
        closed = true;
        return { type: 'Submitted' };
      }
    },
  });
  const original = h.provider.getTransaction;
  h.provider.getTransaction = async (hash) =>
    hash === transactionHash(h.f.closeTransaction)
      ? h.f.closeTransaction
      : original(hash, (await h.lsp.listTenants())[0].fiberLsp.network);
  try {
    await h.client.openChannel({ wallet: h.wallet });
    await h.client.listChannels();
    const result = await h.client.closeChannel(h.f.proposal.channel_id);
    assert.equal(result.closed, true);
    assert.equal(result.ready, false);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
test('shared storage serializes signing across two SDK instances', async () => {
  const h = await channelHarness();
  const other = new fiberlsp(h.sdkOptions);
  try {
    const second = other.createClient(h.f.tenantId);
    const opening = h.client.openChannel({ wallet: h.wallet });
    const query = second.listChannels();
    await opening;
    await query;
    await second.listChannels();
    assert.equal(h.getIndex(), 2);
    assert.equal(h.calls.filter(([m]) => m === 'submit_channel_signature').length, 2);
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
    await other.cleanup(h.f.tenantId);
  }
});
test('declining a signing confirmation pauses automatic prompts until an explicit retry', async () => {
  let prompts = 0;
  const h = await channelHarness({
    sdk: {
      pollIntervalMs: 20,
      onConfirm: (request) => (request.kind === 'sign' ? (prompts++, false) : true),
    },
  });
  try {
    await assert.rejects(
      h.client.openChannel({ wallet: h.wallet }),
      (e) => e instanceof FiberLspError && e.code === 'REJECTED',
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(prompts, 1);
    assert.equal(
      h.calls.some(([m]) => m === 'submit_channel_signature'),
      false,
    );
  } finally {
    await h.lsp.cleanup(h.f.tenantId);
  }
});
