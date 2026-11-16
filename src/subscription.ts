import { FiberLspError, check } from './errors.js';
import type { WebSocketFactory, WebSocketLike } from './types.js';
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
  private pending = new Map<
    number,
    { resolve: () => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private rejectOpen: ((e: unknown) => void) | undefined;
  constructor(
    private readonly wake: () => void,
    private readonly disconnected: (error: Error) => void,
  ) {}
  async connect(
    url: string,
    token: string,
    factory?: WebSocketFactory,
    timeout = 30_000,
  ): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new FiberLspError('NETWORK', 'Signing subscription timed out'));
        this.close();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'subscribe',
          params: ['channel_signing', {}],
        }),
      );
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
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new FiberLspError(
              message.error.code === -32999 ? 'AUTH' : 'RPC',
              'Signing subscription was rejected',
            ),
          );
          this.close();
        } else {
          check(
            typeof message.result === 'string' || typeof message.result === 'number',
            'NETWORK',
            'Invalid subscription ID',
          );
          this.subscriptions.add(message.result);
          pending.resolve();
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
      // Notifications are hints only. Always fetch current state through the same
      // validated status path; never trust notification payloads as signed state.
      if (type === 'removed') {
        this.fail(new FiberLspError('NETWORK', 'Signing subscription ended'));
        return;
      }
      this.wake();
    } catch (cause) {
      this.fail(new FiberLspError('NETWORK', 'Invalid signing notification', { cause }));
    }
  };
  private fail(error: Error): void {
    if (this.closed) return;
    this.close();
    this.disconnected(error);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new FiberLspError('CLOSED', 'Signing subscription closed');
    this.rejectOpen?.(error);
    this.rejectOpen = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.subscriptions.clear();
    if (this.socket) {
      this.socket.removeEventListener('message', this.message);
      this.socket.close();
      this.socket = undefined;
    }
  }
}
