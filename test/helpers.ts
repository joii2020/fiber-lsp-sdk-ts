import type {
  ChainProvider,
  FiberLspOptions,
  FiberLspConfig,
  NetworkConfig,
  RegisterLspTenantResult,
  Script,
  Storage,
} from '../src/index.js';
import type { ChannelFixture, RpcHandler, RpcRequest, RpcRequestOptions } from './fixture-types.ts';
export type { ChannelFixture, RpcHandler, RpcRequest, RpcRequestOptions } from './fixture-types.ts';
import { MemoryStorage, fiberlsp } from '../dist/index.js';
import { readFile } from 'node:fs/promises';
export const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
export const script: Script = {
  code_hash: `0x${'11'.repeat(32)}` as const,
  hash_type: 'type',
  args: '0x',
};
export const network: NetworkConfig = {
  currency: 'Fibd',
  fundingLock: script,
  commitmentLock: { ...script, code_hash: `0x${'22'.repeat(32)}` as const },
  commitmentCellDeps: 1,
  epochDurationMs: 14400000,
  minimumShutdownFee: 100000000n,
  fundingCellDeps: [],
};
export const config: FiberLspConfig = {
  rpcUrl: 'http://127.0.0.1:8119',
  nodePublicKey: key,
  network,
};
export function result(
  id: string,
  publicKey: string,
  token = 'tenant-token',
): RegisterLspTenantResult {
  return {
    tenant: {
      tenant_id: id,
      root_signer_pubkey: publicKey,
      invoice_pubkey: key,
      channels: [],
      created_at: '0x1',
      runtime_status: 'cold',
    },
    access_token: token,
  };
}
export const chain: ChainProvider = {
  getTransaction: async () => null,
  getCell: async () => null,
  getLiveCell: async () => null,
};
export function make(options: Partial<FiberLspOptions> = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const lsp = new fiberlsp({
    storage,
    chain,
    onConfirm: () => true,
    pollIntervalMs: 60_000,
    ...options,
  });
  return { storage, lsp };
}
export async function register(lsp: fiberlsp, fiberLsp: FiberLspConfig = config) {
  const pending = await lsp.beginRegistration({ fiberLsp });
  return lsp.finishRegistration(
    pending.tenantId,
    result(pending.tenantId, pending.params.root_signer_pubkey),
  );
}
export function fetchRpc(handler: RpcHandler): typeof fetch {
  return async (url, options) => {
    const body = JSON.parse(String(options?.body)) as RpcRequest;
    const headers = Object.fromEntries(new Headers(options?.headers));
    const requestOptions: RpcRequestOptions = { ...options, headers, body: String(options?.body) };
    try {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: await handler(body.method, body.params[0], requestOptions, body),
      });
    } catch (e) {
      if (e && typeof e === 'object' && 'rpcCode' in e && 'message' in e)
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: e.rpcCode, message: e.message },
        });
      throw e;
    }
  };
}
export const fixture = async (): Promise<ChannelFixture> =>
  JSON.parse(await readFile(new URL('./fixtures/channel.json', import.meta.url), 'utf8'));
export async function seedFixture(
  storage: Storage,
  f: ChannelFixture,
  rpcUrl = config.rpcUrl,
  wsUrl?: string,
) {
  const fiberLsp: FiberLspConfig = {
    rpcUrl,
    nodePublicKey: f.nodePublicKey,
    network: { ...network, fundingLock: f.script, commitmentLock: f.commitmentLock },
  };
  if (wsUrl) fiberLsp.wsUrl = wsUrl;
  const info = {
    tenantId: f.tenantId,
    publicKey: f.publicKey,
    fiberLsp,
    ready: false,
    createdAt: 1,
    updatedAt: 1,
  };
  await storage.commit(
    [
      {
        key: `tenant/${f.tenantId}`,
        value: {
          schema: 1,
          revision: 0,
          info,
          signer: { snapshot: f.snapshot, session: f.session },
          openings: [],
          payments: [],
          channels: [],
          submissions: {},
        },
        expected: null,
      },
    ],
    [{ tenantId: f.tenantId, key: Uint8Array.from(Buffer.from(f.root, 'hex')) }],
  );
  return fiberLsp;
}
