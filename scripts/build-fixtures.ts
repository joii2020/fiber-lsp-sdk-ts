import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
let manifest = resolve('test/fixtures-builder/Cargo.toml');
if (process.env.FIBER_SOURCE) {
  const work = resolve('target/fixture-source');
  await mkdir(work, { recursive: true });
  let content = await readFile(manifest, 'utf8');
  content +=
    '\n[[bin]]\nname = "fiber-lsp-sdk-fixtures"\npath = ' +
    JSON.stringify(resolve('test/fixtures-builder/src/main.rs')) +
    '\n';
  for (const name of ['fiber-lsp-sdk', 'fiber-types', 'fiber-json-types'])
    content = content.replace(
      new RegExp(`(${name} = \\{ )git = "[^"]+", rev = "[^"]+"`),
      `$1path = ${JSON.stringify(resolve(process.env.FIBER_SOURCE, 'crates', name))}`,
    );
  manifest = resolve(work, 'Cargo.toml');
  await writeFile(manifest, content);
}
const result = spawnSync(
  'cargo',
  ['run', '--manifest-path', manifest, '--quiet', '--target-dir', 'target/fixtures'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
JSON.parse(result.stdout);
await writeFile('test/fixtures/channel.json', result.stdout);
