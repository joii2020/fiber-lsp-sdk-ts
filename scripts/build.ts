import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';

const wasm = spawnSync(process.execPath, ['wasm/build.ts', '--if-needed'], { stdio: 'inherit' });
if (wasm.error) throw wasm.error;
if (wasm.status !== 0) process.exit(wasm.status ?? 1);

await cp('wasm/pkg/fiber_lsp_sdk_wasm.d.ts', 'src/wasm/fiber_lsp_sdk_wasm.d.ts');
const p = spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: false });
if (p.status !== 0) process.exit(p.status ?? 1);
await cp('wasm/pkg', 'dist/wasm', { recursive: true });
