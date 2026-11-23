# TypeScript integration examples

This directory provides a working payment demo with two accounts and an SDK integration guide. All handwritten browser and Node backend logic uses TypeScript. HTML/CSS handles page structure and styles. The browser runs JavaScript compiled by `tsc`, not `.ts` source files.

## Run

Requires Node.js 24, pnpm 11, offckb with Fiber node support, matching Fiber source, and a Rust build environment. fiber-lab is not required.

Before initialization, build the matching `fnn` and check the `FNN_PATH` setting. [Devnet build instructions](devnet/README.md)

```sh
pnpm install
# Initialize and start once; use start.sh to restart an existing environment.
sh examples/devnet/init.sh
sh examples/start.sh
```

`start.sh` requires lsof. It sends SIGTERM to the process listening on port 8008, then uses nohup to run `pnpm example` in the background to build and start the example. Logs append to `.devnet/example.log`.

The server listens on all interfaces at `http://server-ip-or-domain:8008`, or locally at <http://127.0.0.1:8008>. API requests enforce same-origin access using the request Host. HTTPS or localhost uses the SDK's encrypted storage. Plain HTTP uses the example's plaintext IndexedDB storage and shows “HTTP · Private keys stored in plaintext, for testing only” beside the title. This mode is for devnet demos; use HTTPS in production.

When the LSP has a WebSocket listener, the browser connects through the same-origin `/devnet/ws` relay. Signing pushes drive the SDK directly; queries and submissions reuse the connection. The relay forwards the tenant subprotocol credential and never uses the operator token. Existing tenants adopt this transport when restored. HTTP remains available when WebSocket is absent or disconnected. An HTTPS reverse proxy must forward WebSocket upgrades for `/devnet/ws`.

Add two users, each bound to an unused wallet from offckb #6–#9 (the same range as fiber-lab users 1–4). Select a user in each panel, register tenants, open channels, then create and pay invoices. Accounts use the preset wallets' existing CKB without a faucet.

Choose **Receive**, enter an amount in CKB, and select **Create invoice**. Copy the new invoice or use **Send to [account name]** to open the other panel’s **Send** dialog with the invoice filled in. To pay an invoice from elsewhere, open **Send** and paste it. **Payment activity** below the buttons updates automatically for the selected channel.

Node1, Node2, and Node3 (LSP) use #3, #4, and #5. When adding users, preallocated test accounts #0–#2, node wallets, and all other accounts outside #6–#9 are disabled. The backend also rejects these bindings. #19 is used for contract deployment and test UDT issuance. When sharing a devnet with fiber-lab, wallet balances for #6–#9 are shared too.

Run `sh examples/devnet/stop.sh` when done. Use `sh examples/devnet/start.sh` next time to keep using the same data.

`sh examples/devnet/clean.sh` removes node data and this project's `.devnet/`. `sh examples/devnet/reset.sh` cleans, initializes with the configured `fnn`, and starts the environment.

```sh
pnpm typecheck      # Check the SDK, examples, build scripts, and all tests.
pnpm test           # Run Node tests.
```

`pnpm example` builds the SDK into `dist/`, compiles browser TypeScript into `.example/`, then runs `server/index.ts`. Node 24 strips type annotations without checking types, so run `pnpm typecheck` after changes. For browser changes, run `pnpm exec tsc -p examples/tsconfig.browser.json` and refresh. For backend changes, restart `pnpm example`.

## Where to start

The [Chinese integration guide](../docs/integration-zh.md) covers the SDK call flow and the interfaces your app supplies.

**For SDK usage, start with [business/account-session.ts](business/account-session.ts).** It covers setup, identity recovery, registration, event subscriptions, channel opening, payments, and cleanup.

**For backend tenant token registration and refresh, see [server/registration.ts](server/registration.ts).** It is independent of HTTP routes, offckb, and JSON user storage, and can be imported into your own backend.

The browser example follows `ui/ → business/ → fiber-lsp-sdk`. The UI calls `ExampleApp` for user management and `AccountSession` for tenant, channel, and payment operations. It renders state through `onChange`, turns events into messages through `onEvent`, and supplies signing approval through `onConfirm`. The business layer uses `server/` over HTTP for demo services such as user storage, tenant registration, and wallet signing.

| File                                                            | Purpose                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [ui/index.html](ui/index.html) · [ui/styles.css](ui/styles.css) | Page structure and styles                                                          |
| [ui/app.ts](ui/app.ts) · [ui/amount.ts](ui/amount.ts)           | Account panels, forms, confirmations, rendering, and precise CKB input and display |
| [business/example-app.ts](business/example-app.ts)              | User management, network status, session reuse, and refresh                        |
| [business/account-session.ts](business/account-session.ts)      | SDK lifecycle, tenant registration, events, channels, payments, and recovery       |
| [business/connection.ts](business/connection.ts)                | Browser RPC configuration and the `ChainProvider` and `FundingWallet` adapters     |
| [business/storage.ts](business/storage.ts)                      | Browser storage for SDK identities and operation state                             |
| [shared/types.ts](shared/types.ts)                              | User and connection types and JSON types shared with the backend                   |
| [server/index.ts](server/index.ts)                              | HTTP routes, static files, and tenant RPC forwarding                               |
| [server/registration.ts](server/registration.ts)                | Tenant token registration and refresh, and user identity binding                   |
| [server/config.ts](server/config.ts)                            | Trusted chain parameters and LSP details from the local deployment                 |
| [server/users.ts](server/users.ts)                              | JSON user storage, unique account bindings, and atomic writes                      |
| [server/wallet.ts](server/wallet.ts)                            | offckb wallet balances, funding verification, and default lock signing             |
| [devnet/](devnet/README.md)                                     | Shell scripts to initialize, start, stop, clean, and reset offckb                  |

