import type { Script, Transaction, CellDep, OutPoint } from '../src/types.js';
import type { DevnetConfig, LiveCellResponse, ChainRpcResults } from '../examples/shared/types.ts';
import { devnetConfig } from './example-helpers.ts';
import { network } from './helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserStore } from '../examples/server/users.ts';
import { reserveExampleAccounts } from '../examples/server/config.ts';
import { fundingTerms, verifyWalletFunding, CKB } from '../examples/server/wallet.ts';

const script = (args: string): Script => ({
  code_hash: `0x${'11'.repeat(32)}` as const,
  hash_type: 'type',
  args: `0x${args.repeat(20)}`,
});
const accounts = [0, 1, 2].map((index) => ({
  index,
  address: `address-${index}`,
  lockScript: script(String(index).repeat(2)),
  reserved: index === 2 ? 'LSP' : null,
}));

test('example users only bind wallets #6–#9 and reject reserved accounts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fiber-example-allocation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new UserStore(join(directory, 'users.json'), 'chain:lsp');
  const wallets = Array.from({ length: 20 }, (_, index) => ({
    index,
    address: `address-${index}`,
    lockScript: script(index.toString(16).padStart(2, '0')),
  }));
  const allocated = reserveExampleAccounts(wallets, wallets[5].lockScript);
  for (const account of allocated) {
    const input = { name: `user-${account.index}`, display: 'User', accountIndex: account.index };
    if ([6, 7, 8, 9].includes(account.index)) await store.create(input, allocated);
    else await assert.rejects(store.create(input, allocated), /available/);
  }
  assert.deepEqual(
    (await store.list()).map((user) => user.accountIndex),
    [6, 7, 8, 9],
  );
  const customLsp = reserveExampleAccounts(wallets, wallets[6].lockScript);
  assert.equal(customLsp[6].reserved, 'LSP funding account');
  await assert.rejects(
    store.create({ name: 'lsp', display: 'LSP', accountIndex: 6 }, customLsp),
    /available/,
  );
});

test('JSON users serialize conflicting creates, survive restart, and preserve registered identities', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fiber-example-users-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'users.json');
  let store = new UserStore(file, 'chain:lsp');
  const attempts = await Promise.allSettled([
    store.create({ name: 'alice', display: 'Alice', accountIndex: 0 }, accounts),
    store.create({ name: 'bob', display: 'Bob', accountIndex: 0 }, accounts),
  ]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((x) => x.status === 'rejected')!.reason.status, 409);
  store = new UserStore(file, 'chain:lsp');
  const [alice] = await store.list();
  assert.equal(alice.name, 'alice');
  assert.deepEqual(alice.tenantIds, []);
  assert.deepEqual(alice.rootPublicKeys, []);
  await assert.rejects(
    store.create({ name: 'ALICE', display: 'Other', accountIndex: 1 }, accounts),
    /name already exists/,
  );
  await assert.rejects(
    store.create({ name: 'lsp', display: 'LSP', accountIndex: 2 }, accounts),
    /available/,
  );
  await assert.rejects(
    store.create({ name: '../x', display: 'Invalid', accountIndex: 1 }, accounts),
    /name/,
  );
  await store.bindRoot(alice.id, 'root-a');
  await store.bindRoot(alice.id, 'root-b');
  await store.bindRoot(alice.id, 'root-a');
  await assert.rejects(
    store.bindTenant(alice.id, { tenant_id: 'tenant-x', root_signer_pubkey: 'unknown-root' }),
    /does not match/,
  );
  await store.bindTenant(alice.id, { tenant_id: 'tenant-a', root_signer_pubkey: 'root-a' });
  await assert.rejects(store.deleteUnregistered(alice.id), /cannot be deleted/);
  const bob = await store.create({ name: 'bob', display: 'Bob', accountIndex: 1 }, accounts);
  await store.deleteUnregistered(bob.id);
  await store.create({ name: 'charlie', display: 'Charlie', accountIndex: 1 }, accounts);
  await Promise.all([
    store.bindTenant(alice.id, { tenant_id: 'tenant-b', root_signer_pubkey: 'root-b' }),
    store.bindTenant(alice.id, { tenant_id: 'tenant-a', root_signer_pubkey: 'root-a' }),
  ]);
  store = new UserStore(file, 'chain:lsp');
  assert.deepEqual((await store.get(alice.id)).tenantIds, ['tenant-a', 'tenant-b']);
  assert.deepEqual((await store.get(alice.id)).rootPublicKeys, ['root-a', 'root-b']);
  assert.equal((await readFile(file, 'utf8')).includes('privateKey'), false);
  await assert.rejects(new UserStore(file, 'other-chain:lsp').list(), /another devnet/);
});

