import type { CreateUserInput, OffckbAccount, User } from '../shared/types.ts';
import { hasErrorCode } from '../shared/types.ts';
import type { TenantStatus } from 'fiber-lsp-sdk';
interface UserDatabase {
  version: 1;
  environment: string;
  users: User[];
}
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function badRequest(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

// One local server owns this file. Serialize read/modify/write and replace atomically.
export class UserStore {
  #pending: Promise<unknown> = Promise.resolve();
  readonly file: string;
  readonly environment: string;
  constructor(file: string, environment: string) {
    this.file = file;
    this.environment = environment;
  }
  async read(): Promise<UserDatabase> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as UserDatabase;
      if (data.version !== 1 || !Array.isArray(data.users)) throw Error('Invalid user JSON format');
      if (data.environment !== this.environment)
        throw badRequest(
          'User data belongs to another devnet. Set EXAMPLE_USERS_FILE to a separate file.',
          409,
        );
      return data;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT'))
        return { version: 1, environment: this.environment, users: [] };
      throw error;
    }
  }
  async list() {
    await this.#pending;
    return (await this.read()).users;
  }
  async get(id: string) {
    const user = (await this.list()).find((entry) => entry.id === id);
    if (!user) throw badRequest('User not found', 404);
    return user;
  }
  update<T>(action: (users: User[]) => T | Promise<T>): Promise<T> {
    const operation = this.#pending.then(async () => {
      const data = await this.read();
      const result = await action(data.users);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, this.file);
      return result;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
  create(input: CreateUserInput, accounts: readonly OffckbAccount[]) {
    return this.update((users) => {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const display = typeof input.display === 'string' ? input.display.trim() : '';
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(name))
        throw badRequest('name must contain 1–32 letters, digits, underscores, or hyphens');
      if (!display || display.length > 64) throw badRequest('display must contain 1–64 characters');
      const account = accounts.find((item) => item.index === input.accountIndex);
      if (!account || account.reserved) throw badRequest('Select an available offckb account');
      if (users.some((user) => user.name.toLowerCase() === name.toLowerCase()))
        throw badRequest('name already exists', 409);
      if (users.some((user) => user.accountIndex === account.index))
        throw badRequest('This offckb account is already linked. Select another account.', 409);
      const user: User = {
        id: randomUUID(),
        name,
        display,
        accountIndex: account.index,
        address: account.address,
        lockScript: account.lockScript,
        createdAt: new Date().toISOString(),
        tenantIds: [],
        rootPublicKeys: [],
      };
      users.push(user);
      return user;
    });
  }
  // Reserve the root before registration; a lost RPC response must reuse the same identity.
  bindRoot(id: string, rootPublicKey: string) {
    return this.update((users) => {
      const user = users.find((entry) => entry.id === id);
      if (!user) throw badRequest('User not found', 404);
      if (!user.rootPublicKeys.includes(rootPublicKey)) user.rootPublicKeys.push(rootPublicKey);
      return user;
    });
  }
  bindTenant(id: string, tenant: Pick<TenantStatus, 'tenant_id' | 'root_signer_pubkey'>) {
    return this.update((users) => {
      const user = users.find((entry) => entry.id === id);
      if (
        !user ||
        !tenant.root_signer_pubkey ||
        !user.rootPublicKeys.includes(tenant.root_signer_pubkey)
      )
        throw badRequest('Tenant identity does not match the user', 409);
      if (!user.tenantIds.includes(tenant.tenant_id)) user.tenantIds.push(tenant.tenant_id);
      return user;
    });
  }
  deleteUnregistered(id: string) {
    return this.update((users) => {
      const index = users.findIndex((entry) => entry.id === id);
      if (index < 0) throw badRequest('User not found', 404);
      if (users[index]!.rootPublicKeys.length || users[index]!.tenantIds.length)
        throw badRequest(
          'Registered users retain their identities and wallet bindings and cannot be deleted',
          409,
        );
      users.splice(index, 1);
      return { deleted: true };
    });
  }
}
