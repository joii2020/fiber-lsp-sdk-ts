import { connectDevnet, request } from '../shared/connection.ts';
import type { DevnetConnection } from '../shared/connection.ts';
import type { CreateUserInput, NetworkStatus, User } from '../shared/types.ts';
import { AccountSession } from './account-session.ts';
import type { AccountCallbacks } from './account-session.ts';

/** Application services for the demo. No panels, forms, dialogs or rendering. */
export class ExampleApp {
  readonly connection: DevnetConnection;
  private readonly baseUrl: string;
  private readonly sessions = new Map<string, AccountSession>();
  users: User[] = [];

  private constructor(connection: DevnetConnection, baseUrl: string) {
    this.connection = connection;
    this.baseUrl = baseUrl;
  }

  static async connect(baseUrl: string): Promise<ExampleApp> {
    return new ExampleApp(await connectDevnet(baseUrl), baseUrl);
  }

  async loadUsers(): Promise<void> {
    this.users = (await request<{ users: User[] }>(this.baseUrl, '/devnet/users')).users;
    for (const user of this.users) {
      const session = this.sessions.get(user.id);
      if (session) session.user = user;
    }
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const user = await request<User>(this.baseUrl, '/devnet/users', input);
    await this.loadUsers();
    return user;
  }

  async deleteUser(session: AccountSession): Promise<void> {
    await request(this.baseUrl, '/devnet/users/delete', { userId: session.user.id });
    await session.dispose();
    this.sessions.delete(session.user.id);
    this.users = this.users.filter((user) => user.id !== session.user.id);
  }

  async account(user: User, callbacks: AccountCallbacks): Promise<AccountSession> {
    const existing = this.sessions.get(user.id);
    if (existing) return existing;
    const session = await AccountSession.restore(user, this.connection, this.baseUrl, callbacks);
    this.sessions.set(user.id, session);
    return session;
  }

  async networkStatus(): Promise<NetworkStatus> {
    return request<NetworkStatus>(this.baseUrl, '/devnet/status');
  }

  /** Includes accounts hidden by panel logout: their clients still process payments. */
  async refreshAccounts(queryState = true): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.refresh(queryState)));
  }
}
