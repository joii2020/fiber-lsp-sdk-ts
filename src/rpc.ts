import { FiberLspError, RpcError, check } from './errors.js';
import { json } from './utils.js';
import type { RegisterLspTenantParams, RegisterLspTenantResult } from './types.js';
export class RpcTransport {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly timeout = 30_000,
  ) {
    const u = new URL(url);
    check(['http:', 'https:'].includes(u.protocol), 'INVALID_ARGUMENT', 'RPC URL must use HTTP(S)');
    check(!u.username && !u.password, 'INVALID_ARGUMENT', 'RPC URL must not contain credentials');
  }
  async call<T>(method: string, params: unknown, token: string, signal?: AbortSignal): Promise<T> {
    check(
      typeof token === 'string' && token.trim().length > 0 && !/[\r\n]/.test(token),
      'INVALID_ARGUMENT',
      'Access token must not be empty',
    );
    const id = ++this.id;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const fetcher = this.fetcher;
      const response = await fetcher(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: json({ jsonrpc: '2.0', id, method, params: [params] }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 401 || response.status === 403)
        throw new FiberLspError('AUTH', 'Tenant credential was rejected');
      check(response.ok, 'NETWORK', `RPC HTTP status ${response.status}`);
      const body = (await response.json()) as {
        jsonrpc?: string;
        id?: unknown;
        result?: T;
        error?: { code: number; message: string; data?: unknown };
      };
      check(
        body && body.jsonrpc === '2.0' && body.id === id && 'result' in body !== 'error' in body,
        'NETWORK',
        'Malformed JSON-RPC response',
      );
      if (body.error?.code === -32999)
        throw new FiberLspError('AUTH', 'Tenant credential was rejected');
      if (body.error)
        throw new RpcError(
          body.error.code,
          String(body.error.message).replaceAll(token, '[REDACTED]'),
          body.error.data,
        );
      return body.result as T;
    } catch (error) {
      if (error instanceof FiberLspError) throw error;
      throw new FiberLspError(
        'NETWORK',
        controller.signal.aborted
          ? 'RPC request was interrupted; its outcome may be unknown'
          : 'RPC request failed',
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}
/** A single privileged registration request for controlled local debugging. */
export async function debugRegisterTenant(options: {
  rpcUrl: string;
  token: string;
  params: RegisterLspTenantParams;
  fetch?: typeof fetch;
}): Promise<RegisterLspTenantResult> {
  check(
    typeof options.token === 'string' && options.token.trim().length > 0,
    'INVALID_ARGUMENT',
    'Registration token must not be empty',
  );
  return new RpcTransport(options.rpcUrl, options.fetch).call(
    'lsp_register_tenant',
    options.params,
    options.token,
  );
}
export function isInvoiceCreationRejected(error: unknown): error is RpcError {
  if (!(error instanceof RpcError)) return false;
  if (error.rpcCode === -32602) return true;
  if (error.rpcCode !== -32000) return false;

  // Fiber also uses -32000 for errors after persisting the invoice. Match only
  // parameter and feature checks that run before the invoice can be written.
  return [
    /^Currency must be (?:Fibb|Fibt|Fibd) with the chain network$/,
    /^Description with length of \d+ is too long, max length is 639$/,
    /^final_expiry_delta must be (?:greater|less) than or equal to \d+$/,
    /^Node does not support trampoline routing, please enable trampoline routing feature$/,
    /^hosted tenant invoices do not support MPP$/,
  ].some((message) => message.test(error.message));
}
export function isMissing(error: unknown, direction: 'incoming' | 'outgoing'): boolean {
  if (!(error instanceof RpcError) || ![-32000, -32001, -32602].includes(error.rpcCode))
    return false;
  return direction === 'incoming'
    ? /^invoice not found$/i.test(error.message)
    : /^(?:invalid parameter:?\s*)?payment session not found(?:: (?:0x)?[0-9a-f]{64})?$/i.test(
        error.message,
      );
}
