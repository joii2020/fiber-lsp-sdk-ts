import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './wasm-fingerprint.ts';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd: string, args: string[]) => {
  const p = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (p.error) throw p.error;
  if (p.status !== 0) process.exit(p.status ?? 1);
};
let manifest = resolve(root, 'wasm/Cargo.toml');
let source = process.env.FIBER_SOURCE;
if (source) {
  source = resolve(source);
  const work = resolve(root, 'target/wasm-source');
  await mkdir(work, { recursive: true });
  let content = await readFile(manifest, 'utf8');
  content = content.replace(
    'crate-type = ["cdylib"]',
    `crate-type = ["cdylib"]\npath = ${JSON.stringify(resolve(root, 'wasm/src/lib.rs'))}`,
  );
  for (const name of ['fiber-lsp-sdk', 'fiber-types', 'fiber-json-types']) {
    content = content.replace(
      new RegExp(`(${name} = \\{ )git = "[^"]+", rev = "[^"]+"`),
      `$1path = ${JSON.stringify(resolve(source, 'crates', name))}`,
    );
  }
  manifest = resolve(work, 'Cargo.toml');
  await writeFile(manifest, content);
  try {
    let lock = await readFile(resolve(root, 'wasm/Cargo.lock'), 'utf8');
    lock = lock.replace(
      /(name = "fiber-(?:lsp-sdk|types|json-types)"\nversion = "[^"]+"\n)source = "[^"]+"\n/g,
      '$1',
    );
    await writeFile(resolve(work, 'Cargo.lock'), lock);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}
run('cargo', [
  'build',
  '--locked',
  '--manifest-path',
  manifest,
  '--target',
  'wasm32-unknown-unknown',
  '--release',
  '--target-dir',
  resolve(root, 'target/wasm'),
]);
await mkdir(resolve(root, 'wasm/pkg'), { recursive: true });
run('wasm-bindgen', [
  resolve(root, 'target/wasm/wasm32-unknown-unknown/release/fiber_lsp_sdk_wasm.wasm'),
  '--target',
  'web',
  '--out-dir',
  resolve(root, 'wasm/pkg'),
  '--out-name',
  'fiber_lsp_sdk_wasm',
]);
let lock = await readFile(resolve(dirname(manifest), 'Cargo.lock'), 'utf8');
if (source)
  lock = lock.replace(
    /(name = "fiber-(?:lsp-sdk|types|json-types)"\nversion = "[^"]+"\n)/g,
    '$1source = "git+https://github.com/chenyukang/fiber?rev=76307312e8de518c9a32074e6d16867c04de4f86#76307312e8de518c9a32074e6d16867c04de4f86"\n',
  );
await writeFile(resolve(root, 'wasm/Cargo.lock'), lock);
await writeFile(resolve(root, 'wasm/pkg/source.sha256'), await fingerprint());
