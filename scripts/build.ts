import { cp, mkdir, access } from 'node:fs/promises';
import { fingerprint } from './wasm-fingerprint.ts';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
try {
  await access('wasm/pkg/fiber_lsp_sdk_wasm_bg.wasm');
  if ((await readFile('wasm/pkg/source.sha256', 'utf8')) !== (await fingerprint()))
    throw new Error('WASM source changed');
} catch {
  const p = spawnSync(process.execPath, ['scripts/build-wasm.ts'], { stdio: 'inherit' });
  if (p.status !== 0) process.exit(p.status ?? 1);
}
await mkdir('src/wasm', { recursive: true });
await cp('wasm/pkg/fiber_lsp_sdk_wasm.d.ts', 'src/wasm/fiber_lsp_sdk_wasm.d.ts');
const p = spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: false });
if (p.status !== 0) process.exit(p.status ?? 1);
await cp('wasm/pkg', 'dist/wasm', { recursive: true });
