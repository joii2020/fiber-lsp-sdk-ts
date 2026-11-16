# TypeScript integration examples

This directory provides a working payment demo with two accounts and an SDK integration guide. All handwritten browser and Node backend logic uses TypeScript. HTML/CSS handles page structure and styles. The browser runs JavaScript compiled by `tsc`, not `.ts` source files.

## Run

Requires Node.js 24, pnpm 11, offckb with Fiber node support, matching Fiber source, and a Rust build environment. fiber-lab is not required.

```sh
pnpm install
# Initialize and start once; use start.sh to restart an existing environment.
sh examples/devnet/init.sh
sh examples/start.sh
```

`start.sh` requires lsof. It sends SIGTERM to the process listening on port 8008, then uses nohup to run `pnpm example` in the background to build and start the example. Logs append to `.devnet/example.log`.

The server listens on all interfaces at `http://server-ip-or-domain:8008`, or locally at <http://127.0.0.1:8008>. API requests enforce same-origin access using the request Host. HTTPS or localhost uses the SDK's encrypted storage. Plain HTTP uses the example's plaintext IndexedDB storage and shows “HTTP · Private keys stored in plaintext, for testing only” beside the title. This mode is for devnet demos; use HTTPS in production.

Add two users, each bound to an unused wallet from offckb #6–#9 (the same range as fiber-lab users 1–4). Select a user in each panel, register tenants, open channels, then create and pay invoices. Accounts use the preset wallets' existing CKB without a faucet.

Node1, Node2, and Node3 (LSP) use #3, #4, and #5. When adding users, preallocated test accounts #0–#2, node wallets, and all other accounts outside #6–#9 are disabled. The backend also rejects these bindings. #19 is used for contract deployment and test UDT issuance. When sharing a devnet with fiber-lab, wallet balances for #6–#9 are shared too.

Run `sh examples/devnet/stop.sh` when done. Use `sh examples/devnet/start.sh` next time to keep using the same data.

`sh examples/devnet/clean.sh` removes node data and this project's `.devnet/`. `sh examples/devnet/reset.sh` cleans, rebuilds, initializes, and starts the environment.

```sh
pnpm typecheck      # Check the SDK, examples, build scripts, and all tests.
pnpm test           # Run Node tests.
pnpm test:browser   # Build examples and run browser tests; static test server uses port 4173.
pnpm example:node   # Register and query with an in-memory identity while the example backend runs.
```

`pnpm example` builds the SDK into `dist/`, compiles browser TypeScript into `.example/`, then runs `server/index.ts`. Node 24 strips type annotations without checking types, so run `pnpm typecheck` after changes. For browser changes, rerun `pnpm build:example` and refresh. For backend changes, restart `pnpm example`.

## Where to start

**For SDK usage, start with [browser/account-session.ts](browser/account-session.ts).** It covers setup, identity recovery, registration, event subscriptions, channel opening, payments, and cleanup. No page code is needed first.

**For backend tenant token registration and refresh, see [server/registration.ts](server/registration.ts).** It is independent of HTTP routes, offckb, and JSON user storage, and can be imported into your own backend.

The browser example has three layers: `app.ts` handles the UI, `example-app.ts` manages users and sessions, and `account-session.ts` integrates the SDK. The UI calls methods to start operations, reads state through `onChange`, and turns events into messages through `onEvent`. `onConfirm` supplies signing approval.

