import type {
  Cell,
  CellDep,
  FiberLspConfig,
  FundingTerms,
  Hex,
  RegisterLspTenantParams,
  RegisterLspTenantResult,
  Script,
  Transaction,
} from 'fiber-lsp-sdk';

/** JSON boundary: amounts remain exact decimal strings, never floating-point numbers. */
export type Json<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
export type FundingTermsJson = Json<FundingTerms>;
export type PaymentJson = Json<import('fiber-lsp-sdk').PaymentInfo>;
export interface OffckbAccount {
  index: number;
  address: string;
  lockScript: Script;
  reserved?: string | null;
}
export interface User {
  id: string;
  name: string;
  display: string;
  accountIndex: number;
  address: string;
  lockScript: Script;
  createdAt: string;
  tenantIds: string[];
  rootPublicKeys: string[];
}
export interface CreateUserInput {
  name: string;
  display: string;
  accountIndex: number;
}
export interface DevnetConfig {
  ckbRpcUrl: string;
  genesisHash: Hex;
  accounts: OffckbAccount[];
  wallet: {
    fundingAmount: string;
    minFundingAmount: string;
    remoteFundingAmount: string;
    remoteLock: Script;
    defaultLockDep: CellDep;
  };
  fiberLsp: Json<FiberLspConfig>;
}
export interface NetworkStatus {
  blockNumber: string;
  nodePublicKey: string;
}
export interface WalletBalance {
  capacity: string;
}
export type RegisterUserInput = RegisterLspTenantParams & { userId?: string };
export type RegisterUserResult = RegisterLspTenantResult;
export interface TransactionResponse {
  tx_status: { status: string };
  transaction: (Transaction & { hash?: Hex }) | null;
}
export interface LiveCellResponse {
  status: string;
  cell?: { output: Cell['output']; data: { content: Hex } } | null;
}
export interface ChainRpcResults {
  get_transaction: TransactionResponse | null;
  get_live_cell: LiveCellResponse;
  get_blockchain_info: { median_time: Hex };
}
export type ChainCall = <M extends keyof ChainRpcResults>(
  method: M,
  params: unknown[],
) => Promise<ChainRpcResults[M]>;
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}
