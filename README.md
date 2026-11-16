# Fiber LSP SDK for TypeScript

TypeScript SDK for Fiber LSP tenant registration, channel management, payments, and recovery.

A browser and Node.js client for section 3 of `fiber-lsp-sdk.md`. It reuses Rust `fiber-lsp-sdk` for validation, root identities, channel keys, MuSig2 signing, invoice parsing, and preimage release checks, pinned to Fiber commit `76307312e8de518c9a32074e6d16867c04de4f86`. TypeScript handles RPC, storage, events, recovery, and lifecycle management. The package builds ESM, type declarations, and WASM. It keeps `private: true` during development.

## Build and check

Requirements: Node.js 24, pnpm 11.17.0, Rust, `wasm32-unknown-unknown`, and a matching wasm-bindgen CLI.

The SDK, example app, build scripts, and tests use TypeScript. Shell scripts manage the devnet. `pnpm typecheck` checks all handwritten TypeScript. Node.js 24 runs tool and backend `.ts` files directly; `tsc` compiles the browser example. The Rust/WASM bridge reuses the existing signing and validation code.

`packageManager` pins the pnpm version, and `pnpm-lock.yaml` locks JavaScript dependencies. Use `pnpm install --frozen-lockfile` in CI.

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm build
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

The first build fetches Rust dependencies from the pinned commit. Later builds reuse WASM based on a source fingerprint and rebuild it when the signing bridge changes. To use a local copy of the matching Fiber source:

```sh
FIBER_SOURCE=../fiber pnpm build:wasm
pnpm build
```

`FIBER_SOURCE` must point to the commit above. The build script writes local Cargo configuration only under this repository's `target/` directory and leaves the Fiber repository unchanged. Deploy `dist/wasm/` with the JavaScript files and serve `.wasm` as `application/wasm`. Browsers must support ESM, top-level await, BigInt, Web Crypto, IndexedDB, and Web Locks. The SDK's default encrypted storage requires HTTPS or localhost; the examples also provide plaintext storage over HTTP for devnet use. Node.js loads WASM through a separate file loader. Importing the SDK does not access browser storage or prompt for a password.

## Initial setup

```typescript
import { fiberlsp, BrowserStorage, FiberLspEvent } from 'fiber-lsp-sdk';

const storage = new BrowserStorage({
  onUnlock: ({ reason }) => app.requestStoragePassword(reason),
});
const lsp = new fiberlsp({
  storage,
  chain, // Trusted CKB queries controlled by the app; see below.
  onConfirm: (request) => app.confirm(request),
});
const tenant = await lsp.setup({
  fiberLsp: { rpcUrl, wsUrl, nodePublicKey, network },
  registration: { register: (params) => app.registerTenant(params) },
});
const client = lsp.createClient(tenant.tenantId);
const cancel = client.on(FiberLspEvent.ChannelChanged, app.updateChannel);
client.on(FiberLspEvent.Error, app.showError);
app.showChannels(await client.listChannels());
```

The registration backend returns the raw `{ tenant, access_token }`. The SDK saves the local identity and proof before sending the request. It marks the tenant `ready` only after checking the tenant ID, root public key, invoice public key, and nonempty token. If registration fails, find the pending record with `listTenants()` and resume with the same `tenantId`. Existing tenants can create a client directly. Pass `refresh: true` to `setup` to force a token refresh; a 401/403 response automatically marks the token for refresh.

For separate registration steps, use `beginRegistration({ tenantId?, fiberLsp })` and `finishRegistration(tenantId, result)`. Each attempt creates a new request ID and signature. The separate `debugRegisterTenant({ rpcUrl, token, params })` export is available for controlled local debugging. Its operator token is used only for that request. Production web apps register through the provider's backend.

Supply `network` from trusted app configuration. See [src/types.ts](src/types.ts) for field definitions:

```typescript
const network = {
  currency: 'Fibd', // Mainnet: Fibb; testnet: Fibt; devnet: Fibd.
  fundingLock, // Trusted deployed Script; args must be "0x".
  commitmentLock, // Trusted deployed Script; args must be "0x".
  fundingCellDeps, // Allowed CellDep[] for funding and cooperative close.
  commitmentCellDeps: 1, // Must match the actual commitment transaction's dependency count.
  epochDurationMs: 14_400_000,
  minimumShutdownFee: 100_000_000n,
  minTlcExpiryDeltaMs: 9_600_000,
  tlcExpiryLimitMs: 14 * 86_400_000,
};
```

These values are examples. Use the actual network and deployment configuration. Never replace trusted settings with values from a server signing request. Amounts, fees, and encoded epochs use `bigint`; durations and local timestamps use safe integer milliseconds. The SDK converts RPC integers to `0x` hex strings.