| File                                                     | Purpose                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [node.ts](node.ts)                                       | Minimal `setup → createClient → listChannels → cleanup` flow                                                               |
| [browser/account-session.ts](browser/account-session.ts) | Full SDK integration: per-user storage, registration, events, channels, payments, recovery, and cleanup; no DOM dependency |
| [browser/example-app.ts](browser/example-app.ts)         | User creation, deletion, and loading; network status, session reuse, and background refresh; no DOM dependency             |
| [shared/connection.ts](shared/connection.ts)             | Implements the `TenantRegistration`, `ChainProvider`, and `FundingWallet` adapters                                         |
| [shared/types.ts](shared/types.ts)                       | Shared user, connection, and JSON DTO types; amounts are sent as strings                                                   |
| [browser/app.ts](browser/app.ts)                         | Account panels, forms, confirmations, messages, and rendering; no direct SDK or backend calls                              |
| [browser/amount.ts](browser/amount.ts)                   | Exact CKB/shannon conversion without floating-point arithmetic                                                             |
| [server/index.ts](server/index.ts)                       | HTTP routes, static files, and tenant RPC forwarding                                                                       |
| [server/registration.ts](server/registration.ts)         | Tenant token registration and refresh, user identity binding; accepts the LSP URL, operator token source, and user store   |
| [server/config.ts](server/config.ts)                     | Reads trusted chain parameters and LSP details from the local deployment                                                   |
| [server/users.ts](server/users.ts)                       | JSON user storage, unique account bindings, and atomic writes                                                              |
| [server/wallet.ts](server/wallet.ts)                     | offckb wallet balances, funding verification, and default lock signing                                                     |
| [devnet/](devnet/README.md)                              | Shell scripts to initialize, start, stop, clean, and reset offckb                                                          |

## SDK integration flow

Read `AccountSession` first, then replace the three adapters for your app. The page layout, JSON user store, and offckb are choices made by the example, not SDK requirements.

Follow `restore → register → attachClient → openChannel / createInvoice / payInvoice → dispose` for the full call flow. The internal `attachClient` method shows how to subscribe before the first query.

`AccountSession` works on its own in a browser on the same origin, without loading `app.ts` or creating page elements. For an existing example user `user`:

```ts
import { AccountSession } from './browser/account-session.ts';
import { connectDevnet } from './shared/connection.ts';

const baseUrl = window.location.origin;
const connection = await connectDevnet(baseUrl);
const account = await AccountSession.restore(user, connection, baseUrl, {
  onChange: (session) => console.log(session.tenant, session.channel, session.payments),
  onEvent: (_session, event) => console.log(event),
  onConfirm: () => false, // Supply your app's approval policy; this rejects requests by default.
});
try {
  await account.run(() => account.register());
  await account.refresh();
} finally {
  await account.dispose();
}
```

`run()` sets a read-only `busy` state during an operation to prevent duplicate submissions and pause new refreshes. Errors reach the caller, and the busy state clears when the operation ends. SDK background events pass through callbacks; the session module does not choose messages or show confirmation dialogs. Browser storage still uses the example's `storage.ts` and Web Storage. See `node.ts` for a minimal Node integration.

### 1. Create a persistent identity for each user

`AccountSession.restore()` creates separate IndexedDB storage for each user, then constructs `fiberlsp`. Secure contexts use `BrowserStorage`. Plain HTTP uses the plaintext implementation in `browser/storage.ts`, with a `-plaintext` database suffix, and never reads or overwrites encrypted databases. HTTP mode uses separate IndexedDB read/write transactions for locking across tabs. It keeps transactions alive with repeated requests during asynchronous work. This fallback is for the example only. Browser storage does not migrate automatically when the protocol, host, or port changes. App user IDs, LSP tenant IDs, and on-chain wallet addresses are distinct identifiers linked by the user record.

Each user has separate storage and an SDK manager. A user can register multiple tenants, managed through “Add tenant” and the “Current tenant” selector. After refresh, the app reads `listTenants()` and restores the selected tenant. Interrupted registration resumes with the same identity. Do not generate a new identity after a network failure. The backend JSON stores tenant IDs and root public keys in `tenantIds` and `rootPublicKeys` arrays as sets, not paired by index. Registration and token refresh append unique values. Root public keys verify bindings but cannot restore private keys.

### 2. Register through the backend

`register()` passes the SDK's registration proof to `TenantRegistration.register()`. The backend route validates the request, then calls `registerTenant()` in `server/registration.ts`, which calls the SDK's `debugRegisterTenant()`. The operator token is read only on the server. Later browser RPC calls use the returned tenant token.

For registered users, “Refresh token” calls `setup({ refresh: true })` for the selected tenant.

To reuse this in your backend:

```ts
import { registerTenant } from './server/registration.ts';

// proof is generated by the client SDK and has passed request format validation.
const result = await registerTenant(proof, {
  rpcUrl: lspRpcUrl, // From trusted server configuration.
  readToken: () => secrets.readLspOperatorToken(),
  user: { id: currentUser.id, store: tenantBindings },
});
// Return result (tenant + access_token) to the SDK to finish registration or token refresh.
```

