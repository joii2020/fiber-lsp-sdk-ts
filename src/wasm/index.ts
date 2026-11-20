import init, {
  create_identity,
  execute,
  parse_invoice,
  payment_hash,
  transaction_hash,
  pack_script,
  close_template,
  verify_invoice_response,
  validate_public_key,
} from './fiber_lsp_sdk_wasm.js';
import { FiberLspError } from '../errors.js';
import { json, fromHex } from '../utils.js';
import type { ParsedInvoice, Transaction, HashAlgorithm, Script } from '../types.js';
const url = new URL('./fiber_lsp_sdk_wasm_bg.wasm', import.meta.url);
if (url.protocol === 'file:') {
  const { readFile } = await import('node:fs/promises');
  await init({ module_or_path: await readFile(url) });
} else {
  await init({ module_or_path: fetch(url) });
}
export interface SignerState {
  snapshot: string;
  session: string;
}
export interface SignerResult<T> extends SignerState {
  value: T;
}
function wrap<T>(action: () => T): T {
  try {
    return action();
  } catch (cause) {
    throw new FiberLspError('VERIFICATION', String(cause), { cause });
  }
}
export async function createIdentity(): Promise<
  SignerResult<{ root: string; tenantId: string; publicKey: string }>
> {
  return JSON.parse(await create_identity()) as SignerResult<{
    root: string;
    tenantId: string;
    publicKey: string;
  }>;
}
export async function signerAction<T>(
  root: Uint8Array,
  state: SignerState,
  command: Record<string, unknown>,
): Promise<SignerResult<T>> {
  try {
    return JSON.parse(
      await execute(root, state.snapshot, state.session, json(command)),
    ) as SignerResult<T>;
  } catch (cause) {
    throw new FiberLspError('VERIFICATION', String(cause), { cause });
  }
}
export function parseInvoice(invoice: string): ParsedInvoice {
  const p = wrap(() => JSON.parse(parse_invoice(invoice))) as Record<string, unknown>;
  const safe = (key: string) => {
    const n = fromHex(p[key]);
    if (n > BigInt(Number.MAX_SAFE_INTEGER))
      throw new FiberLspError('VERIFICATION', 'Invoice time exceeds safe integer range');
    return Number(n);
  };
  return {
    ...p,
    amount: p.amount === null ? null : fromHex(p.amount),
    timestamp: safe('timestamp'),
    expiresAt: safe('expiresAt'),
    expirySeconds: safe('expirySeconds'),
    finalTlcExpiryDelta: safe('finalTlcExpiryDelta'),
  } as unknown as ParsedInvoice;
}
export function paymentHash(preimage: Uint8Array, algorithm: HashAlgorithm): `0x${string}` {
  return wrap(() => payment_hash(preimage, algorithm)) as `0x${string}`;
}
export function transactionHash(tx: Transaction): `0x${string}` {
  return wrap(() => transaction_hash(json(tx))) as `0x${string}`;
}
export function packScript(script: Script): `0x${string}` {
  return wrap(() => pack_script(json(script))) as `0x${string}`;
}

export function closeTemplate(args: Record<string, unknown>): {
  fee: `0x${string}`;
  transaction: Transaction;
} {
  return wrap(() => JSON.parse(close_template(json(args)))) as {
    fee: `0x${string}`;
    transaction: Transaction;
  };
}

export function verifyInvoiceResponse(address: string, body: unknown): void {
  wrap(() => verify_invoice_response(address, json(body)));
}

export function validatePublicKey(value: string): void {
  wrap(() => validate_public_key(value));
}
