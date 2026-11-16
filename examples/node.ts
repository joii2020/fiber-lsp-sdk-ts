import { fiberlsp, MemoryStorage } from 'fiber-lsp-sdk';
import { connectDevnet } from './shared/connection.ts';

const { fiberLsp, chain, registration } = await connectDevnet('http://127.0.0.1:8008');
const lsp = new fiberlsp({ storage: new MemoryStorage(), chain, onConfirm: () => false });
let tenant;
try {
  tenant = await lsp.setup({ fiberLsp, registration });
  console.log({
    tenantId: tenant.tenantId,
    channels: await lsp.createClient(tenant.tenantId).listChannels(),
  });
} finally {
  if (tenant) await lsp.cleanup(tenant.tenantId);
}