## Chain and funding wallet

`chain` implements `ChainProvider`:

- `getTransaction(hash, network)`: independently verifies the full confirmed transaction; returns `null` if unconfirmed.
- `getLiveCell(outPoint, network)`: reads an unspent Cell from a trusted chain source; returns `{ output, data }` or `null`.
- `getCell(outPoint, network)`: independently resolves funding inputs, including Cells already spent by the funding transaction.

```typescript
const channel = await client.openChannel({ wallet });
```

`wallet` implements `FundingWallet` and can wrap a CCC wallet:

1. `getFundingTerms(network)` returns the user's chosen `FundingTerms`: both parties' contributions, asset, funding and refund scripts, commitment delay in epochs, fee rates, maximum wallet CKB debit, and maximum total CKB fee.
2. `verifyFunding(transaction, terms, network)` independently approves the full transaction, both contributions, asset, and change. It returns all approved input OutPoints in transaction order. The SDK also queries inputs through `chain` to check wallet debit, total fees, dependencies, and Rust channel rules.
3. `signFundingTransaction(transaction)` signs only inputs owned by the wallet and preserves the transaction structure.

`maxWalletDebit` is always in CKB shannons. `fundingAmount` separately limits the authorized UDT amount. `maxFundingFee` also caps the cooperative close fee. The local party currently pays the full close fee. Closing uses the `shutdownScript` saved at channel opening and defaults to `fundingFeeRate`; set `closeFeeRate` to override it.

Opening returns an operation ID and current state. `ready: true` requires server readiness, trusted on-chain funding checks, and a complete local recovery signature. If a wallet is missing during opening, `ChannelInfo.needsWallet` is `true`; call `openChannel({ wallet })` again to resume the same operation. Recovery can resubmit a signed funding transaction and keeps its original hash if the result is unknown. Use `openChannel({ wallet, newChannel: true })` to add another channel under the same tenant. An unfinished opening is resumed first, using its original signer and terms. Without `newChannel`, calling open again returns the latest channel or resumes an unfinished opening. Failed or closed openings allow a fresh channel after user approval.

```typescript
await client.closeChannel(channel.channelId!);
// Poll until closed is true: both on-chain refunds, assets, scripts, and fees are verified.
```

## Payments and events

```typescript
const invoice = await client.createInvoice({ channelId, amount: 1000n });
app.showInvoice(invoice.invoice);

const parsed = client.parseInvoice(invoiceString); // Synchronous and local; no network or background startup.
await client.payInvoice({ channelId, invoice: invoiceString, maxFee: 10n });
await client.getPayment({ paymentHash: parsed.paymentHash, direction: 'outgoing' });
await client.getPayment({ paymentHash: invoice.paymentHash, direction: 'incoming' });

await client.keysend({ channelId, targetPublicKey, amount: 1000n, maxFee: 10n });
```

Before paying an invoice, the SDK saves the hash, exact channel amount, fee budget, authorization deadline, and commitment baseline. The trampoline fee cap is rounded up from the per-thousand rate, then limited to `maxFee`. Payments directly to the LSP node add no trampoline fee. Incoming payments use hold invoices with preimages kept by the client. Rust checks the full local commitment signature, valid funding, and safe timing before releasing a preimage. `Received`, `Success`, and `Paid` retain their server meanings. `complete` becomes `true` only after local TLC acceptance, removal, balance, and chain checks pass.

Keysend uses the server's `send_payment` without `invoice` or `payment_hash`. Before sending, the SDK saves a random correlation ID in a custom record. If the response is lost, it pages through `list_payments`, finds the hash by that ID, and creates the authorization. If no match or multiple matches are found, it keeps the state unknown and stops resending. This recovery requires the server to retain and return custom records. There is no separate query API for incoming keysend payments.

A tenant can have multiple active channels. Choose a `channelId` for invoices, payments, and closing. This version processes payments one at a time per tenant. Each payment must pass verification before the next starts, so exact amounts match both balance baselines. MPP invoices are rejected. A missing record in the requested direction returns `null`, while local records remain available for recovery. Other errors are thrown. Server records without local authorization are reported as missing data, not marked as verified.

Events include `ChannelChanged`, `BalanceChanged`, `PaymentChanged`, `InvoiceChanged`, `ConnectionChanged`, and `Error`. Queries and events share result types, and state records carry an increasing `version`. Subscribe before querying. Listeners share a connection, and cancellation is safe to repeat. After the last page unsubscribes, signing continues for started tenants until `cleanup` is called.

