import { FiberLspError, RpcError, check } from './errors.js';
import type { WebSocketFactory, WebSocketLike } from './types.js';
import { hash, json } from './utils.js';
import type { Hex } from './utils.js';
export interface ChannelSigningUpdate {
  channel_id: Hex;
  status: Record<string, unknown>;
}
export async function defaultWebSocket(
  url: string,
  token: string,
  factory?: WebSocketFactory,
): Promise<WebSocketLike> {
  const protocols = ['fiber-rpc', `base64url.bearer.authorization.fiber.${token}`];
  const auth = { token, protocols, headers: { Authorization: `Bearer ${token}` } };
  if (factory) return factory(url, auth);
  if (typeof globalThis.process !== 'undefined' && globalThis.process.versions?.node) {
    const { default: WebSocket } = await import('ws');
    return new WebSocket(url, { headers: auth.headers }) as unknown as WebSocketLike;
  }
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}
export class SigningSubscription {
  private socket: WebSocketLike | undefined;
  private closed = false;
  private subscriptions = new Set<string | number>();
  private id = 0;
  private token = '';
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: unknown) => void; subscribe: boolean }
  >();
  private rejectOpen: ((e: unknown) => void) | undefined;
  constructor(
    private readonly wake: (update: ChannelSigningUpdate) => void,
    private readonly disconnected: (error: Error) => void,
  ) {}
  get connected(): boolean {
    return !this.closed && this.socket?.readyState === 1 && this.subscriptions.size > 0;
  }
  async connect(
    url: string,
    token: string,
    factory?: WebSocketFactory,
    timeout = 30_000,
  ): Promise<void> {
    this.token = token;
    const socket = await defaultWebSocket(url, token, factory);
    if (this.closed) {
      socket.close();
      throw new FiberLspError('CLOSED', 'Subscription closed');
    }
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      this.rejectOpen = reject;
      const timer = setTimeout(() => {
        reject(new FiberLspError('NETWORK', 'WebSocket connection timed out'));
        this.close();
      }, timeout);
      const opened = () => {
        clearTimeout(timer);
        this.rejectOpen = undefined;
        resolve();
      };
      socket.addEventListener('open', opened);
      socket.addEventListener('message', this.message);
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        this.fail(new FiberLspError('NETWORK', 'WebSocket disconnected'));
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        this.fail(new FiberLspError('NETWORK', 'WebSocket connection failed'));
      });
      if (socket.readyState === 1) opened();
    });
    try {
      await this.request('subscribe', ['channel_signing', {}], timeout, undefined, true);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  call<T>(method: string, params: unknown, timeout = 30_000, signal?: AbortSignal): Promise<T> {
    check(this.connected, 'NETWORK', 'WebSocket is not connected');
    return this.request(method, [params], timeout, signal);
  }
  private request<T>(
    method: string,
    params: unknown[],
    timeout: number,
    signal?: AbortSignal,
    subscribe = false,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || signal?.aborted) {
        reject(new FiberLspError('CLOSED', 'WebSocket request interrupted'));
        return;
      }
      const id = ++this.id;
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(new FiberLspError('CLOSED', 'WebSocket request interrupted'));
      const timer = setTimeout(() => {
        const error = new FiberLspError(
          'NETWORK',
          'WebSocket RPC timed out; its outcome may be unknown',
        );
        finish(error);
        this.fail(error);
      }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => finish(undefined, value),
        reject: (error) => finish(error),
        subscribe,
      });
      try {
        this.socket!.send(json({ jsonrpc: '2.0', id, method, params }));
      } catch (cause) {
        const error = new FiberLspError(
          'NETWORK',
          'WebSocket RPC failed; its outcome may be unknown',
          { cause },
        );
        finish(error);
        this.fail(error);
      }
    });
  }
  private message = (event: { data: unknown }): void => {
    if (this.closed) return;
    try {
      const message = JSON.parse(String(event.data)) as Record<string, any>;
      check(message.jsonrpc === '2.0', 'NETWORK', 'Invalid WebSocket RPC version');
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        check(
          'result' in message !== 'error' in message,
          'NETWORK',
          'Malformed WebSocket RPC response',
        );
        if (message.error) {
          pending.reject(
            message.error.code === -32999
              ? new FiberLspError('AUTH', 'Tenant credential was rejected')
              : new RpcError(
                  message.error.code,
                  String(message.error.message).replaceAll(this.token, '[REDACTED]'),
                  message.error.data,
                ),
          );
        } else {
          if (pending.subscribe) {
            check(
              typeof message.result === 'string' || typeof message.result === 'number',
              'NETWORK',
              'Invalid subscription ID',
            );
            this.subscriptions.add(message.result);
          }
          pending.resolve(message.result);
        }
        return;
      }
      if (!this.subscriptions.has(message.params?.subscription)) return;
      const type = message.params?.result?.type;
      check(
        ['channel_signing', 'removed'].includes(type),
        'NETWORK',
        'Unexpected signing subscription event',
      );
      if (type === 'removed') {
        this.fail(new FiberLspError('NETWORK', 'Signing subscription ended'));
        return;
      }
      const data = message.params.result.data;
      hash(data?.channel_id);
      check(
        data.status && ['SignatureRequired', 'NoSignatureRequired'].includes(data.status.type),
        'NETWORK',
        'Invalid channel signing status',
      );
      // The signer independently verifies the pushed request before producing a signature.
      this.wake(data);
    } catch (cause) {
      this.fail(new FiberLspError('NETWORK', 'Invalid signing notification', { cause }));
    }
  };
  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    this.disconnected(error);
  }
  close(error: Error = new FiberLspError('CLOSED', 'Signing subscription closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectOpen?.(error);
    this.rejectOpen = undefined;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.subscriptions.clear();
    if (this.socket) {
      this.socket.removeEventListener('message', this.message);
      this.socket.close();
      this.socket = undefined;
    }
  }
}
