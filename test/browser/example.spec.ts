import type { Page } from '@playwright/test';
import type { User, CreateUserInput, RegisterUserInput } from '../../examples/shared/types.ts';
import { test, expect } from '@playwright/test';
import { mockExampleChannels } from './example-channel-mock.ts';
import { config, result } from '../helpers.ts';
import { reserveExampleAccounts } from '../../examples/server/config.ts';

test.use({
  launchOptions: {
    args: ['--host-resolver-rules=MAP example-http.test 127.0.0.1', '--no-proxy-server'],
  },
});

async function mockExample(page: Page) {
  const users: User[] = [];
  const identities: string[] = [];
  let dropResponse = false;
  const wallets = Array.from({ length: 20 }, (_, index) => ({
    index,
    address: `ckt1-test-wallet-${index}`,
    lockScript: {
      ...config.network.fundingLock,
      args: `0x${index.toString(16).padStart(2, '0')}` as const,
    },
  }));
  const accounts = reserveExampleAccounts(wallets, wallets[5].lockScript);
  await page.route('**/devnet/config', (route) =>
    route.fulfill({
      json: {
        ckbRpcUrl: 'http://127.0.0.1:8114',
        genesisHash: 'example-test',
        accounts,
        wallet: { fundingAmount: '100000000000', remoteFundingAmount: '100000000000' },
        fiberLsp: { ...config, network: { ...config.network, minimumShutdownFee: '100000000' } },
      },
    }),
  );
  await page.route('**/devnet/status', (route) =>
    route.fulfill({ json: { blockNumber: '123', nodePublicKey: config.nodePublicKey } }),
  );
  await page.route('**/devnet/users', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { users } });
    const input = route.request().postDataJSON() as CreateUserInput;
    if (users.some((user) => user.accountIndex === input.accountIndex))
      return route.fulfill({
        status: 409,
        json: { error: 'This offckb account is already linked' },
      });
    const user: User = {
      ...input,
      createdAt: new Date().toISOString(),
      tenantIds: [],
      rootPublicKeys: [],
      lockScript: config.network.fundingLock,
      id: `user-${users.length}`,
      address: accounts.find((a) => a.index === input.accountIndex)!.address,
    };
    users.push(user);
    return route.fulfill({ status: 201, json: user });
  });
  await page.route('**/devnet/wallet', (route) =>
    route.fulfill({ json: { capacity: '4200000000000000' } }),
  );
  await page.route('**/devnet/register', async (route) => {
    const proof = route.request().postDataJSON() as RegisterUserInput;
    const name = `fiber-sdk-devnet-example-test-${config.nodePublicKey}-user-${proof.userId}`;
    const id = await page.evaluate(
      async ({ name, publicKey }) => {
        const { fiberlsp } = await import('/dist/index.js');
        const { createExampleStorage } = await import('/example/browser/storage.js');
        const storage = createExampleStorage(name, 'unused-for-reading');
        try {
          const lsp = new fiberlsp({
            storage,
            chain: {
              getTransaction: async () => null,
              getLiveCell: async () => null,
              getCell: async () => null,
            },
            onConfirm: () => false,
          });
          return (await lsp.listTenants()).find((tenant) => tenant.publicKey === publicKey)!
            .tenantId;
        } finally {
          await storage.close();
        }
      },
      { name, publicKey: proof.root_signer_pubkey },
    );
    const user = users.find((user) => user.id === proof.userId)!;
    if (!user.tenantIds.includes(id)) user.tenantIds.push(id);
    if (!user.rootPublicKeys.includes(proof.root_signer_pubkey))
      user.rootPublicKeys.push(proof.root_signer_pubkey);
    identities.push(id);
    if (dropResponse) {
      dropResponse = false;
      return route.fulfill({ status: 503, json: { error: 'Registration response lost' } });
    }
    return route.fulfill({ json: result(id, proof.root_signer_pubkey) });
  });
  await page.route('**/devnet/rpc', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.method).toBe('list_channels');
    expect(route.request().headers().authorization).toBe('Bearer tenant-token');
    return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { channels: [] } } });
  });
  return {
    users,
    identities,
    dropNextResponse: () => {
      dropResponse = true;
    },
  };
}