With `wsUrl` configured, the SDK subscribes to `channel_signing`. Notifications trigger independent queries and checks; polling covers states without notifications. Node.js uses the `ws` Authorization header; browsers use the `fiber-rpc` and token subprotocols. The WebSocket URL is never inferred from the HTTP URL. Reconnection restores subscriptions and queries existing operations. Token refresh rebuilds the connection. Without WebSocket configuration, the SDK uses HTTP.

## Storage, recovery, and cleanup

`MemoryStorage` suits temporary Node.js experiments. `BrowserStorage` saves records in IndexedDB and encrypts each tenant's root key with AES-256-GCM. PBKDF2-HMAC-SHA256 with a random salt and 600,000 iterations derives a password key that wraps a random storage encryption key. Passwords and plaintext keys are never stored in the database. Regular records and root keys use separate object stores.

```typescript
await storage.changePassword({ oldPassword, newPassword });
const backup = await storage.exportBackup(backupPassword);
await anotherStorage.importBackup(backup, backupPassword);
storage.lock();
await storage.unlock(); // BrowserStorage calls onUnlock as needed.
```

Changing the password replaces only the wrapped encryption key record. A failed transaction keeps the old record; success locks storage and notifies other tabs. Backups contain root keys, signing snapshots, sessions, and operation records, encrypted as a whole. Import preserves the original identity and refuses to overwrite existing records. Earlier backups still use their original backup password. `MemoryStorage` also supports encrypted backup and import.

Custom persistent storage must follow the [Storage](src/storage.ts) interface: batch `commit` and CAS conditions must share a transaction; `withLock` must cover all instances, processes, or tabs sharing storage; `getRootKey` must return an independent byte copy; and locking must notify the SDK. The default browser implementation uses Web Locks and BroadcastChannel. The SDK saves the full Rust signing snapshot with the session. A failed save stops further requests or signature submissions.

```typescript
const [tenant] = await lsp.listTenants();
const client = lsp.createClient(tenant.tenantId);
await client.listChannels(); // Starts recovery on demand.
cancel(); // A page leaving only cancels its own listener.
await lsp.cleanup(tenant.tenantId); // Stops the tenant's entire client.
```

Repeated `createClient` calls on the same manager return the same object. `cleanup` combines concurrent cleanup calls, immediately rejects new operations, aborts network waits, closes subscriptions, removes all listeners, and waits for in-flight work to finish. Other tenants and saved data remain intact. The old client then returns `CLOSED`; a new client can be created after cleanup succeeds. Locking storage pauses affected tenants. After unlocking, query the original client to resume. Invalid tokens require registration with the same identity. Network timeouts never create new identities or repeat payments automatically.

## Tests and examples

The Shell scripts in [examples/devnet/](examples/devnet/README.md) call offckb directly to manage CKB and three Fiber nodes, with LSP enabled on Node3. Run them with `sh`. During setup, `configure.ts` uses the project's `js-yaml` dependency to update node configuration, and biscuit-cli 0.6 issues the operator token.

First setup:

```sh
sh examples/devnet/init.sh  # Initialize offckb nodes, configure LSP, and start.
sh examples/start.sh        # Run the example in the background on port 8008.
```

The example startup script sends SIGTERM to the process listening on port 8008, then runs `pnpm example` through nohup. Build and runtime logs append to `.devnet/example.log`. The server listens on all interfaces at `http://server-ip-or-domain:8008`. API requests enforce same-origin access using the request Host. HTTPS/localhost uses encrypted storage. Plain HTTP uses the example's plaintext storage, with a warning beside the title.

`sh examples/devnet/stop.sh` stops Fiber and CKB while keeping data. Use `sh examples/devnet/start.sh` to start again. As in fiber-lab, the startup script calls offckb directly; stop before restarting.

`sh examples/devnet/clean.sh` stops nodes and removes offckb data and this project's `.devnet/`. `sh examples/devnet/reset.sh` cleans, rebuilds fnn, initializes, and starts the environment.

The scripts use `../fiber/target/release/fnn` and save the operator token in `.devnet/keys/operator-token`. When using a custom offckb directory, use the same XDG environment variables for scripts and the example server. See the [devnet script guide](examples/devnet/README.md).

The page header shows CKB/LSP connection status, block height, user count, and an “Add user” dialog. Each of the two panels selects a user and runs an independent SDK client.

Demo steps:

