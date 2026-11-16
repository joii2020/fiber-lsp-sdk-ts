import { test, expect } from '@playwright/test';

test.use({
  baseURL: 'http://example-http.test:4173',
  launchOptions: {
    args: ['--host-resolver-rules=MAP example-http.test 127.0.0.1', '--no-proxy-server'],
  },
});

test('HTTP storage commits atomically, checks CAS, and copies root keys across reloads', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { createExampleStorage } = await import('/example/browser/storage.js');
    const storage = createExampleStorage('http-atomic-test', 'user');
    const id = 'a'.repeat(64);
    const key = new Uint8Array(32).fill(7);
    await storage.commit(
      [{ key: 'tenant/test', value: { balance: 1n }, expected: null }],
      [{ tenantId: id, key }],
    );
    key.fill(0);
    const copy = await storage.getRootKey(id);
    copy.fill(0);
    let conflict = false;
    try {
      await storage.commit([
        { key: 'other', value: 'must roll back' },
        { key: 'tenant/test', value: 2, expected: { balance: 0n } },
      ]);
    } catch (error) {
      conflict = (error as { code: string }).code === 'CONFLICT';
    }
    let duplicate = false;
    try {
      await storage.commit(
        [{ key: 'other', value: 'must also roll back' }],
        [{ tenantId: id, key }],
      );
    } catch {
      duplicate = true;
    }
    const result = {
      conflict,
      duplicate,
      other: await storage.get('other'),
      key: Array.from(await storage.getRootKey(id)),
      count: (await storage.list('tenant/')).length,
    };
    await storage.close();
    return result;
  });
  expect(result).toEqual({
    conflict: true,
    duplicate: true,
    other: null,
    key: Array(32).fill(7),
    count: 1,
  });
  await page.reload();
  expect(
    await page.evaluate(async () => {
      const { createExampleStorage } = await import('/example/browser/storage.js');
      const storage = createExampleStorage('http-atomic-test', 'user');
      try {
        return await storage.get('tenant/test');
      } finally {
        await storage.close();
      }
    }),
  ).toEqual({ balance: 1n });
});

test('HTTP locks serialize tabs, allow nested locks, and release after errors and tab closure', async ({
  page,
  context,
}) => {
  const second = await context.newPage();
  for (const tab of [page, second]) {
    await tab.goto('/');
    await tab.evaluate(async () => {
      const { PlaintextExampleStorage } = await import('/example/browser/storage.js');
      globalThis.httpStorage = new PlaintextExampleStorage('http-lock-test');
    });
  }
  await page.evaluate(() => httpStorage.commit([{ key: 'counter', value: 0 }]));
  await Promise.all(
    [page, second].map((tab) =>
      tab.evaluate(async () => {
        for (let i = 0; i < 5; i++) {
          await httpStorage.withLock('counter', async () => {
            const value = (await httpStorage.get<number>('counter'))!;
            await new Promise((resolve) => setTimeout(resolve, 10));
            await httpStorage.withLock('nested', () =>
              httpStorage.commit([{ key: 'counter', value: value + 1 }]),
            );
          });
        }
      }),
    ),
  );
  expect(await page.evaluate(() => httpStorage.get('counter'))).toBe(10);
  expect(
    await page.evaluate(async () => {
      try {
        await httpStorage.withLock('counter', async () => {
          throw Error('expected');
        });
      } catch (error) {
        return (error as Error).message;
      }
    }),
  ).toBe('expected');
  // Hold the lock until the tab is destroyed. Another tab must then acquire it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        void httpStorage.withLock('counter', () => {
          resolve();
          return new Promise<void>(() => {});
        });
      }),
  );
  await second.evaluate(() => {
    globalThis.httpLockAcquired = false;
    void httpStorage.withLock('counter', async () => {
      globalThis.httpLockAcquired = true;
    });
  });
  expect(await second.evaluate(() => httpLockAcquired)).toBe(false);
  await page.close();
  await expect.poll(() => second.evaluate(() => httpLockAcquired)).toBe(true);
  await second.evaluate(() => httpStorage.close());
});
