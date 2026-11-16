import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function fingerprint() {
  const hash = createHash('sha256');
  for (const path of ['wasm/src/lib.rs', 'wasm/Cargo.toml', 'wasm/Cargo.lock'])
    hash.update(await readFile(path));
  return hash.digest('hex');
}