1. Click “Add user”, enter a unique `name` and a display name (`display`), and select a preset offckb account. Bound accounts and the LSP funding account are disabled; the backend also rejects duplicate bindings.
2. Select a user in each panel. No login password is needed. Wallets use the bound offckb accounts' existing CKB without a faucet.
3. Click “Register tenant”, then “Open channel” in each panel. The default local contribution is 1000 CKB, or the LSP minimum if higher. The LSP contribution comes from the current node configuration. Confirm funding and wait for “Ready”. The example automatically approves protocol signatures verified by the SDK; funding, payment, and channel closing each require confirmation.
4. Enter a CKB amount on the receiving side, create an invoice, and copy it to the payer's input, or click “Fill other side”. Click “Pay invoice” on the paying side. Keep the page open until both records show “Complete” and check the balance changes. The maximum payment fee is 1 CKB. Amounts support up to 8 decimal places.
5. Refreshing restores both selected users, tenant identities, and payment records for the current tab. Close channels through “Account tools”; on-chain balances update after refunds are confirmed. Users without tenants can be deleted to release their bindings. Registered users keep their identities and bindings to protect recovery data.

User profiles are stored in `.devnet/example-users.json` (override with `EXAMPLE_USERS_FILE`). They contain names, public offckb wallet bindings, tenant IDs, and root public keys. Writes are serialized and replace the file atomically through a temporary file. Only one example server process may manage a file. Files are scoped to the chain genesis and LSP node identity. Use a new user file when rebuilding the devnet and keep old data needed for recovery.

Tenant keys, signing snapshots, and operation state are stored per user in IndexedDB. HTTPS/localhost uses the SDK's `BrowserStorage` to encrypt root private keys; plain HTTP uses the example's plaintext storage with a `-plaintext` database suffix. Payment records for display are stored in localStorage. For a local experience without passwords, the example uses a fixed, derivable development unlock password. **It provides no password protection and is for devnet use only.** offckb wallet private keys are read only for backend signing; they are never written to the user JSON or sent to the browser. Clearing browser data loses tenant keys, which the JSON user file cannot restore. Use the same browser and site address (`localhost` and `127.0.0.1` are different origins). Leaving one panel only hides it; started clients keep processing pending payments.

See [examples/README.md](examples/README.md) for integration details. Start with the minimal registration flow in [examples/node.ts](examples/node.ts), then read the full lifecycle in [AccountSession](examples/browser/account-session.ts).

Directory layout:

- `examples/browser/`: TypeScript page logic, amount conversion, and independent SDK account sessions.
- `examples/shared/`: shared types and adapters for registration, trusted chain queries, and funding wallets.
- `examples/server/`: TypeScript HTTP backend, trusted configuration, JSON user storage, and offckb wallet verification and signing.
- `examples/browser.html`, `examples/styles.css`: page structure and styles; the SDK loads through an import map.
- `examples/node.ts`: minimal Node.js integration with an identity stored in memory.
- `examples/devnet/`: offckb scripts to initialize, start, stop, clean, and reset the local environment.

`pnpm example` builds the SDK into `dist/`, compiles browser code into `.example/`, and runs the TypeScript backend directly. After browser changes, run `pnpm build:example` and refresh. After backend changes, restart the example. App source files use `.ts`; environment scripts use `.sh`. The SDK's `.js` import suffixes and generated JavaScript follow ESM build conventions.

offckb defaults to CKB port `8114`, LSP HTTP `21716`, and WebSocket `21717`. The example page uses `8008`. `pnpm example:browser` is equivalent to `pnpm example`. The browser uses same-origin HTTP polling, so node CORS needs no extra setup. Browser tests use a separate static server on `4173` and do not require a running devnet.

- `pnpm test`: Node.js tests cover real Rust invoice and MuSig2 validation, channel opening and cooperative close, tamper rejection, lost payment responses, keysend correlation, recovery, cleanup, WebSocket reconnection, transactions, and encrypted storage.
- `pnpm test:browser`: Chromium tests cover WASM, real HTTP CORS and WebSocket subprotocols, channel signing, payment recovery, IndexedDB, page refresh, password changes, and locking across tabs.
- `FIBER_SOURCE=../fiber pnpm test:fixtures`: generates local RPC fixtures from the pinned Rust SDK. Fixture private keys are for tests only and must not hold real funds.
- `pnpm test:integration`: skipped by default. Set `FIBER_LSP_TEST_ADAPTER=/absolute/path/adapter.ts` to run real registration, channel opening, hold invoice receipt, and closing with an app-provided local test chain, funding wallet, and payer. See [test/integration/live.test.ts](test/integration/live.test.ts) for the adapter contract.

Current automated tests use valid Rust-generated transactions and signing requests with local RPC/WebSocket servers. The examples support manual checks of payments between two users on a real LSP. Callers still provide the general `test:integration` adapter. Watchtower and on-chain withdrawals after forced closure are outside this version's public API.