function fundingFixture() {
  const user = { lockScript: accounts[0].lockScript };
  const remote = accounts[1].lockScript;
  const dep: CellDep = {
    out_point: { tx_hash: `0x${'44'.repeat(32)}` as const, index: '0x0' },
    dep_type: 'dep_group',
  };
  const funding = { ...script('aa'), code_hash: `0x${'33'.repeat(32)}` as const };
  const config: DevnetConfig = {
    ...devnetConfig(),
    wallet: {
      fundingAmount: String(1000n * CKB),
      remoteFundingAmount: String(1000n * CKB),
      remoteLock: remote,
      defaultLockDep: dep,
    },
    fiberLsp: {
      ...devnetConfig().fiberLsp,
      network: { ...devnetConfig().fiberLsp.network, fundingLock: { ...funding, args: '0x' } },
    },
  };
  const tx: Transaction = {
    version: '0x0',
    header_deps: [],
    cell_deps: [dep],
    inputs: [0, 1].map((index) => ({
      since: '0x0',
      previous_output: { tx_hash: `0x${String(index).repeat(64)}`, index: '0x0' },
    })),
    outputs: [
      { capacity: `0x${(2000n * CKB).toString(16)}` as const, lock: funding },
      { capacity: `0x${(999n * CKB).toString(16)}` as const, lock: user.lockScript },
      { capacity: `0x${(1000n * CKB).toString(16)}` as const, lock: remote },
    ],
    outputs_data: ['0x', '0x', '0x'],
    witnesses: [],
  };
  const call = async (_: string, method: string, params: unknown[]): Promise<LiveCellResponse> => {
    const point = params[0] as OutPoint;
    assert.equal(method, 'get_live_cell');
    return {
      status: 'live',
      cell: {
        output: {
          capacity: `0x${(2000n * CKB).toString(16)}` as const,
          lock: point.tx_hash.endsWith('0') ? user.lockScript : remote,
        },
        data: { content: '0x' },
      },
    };
  };
  return { config, user, tx, call, terms: fundingTerms(config, user) };
}

test('offckb wallet rejects wrong change, excess fees, missing remote funding and altered terms', async () => {
  const { config, user, tx, call, terms } = fundingFixture();
  assert.deepEqual(
    await verifyWalletFunding(config, user, tx, terms, call),
    tx.inputs.map((i) => i.previous_output),
  );
  const badChange = structuredClone(tx);
  badChange.outputs[1].lock = script('ff');
  await assert.rejects(verifyWalletFunding(config, user, badChange, terms, call), /Change address/);
  const highFee = structuredClone(tx);
  highFee.outputs[1].capacity = `0x${(998n * CKB).toString(16)}` as const;
  await assert.rejects(verifyWalletFunding(config, user, highFee, terms, call), /fees/);
  const remoteUnderpaid = structuredClone(tx);
  remoteUnderpaid.outputs[1].capacity = `0x${(998n * CKB).toString(16)}` as const;
  remoteUnderpaid.outputs[2].capacity = `0x${(1001n * CKB).toString(16)}` as const;
  await assert.rejects(verifyWalletFunding(config, user, remoteUnderpaid, terms, call), /funding/);
  await assert.rejects(
    verifyWalletFunding(config, user, tx, { ...terms, fundingAmount: '1' }, call),
    /terms do not match/,
  );
  const duplicate = structuredClone(tx);
  duplicate.inputs[1] = duplicate.inputs[0];
  await assert.rejects(verifyWalletFunding(config, user, duplicate, terms, call), /Duplicate/);
});

test('chain adapter removes TransactionView metadata and only returns committed transactions', async () => {
  const { chainProvider } = await import('../examples/shared/connection.ts');
  const { tx } = fundingFixture();
  let committed = false;
  const chain = chainProvider(async <M extends keyof ChainRpcResults>(method: M) => {
    assert.equal(method, 'get_transaction');
    const results: ChainRpcResults = {
      get_live_cell: { status: 'dead' },
      get_transaction: {
        tx_status: { status: committed ? 'committed' : 'pending' },
        transaction: { ...tx, hash: '0xmetadata' },
      },
    };
    return results[method];
  });
  assert.equal(await chain.getTransaction('0xhash', network), null);
  committed = true;
  assert.deepEqual(await chain.getTransaction('0xhash', network), tx);
  assert.deepEqual(await chain.getCell({ tx_hash: '0xhash', index: '0x0' }, network), {
    output: tx.outputs[0],
    data: tx.outputs_data[0],
  });
});
