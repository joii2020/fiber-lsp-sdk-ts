import type { CellDep, Hex, OutPoint, Script, Transaction } from 'fiber-lsp-sdk';
import type {
  DevnetConfig,
  FundingTermsJson,
  LiveCellResponse,
  OffckbAccount,
  User,
  WalletBalance,
} from '../shared/types.ts';
type WalletUser = Pick<User, 'lockScript' | 'accountIndex'>;
interface SecretAccount extends OffckbAccount {
  privateKey: Hex;
}
interface OffckbResult {
  ok: boolean;
  command: string;
  forked: boolean;
  context: string;
  accounts: {
    index: number;
    address: string;
    privkey?: Hex;
    lockScript: { codeHash: Hex; hashType: Script['hash_type']; args: Hex };
  }[];
}
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ccc } from '@ckb-ccc/core';
import { JsonRpcTransformers } from '@ckb-ccc/core/advanced';
import { rpc } from './rpc.ts';
import { badRequest } from './users.ts';

const execute = promisify(execFile);
export const CKB = 100_000_000n;
const hex = (value: number | bigint): Hex => `0x${BigInt(value).toString(16)}`;
export const sameScript = (a: Script | null | undefined, b: Script | null | undefined): boolean =>
  a?.code_hash === b?.code_hash && a?.hash_type === b?.hash_type && a?.args === b?.args;

export function readOffckbAccounts(privateKeys: true): Promise<SecretAccount[]>;
export function readOffckbAccounts(privateKeys?: false): Promise<OffckbAccount[]>;
export async function readOffckbAccounts(
  privateKeys = false,
): Promise<(OffckbAccount | SecretAccount)[]> {
  // Never forward command output or errors: offckb includes keys in both logs and result.
  let stdout;
  try {
    ({ stdout } = await execute(
      process.env.OFFCKB_BINARY ?? 'offckb',
      ['--json', 'accounts', privateKeys ? '--show-private-keys' : '--hide-private-keys'],
      { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
    ));
  } catch {
    throw Error(
      'Cannot read preset offckb accounts. Check the offckb installation and local environment.',
    );
  }
  let result: OffckbResult | undefined;
  try {
    result = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as OffckbResult)
      .find((row) => row.command === 'accounts');
  } catch {
    throw Error('offckb accounts returned invalid JSON');
  }
  if (!result?.ok || result.forked || result.context !== 'DEVNET')
    throw Error('This example only supports the native offckb devnet');
  return result.accounts.map((account) => ({
    index: account.index,
    address: account.address,
    lockScript: {
      code_hash: account.lockScript.codeHash,
      hash_type: account.lockScript.hashType,
      args: account.lockScript.args,
    },
    ...(privateKeys ? { privateKey: account.privkey } : {}),
  }));
}

export function fundingTerms(
  config: DevnetConfig,
  user: Pick<User, 'lockScript'>,
): FundingTermsJson {
  const amount = BigInt(config.wallet.fundingAmount);
  return {
    fundingAmount: amount.toString(),
    remoteFundingAmount: config.wallet.remoteFundingAmount,
    fundingLockScript: user.lockScript,
    shutdownScript: user.lockScript,
    fundingLockScriptCellDeps: [config.wallet.defaultLockDep],
    commitmentDelayEpoch: '1099511627777', // EpochNumberWithFraction(1, 0, 1)
    commitmentFeeRate: '1000',
    fundingFeeRate: '1000',
    closeFeeRate: '1000',
    maxFundingFee: CKB.toString(),
    maxWalletDebit: (amount + CKB).toString(),
  };
}

export async function walletBalance(
  config: DevnetConfig,
  user: Pick<User, 'lockScript'>,
): Promise<WalletBalance> {
  const result = await rpc<{ capacity: Hex }>(config.ckbRpcUrl, 'get_cells_capacity', [
    {
      script: user.lockScript,
      script_type: 'lock',
      script_search_mode: 'exact',
      filter: { script_len_range: ['0x0', '0x1'], output_data_len_range: ['0x0', '0x1'] },
    },
  ]);
  return { capacity: BigInt(result?.capacity ?? '0x0').toString() };
}

