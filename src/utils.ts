import { check } from './errors.js';
export type Hex = `0x${string}`;
export function toHex(value: bigint | number): Hex {
  check(
    typeof value === 'bigint' || Number.isSafeInteger(value),
    'INVALID_ARGUMENT',
    'Integer must be a bigint or safe integer',
  );
  check(value >= 0, 'INVALID_ARGUMENT', 'Integer must be nonnegative');
  return `0x${value.toString(16)}`;
}
export function fromHex(value: unknown): bigint {
  check(
    typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value),
    'CORRUPT_DATA',
    'Invalid hexadecimal integer',
  );
  return BigInt(value);
}
export function bytesToHex(value: Uint8Array): Hex {
  return `0x${Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export function hexToBytes(value: string): Uint8Array {
  const s = value.startsWith('0x') ? value.slice(2) : value;
  check(/^(?:[0-9a-fA-F]{2})*$/.test(s), 'CORRUPT_DATA', 'Invalid hexadecimal bytes');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}
export function randomBytes(size = 32): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}
export function hash(value: string): asserts value is Hex {
  check(
    typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value),
    'INVALID_ARGUMENT',
    'Expected a 32-byte 0x-prefixed hash',
  );
}
export function tenantId(value: string): void {
  check(/^[0-9a-f]{64}$/.test(value), 'INVALID_ARGUMENT', 'Invalid tenantId');
}
export function pubkey(value: string): void {
  check(
    /^(02|03)[0-9a-f]{64}$/.test(value),
    'INVALID_ARGUMENT',
    'Expected a compressed public key without 0x',
  );
}
export function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(toHex(value));
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? toHex(v) : v));
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