async function createUser(page: Page, name: string, display: string, accountIndex: number) {
  await page.getByRole('button', { name: 'Add user' }).click();
  await page.locator('[name=name]').fill(name);
  await page.locator('[name=display]').fill(display);
  await page.locator('[name=accountIndex]').selectOption(String(accountIndex));
  await page.getByRole('button', { name: 'Create user', exact: true }).click();
  await expect(page.locator('#user-dialog')).not.toBeVisible();
}

for (const insecure of [false, true]) {
  test.describe(insecure ? 'HTTP plaintext example' : 'localhost encrypted example', () => {
    if (insecure)
      test.use({
        baseURL: 'http://example-http.test:4173',
      });

    test('application and SDK sessions work without loading the UI', async ({ page }) => {
      const { identities } = await mockExample(page);
      await page.goto('/test/fixtures/session.html');
      const state = await page.evaluate(async () => {
        const { ExampleApp } = await import('/example/browser/example-app.js');
        const { AccountSession } = await import('/example/browser/account-session.js');
        const app = await ExampleApp.connect(location.origin);
        const user = await app.createUser({ name: 'alice', display: 'Alice', accountIndex: 6 });
        const events: string[] = [];
        const errors: string[] = [];
        const callbacks = {
          onChange: () => {},
          onEvent: (_session: unknown, event: { type: string }) => events.push(event.type),
          onConfirm: () => false,
        };
        const session = await app.account(user, callbacks);
        const reused = (await app.account(user, callbacks)) === session;
        let busyDuringOperation = false;
        try {
          await session.run(async () => {
            busyDuringOperation = session.busy;
            throw Error('application action failed');
          });
        } catch (error) {
          errors.push((error as Error).message);
        }
        const busyAfterFailure = session.busy;
        await session.run(() => session.register());
        await app.loadUsers();
        await app.refreshAccounts();
        const tenantId = session.tenant!.tenantId;
        const balance = session.balance;
        const boundTenants = session.user.tenantIds;
        await session.dispose();

        // Reopen through the SDK module alone, with no ExampleApp or DOM callbacks.
        const restored = await AccountSession.restore(
          session.user,
          app.connection,
          location.origin,
          callbacks,
        );
        try {
          await restored.refresh();
          return {
            reused,
            busyDuringOperation,
            busyAfterFailure,
            errors,
            events,
            tenantId,
            restoredTenantId: restored.tenant?.tenantId,
            ready: restored.tenant?.ready,
            balance,
            boundTenants,
          };
        } finally {
          await restored.dispose();
        }
      });
      expect(identities).toHaveLength(1);
      expect(state).toMatchObject({
        reused: true,
        busyDuringOperation: true,
        busyAfterFailure: false,
        errors: ['application action failed'],
        tenantId: identities[0],
        restoredTenantId: identities[0],
        ready: true,
        balance: '4200000000000000',
        boundTenants: [identities[0]],
      });
      expect(state.events).toContain('tenant-selected');
      expect(state.events).not.toContain('error');
      await expect(page.locator('body > *')).toHaveCount(0);
    });

    test('two panels bind unique offckb wallets and recover independent tenants without passwords', async ({
      page,
    }) => {
      const { identities, users } = await mockExample(page);
      await mockExampleChannels(page);
      page.on('dialog', () => {
        throw Error('Registration/login must not request passwords');
      });
      await page.goto('/');
      await expect(page.locator('#network-status')).toHaveText('Connected to CKB and LSP');
      expect(await page.evaluate(() => isSecureContext)).toBe(!insecure);
      await expect(page.locator('#storage-notice')).toHaveText(
        insecure
          ? 'HTTP · Private keys stored in plaintext, for testing only'
          : 'Private keys are encrypted',
      );
      if (insecure)
        expect(await page.evaluate(() => !navigator.locks && !crypto.subtle)).toBe(true);
      await expect(page.locator('#left .workspace')).toBeHidden();
      await createUser(page, 'alice', 'Alice', 6);
      await page.getByRole('button', { name: 'Add user' }).click();
      for (const index of [0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
        await expect(page.locator(`[name=accountIndex] option[value="${index}"]`)).toBeDisabled();
      }
      for (const index of [7, 8, 9]) {
        await expect(page.locator(`[name=accountIndex] option[value="${index}"]`)).toBeEnabled();
      }
      await expect(page.locator('[name=accountIndex] option[value="3"]')).toContainText(
        'Fiber Node1',
      );
      await expect(page.locator('[name=accountIndex] option[value="5"]')).toContainText('LSP');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await createUser(page, 'bob', 'Bob', 7);
      for (const [side, user] of [
        ['left', users[0]],
        ['right', users[1]],
      ] as const) {
        await page.locator(`#${side} .login`).selectOption(user.id);
        await expect(page.locator(`#${side} .display-name`)).toHaveText(user.display);
        await expect(page.locator(`#${side} .open-channel`)).toBeDisabled();
        await expect(page.locator(`#${side} .pay`)).toBeDisabled();
        await page.locator(`#${side} .register`).click();
        await expect(page.locator(`#${side} .tenant-state`)).toHaveText('Registered');
        await expect(page.locator(`#${side} .open-channel`)).toBeEnabled();
        await page.locator(`#${side} .open-channel`).click();
        await expect(page.locator(`#${side} .channel-state`)).toHaveText('Ready');
      }
      expect(identities).toHaveLength(2);
      expect(identities[0]).not.toBe(identities[1]);
      await expect(page.locator('#right .login option[value="user-0"]')).toBeDisabled();
      await page.reload();
      await expect(page.locator('#left .tenant-id')).toHaveText(identities[0]);
      await expect(page.locator('#right .tenant-id')).toHaveText(identities[1]);
      expect(identities).toHaveLength(2);
      await page.locator('#left .register').click();
      await expect.poll(() => identities.length).toBe(3);
      expect(identities[2]).toBe(identities[0]);
      await expect(page.locator('#left .register')).toBeEnabled();
      const root = await page.evaluate(
        async ({ name, id }) => {
          const opened = indexedDB.open(name);
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            opened.onsuccess = () => resolve(opened.result);
            opened.onerror = () => reject(opened.error);
          });
          try {
            const read = db.transaction('roots').objectStore('roots').get(id);
            const value = await new Promise<Uint8Array | { ciphertext?: string }>((resolve) => {
              read.onsuccess = () => resolve(read.result);
            });
            return {
              plaintext: value instanceof Uint8Array && value.length === 32,
              encrypted: !(value instanceof Uint8Array) && typeof value?.ciphertext === 'string',
            };
          } finally {
            db.close();
          }
        },
        {
          name: `fiber-sdk-devnet-example-test-${config.nodePublicKey}-user-${users[0].id}${insecure ? '-plaintext' : ''}`,
          id: identities[0],
        },
      );
      expect(root).toEqual({ plaintext: insecure, encrypted: !insecure });
      await page.locator('#left .new-tenant').click();
      await expect.poll(() => users[0].tenantIds.length).toBe(2);
      await expect(page.locator('#left .tenant-state')).toHaveText('Registered');
      const secondTenant = users[0].tenantIds[1];
      expect(secondTenant).not.toBe(identities[0]);
      expect(users[0].rootPublicKeys).toHaveLength(2);
      await expect(page.locator('#left .tenant-id')).toHaveText(secondTenant);
      await page.evaluate(
        ({ key, tenantId }) => {
          localStorage.setItem(
            key,
            JSON.stringify([
              {
                tenantId,
                operationId: 'receipt',
                channelId: `0x${'1'.padStart(64, '0')}`,
                paymentHash: '0x02',
                direction: 'incoming',
                status: 'Paid',
                complete: true,
                amount: '100000000',
                invoice: 'first-tenant-invoice',
                version: 1,
              },
            ]),
          );
        },
        {
          key: `fiber-sdk-devnet-example-test-${config.nodePublicKey}-user-${users[0].id}-payments-${identities[0]}`,
          tenantId: identities[0],
        },
      );
      await page.reload();
      await expect(page.locator('#left .tenant-id')).toHaveText(secondTenant);
      await expect(page.locator('#left .history-count')).toHaveText('0');
      await expect(page.locator('#left .invoice-output')).toBeHidden();
      await page.locator('#left .tenant-select').selectOption(identities[0]);
      await expect(page.locator('#left .history-count')).toHaveText('1');
      await expect(page.locator('#left .generated-invoice')).toHaveValue('first-tenant-invoice');
      await expect(page.locator('#left .tenant-id')).toHaveText(identities[0]);
      await page.locator('#left .register').click();
      await expect(page.locator('#left .register')).toBeEnabled();
      expect(users[0].tenantIds).toEqual([identities[0], secondTenant]);
      await page.locator('#left .logout').click();
      await expect(page.locator('#left .workspace')).toBeHidden();
      await expect(page.locator('#right .display-name')).toHaveText('Bob');
      await expect(page.locator('#right .tenant-id')).toHaveText(identities[1]);
    });

    test('multiple channels keep independent selection, balances, payments, and opening recovery', async ({
      page,
    }) => {
      const { users } = await mockExample(page);
      await mockExampleChannels(page);
      await page.goto('/');
      await createUser(page, 'alice', 'Alice', 6);
      const panel = page.locator('#left');
      await panel.locator('.login').selectOption(users[0].id);
      await panel.locator('.register').click();
      await expect(panel.locator('.tenant-state')).toHaveText('Registered');
      const tenant = users[0].tenantIds[0];
      await panel.locator('.open-channel').click();
      await expect(panel.locator('.open-channel')).toHaveText('Add channel');
      await panel.locator('.create-invoice').click();
      const firstInvoice = await panel.locator('.generated-invoice').inputValue();
      await panel.locator('.open-channel').click();
      await expect(panel.locator('.channel-select option')).toHaveCount(2);
      await expect(panel.locator('.channel-select')).toHaveValue('opening-2');
      await expect(panel.locator('.local-balance')).toHaveText('2');
      await expect(panel.locator('.history-count')).toHaveText('0');
      await expect(panel.locator('.invoice-output')).toBeHidden();
      await panel.locator('.create-invoice').click();
      const secondInvoice = await panel.locator('.generated-invoice').inputValue();
      expect(secondInvoice).not.toBe(firstInvoice);
      await panel.locator('.channel-select').selectOption('opening-1');
      await expect(panel.locator('.generated-invoice')).toHaveValue(firstInvoice);
      await expect(panel.locator('.local-balance')).toHaveText('1');
      // Events for the other channel and stale versions must not change the selected view.
      await page.evaluate((tenant) => {
        updateExampleChannel(tenant, 'opening-2', { localBalance: 900000000n, version: 2 });
        updateExampleChannel(tenant, 'opening-1', { localBalance: 300000000n, version: 2 });
        updateExampleChannel(tenant, 'opening-1', { localBalance: 9900000000n, version: 1 });
      }, tenant);
      await expect(panel.locator('.channel-select')).toHaveValue('opening-1');
      await expect(panel.locator('.local-balance')).toHaveText('3');
      await panel.locator('.channel-select').selectOption('opening-2');
      await expect(panel.locator('.local-balance')).toHaveText('9');
      await panel.locator('.new-tenant').click();
      await expect(panel.locator('.channel-select option')).toHaveCount(0);
      await panel.locator('.open-channel').click();
      await expect(panel.locator('.channel-select option')).toHaveCount(1);
      await panel.locator('.tenant-select').selectOption(tenant);
      await expect(panel.locator('.channel-select')).toHaveValue('opening-2');
      await page.reload();
      await expect(panel.locator('.channel-select')).toHaveValue('opening-2');
      await expect(panel.locator('.generated-invoice')).toHaveValue(secondInvoice);
      await panel.locator('.pay-invoice').fill('another-invoice');
      await panel.locator('.pay').click();
      await expect(panel.locator('.history-count')).toHaveText('2');
      await panel.locator('summary').click();
      await panel.locator('.close-channel').click();
      await expect(panel.locator('.channel-state')).toHaveText('Closed');
      await expect(panel.locator('.pay')).toBeDisabled();
      expect(await page.evaluate(() => exampleChannelActions)).toEqual([
        { kind: 'pay', channelId: `0x${'2'.padStart(64, '0')}` },
        { kind: 'close', channelId: `0x${'2'.padStart(64, '0')}` },
      ]);
      await panel.locator('.channel-select').selectOption('opening-1');
      await expect(panel.locator('.channel-state')).toHaveText('Ready');
      await expect(panel.locator('.history-count')).toHaveText('1');
      await panel.locator('.pay-invoice').fill('another-invoice');
      await panel.locator('.pay').click();
      await expect(panel.locator('.panel-message')).toContainText('already been submitted');
      await page.evaluate(() => {
        window.failNextExampleOpening = true;
      });
      await panel.locator('.open-channel').click();
      await expect(panel.locator('.panel-message')).toHaveText('Opening response lost');
      await expect(panel.locator('.channel-select option')).toHaveCount(3);
      await expect(panel.locator('.open-channel')).toHaveText('Resume opening');
      await page.reload();
      await expect(panel.locator('.open-channel')).toHaveText('Resume opening');
      await panel.locator('.open-channel').click();
      await expect(panel.locator('.channel-select')).toHaveValue('opening-3');
      await expect(panel.locator('.channel-select option')).toHaveCount(3);
      await expect(panel.locator('.channel-state')).toHaveText('Ready');
    });

    test('lost registration response retries the same additional tenant after reload', async ({
      page,
    }) => {
      const { users, identities, dropNextResponse } = await mockExample(page);
      await page.goto('/');
      await createUser(page, 'alice', 'Alice', 6);
      await page.locator('#left .login').selectOption(users[0].id);
      await page.locator('#left .register').click();
      await expect(page.locator('#left .tenant-state')).toHaveText('Registered');
      dropNextResponse();
      await page.locator('#left .new-tenant').click();
      await expect(page.locator('#left .panel-message')).toHaveText('Registration response lost');
      await expect(page.locator('#left .tenant-state')).toHaveText('Recovery pending');
      const pending = identities[1];
      await page.reload();
      await expect(page.locator('#left .tenant-id')).toHaveText(pending);
      await expect(page.locator('#left .new-tenant')).toBeDisabled();
      await page.locator('#left .register').click();
      await expect(page.locator('#left .tenant-state')).toHaveText('Registered');
      expect(identities).toEqual([identities[0], pending, pending]);
      expect(users[0].tenantIds).toEqual([identities[0], pending]);
      expect(users[0].rootPublicKeys).toHaveLength(2);
    });

    test('add-user form keeps input after a server conflict and mobile layout does not overflow', async ({
      page,
    }) => {
      await mockExample(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Add user' }).click();
      await page.locator('[name=name]').fill('alice');
      await page.locator('[name=display]').fill('Alice');
      await page.locator('[name=accountIndex]').selectOption('6');
      await page.route('**/devnet/users', (route) =>
        route.request().method() === 'POST'
          ? route.fulfill({ status: 409, json: { error: 'This offckb account is already linked' } })
          : route.fallback(),
      );
      await page.getByRole('button', { name: 'Create user', exact: true }).click();
      await expect(page.locator('#form-error')).toHaveText('This offckb account is already linked');
      await expect(page.locator('[name=name]')).toHaveValue('alice');
      await expect(page.locator('#user-dialog')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  });
}
