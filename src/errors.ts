export type ErrorCode =
  | 'INVALID_ARGUMENT'
  | 'CORRUPT_DATA'
  | 'NOT_FOUND'
  | 'NOT_READY'
  | 'LOCKED'
  | 'CLOSED'
  | 'CLEANING_UP'
  | 'CONFLICT'
  | 'REJECTED'
  | 'NETWORK'
  | 'AUTH'
  | 'RPC'
  | 'VERIFICATION'
  | 'STORAGE'
  | 'UNKNOWN_OUTCOME';
export class FiberLspError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FiberLspError';
  }
}
export class RpcError extends FiberLspError {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super('RPC', message);
    this.name = 'RpcError';
  }
}
export function check(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new FiberLspError(code, message);
}
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
