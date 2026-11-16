import type { Hex } from './utils.js';
import type { Storage } from './storage.js';
export type { Hex } from './utils.js';
export type HashAlgorithm = 'ckb_hash' | 'sha256';
export type PaymentDirection = 'incoming' | 'outgoing';
export interface Script {
  code_hash: Hex;
  hash_type: 'data' | 'type' | 'data1' | 'data2';
  args: Hex;
}
export interface OutPoint {
  tx_hash: Hex;
  index: Hex;
}
export interface CellDep {
  out_point: OutPoint;
  dep_type: 'code' | 'dep_group';
}
export interface CellOutput {
  capacity: Hex;
  lock: Script;
  type?: Script | null;
}
export interface Transaction {
  version: Hex;
  cell_deps: CellDep[];
  header_deps: Hex[];
  inputs: { since: Hex; previous_output: OutPoint }[];
  outputs: CellOutput[];
  outputs_data: Hex[];
  witnesses: Hex[];
}
export interface Cell {
  output: CellOutput;
  data: Hex;
}
export interface OpeningNetwork {
  fundingLock: Script;
  commitmentLock: Script;
  commitmentCellDeps: number;
  epochDurationMs: number;
  minimumShutdownFee: bigint;
  fundingCellDeps: CellDep[];
}
export interface NetworkConfig extends OpeningNetwork {
  currency: 'Fibb' | 'Fibt' | 'Fibd';
  /** Absolute TLC safety bounds, in milliseconds. */
  minTlcExpiryDeltaMs?: number;
  tlcExpiryLimitMs?: number;
}
export interface FiberLspConfig {
  rpcUrl: string;
  wsUrl?: string;
  nodePublicKey: string;
  network: NetworkConfig;
}
export interface RegisterLspTenantParams {
  root_signer_pubkey: string;
  request_id: Hex;
  signed_at: Hex;
  signature: string;
}
export interface TenantStatus {
  tenant_id: string;
  root_signer_pubkey: string | null;
  invoice_pubkey: string;
  channels: { channel_id: Hex; funding_udt_type_script?: Script | null; online: boolean }[];
  created_at: Hex;
  runtime_status: 'cold' | 'active';
}
export interface RegisterLspTenantResult {
  tenant: TenantStatus;
  access_token: string;
}
export interface TenantRegistration {
  register(params: RegisterLspTenantParams): Promise<RegisterLspTenantResult>;
}
export interface SetupConfig {
  tenantId?: string;
  fiberLsp: FiberLspConfig;
  registration: TenantRegistration;
  /** Refresh an existing credential, retaining the original identity and history. */ refresh?: boolean;
}
export interface BeginRegistrationConfig {
  tenantId?: string;
  fiberLsp: FiberLspConfig;
}
export interface TenantInfo {
  tenantId: string;
  publicKey: string;
  fiberLsp: FiberLspConfig;
  ready: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ChainProvider {
  /** Must use an independently trusted CKB source for this configured network. */
  getLiveCell(outPoint: OutPoint, network: NetworkConfig): Promise<Cell | null>;
  /** Return only a committed transaction, with its full raw body. */
  getTransaction(hash: Hex, network: NetworkConfig): Promise<Transaction | null>;
  /** Resolve funding inputs, including cells now spent by this exact transaction. */
  getCell(outPoint: OutPoint, network: NetworkConfig): Promise<Cell | null>;
}
export interface FundingTerms {
  fundingAmount: bigint;
  shutdownScript: Script;
  fundingLockScript: Script;
  fundingLockScriptCellDeps?: CellDep[];
  udtTypeScript?: Script;
  commitmentDelayEpoch: bigint;
  commitmentFeeRate: bigint;
  fundingFeeRate: bigint;
  maxFundingFee: bigint;
  maxWalletDebit: bigint;
  remoteFundingAmount: bigint;
  tlcExpiryDeltaMs?: number;
  closeFeeRate?: bigint;
}
export interface FundingWallet {
  getFundingTerms(network: NetworkConfig): Promise<FundingTerms>;
  /** Approve the complete funding transaction and return every input, in order. */
  verifyFunding(
    transaction: Transaction,
    terms: FundingTerms,
    network: NetworkConfig,
  ): Promise<OutPoint[]>;
  /** Sign only wallet-owned inputs; preserve the raw transaction. */
  signFundingTransaction(transaction: Transaction): Promise<Transaction>;
}
export interface OpenChannelOptions {
  wallet: FundingWallet;
  /** Open an additional channel; an unfinished opening is always resumed first. */
  newChannel?: boolean;
}
export interface OpenResult {
  channel_id: Hex;
  unsigned_funding_tx: Transaction;
  opening_context: {
    remote_funding_key: string;
    remote_settlement_key: string;
    remote_shutdown_script: Script;
    commitment_delay_epoch: Hex;
    commitment_fee_rate: Hex;
    local_amount: Hex;
    remote_amount: Hex;
    local_reserved_ckb_amount: Hex;
    remote_reserved_ckb_amount: Hex;
  };
}
export interface ChannelInfo {
  tenantId: string;
  operationId: string;
  channelId: Hex | null;
  state: string;
  ready: boolean;
  closed: boolean;
  localBalance: bigint;
  remoteBalance: bigint;
  version: number;
  needsWallet?: boolean;
  failureReason?: string;
  raw?: Record<string, unknown>;
}
export interface PaymentInfo {
  tenantId: string;
  operationId: string;
  channelId: Hex;
  paymentHash: Hex | null;
  direction: PaymentDirection;
  status: string;
  complete: boolean;
  amount: bigint;
  fee?: bigint;
  invoice?: string;
  failureReason?: string;
  version: number;
  raw?: Record<string, unknown>;
}
export interface ParsedInvoice {
  paymentHash: Hex;
  amount: bigint | null;
  currency: NetworkConfig['currency'];
  payeePublicKey: string;
  timestamp: number;
  expiresAt: number;
  expirySeconds: number;
  hashAlgorithm: HashAlgorithm;
  udtTypeScript: Script | null;
  finalTlcExpiryDelta: number;
  allowMpp: boolean;
  trampolineHint: string | null;
  description: string | null;
  signed: boolean;
}
export interface CreateInvoiceOptions {
  channelId: Hex;
  amount: bigint;
  expirySeconds?: number;
  finalTlcExpiryDeltaMs?: number;
  description?: string;
  hashAlgorithm?: HashAlgorithm;
}
export interface PayInvoiceOptions {
  channelId: Hex;
  invoice: string;
  maxFee: bigint;
  maxFeeRate?: bigint;
}
export interface KeysendOptions {
  channelId: Hex;
  targetPublicKey: string;
  amount: bigint;
  maxFee: bigint;
  maxFeeRate?: bigint;
}
export interface ConfirmationRequest {
  tenantId: string;
  kind: 'openChannel' | 'closeChannel' | 'payInvoice' | 'keysend' | 'sign';
  channelId?: Hex;
  operationId?: string;
  details: Readonly<Record<string, unknown>>;
}
export enum FiberLspEvent {
  ChannelChanged = 'channelChanged',
  BalanceChanged = 'balanceChanged',
  PaymentChanged = 'paymentChanged',
  InvoiceChanged = 'invoiceChanged',
  ConnectionChanged = 'connectionChanged',
  Error = 'error',
}
export interface ConnectionInfo {
  tenantId: string;
  state: 'connecting' | 'recovering' | 'connected' | 'disconnected' | 'paused';
}
export interface EventMap {
  [FiberLspEvent.ChannelChanged]: ChannelInfo;
  [FiberLspEvent.BalanceChanged]: ChannelInfo;
  [FiberLspEvent.PaymentChanged]: PaymentInfo;
  [FiberLspEvent.InvoiceChanged]: PaymentInfo;
  [FiberLspEvent.ConnectionChanged]: ConnectionInfo;
  [FiberLspEvent.Error]: Error;
}
export interface WebSocketLike {
  readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(data: string): void;
  close(): void;
}
export type WebSocketFactory = (
  url: string,
  auth: { token: string; protocols: string[]; headers: Record<string, string> },
) => WebSocketLike;
export interface FiberLspOptions {
  storage: Storage;
  chain: ChainProvider;
  onConfirm: (request: ConfirmationRequest) => boolean | Promise<boolean>;
  fetch?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  signingPolicy?: 'auto' | 'manual';
}
