import type {
  ChainProvider,
  FiberLspConfig,
  FiberLspOptions,
  Hex,
  NetworkConfig,
} from '../../src/types.js';
import type { TenantRecord } from '../../src/state.js';
import type { ChannelFixture, MockPayment } from '../fixture-types.ts';
import { test, expect } from '@playwright/test';
test('browser verifies funding and real signatures, persists a payment before RPC, and restores the client', async ({
  page,
}) => {
  await page.goto('/');
  const outcome = await page.evaluate(async () => {
    const { fiberlsp, BrowserStorage } = await import('/dist/index.js');
    const { transactionHash } = await import('/dist/wasm.js');
    const f = (await fetch('/test/fixtures/channel.json').then((r) => r.json())) as ChannelFixture;
    const network: NetworkConfig = {
      currency: 'Fibd',
      fundingLock: f.script,
      commitmentLock: f.commitmentLock,
      commitmentCellDeps: 1,
      epochDurationMs: 14400000,
      minimumShutdownFee: 100000000n,
      fundingCellDeps: [],
    };
    const config: FiberLspConfig = {
      rpcUrl: 'http://localhost:1',
      nodePublicKey: f.nodePublicKey,
      network,
    };
    const storage = new BrowserStorage({
      name: 'browser-channel',
      onUnlock: () => 'test-password',
    });
    const info = {
      tenantId: f.tenantId,
      publicKey: f.publicKey,
      fiberLsp: config,
      ready: false,
      createdAt: 1,
      updatedAt: 1,
    };
    await storage.commit(
      [
        {
          key: `tenant/${f.tenantId}`,
          value: {
            schema: 1,
            revision: 0,
            info,
            signer: { snapshot: f.snapshot, session: f.session },
            openings: [],
            payments: [],
            channels: [],
            submissions: {},
          },
        },
      ],
      [
        {
          tenantId: f.tenantId,
          key: Uint8Array.from(f.root.match(/../g)!, (s) => parseInt(s, 16)),
        },
      ],
    );
    let opened = false,
      submitted = false,
      index = 0,
      payment: MockPayment | undefined,
      sendCount = 0;
    const txHash = transactionHash(f.proposal.unsigned_funding_tx);
    const chain: ChainProvider = {
      getTransaction: async () => (submitted ? f.proposal.unsigned_funding_tx : null),
      getLiveCell: async () => (submitted ? f.fundingCell : null),
      getCell: async (p) =>
        p.tx_hash === (`0x${'07'.repeat(32)}` as const)
          ? f.inputCell
          : {
              output: {
                ...f.inputCell.output,
                capacity: '0xba43b7400',
                lock: { ...f.script, code_hash: `0x${'55'.repeat(32)}` as const },
              },
              data: '0x',
            },
    };
    const fetcher: typeof fetch = async (url, options) => {
      const {
        id,
        method,
        params: [p],
      } = JSON.parse(String(options?.body)) as {
        id: number;
        method: string;
        params: [{ payment_hash: Hex }];
      };
      let result;
      if (method === 'list_channels')
        result = {
          channels: opened
            ? [
                {
                  channel_id: f.proposal.channel_id,
                  is_public: false,
                  pubkey: f.nodePublicKey,
                  state: {
                    state_name: submitted ? 'ChannelReady' : 'NegotiatingFunding',
                    state_flags: 'AWAITING_EXTERNAL_FUNDING',
                  },
                  local_balance: `0x${(50000000000n - BigInt(f.reserve)).toString(16)}`,
                  remote_balance: `0x${(50000000000n - BigInt(f.reserve)).toString(16)}`,
                  pending_tlcs: [],
                  offered_tlc_balance: '0x0',
                  received_tlc_balance: '0x0',
                },
              ]
            : [],
        };
      else if (method === 'open_channel_with_external_funding') {
        opened = true;
        result = f.proposal;
      } else if (method === 'submit_signed_funding_tx') {
        submitted = true;
        result = { channel_id: f.proposal.channel_id, funding_tx_hash: txHash };
      } else if (method === 'get_channel_signing_status')
        result = {
          channel_id: f.proposal.channel_id,
          status: f.statuses[index] ?? { type: 'NoSignatureRequired' },
        };
      else if (method === 'submit_channel_signature') {
        index++;
        result = { type: 'Submitted' };
      } else if (method === 'send_payment') {
        const saved = (await storage.get<TenantRecord>(`tenant/${f.tenantId}`))!;
        if (saved.payments[0].info.paymentHash !== p.payment_hash)
          throw Error('Payment was not saved');
        sendCount++;
        payment = { payment_hash: p.payment_hash, status: 'Inflight', fee: '0x0' };
        result = payment;
      } else if (method === 'get_payment') result = payment;
      else throw Error(method);
      return Response.json({ jsonrpc: '2.0', id, result });
    };
    const options: FiberLspOptions = {
      storage,
      chain,
      fetch: fetcher,
      onConfirm: () => true,
      pollIntervalMs: 60000,
    };
    let lsp = new fiberlsp(options);
    const pending = await lsp.beginRegistration({ tenantId: f.tenantId, fiberLsp: config });
    await lsp.finishRegistration(f.tenantId, {
      tenant: {
        tenant_id: f.tenantId,
        root_signer_pubkey: f.publicKey,
        invoice_pubkey: f.nodePublicKey,
        channels: [],
        created_at: '0x1',
        runtime_status: 'cold',
      },
      access_token: 'browser-token',
    });
    const client = lsp.createClient(f.tenantId);
    await client.openChannel({
      wallet: {
        getFundingTerms: async () => ({
          fundingAmount: 50000000000n,
          remoteFundingAmount: 50000000000n,
          maxFundingFee: 100000n,
          maxWalletDebit: 50000001000n,
          shutdownScript: f.script,
          fundingLockScript: f.script,
          commitmentDelayEpoch: 0x10000000001n,
          commitmentFeeRate: 1000n,
          fundingFeeRate: 1000n,
        }),
        verifyFunding: async (tx) => tx.inputs.map((i) => i.previous_output),
        signFundingTransaction: async (tx) => ({ ...tx, witnesses: ['0x01'] }),
      },
    });
    const [channel] = await client.listChannels();
    const p = await client.payInvoice({
      channelId: f.proposal.channel_id,
      invoice: f.invoice,
      maxFee: 0n,
    });
    await lsp.cleanup(f.tenantId);
    lsp = new fiberlsp(options);
    const restored = await lsp
      .createClient(f.tenantId)
      .getPayment({ paymentHash: p.paymentHash!, direction: 'outgoing' });
    await lsp.cleanup(f.tenantId);
    await storage.close();
    return {
      ready: channel.ready,
      index,
      sendCount,
      status: restored!.status,
      paymentHash: restored!.paymentHash,
      expected: client.parseInvoice?.name,
    };
  });
  expect(outcome.ready).toBe(true);
  expect(outcome.index).toBe(2);
  expect(outcome.sendCount).toBe(1);
  expect(outcome.status).toBe('Inflight');
  expect(outcome.paymentHash).toMatch(/^0x[0-9a-f]{64}$/);
});