`tenantBindings` only needs the file's `bindRoot()` and `bindTenant()` methods and can use your own database. The example's `UserStore` implements both. Omit `user` when no app user binding is needed, as `node.ts` does. `readToken()` runs for each request, so it can read the latest operator token from a file or secret service.

The module first saves the root public key binding, requests an LSP token, verifies and saves the tenant binding, then returns the result. Binding operations should avoid duplicates. `bindTenant()` should verify that the returned root public key belongs to the user. If a step fails, keep existing bindings and retry with the same identity. The module does not depend on HTTP request objects. The host backend handles HTTP validation, app user authentication, and error responses. This example uses the privileged registration API of a controlled devnet.

### 3. Provide trusted chain queries and a funding wallet

`chainProvider()` implements:

- `getTransaction()`: returns only confirmed transactions, removing the extra `hash` field from CKB `TransactionView`.
- `getLiveCell()`: checks the current unspent Cell.
- `getCell()`: resolves the transaction that created an input, even if the funding transaction has already spent it.

`fundingWallet()` implements the SDK's `FundingWallet` interface:

1. `getFundingTerms()` returns explicit contributions, refund addresses, fee limits, and trusted dependencies.
2. `verifyFunding()` independently checks input ownership, both contributions, change, and fees. The SDK also runs its own chain and Rust checks.
3. `signFundingTransaction()` signs only the bound wallet's inputs and preserves the transaction structure.

The example backend uses CCC for offckb default lock signing. Replace this adapter to use a real wallet. The SDK still handles tenant signing and the channel protocol.

### 4. Subscribe before querying or acting

`attachClient()` subscribes to `ChannelChanged`, `BalanceChanged`, `PaymentChanged`, `InvoiceChanged`, and `Error` before querying. The UI merges state by increasing `version`.

Each tenant can open multiple channels through “Add channel” and switch between them with “Current channel”. `AccountSession.channels` lists the selected tenant’s channels; `selectChannel(operationId)` selects one, including an opening that does not yet have a channel ID. The selected channel is remembered per tenant in sessionStorage. Balances, invoices, payment history, and closing use the selected channel. Background updates keep all channels current without changing the selection. An unfinished opening is resumed before another channel is created.

A completed open call does not mean the channel is usable. Enable payments only when `ChannelInfo.ready` is true. Both channels need liquidity in the required direction. Payments use `createInvoice()` and `payInvoice()`. The UI shows completion only when `PaymentInfo.complete` is true; server `Success` / `Paid` states alone are insufficient.

The example automatically approves protocol signatures verified by the SDK. Funding, payment, and closing each require user confirmation once. Production apps can set their signing approval policy through `onConfirm`.

### 5. Recover and clean up

SDK keys, signing snapshots, authorizations, and pending operations are stored in IndexedDB. Payment lists in localStorage are only a display cache. After recovery, query payment status through the SDK instead of resending transactions from cached records.

Leaving either panel only changes the display. Started clients continue receiving payments and signing. When switching tenants or channels, each channel has its own balance and payment view, and started clients keep running. `dispose()` calls `cleanup()` for all tenants and closes storage. Keep the page open while receiving payments. Closing all pages stops browser processing until a page is reopened.

## Example data and scope

- User profiles: `.devnet/example-users.json`; override with `EXAMPLE_USERS_FILE`.
- Browser build: `.example/`; can be regenerated and is not committed to Git.
- SDK build: `dist/`, containing JavaScript ESM, type declarations, and WASM.
- User, tenant, and channel selections: sessionStorage; selections in one tab do not overwrite other tabs.
- Wallet private keys: read from offckb only for backend signing, never stored in the user JSON or browser.

This is a local devnet demo without login passwords. Its development unlock password is derivable and does not protect production keys. Use the same browser and origin; clearing IndexedDB loses tenant identities. Only unregistered users can be deleted. Registered identities and wallet bindings are retained.

See [test/integration/adapter.ts](../test/integration/adapter.ts) for the real-chain test adapter contract. The Rust/WASM bridge and Rust fixture generator reuse the pinned signing and validation code. The cryptographic protocol is not reimplemented in TypeScript.
