import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { load } from 'js-yaml';

async function shellProject(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), "sdk shell's-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = resolve(directory, 'examples/devnet');
  // Run the actual scripts in a temporary project without a real devnet.
  await cp(fileURLToPath(new URL('../examples/devnet/', import.meta.url)), scripts, {
    recursive: true,
  });
  const bin = resolve(directory, 'bin');
  await mkdir(bin);
  const executable = resolve(bin, 'offckb');
  await writeFile(
    executable,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALL_LOG"
if [ "$1" = node ]; then
  case "$2" in
    --daemon)
      if [ -f "$TEST_CKB_STATE" ]; then
        echo 'A CKB node is already answering at http://127.0.0.1:8114. Stop it before starting daemon mode.' >&2
        exit 1
      fi
      touch "$TEST_CKB_STATE"
      ;;
    stop) rm -f "$TEST_CKB_STATE" ;;
  esac
fi
if [ "$1" = fiber ] && [ "$2" = init ]; then
  mkdir -p "$FIBER_NODE_DIR/biscuit"
  cp "$TEST_FIXTURE_DIR/config.yml" "$FIBER_NODE_DIR/config.yml"
  cp "$TEST_FIXTURE_DIR/biscuit/private.key" "$FIBER_NODE_DIR/biscuit/private.key"
  cp "$TEST_FIXTURE_DIR/biscuit/public.key" "$FIBER_NODE_DIR/biscuit/public.key"
fi
`,
    { mode: 0o700 },
  );
  const credential = resolve(directory, '.devnet/keys/operator-token');
  const log = resolve(directory, 'calls');
  const fixture = resolve(directory, 'fixture');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALL_LOG: log,
    TEST_FIXTURE_DIR: fixture,
    TEST_CKB_STATE: resolve(directory, 'ckb-running'),
    XDG_DATA_HOME: directory,
  };
  const run = (file: string) =>
    spawnSync('sh', [resolve(scripts, `${file}.sh`)], {
      cwd: tmpdir(),
      env,
      encoding: 'utf8',
    });
  return { directory, credential, fixture, log, run };
}

test('sh directly starts and stops offckb without project dependencies', async (t) => {
  const { log, run } = await shellProject(t);
  for (const action of ['start', 'stop']) {
    const result = run(action);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(
    await readFile(log, 'utf8'),
    'node --daemon\nfiber start --daemon\nfiber stop\nnode stop\n',
  );
});

test('clean stops nodes and removes project devnet data while preserving other project files', async (t) => {
  const { directory, credential, log, run } = await shellProject(t);
  await mkdir(resolve(directory, '.devnet/keys'), { recursive: true });
  await writeFile(credential, 'old-operator-token');
  const users = resolve(directory, '.devnet/example-users.json');
  await writeFile(users, 'old-users');
  const keep = resolve(directory, 'keep.txt');
  await writeFile(keep, 'keep');

  const result = run('clean');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(log, 'utf8'), 'fiber stop\nnode stop\nclean\n');
  await assert.rejects(readFile(credential), { code: 'ENOENT' });
  await assert.rejects(readFile(users), { code: 'ENOENT' });
  assert.equal(await readFile(keep, 'utf8'), 'keep');
});

const biscuitAvailable = spawnSync('biscuit', ['--version']).status === 0;
test(
  'init restarts running CKB, configures LSP without duplicate entries and preserves node keys',
  {
    skip: !biscuitAvailable && 'requires biscuit-cli 0.6',
  },
  async (t) => {
    const { directory, fixture, credential, log, run } = await shellProject(t);
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      resolve(directory, 'node_modules'),
      'dir',
    );
    await writeFile(resolve(directory, 'package.json'), '{"type":"module"}\n');
    await mkdir(resolve(fixture, 'biscuit'), { recursive: true });
    const key = spawnSync('biscuit', ['keypair', '--only-private-key'], { encoding: 'utf8' });
    assert.equal(key.status, 0, key.stderr);
    const keyFile = resolve(fixture, 'biscuit/private.key');
    await writeFile(keyFile, key.stdout);
    const publicKey = spawnSync(
      'biscuit',
      ['keypair', '--from-file', keyFile, '--only-public-key'],
      { encoding: 'utf8' },
    );
    assert.equal(publicKey.status, 0, publicKey.stderr);
    await writeFile(resolve(fixture, 'biscuit/public.key'), publicKey.stdout);
    const hash = `0x${'0'.repeat(63)}1`;
    await writeFile(
      resolve(fixture, 'config.yml'),
      `
services: [fiber, rpc, ckb, lsp]
ckb:
  rpc_url: http://127.0.0.1:8114
fiber:
  chain: dev.toml
  scripts:
    - name: FundingLock
      script:
        code_hash: '${hash}'
rpc:
  listening_addr: 127.0.0.1:21716
  enabled_modules: [node, lsp, pubsub]
`,
    );
    await writeFile(resolve(directory, 'ckb-running'), 'existing CKB');
    const initialized = run('init');
    assert.equal(initialized.status, 0, initialized.stderr);
    const calls = `fiber stop\nnode stop\nnode --daemon\nfiber init --nodes 3 --binary-path ${directory}/../fiber/target/release/fnn\nfiber start --daemon\n`;
    assert.equal(await readFile(log, 'utf8'), calls);
    const node = resolve(directory, 'offckb-nodejs/devnet/fiber/nodes/3');
    const configFile = resolve(node, 'config.yml');
    const config = load(await readFile(configFile, 'utf8')) as {
      services: string[];
      fiber: {
        auto_accept_channel_ckb_funding_amount: number;
        scripts: { script: { code_hash: string } }[];
      };
      rpc: {
        enabled_modules: string[];
        biscuit_public_key: string;
        biscuit_private_key_path: string;
        ws_listening_addr: string;
      };
    };
    assert.equal(config.services.filter((name) => name === 'lsp').length, 1);
    assert.equal(config.rpc.enabled_modules.filter((name) => name === 'lsp').length, 1);
    assert.equal(config.rpc.enabled_modules.filter((name) => name === 'pubsub').length, 1);
    assert.equal(config.rpc.ws_listening_addr, '127.0.0.1:21717');
    assert.equal(config.fiber.auto_accept_channel_ckb_funding_amount, 100000000000);
    assert.equal(config.fiber.scripts[0].script.code_hash, hash);
    assert.equal(config.rpc.biscuit_public_key, publicKey.stdout.trim());
    assert.equal(config.rpc.biscuit_private_key_path, resolve(node, 'biscuit/private.key'));
    assert.equal(await readFile(resolve(node, 'biscuit/private.key'), 'utf8'), key.stdout);
    const verified = spawnSync(
      'biscuit',
      [
        'inspect',
        '--public-key',
        publicKey.stdout.trim(),
        '--authorize-with',
        'allow if read("node"), read("lsp"), write("lsp");',
        credential,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(verified.status, 0, verified.stderr);
  },
);
