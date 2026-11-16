import type { FiberLspConfig, Script } from '../../src/types.js';
import { test, expect } from '@playwright/test';
test('real browser loads WASM, registers, preserves IndexedDB identity across reload, and unlocks with a new password', async ({
  page,
}) => {
  await page.goto('/');
  expect(
    await page.evaluate(async () => (await import('/dist/index.js')).SDK_VERSION),
  ).toBeTruthy();
  const id = await page.evaluate(async () => {
    const { fiberlsp, BrowserStorage } = await import('/dist/index.js');
    const script: Script = {
      code_hash: `0x${'11'.repeat(32)}` as const,
      hash_type: 'type',
      args: '0x',
    };
    const config: FiberLspConfig = {
      rpcUrl: 'http://127.0.0.1:8119',
      nodePublicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      network: {
        currency: 'Fibd',
        fundingLock: script,
        commitmentLock: script,
        commitmentCellDeps: 1,
        epochDurationMs: 14400000,
        minimumShutdownFee: 100000000n,
        fundingCellDeps: [],
      },
    };
    const storage = new BrowserStorage({ name: 'browser-test', onUnlock: () => 'first-password' });
    const lsp = new fiberlsp({
      storage,
      chain: {
        getTransaction: async () => null,
        getLiveCell: async () => null,
        getCell: async () => null,
      },
      onConfirm: () => true,
    });
    const pending = await lsp.beginRegistration({ fiberLsp: config });
    await lsp.finishRegistration(pending.tenantId, {
      tenant: {
        tenant_id: pending.tenantId,
        root_signer_pubkey: pending.params.root_signer_pubkey,
        invoice_pubkey: config.nodePublicKey,
        channels: [],
        created_at: '0x1',
        runtime_status: 'cold',
      },
      access_token: 'test-tenant-token',
    });
    await storage.changePassword({ oldPassword: 'first-password', newPassword: 'second-password' });
    await storage.close();
    return pending.tenantId;
  });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const { fiberlsp, BrowserStorage } = await import('/dist/index.js');
    let prompts = 0;
    const storage = new BrowserStorage({
      name: 'browser-test',
      onUnlock: () => {
        prompts++;
        return 'second-password';
      },
    });
    const lsp = new fiberlsp({
      storage,
      chain: {
        getTransaction: async () => null,
        getLiveCell: async () => null,
        getCell: async () => null,
      },
      onConfirm: () => true,
    });
    const [tenant] = await lsp.listTenants();
    const before = prompts;
    const pending = await lsp.beginRegistration({
      tenantId: tenant.tenantId,
      fiberLsp: tenant.fiberLsp,
    });
    const backup = await storage.exportBackup('export-password');
    await storage.close();
    return {
      tenantId: tenant.tenantId,
      publicKey: tenant.publicKey,
      proofKey: pending.params.root_signer_pubkey,
      before,
      prompts,
      backup,
    };
  });
  expect(restored.tenantId).toBe(id);
  expect(restored.publicKey).toBe(restored.proofKey);
  expect(restored.before).toBe(0);
  expect(restored.prompts).toBe(1);
  expect(JSON.parse(restored.backup).format).toBe('fiber-lsp-sdk-backup');
});
test('two tabs share the Web Lock and propagate storage locking', async ({ page, context }) => {
  await page.goto('/');
  const second = await context.newPage();
  await second.goto('/');
  await page.evaluate(async () => {
    const { BrowserStorage } = await import('/dist/index.js');
    globalThis.testStorage = new BrowserStorage({
      name: 'shared-test',
      onUnlock: () => 'password',
    });
    await testStorage.commit(
      [{ key: 'tenant/test', value: 1 }],
      [{ tenantId: '1'.repeat(64), key: new Uint8Array(32).fill(1) }],
    );
  });
  await second.evaluate(async () => {
    const { BrowserStorage } = await import('/dist/index.js');
    globalThis.testStorage = new BrowserStorage({
      name: 'shared-test',
      onUnlock: () => 'password',
    });
    await testStorage.getRootKey('1'.repeat(64));
    globalThis.locked = false;
    testStorage.onLock(() => {
      globalThis.locked = true;
    });
  });
  await page.evaluate(() => testStorage.lock());
  await expect.poll(() => second.evaluate(() => globalThis.locked)).toBe(true);
  await page.evaluate(() => testStorage.close());
  await second.evaluate(() => testStorage.close());
});