## SDK integration flow

Read `AccountSession` first, then replace the three adapters for your app. The page layout, JSON user store, and offckb are choices made by the example, not SDK requirements.

Follow `restore → register → attachClient → openChannel / createInvoice / payInvoice → dispose` for the full call flow. The internal `attachClient` method shows how to subscribe before the first query.

`AccountSession` can run on the demo origin independently of the page. For an existing example user `user`:

```ts
import { AccountSession } from './business/account-session.ts';
import { connectDevnet } from './business/connection.ts';

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

`run()` sets a read-only `busy` state during an operation to prevent duplicate submissions and pause new refreshes. Errors reach the caller, and the busy state clears when the operation ends. SDK background events pass through callbacks; the session module does not choose messages or show confirmation dialogs. Browser storage still uses the example's `storage.ts` and Web Storage.

### 1. Create a persistent identity for each user

`AccountSession.restore()` creates separate IndexedDB storage for each user, then constructs `fiberlsp`. Secure contexts use `BrowserStorage`. Plain HTTP uses the plaintext implementation in `business/storage.ts`, with a `-plaintext` database suffix, and never reads or overwrites encrypted databases. HTTP mode uses separate IndexedDB read/write transactions for locking across tabs. It keeps transactions alive with repeated requests during asynchronous work. This fallback is for the example only. Browser storage does not migrate automatically when the protocol, host, or port changes. App user IDs, LSP tenant IDs, and on-chain wallet addresses are distinct identifiers linked by the user record.

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
// Return { tenant, access_token, expires_at_ms } to the SDK.
```

`tenantBindings` only needs the file's `bindRoot()` and `bindTenant()` methods and can use your own database. The example's `UserStore` implements both. Omit `user` when no app user binding is needed. `readToken()` runs for each request, so it can read the latest operator token from a file or secret service.

The module first saves the root public key binding, requests an LSP token, verifies and saves the tenant binding, then returns the result. Binding operations should avoid duplicates. `bindTenant()` should verify that the returned root public key belongs to the user. If a step fails, keep existing bindings and retry with the same identity. The module does not depend on HTTP request objects. The host backend handles HTTP validation, app user authentication, and error responses. This example uses the privileged registration API of a controlled devnet.

### 3. Provide trusted chain queries and a funding wallet

`chainProvider()` implements:

- `getTransaction()`: returns only confirmed transactions, removing the extra `hash` field from CKB `TransactionView`.
- `getLiveCell()`: checks the current unspent Cell.
- `getCell()`: resolves the transaction that created an input, even if the funding transaction has already spent it.
- `getMedianTime()` reads `median_time` from the trusted CKB node's `get_blockchain_info` response. The SDK uses this hex millisecond timestamp before releasing an invoice preimage.

`fundingWallet()` implements the SDK's `FundingWallet` interface:

1. `getFundingTerms()` returns explicit contributions, refund addresses, fee limits, and trusted dependencies.
2. `verifyFunding()` independently checks input ownership, both contributions, change, and fees. The SDK also runs its own chain and Rust checks.
3. `signFundingTransaction()` signs only the bound wallet's inputs and preserves the transaction structure.

The example backend uses CCC for offckb default lock signing. Replace this adapter to use a real wallet. The SDK still handles tenant signing and the channel protocol.

### 4. Subscribe before querying or acting

`attachClient()` subscribes to `ChannelChanged`, `BalanceChanged`, `PaymentChanged`, `InvoiceChanged`, and `Error` before querying. The account session merges state by increasing `version`.

The SDK handles background reconciliation; the page has no global refresh timer. Initial loading and manual refresh check network status, users, wallet balances, and SDK state. Channel readiness, verified closure, and completed payments trigger wallet balance updates, with updates deferred while an operation or refresh is in progress. Signing notifications are immediate, idle WebSocket reconciliation defaults to 15 seconds, and unfinished operations use the example's one-second interval to discover state changes without signing notifications. Trusted CKB checks remain independent of the LSP transport. Use manual refresh to discover unrelated on-chain transfers or user changes made in another page.

Each tenant can open multiple channels through “Add channel” and switch between them with “Current channel”. `AccountSession.channels` lists the selected tenant’s channels; `selectChannel(operationId)` selects one, including an opening that does not yet have a channel ID. The selected channel is remembered per tenant in sessionStorage. Balances, invoices, payment history, and closing use the selected channel. Background updates keep all channels current without changing the selection. An unfinished opening is resumed before another channel is created.

Both parties exchange V2 commitment signatures and the SDK verifies the local commitment before the wallet signs the funding transaction. If the UI shows **Resume opening**, use it to continue with the same wallet and funding terms. Enable payments only when `ChannelInfo.ready` is true. Both channels need liquidity in the required direction. Payments use `createInvoice()` and `payInvoice()`. The UI shows completion only when `PaymentInfo.complete` is true; server `Success` / `Paid` states alone are insufficient.

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

The Rust/WASM bridge reuses the pinned Fiber SDK for signing and validation.
