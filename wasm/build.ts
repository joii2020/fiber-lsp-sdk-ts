import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const wasmDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(wasmDir, '..');
const pkg = resolve(wasmDir, 'pkg');
const crateSource = resolve(wasmDir, 'src/lib.rs');
const crateManifest = resolve(wasmDir, 'Cargo.toml');
const crateLock = resolve(wasmDir, 'Cargo.lock');
const stamp = resolve(pkg, 'source.sha256');

async function fingerprint() {
  const hash = createHash('sha256');
  for (const path of [crateSource, crateManifest, crateLock]) hash.update(await readFile(path));
  return hash.digest('hex');
}

if (process.argv.includes('--if-needed')) {
  try {
    await Promise.all(
      [
        'fiber_lsp_sdk_wasm.js',
        'fiber_lsp_sdk_wasm.d.ts',
        'fiber_lsp_sdk_wasm_bg.wasm',
        'fiber_lsp_sdk_wasm_bg.wasm.d.ts',
      ].map((file) => access(resolve(pkg, file))),
    );
    if ((await readFile(stamp, 'utf8')) === (await fingerprint())) process.exit(0);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

const run = (cmd: string, args: string[]) => {
  const p = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (p.error) throw p.error;
  if (p.status !== 0) process.exit(p.status ?? 1);
};
let manifest = crateManifest;
let source = process.env.FIBER_SOURCE;
if (source) {
  source = resolve(source);
  const work = resolve(root, 'target/wasm-source');
  await mkdir(work, { recursive: true });
  let content = await readFile(manifest, 'utf8');
  content = content.replace(
    'crate-type = ["cdylib"]',
    `crate-type = ["cdylib"]\npath = ${JSON.stringify(crateSource)}`,
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
    let lock = await readFile(crateLock, 'utf8');
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
await mkdir(pkg, { recursive: true });
run('wasm-bindgen', [
  resolve(root, 'target/wasm/wasm32-unknown-unknown/release/fiber_lsp_sdk_wasm.wasm'),
  '--target',
  'web',
  '--out-dir',
  pkg,
  '--out-name',
  'fiber_lsp_sdk_wasm',
]);
await writeFile(stamp, await fingerprint());
