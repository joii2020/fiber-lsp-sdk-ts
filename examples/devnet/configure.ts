import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { load, dump } from 'js-yaml';

const nodeDir = process.env.FIBER_NODE_DIR!;
const configFile = resolve(nodeDir, 'config.yml');
const config = load(await readFile(configFile, 'utf8')) as {
  services: string[];
  rpc: {
    enabled_modules: string[];
    biscuit_public_key: string;
    biscuit_private_key_path: string;
    ws_listening_addr: string;
  };
  fiber: { auto_accept_channel_ckb_funding_amount: number };
};

config.services = [...new Set([...config.services, 'lsp'])];
config.rpc.enabled_modules = [...new Set([...config.rpc.enabled_modules, 'lsp', 'pubsub'])];
config.rpc.biscuit_public_key = (
  await readFile(resolve(nodeDir, 'biscuit/public.key'), 'utf8')
).trim();
config.rpc.biscuit_private_key_path = resolve(nodeDir, 'biscuit/private.key');
config.rpc.ws_listening_addr = '127.0.0.1:21717';
config.fiber.auto_accept_channel_ckb_funding_amount = 100000000000;

await writeFile(configFile, dump(config));
