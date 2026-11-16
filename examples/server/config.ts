import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load } from 'js-yaml';
import toml from '@iarna/toml';
import type { CellDep, Hex, Script } from 'fiber-lsp-sdk';
import type { DevnetConfig, OffckbAccount } from '../shared/types.ts';
import { rpc } from './rpc.ts';
import { CKB, readOffckbAccounts, sameScript, defaultLockDep } from './wallet.ts';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const tokenFile = resolve(
  root,
  process.env.FIBER_OPERATOR_TOKEN ?? '.devnet/keys/operator-token',
);
const nodeDir = resolve(
  root,
  process.env.XDG_DATA_HOME ?? resolve(homedir(), '.local/share'),
  'offckb-nodejs/devnet/fiber/nodes/3',
);
interface NodeConfig {
  ckb: { rpc_url: string };
  rpc: { listening_addr: string; ws_listening_addr?: string };
  fiber: {
    chain: string;
    scripts: { name: string; script: Script; cell_deps: { cell_dep: CellDep }[] }[];
  };
}
interface NodeInfo {
  chain_hash: Hex;
  pubkey: string;
  default_funding_lock_script: Script;
  auto_accept_channel_ckb_funding_amount: Hex;
  open_channel_auto_accept_min_ckb_funding_amount: Hex;
}

// Match fiber-lab: Node1–3 use #3–#5; user wallets use #6–#9.
export function reserveExampleAccounts(
  accounts: readonly OffckbAccount[],
  lspLock: Script,
): OffckbAccount[] {
  return accounts.map((account) => {
    let reserved = account.reserved ?? null;
    if (sameScript(account.lockScript, lspLock)) reserved = 'LSP funding account';
    else if (account.index >= 0 && account.index <= 2)
      reserved = `Preallocated test account (${['Alice', 'Bob', 'Carol'][account.index]})`;
    else if (account.index >= 3 && account.index <= 5)
      reserved = `Fiber Node${account.index - 2} funding account`;
    else if (account.index === 19) reserved = 'Contract deployment / test UDT issuance account';
    else if (account.index < 6 || account.index > 9)
      reserved = 'Reserved account (users use #6–#9)';
    return { ...account, reserved };
  });
}

// Read offckb's local deployment and this project's operator credential.
export async function readDevnetConfig(): Promise<DevnetConfig> {
  const node = load(await readFile(resolve(nodeDir, 'config.yml'), 'utf8')) as NodeConfig;
  if (
    !node?.ckb?.rpc_url ||
    !node.rpc?.listening_addr ||
    !node.fiber?.chain ||
    !Array.isArray(node.fiber.scripts)
  )
    throw Error('Invalid offckb node configuration');
  const spec = toml.parse(await readFile(resolve(nodeDir, node.fiber.chain), 'utf8')) as {
    name: string;
    params: { epoch_duration_target: number };
  };
  if (spec.name !== 'ckb_dev') throw Error('The example requires offckb devnet');
  const ckbRpcUrl = node.ckb.rpc_url;
  const rpcUrl = `http://${node.rpc.listening_addr}`;
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const genesisHash = await rpc<Hex>(ckbRpcUrl, 'get_block_hash', ['0x0']);
  const info = await rpc<NodeInfo>(rpcUrl, 'node_info', [], token);
  const status = await rpc<{ public_node_id: string }>(rpcUrl, 'lsp_get_status', [], token);
  if (info.chain_hash !== genesisHash || info.pubkey !== status.public_node_id)
    throw Error('LSP identity or chain does not match the local offckb deployment');
  const funding = node.fiber.scripts.find((script) => script.name === 'FundingLock');
  const commitment = node.fiber.scripts.find((script) => script.name === 'CommitmentLock');
  if (!funding || !commitment)
    throw Error('Channel contracts are missing from the local configuration');
  const accounts = await readOffckbAccounts();
  const remoteAmount = BigInt(info.auto_accept_channel_ckb_funding_amount);
  const minimum = BigInt(info.open_channel_auto_accept_min_ckb_funding_amount);
  if (!minimum || remoteAmount <= 99n * CKB)
    throw Error('LSP must auto-accept channels and provide inbound liquidity');
  return {
    ckbRpcUrl,
    genesisHash,
    accounts: reserveExampleAccounts(accounts, info.default_funding_lock_script),
    wallet: {
      fundingAmount: (minimum > 1000n * CKB ? minimum : 1000n * CKB).toString(),
      remoteFundingAmount: remoteAmount.toString(),
      remoteLock: info.default_funding_lock_script,
      defaultLockDep: await defaultLockDep(ckbRpcUrl, accounts[0]!.lockScript),
    },
    fiberLsp: {
      rpcUrl,
      wsUrl: node.rpc.ws_listening_addr ? `ws://${node.rpc.ws_listening_addr}` : undefined,
      nodePublicKey: status.public_node_id,
      network: {
        currency: 'Fibd',
        fundingLock: funding.script,
        commitmentLock: commitment.script,
        commitmentCellDeps: funding.cell_deps.length,
        epochDurationMs: spec.params.epoch_duration_target * 1000,
        minimumShutdownFee: '100000000',
        fundingCellDeps: funding.cell_deps.map((entry) => entry.cell_dep),
      },
    },
  };
}