export async function verifyWalletFunding(
  config: DevnetConfig,
  user: Pick<User, 'lockScript'>,
  tx: Transaction,
  terms: FundingTermsJson,
  call: (url: string, method: string, params: unknown[]) => Promise<LiveCellResponse> = rpc,
): Promise<OutPoint[]> {
  const expected = fundingTerms(config, user);
  for (const key of Object.keys(expected) as (keyof FundingTermsJson)[]) {
    const value = expected[key];
    const actual = terms[key];
    const matches =
      key === 'fundingLockScript' || key === 'shutdownScript'
        ? sameScript(terms[key], expected[key])
        : Array.isArray(value)
          ? JSON.stringify(actual) === JSON.stringify(value)
          : String(actual) === value;
    if (!matches) throw badRequest(`Wallet funding terms do not match: ${key}`);
  }
  if (
    terms.udtTypeScript ||
    tx.version !== '0x0' ||
    tx.header_deps.length ||
    !tx.inputs.length ||
    !tx.outputs.length ||
    tx.outputs.length !== tx.outputs_data.length
  )
    throw badRequest('Invalid CKB funding transaction');
  const dep = config.wallet.defaultLockDep;
  if (tx.cell_deps.length !== 1 || JSON.stringify(tx.cell_deps[0]) !== JSON.stringify(dep))
    throw badRequest('Funding transaction uses unknown dependencies');
  const seen = new Set();
  let total = 0n,
    local = 0n,
    remote = 0n;
  for (const input of tx.inputs) {
    const key = `${input.previous_output.tx_hash}:${BigInt(input.previous_output.index)}`;
    if (seen.has(key) || BigInt(input.since) !== 0n)
      throw badRequest('Duplicate or restricted funding input');
    seen.add(key);
    const cell = await call(config.ckbRpcUrl, 'get_live_cell', [input.previous_output, true]);
    if (
      cell.status !== 'live' ||
      !cell.cell ||
      cell.cell.output.type ||
      cell.cell.data.content !== '0x'
    )
      throw badRequest('Funding input is not an available plain CKB Cell');
    const { output } = cell.cell;
    const capacity = BigInt(output.capacity);
    total += capacity;
    if (sameScript(output.lock, user.lockScript)) local += capacity;
    else if (sameScript(output.lock, config.wallet.remoteLock)) remote += capacity;
    else throw badRequest('Funding input does not belong to the user or LSP');
  }
  const funding = tx.outputs[0]!;
  const trusted = config.fiberLsp.network.fundingLock;
  if (
    funding.lock.code_hash !== trusted.code_hash ||
    funding.lock.hash_type !== trusted.hash_type ||
    !/^0x[0-9a-f]{40}$/.test(funding.lock.args) ||
    BigInt(funding.capacity) !==
      BigInt(expected.fundingAmount) + BigInt(expected.remoteFundingAmount)
  )
    throw badRequest('Channel contract or total funding amount does not match');
  let outputs = 0n;
  for (let index = 0; index < tx.outputs.length; index++) {
    const output = tx.outputs[index]!;
    if (output.type || tx.outputs_data[index] !== '0x')
      throw badRequest('Unsupported funding asset');
    const capacity = BigInt(output.capacity);
    outputs += capacity;
    if (!index) continue;
    if (sameScript(output.lock, user.lockScript)) local -= capacity;
    else if (sameScript(output.lock, config.wallet.remoteLock)) remote -= capacity;
    else throw badRequest('Change address does not belong to the user or LSP');
  }
  if (
    total < outputs ||
    total - outputs > CKB ||
    local < BigInt(expected.fundingAmount) ||
    local > BigInt(expected.maxWalletDebit) ||
    remote < BigInt(expected.remoteFundingAmount)
  )
    throw badRequest('Wallet debit, LSP funding, or fees do not meet the agreed terms');
  return tx.inputs.map((input) => input.previous_output);
}

export async function signWalletFunding(
  config: DevnetConfig,
  user: WalletUser,
  transaction: Transaction,
  terms: FundingTermsJson,
): Promise<Transaction> {
  await verifyWalletFunding(config, user, transaction, terms);
  const account = (await readOffckbAccounts(true)).find(
    (entry) => entry.index === user.accountIndex,
  );
  if (!account || !sameScript(account.lockScript, user.lockScript))
    throw badRequest('offckb wallet binding has changed');
  const client = new ccc.ClientPublicTestnet({ url: config.ckbRpcUrl, fallbacks: [] });
  const lock = JsonRpcTransformers.scriptTo(user.lockScript);
  // Restrict signing to this exact default-lock group; no ACP lookup or public-network fallback.
  class LocalSigner extends ccc.SignerCkbPrivateKey {
    async getRelatedScripts() {
      return [{ script: lock, cellDeps: [] }];
    }
  }
  const signer = new LocalSigner(client, account.privateKey);
  if (ccc.hashCkb(signer.publicKey).slice(0, 42) !== user.lockScript.args)
    throw Error('offckb private key does not match the linked address');
  const tx = JsonRpcTransformers.transactionTo({
    ...transaction,
    outputs: transaction.outputs.map((output) => ({ ...output, type: output.type ?? undefined })),
  });
  await tx.prepareSighashAllWitness(lock, 65, client);
  const signed = await signer.signOnlyTransaction(tx);
  return { ...transaction, witnesses: signed.witnesses };
}

export async function defaultLockDep(ckbRpcUrl: string, lockScript: Script): Promise<CellDep> {
  const genesis = await rpc<{ transactions: (Transaction & { hash: Hex })[] }>(
    ckbRpcUrl,
    'get_block_by_number',
    ['0x0'],
  );
  const type = genesis.transactions[0]?.outputs[1]?.type;
  if (!type || JsonRpcTransformers.scriptTo(type).hash() !== lockScript.code_hash)
    throw Error('devnet genesis does not contain the expected default wallet contract');
  return {
    out_point: { tx_hash: genesis.transactions[1]!.hash, index: hex(0) },
    dep_type: 'dep_group',
  };
}
