import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DevnetConfig, FundingTermsJson } from '../shared/types.ts';
import type { Transaction } from 'fiber-lsp-sdk';
import { hasErrorCode } from '../shared/types.ts';
import { record, stringField, numberField, publicError, registrationProof } from './validation.ts';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpc } from './rpc.ts';
import { registerTenant } from './registration.ts';
import { UserStore, badRequest } from './users.ts';
import { attachDevnetWebSocket } from './websocket.ts';
import {
  sameScript,
  fundingTerms,
  walletBalance,
  verifyWalletFunding,
  signWalletFunding,
} from './wallet.ts';

import { root, tokenFile, readDevnetConfig } from './config.ts';
export { readDevnetConfig } from './config.ts';
const chainMethods = new Set(['get_transaction', 'get_live_cell']);

export function createDevnetHandler(
  config: DevnetConfig,
  readToken = () => readFile(tokenFile, 'utf8'),
  options: { users?: UserStore } = {},
) {
  const users =
    options.users ??
    new UserStore(
      resolve(root, process.env.EXAMPLE_USERS_FILE ?? '.devnet/example-users.json'),
      `${config.genesisHash}:${config.fiberLsp.nodePublicKey}`,
    );
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    if (!pathname.startsWith('/devnet/')) return false;
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (pathname === '/devnet/config' && req.method === 'GET') {
      reply(200, config);
      return true;
    }
    if (pathname === '/devnet/users' && req.method === 'GET') {
      try {
        reply(200, { users: await users.list() });
      } catch (error) {
        const failure = publicError(error, 'Cannot read user JSON', 500);
        reply(failure.status, { error: failure.message });
      }
      return true;
    }
    if (pathname === '/devnet/status' && req.method === 'GET') {
      try {
        const [tip, status] = await Promise.all([
          rpc<string>(config.ckbRpcUrl, 'get_tip_block_number'),
          rpc<{ public_node_id: string }>(
            config.fiberLsp.rpcUrl,
            'lsp_get_status',
            [],
            (await readToken()).trim(),
          ),
        ]);
        reply(200, { blockNumber: BigInt(tip).toString(), nodePublicKey: status.public_node_id });
      } catch {
        reply(503, { error: 'CKB or LSP is offline. Start the devnet first.' });
      }
      return true;
    }
    if (
      ![
        '/devnet/register',
        '/devnet/chain',
        '/devnet/rpc',
        '/devnet/users',
        '/devnet/users/delete',
        '/devnet/wallet',
      ].includes(pathname)
    ) {
      reply(404, { error: 'Unknown endpoint' });
      return true;
    }
    if (req.method !== 'POST') {
      reply(405, { error: 'POST required' });
      return true;
    }
    if (
      !req.headers.host ||
      ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(
        req.headers.origin ?? '',
      ) ||
      req.headers['content-type'] !== 'application/json'
    ) {
      reply(403, { error: 'Use the example page on this host' });
      return true;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > (pathname === '/devnet/wallet' ? 256_000 : 16_384)) {
          reply(413, { error: 'Request too large' });
          return true;
        }
      }
      const input = record(JSON.parse(body));
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw badRequest('Invalid request format');
      if (pathname === '/devnet/users') {
        reply(
          201,
          await users.create(
            {
              name: stringField(input, 'name'),
              display: stringField(input, 'display'),
              accountIndex: numberField(input, 'accountIndex'),
            },
            config.accounts,
          ),
        );
      } else if (pathname === '/devnet/users/delete') {
        reply(200, await users.deleteUnregistered(stringField(input, 'userId')));
      } else if (pathname === '/devnet/wallet') {
        const user = await users.get(stringField(input, 'userId'));
        const account = config.accounts.find((entry) => entry.index === user.accountIndex);
        if (!account || account.reserved || !sameScript(account.lockScript, user.lockScript))
          throw badRequest('Wallet binding does not match the current offckb environment', 409);
        if (input.action === 'balance') reply(200, await walletBalance(config, user));
        else if (input.action === 'terms')
          reply(
            200,
            fundingTerms(
              config,
              user,
              input.fundingAmount === undefined ? undefined : stringField(input, 'fundingAmount'),
            ),
          );
        else if (input.action === 'verify')
          reply(
            200,
            await verifyWalletFunding(
              config,
              user,
              input.transaction as Transaction,
              input.terms as FundingTermsJson,
            ),
          );
        else if (input.action === 'sign')
          reply(
            200,
            await signWalletFunding(
              config,
              user,
              input.transaction as Transaction,
              input.terms as FundingTermsJson,
            ),
          );
        else throw badRequest('Unknown wallet operation');
      } else if (pathname === '/devnet/rpc') {
        // Forward only the tenant credential supplied by the SDK, never the operator token.
        if (!req.headers.authorization?.startsWith('Bearer ')) {
          reply(401, { error: 'Tenant credential required' });
          return true;
        }
        const response = await fetch(config.fiberLsp.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization },
          body,
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
        });
        res.writeHead(response.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(await response.text());
      } else if (pathname === '/devnet/register') {
        const result = await registerTenant(registrationProof(input), {
          rpcUrl: config.fiberLsp.rpcUrl,
          readToken,
          user: input.userId ? { id: stringField(input, 'userId'), store: users } : undefined,
        });
        reply(200, result);
      } else {
        if (
          typeof input.method !== 'string' ||
          !chainMethods.has(input.method) ||
          !Array.isArray(input.params)
        ) {
          reply(400, { error: 'Only get_transaction and get_live_cell are supported' });
          return true;
        }
        reply(200, { result: await rpc(config.ckbRpcUrl, input.method, input.params) });
      }
    } catch (error) {
      // Do not expose credentials, node filesystem paths or RPC error payloads.
      const failure = publicError(
        error,
        'Local request failed. Check that the devnet is running. Operation data is saved; refresh to resume.',
      );
      reply(failure.status, { error: failure.message });
    }
    return true;
  };
}

export async function serve() {
  const port = 8008;
  let config: DevnetConfig;
  try {
    config = await readDevnetConfig();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      throw Error('Prepare offckb first: sh examples/devnet/init.sh');
    throw error;
  }
  const handler = createDevnetHandler(config);
  const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.wasm': 'application/wasm',
  };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (await handler(req, res, pathname)) return;
    const relative =
      pathname === '/'
        ? 'examples/browser.html'
        : pathname.startsWith('/example/')
          ? `.example/${pathname.slice('/example/'.length)}`
          : pathname.slice(1);
    if (
      pathname !== '/' &&
      !pathname.startsWith('/example/browser/') &&
      !pathname.startsWith('/example/shared/') &&
      pathname !== '/examples/styles.css' &&
      !pathname.startsWith('/dist/')
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const path = resolve(root, relative);
    if (!path.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const bytes = await readFile(path);
      res.writeHead(200, {
        'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('Run pnpm build before starting this example.');
    }
  });
  attachDevnetWebSocket(server, config.fiberLsp.wsUrl);
  server.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, () => console.log(`Example server listening on port ${port}`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await serve();
}
