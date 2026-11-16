import type {
  ChainProvider,
  FiberLspConfig,
  FundingTerms,
  FundingWallet,
  OutPoint,
  TenantRegistration,
  Transaction,
} from 'fiber-lsp-sdk';
import { jsonStringify } from './types.ts';
import type {
  ChainCall,
  ChainRpcResults,
  DevnetConfig,
  FundingTermsJson,
  RegisterUserResult,
} from './types.ts';

/** Small HTTP boundary. Backend DTOs are shared; the SDK independently verifies chain/signing data. */
export async function request<T>(baseUrl: string, path: string, value?: unknown): Promise<T> {
  const response = await fetch(
    new URL(path, baseUrl),
    value === undefined
      ? {}
      : {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(typeof window === 'undefined' ? { Origin: new URL(baseUrl).origin } : {}),
          },
          body: jsonStringify(value),
        },
  );
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String(body.error)
        : `HTTP ${response.status}`;
    throw Error(message);
  }
  return body as T;
}
export interface DevnetConnection {
  config: DevnetConfig;
  fiberLsp: FiberLspConfig;
  storageName: string;
  registration: TenantRegistration;
  chain: ChainProvider;
}
export async function connectDevnet(baseUrl = window.location.origin): Promise<DevnetConnection> {
  const config = await request<DevnetConfig>(baseUrl, '/devnet/config');
  const { wsUrl: _, ...httpLsp } = config.fiberLsp;
  const fiberLsp: FiberLspConfig = {
    ...httpLsp,
    rpcUrl: typeof window === 'undefined' ? httpLsp.rpcUrl : new URL('/devnet/rpc', baseUrl).href,
    network: {
      ...config.fiberLsp.network,
      minimumShutdownFee: BigInt(config.fiberLsp.network.minimumShutdownFee),
    },
  };
  return {
    config,
    fiberLsp,
    storageName: `fiber-sdk-devnet-${config.genesisHash}-${fiberLsp.nodePublicKey}`,
    registration: {
      register: (params) => request<RegisterUserResult>(baseUrl, '/devnet/register', params),
    },
    chain: chainProvider(
      async <M extends keyof ChainRpcResults>(method: M, params: unknown[]) =>
        (
          await request<{ result: ChainRpcResults[M] }>(baseUrl, '/devnet/chain', {
            method,
            params,
          })
        ).result,
    ),
  };
}
/** Example FundingWallet: the browser approves terms; the local backend holds the dev wallet key. */
export function fundingWallet(userId: string, baseUrl = window.location.origin): FundingWallet {
  let approvedTerms: FundingTerms | undefined;
  const call = <T>(action: string, extra: Record<string, unknown> = {}) =>
    request<T>(baseUrl, '/devnet/wallet', { userId, action, ...extra });
  return {
    async getFundingTerms() {
      const { closeFeeRate, ...terms } = await call<FundingTermsJson>('terms');
      return {
        ...terms,
        fundingAmount: BigInt(terms.fundingAmount),
        remoteFundingAmount: BigInt(terms.remoteFundingAmount),
        commitmentDelayEpoch: BigInt(terms.commitmentDelayEpoch),
        commitmentFeeRate: BigInt(terms.commitmentFeeRate),
        fundingFeeRate: BigInt(terms.fundingFeeRate),
        maxFundingFee: BigInt(terms.maxFundingFee),
        maxWalletDebit: BigInt(terms.maxWalletDebit),
        ...(closeFeeRate === undefined ? {} : { closeFeeRate: BigInt(closeFeeRate) }),
      };
    },
    async verifyFunding(transaction, terms) {
      const inputs = await call<OutPoint[]>('verify', { transaction, terms });
      approvedTerms = terms;
      return inputs;
    },
    signFundingTransaction(transaction) {
      if (!approvedTerms) throw Error('Verify the funding transaction first');
      return call<Transaction>('sign', { transaction, terms: approvedTerms });
    },
  };
}
/** Trusted CKB queries are deliberately separate from the LSP's proposed transaction data. */
export function chainProvider(call: ChainCall): ChainProvider {
  const getTransaction: ChainProvider['getTransaction'] = async (hash) => {
    const result = await call('get_transaction', [hash]);
    if (result?.tx_status.status !== 'committed' || !result.transaction) return null;
    const { version, cell_deps, header_deps, inputs, outputs, outputs_data, witnesses } =
      result.transaction;
    // Do not include TransactionView.hash in the raw transaction comparison.
    return { version, cell_deps, header_deps, inputs, outputs, outputs_data, witnesses };
  };
  return {
    getTransaction,
    async getCell(point, network) {
      const tx = await getTransaction(point.tx_hash, network);
      const index = Number(BigInt(point.index));
      const output = tx?.outputs[index],
        data = tx?.outputs_data[index];
      return output && data !== undefined ? { output, data } : null;
    },
    async getLiveCell(point) {
      const result = await call('get_live_cell', [point, true]);
      return result.status === 'live' && result.cell
        ? { output: result.cell.output, data: result.cell.data.content }
        : null;
    },
  };
}
