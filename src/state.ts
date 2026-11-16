import type { SignerState } from './wasm.js';
import type {
  TenantInfo,
  TenantStatus,
  RegisterLspTenantParams,
  OpenResult,
  FundingTerms,
  PaymentInfo,
  ChannelInfo,
  Transaction,
} from './types.js';
import type { Hex } from './utils.js';
export interface RecoverySummary {
  forRemote: boolean;
  version: Hex;
  txHash: Hex;
  complete: boolean;
  localAmount: Hex;
  remoteAmount: Hex;
  tlcs: { paymentHash: Hex; amount: Hex }[];
}
export interface OpeningRecord {
  operationId: string;
  terms: FundingTerms;
  request: Record<string, unknown>;
  stage: 'intent' | 'proposed' | 'signed' | 'submitted' | 'ready' | 'failed' | 'closing' | 'closed';
  proposal?: OpenResult;
  signedTransaction?: Transaction;
  fundingHash?: Hex;
  failureReason?: string;
  close?: {
    fee: bigint;
    localAmount: bigint;
    remoteAmount: bigint;
    requested: boolean;
    hash?: Hex;
  };
  info: ChannelInfo;
}
export interface PaymentRecord {
  info: PaymentInfo;
  request: Record<string, unknown>;
  authorization?: Record<string, unknown>;
  preimage?: Hex;
  startVersions: [Hex, Hex];
  startBalances: [Hex, Hex];
  releaseStarted?: boolean;
  resolution?: 'fulfill' | 'cancel';
  sent: boolean;
  raw?: Record<string, unknown>;
  /** Once true, an interrupted keysend must never be submitted again. */
  outcomeUnknown?: boolean;
}
export interface TenantRecord {
  schema: 1;
  revision: number;
  info: TenantInfo;
  signer: SignerState;
  tenant?: TenantStatus;
  token?: string;
  authInvalid?: boolean;
  registration?: { params: RegisterLspTenantParams; startedAt: number };
  openings: OpeningRecord[];
  payments: PaymentRecord[];
  channels: ChannelInfo[];
  submissions: Record<
    string,
    { channelId: Hex; params: Record<string, unknown>; statusHash: string; done: boolean }
  >;
}
export const recordKey = (id: string) => `tenant/${id}`;
