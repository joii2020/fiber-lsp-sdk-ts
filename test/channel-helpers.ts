import type {
  ChainProvider,
  FiberLspOptions,
  FundingTerms,
  FundingWallet,
  Storage,
} from '../src/index.js';
import type { TenantRecord } from '../src/state.js';
import type { RpcParams } from './fixture-types.ts';
interface HarnessOptions {
  storage?: Storage;
  wsUrl?: string;
  sdk?: Partial<FiberLspOptions>;
  handler?: (method: string, params: RpcParams) => unknown | Promise<unknown>;
}
export type ChannelHarness = Awaited<ReturnType<typeof channelHarness>>;
import assert from 'node:assert/strict';
import { MemoryStorage, fiberlsp, FiberLspEvent } from '../dist/index.js';
import { fixture, seedFixture, result, fetchRpc } from './helpers.ts';
import { transactionHash } from '../dist/wasm/index.js';
export async function channelHarness(options: HarnessOptions = {}) {
  const f = await fixture();
  const storage = options.storage ?? new MemoryStorage();
  const fiberLsp = await seedFixture(storage, f, undefined, options.wsUrl);
  let submitted = false,
    index = 0;
  const calls: [string, RpcParams][] = [];
  const channel = {
    channel_id: f.proposal.channel_id,
    is_public: false,
    pubkey: f.nodePublicKey,
    funding_udt_type_script: null,
    channel_outpoint: { tx_hash: transactionHash(f.proposal.unsigned_funding_tx), index: '0x0' },
    local_balance: `0x${(50000000000n - BigInt(f.reserve)).toString(16)}`,
    remote_balance: `0x${(50000000000n - BigInt(f.reserve)).toString(16)}`,
    pending_tlcs: [],
    offered_tlc_balance: '0x0',
    received_tlc_balance: '0x0',
    failure_detail: null,
  };
  const raw = () => ({
    ...channel,
    state: submitted
      ? { state_name: 'ChannelReady' }
      : index === 0
        ? { state_name: 'NegotiatingFunding', state_flags: 'AWAITING_EXTERNAL_FUNDING' }
        : {
            state_name: 'SigningCommitment',
            state_flags:
              index === 1
                ? 'THEIR_COMMITMENT_SIGNED_SENT|COMMITMENT_SIGNED_SENT'
                : 'OUR_COMMITMENT_SIGNED_SENT|THEIR_COMMITMENT_SIGNED_SENT|COMMITMENT_SIGNED_SENT',
          },
  });
  const network = fiberLsp.network;
  const terms: FundingTerms = {
    fundingAmount: 50000000000n,
    remoteFundingAmount: 50000000000n,
    maxFundingFee: 100000n,
    maxWalletDebit: 50000001000n,
    shutdownScript: f.script,
    fundingLockScript: f.script,
    commitmentDelayEpoch: 0x10000000001n,
    commitmentFeeRate: 1000n,
    fundingFeeRate: 1000n,
  };
  const provider: ChainProvider = {
    getTransaction: async (hash) =>
      submitted && hash === transactionHash(f.proposal.unsigned_funding_tx)
        ? f.proposal.unsigned_funding_tx
        : null,
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
  const handler = async (method: string, params: RpcParams) => {
    calls.push([method, structuredClone(params)]);
    if (options.handler) {
      const override = await options.handler(method, params);
      if (override !== undefined) return override;
    }
    if (method === 'list_channels')
      return {
        channels: calls.some(([m]) => m === 'open_channel_with_external_funding') ? [raw()] : [],
      };
    if (method === 'open_channel_with_external_funding') {
      assert.deepEqual(params.external_channel_signer, f.request.external_channel_signer);
      return f.proposal;
    }
    if (method === 'submit_signed_funding_tx') {
      assert.equal(index, f.statuses.length, 'initial commitment signatures precede funding');
      submitted = true;
      return {
        channel_id: f.proposal.channel_id,
        funding_tx_hash: transactionHash(f.proposal.unsigned_funding_tx),
      };
    }
    if (method === 'get_channel_signing_status')
      return {
        channel_id: f.proposal.channel_id,
        status: f.statuses[index] ?? { type: 'NoSignatureRequired' },
      };
    if (method === 'submit_channel_signature') {
      const state = (await storage.get<TenantRecord>(`tenant/${f.tenantId}`))!;
      assert.ok(state.submissions[String(params.request_id)]);
      assert.ok(state.signer.snapshot.length > f.snapshot.length);
      index++;
      return { type: 'Submitted' };
    }
    if (method === 'get_payment')
      throw {
        rpcCode: -32000,
        message: `Invalid parameter: Payment session not found: ${params.payment_hash}`,
      };
    throw Error(`Unexpected RPC ${method}`);
  };
  const sdkOptions: FiberLspOptions = {
    storage,
    chain: provider,
    fetch: fetchRpc(handler),
    onConfirm: () => true,
    pollIntervalMs: 60000,
    ...options.sdk,
  };
  const lsp = new fiberlsp(sdkOptions);
  const p = await lsp.beginRegistration({ tenantId: f.tenantId, fiberLsp });
  await lsp.finishRegistration(f.tenantId, result(f.tenantId, p.params.root_signer_pubkey));
  const client = lsp.createClient(f.tenantId);
  const wallet: FundingWallet = {
    getFundingTerms: async () => terms,
    verifyFunding: async (tx) => tx.inputs.map((i) => i.previous_output),
    signFundingTransaction: async (tx) => {
      assert.equal(
        index,
        f.statuses.length,
        'initial commitment signatures precede wallet signing',
      );
      return { ...tx, witnesses: ['0x01'] };
    },
  };
  return {
    f,
    lsp,
    client,
    storage,
    calls,
    wallet,
    provider,
    sdkOptions,
    handleRpc: handler,
    getIndex: () => index,
    terms,
  };
}
