import type { RegisterLspTenantParams } from 'fiber-lsp-sdk';
import { badRequest } from './users.ts';
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('Invalid request format');
  return value as Record<string, unknown>;
}
export function stringField(input: Record<string, unknown>, key: string): string {
  if (typeof input[key] !== 'string') throw badRequest(`Missing string field: ${key}`);
  return input[key];
}
export function numberField(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw badRequest(`Invalid integer field: ${key}`);
  return value;
}
export function registrationProof(input: Record<string, unknown>): RegisterLspTenantParams {
  const request_id = stringField(input, 'request_id'),
    signed_at = stringField(input, 'signed_at');
  if (!request_id.startsWith('0x') || !signed_at.startsWith('0x'))
    throw badRequest('Invalid registration proof format');
  return {
    root_signer_pubkey: stringField(input, 'root_signer_pubkey'),
    request_id: request_id as `0x${string}`,
    signed_at: signed_at as `0x${string}`,
    signature: stringField(input, 'signature'),
  };
}
export function publicError(
  error: unknown,
  message: string,
  status = 502,
): { message: string; status: number } {
  if (error instanceof Error && 'status' in error && typeof error.status === 'number')
    return { message: error.message, status: error.status };
  return { message, status };
}
