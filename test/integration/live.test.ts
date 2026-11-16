import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fiberlsp } from '../../dist/index.js';
import type { TenantInfo } from '../../src/types.js';
import type { LiveAdapter } from './adapter.ts';
const adapter = process.env.FIBER_LSP_TEST_ADAPTER;
async function until<T>(predicate: () => Promise<T | null | false | undefined>): Promise<T> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error(
    'Live integration deadline exceeded; retained state must be reconciled before retrying',
  );
}
test(
  'live LSP registration, funding, invoice payment and cooperative refund',
  { skip: !adapter, timeout: 300_000 },
  async () => {
    assert.ok(adapter);
    const { createHarness } = (await import(pathToFileURL(resolve(adapter)).href)) as LiveAdapter;
    const harness = await createHarness();
    const { options, setup, wallet, payIncoming } = harness;
    const lsp = new fiberlsp(options);
    let tenant: TenantInfo | undefined;
    try {
      tenant = await lsp.setup(setup);
      const client = lsp.createClient(tenant.tenantId);
      const opened = await client.openChannel({ wallet });
      const channel = await until(async () => {
        const channel = (await client.listChannels()).find(
          (c) => c.operationId === opened.operationId,
        );
        return channel?.ready ? channel : null;
      });
      assert.ok(channel.channelId);
      const invoice = await client.createInvoice({ channelId: channel.channelId, amount: 1000n });
      assert.ok(invoice.invoice && invoice.paymentHash);
      await payIncoming(invoice.invoice);
      const hash = invoice.paymentHash;
      const payment = await until(async () => {
        const payment = await client.getPayment({ paymentHash: hash, direction: 'incoming' });
        return payment?.complete ? payment : null;
      });
      assert.equal(payment.status, 'Paid');
      await client.closeChannel(channel.channelId);
      await until(async () =>
        (await client.listChannels()).some((c) => c.channelId === channel.channelId && c.closed),
      );
    } finally {
      if (tenant) await lsp.cleanup(tenant.tenantId);
      await options.storage.close?.();
      await harness.close?.();
    }
  },
);
