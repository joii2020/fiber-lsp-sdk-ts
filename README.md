# Fiber LSP SDK for TypeScript

TypeScript SDK for Fiber LSP tenant registration, channel management, payments, and recovery.

[中文接入指南](docs/integration-zh.md) walks through the devnet demo and integrating the SDK into your own app.

A browser and Node.js client for section 3 of `fiber-lsp-sdk.md`. It reuses Rust `fiber-lsp-sdk` for validation, root identities, channel keys, MuSig2 signing, invoice parsing, and preimage release checks, pinned to Fiber commit `5da02c0d0843b5a690eb82a8cc915bf7b4438693`. TypeScript handles RPC, storage, events, recovery, and lifecycle management.

Existing hosted channels and pending openings from the previous signer format require the previous SDK to manage them. V2 uses fresh channel signer state. A registered identity with no channel keys can be reused.

## Install

```sh
npm install fiber-lsp-sdk
```

The npm package ships ESM, TypeScript declarations, and compiled WASM. For Node.js, use version 24 or later.

## Build and check

Requirements: Node.js 24, pnpm 11.17.0, Rust, `wasm32-unknown-unknown`, and a matching wasm-bindgen CLI.

The SDK, example app, build scripts, and tests use TypeScript. Shell scripts manage the devnet. `pnpm typecheck` checks all handwritten TypeScript. Node.js 24 runs tool and backend `.ts` files directly; `tsc` compiles the browser example. The Rust/WASM bridge reuses the existing signing and validation code.

`wasm/` contains the Rust crate and its build script, which generate bindings in `wasm/pkg/`. `src/wasm/` contains the SDK's TypeScript adapter for Node.js and browsers. The SDK ships the adapter and generated bindings together in `dist/wasm/`.

`packageManager` pins the pnpm version, and `pnpm-lock.yaml` locks JavaScript dependencies. Use `pnpm install --frozen-lockfile` in CI.

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
pnpm build
pnpm typecheck
pnpm test
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
const client = lsp.createClient(tenant.tenantId); // Starts background recovery.
const cancel = client.on(FiberLspEvent.ChannelChanged, app.updateChannel);
client.on(FiberLspEvent.Error, app.showError);
app.showChannels(await client.listChannels());
```

The registration backend returns `{ tenant, access_token, expires_at_ms }`. The expiry is a hex Unix timestamp in milliseconds. The SDK saves the local identity and proof before sending the request. It verifies the tenant ID and public keys, then saves the token and expiry before marking the tenant `ready`. If registration fails, find the pending record with `listTenants()` and resume with the same `tenantId`. Existing tenants can create a client directly. Pass `refresh: true` to `setup` to force a token refresh. A 401/403 response automatically marks the token for refresh.

`TenantInfo.ready` records that registration finished. `credentialStatus` is `unregistered` before registration, `available` after registration or refresh, and `refreshRequired` after the LSP rejects the credential. When resuming or refreshing an existing tenant, `setup` checks the saved HTTP RPC URL, LSP public key, and network. Use `setWebSocketUrl` to update the saved WebSocket endpoint.

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
- `getMedianTime(network)` returns the trusted CKB chain median time as a hex Unix timestamp in milliseconds. Apps that receive payments must provide it. The example reads `median_time` from CKB's `get_blockchain_info` RPC.

```typescript
const channel = await client.openChannel({ wallet });
```

`wallet` implements `FundingWallet` and can wrap a CCC wallet:

1. `getFundingTerms(network)` returns the user's chosen `FundingTerms`: both parties' contributions, asset, funding and refund scripts, commitment delay in epochs, fee rates, maximum wallet CKB debit, and maximum total CKB fee.
2. `verifyFunding(transaction, terms, network)` independently approves the full transaction, both contributions, asset, and change. It returns all approved input OutPoints in transaction order. The SDK also queries inputs through `chain` to check wallet debit, total fees, dependencies, and Rust channel rules.
3. `signFundingTransaction(transaction)` signs only inputs owned by the wallet and preserves the transaction structure.

`maxWalletDebit` is always in CKB shannons. `fundingAmount` separately limits the authorized UDT amount. `maxFundingFee` also caps the cooperative close fee. The local party currently pays the full close fee. Closing uses the `shutdownScript` saved at channel opening and defaults to `fundingFeeRate`; set `closeFeeRate` to override it.

In `onConfirm`, check `request.kind` to access the typed details for that operation. Use `feeBudget` for the maximum payment fee and the UDT script to determine the asset for displayed amounts. The callback runs within the tenant's operation lock. It can read saved records with `listPayments()`. Wait for the operation to finish before calling methods that reconcile state, such as `listChannels()` or `getPayment()`.

Opening returns an operation ID and current state. The SDK waits for both parties to exchange V2 commitment signatures and verifies a complete local commitment before asking the wallet to sign the funding transaction. When `ChannelInfo.needsWallet` is `true`, call `openChannel({ wallet })` again with the original wallet to resume the same operation. This can happen while the initial commitment exchange is still in progress. Enable payments when `ready` is `true`, after the SDK verifies channel readiness and on-chain funding.

Recovery can resubmit a signed funding transaction and keeps its original hash if the result is unknown. Use `openChannel({ wallet, newChannel: true })` to add another channel under the same tenant. An unfinished opening is resumed first, using its original signer and terms. Without `newChannel`, calling open again returns the latest channel or resumes an unfinished opening. Failed or closed openings allow a fresh channel after user approval.

```typescript
await client.closeChannel(channel.channelId!);
// Poll until closed is true: both on-chain refunds, assets, scripts, and fees are verified.
```

## Payments and events

```typescript
const invoice = await client.createInvoice({ channelId, amount: 1000n });
app.showInvoice(invoice.invoice);

const parsed = client.parseInvoice(invoiceString); // Synchronous and local.
await client.payInvoice({ channelId, invoice: invoiceString, maxFee: 10n });
await client.getPayment({ paymentHash: parsed.paymentHash, direction: 'outgoing' });
await client.getPayment({ paymentHash: invoice.paymentHash, direction: 'incoming' });

await client.keysend({ channelId, targetPublicKey, amount: 1000n, maxFee: 10n });
```

Use `await client.listPayments()` to load saved payments and invoices while the client is recovering or offline. The method reads local storage. A pending keysend can have `paymentHash: null` while the SDK looks for its hash. Merge the list with `PaymentChanged` and `InvoiceChanged` events by `operationId`, keeping the entry with the higher `version`.

Before paying an invoice, the SDK saves the hash, exact channel amount, fee budget, authorization deadline, and commitment baseline. The trampoline fee cap is rounded up from the per-thousand rate, then limited to `maxFee`. Payments directly to the LSP node add no trampoline fee. Incoming payments use hold invoices with preimages kept by the client. Rust checks the full local commitment signature, valid funding, and safe timing before releasing a preimage. To confirm settlement, check both `complete` and `status`. A successful outgoing payment requires `Success` and a successful incoming payment requires `Paid`. Failed or expired payments can also reach `complete` after local reconciliation.

Keysend uses the server's `send_payment` without `invoice` or `payment_hash`. Before sending, the SDK saves a random correlation ID in a custom record. If the response is lost, it pages through `list_payments`, finds the hash by that ID, and creates the authorization. If no match or multiple matches are found, it keeps the state unknown and stops resending. This recovery requires the server to retain and return custom records. There is no separate query API for incoming keysend payments.

A tenant can have multiple active channels. Choose a `channelId` for invoices, payments, and closing. This version processes payments one at a time per tenant. Each payment must pass verification before the next starts, so exact amounts match both balance baselines. MPP invoices are rejected. A missing record in the requested direction returns `null`, while local records remain available for recovery. Other errors are thrown. Server records without local authorization are reported as missing data, not marked as verified.

For invoices, keep one channel per asset eligible for delivery while an invoice is outstanding. The LSP chooses the delivery channel when payment arrives. Before issuing an invoice, `createInvoice` checks the node's channel list and returns `CONFLICT` if the selected channel is unavailable or another channel for that asset could receive the payment. Offline and opening channels can become eligible. Channels reported as closed or shutting down are excluded.

Events include `ChannelChanged`, `BalanceChanged`, `PaymentChanged`, `InvoiceChanged`, `ConnectionChanged`, and `Error`. Queries and events share result types, and state records carry an increasing `version`. Subscribe before querying. Listeners share a connection, and cancellation is safe to repeat. After the last page unsubscribes, signing continues for started tenants until `cleanup` is called.

With `wsUrl` configured, the SDK subscribes to `channel_signing` and reuses that WebSocket for JSON-RPC queries and submissions. Pushed signing requests go directly through the Rust signer's verification and durable submission path, without querying `get_channel_signing_status` again. Notifications preempt the polling timer, and repeated completed requests are deduplicated. Reconnection restores subscriptions, replays pending requests, and reconciles existing operations. Node.js uses the `ws` Authorization header; browsers use the `fiber-rpc` and token subprotocols. Token refresh rebuilds the connection.

The server currently pushes signing status, not full channel or payment state. The SDK still reconciles these states and checks trusted CKB data. Idle WebSocket clients reconcile every `webSocketPollIntervalMs` (default 15 seconds); opening, closing, and pending payments use `pollIntervalMs` (default 1.5 seconds). Signing-status queries serve as a periodic fallback. Without a configured or available WebSocket, requests use HTTP. A request already sent over WebSocket is never automatically repeated over HTTP after a timeout or disconnect, because a write may already have succeeded.

The WebSocket URL is never inferred from the HTTP URL. Existing HTTP tenants can enable or change it without registering again: `await lsp.setWebSocketUrl(tenantId, wsUrl)`. Omit the URL to return to HTTP; the tenant identity, network, and credential are retained.

## Storage, recovery, and cleanup

`MemoryStorage` suits temporary Node.js experiments. `BrowserStorage` saves records in IndexedDB and encrypts each tenant's root key with AES-256-GCM. PBKDF2-HMAC-SHA256 with a random salt and 600,000 iterations derives a password key that wraps a random storage encryption key. Passwords and plaintext keys are never stored in the database. Regular records and root keys use separate object stores.

```typescript
await storage.changePassword({ oldPassword, newPassword });
storage.lock();
await storage.unlock(); // BrowserStorage calls onUnlock as needed.
```

Changing the password replaces only the wrapped encryption key record. A failed transaction keeps the old record; success locks storage and notifies other tabs. Backups contain root keys, signing snapshots, sessions, and operation records, encrypted as a whole. Import preserves the original identity and refuses to overwrite existing records. Earlier backups still use their original backup password. `MemoryStorage` also supports encrypted backup and import.

For a V2 signer move, stop clients using the source store and export its latest state. Resume signing only from the destination store after import. Restoring older state or running two writable copies of the same signer can reuse MuSig2 nonces and expose the channel funding key.

```typescript
const backup = await storage.exportBackup(backupPassword);
await anotherStorage.importBackup(backup, backupPassword);
```

Custom persistent storage must follow the [Storage](src/storage.ts) interface: batch `commit` and CAS conditions must share a transaction; `withLock` must cover all instances, processes, or tabs sharing storage; `getRootKey` must return an independent byte copy; and locking must notify the SDK. The default browser implementation uses Web Locks and BroadcastChannel. The SDK saves the full Rust signing snapshot with the session. A failed save stops further requests or signature submissions.

```typescript
const [tenant] = await lsp.listTenants();
const client = lsp.createClient(tenant.tenantId);
await client.listChannels(); // Waits for initial recovery, then reconciles channels.
cancel(); // A page leaving only cancels its own listener.
await lsp.cleanup(tenant.tenantId); // Stops the tenant's entire client.
```

`createClient` returns synchronously and starts background recovery for a new client. Recovery can invoke `onUnlock` and reports background failures through the `Error` event. Repeated calls on the same manager return the same object. `cleanup` combines concurrent cleanup calls, immediately rejects new operations, aborts network waits, closes subscriptions, removes all listeners, and waits for in-flight work to finish. Other tenants and saved data remain intact. The old client then returns `CLOSED`; a new client can be created after cleanup succeeds. Locking storage pauses affected tenants. After unlocking, call `client.listChannels()` to resume. Invalid tokens require registration with the same identity. Network timeouts never create new identities or repeat payments automatically.

For a client created by the manager, `client.cleanup()` and `lsp.cleanup(tenantId)` share the same shutdown. Either call releases the cached client once cleanup finishes.

## Tests and examples

The Shell scripts in [examples/devnet/](examples/devnet/README.md) call offckb directly to manage CKB and three Fiber nodes, with LSP enabled on Node3. Run them with `sh`. During setup, `configure.ts` uses the project's `js-yaml` dependency to update node configuration, and biscuit-cli 0.6 issues the operator token.

Before running `init.sh`, prepare a compatible `fnn` executable. `FNN_PATH` defaults to `../fiber/target/release/fnn` relative to the SDK repository root. Set `FNN_PATH` in [examples/devnet/config.sh](examples/devnet/config.sh) if your executable is elsewhere.

```sh
sh examples/devnet/init.sh  # Initialize offckb nodes, configure LSP, and start.
sh examples/start.sh        # Run the example in the background on port 8008.
```

The example startup script sends SIGTERM to the process listening on port 8008, then runs `pnpm example` through nohup. Build and runtime logs append to `.devnet/example.log`. The server listens on all interfaces at `http://server-ip-or-domain:8008`. API requests enforce same-origin access using the request Host. HTTPS/localhost uses encrypted storage. Plain HTTP uses the example's plaintext storage, with a warning beside the title.

`sh examples/devnet/stop.sh` stops Fiber and CKB while keeping data. Use `sh examples/devnet/start.sh` to start again. As in fiber-lab, the startup script calls offckb directly; stop before restarting.

`sh examples/devnet/clean.sh` stops nodes and removes offckb data and this project's `.devnet/`. `sh examples/devnet/reset.sh` cleans, initializes with the configured `fnn`, and starts the environment.

The scripts save the operator token in `.devnet/keys/operator-token`. When using a custom offckb directory, use the same XDG environment variables for scripts and the example server. See the [devnet script guide](examples/devnet/README.md).

The page header shows CKB/LSP connection status, block height, user count, and an “Add user” dialog. Each of the two panels selects a user and runs an independent SDK client.

Demo steps:

1. Click “Add user” and enter a unique `name`. The display name follows it until you edit the display name directly. The form selects the lowest-numbered available offckb account by default, and you can select another available account. The backend rejects duplicate bindings.
2. Select a user in each panel. No login password is needed. Wallets use the bound offckb accounts' existing CKB without a faucet.
3. Click “Register tenant”, then “Open channel” in each panel. Enter a local contribution in CKB (default 1000), confirm, and wait for “Ready”. The LSP sets the minimum local contribution and supplies its own contribution from the current node configuration. The example automatically approves protocol signatures verified by the SDK. Funding, payment, and channel closing each require confirmation.
4. Enter a CKB amount on the receiving side, create an invoice, and copy it to the payer's input, or click “Fill other side”. Click “Pay invoice” on the paying side. Keep the page open until both records show “Complete” and check the balance changes. The maximum payment fee is 1 CKB. Amounts support up to 8 decimal places.
5. Refreshing restores both selected users, tenant identities, and payment records for the current tab. Close channels through “Account tools”; on-chain balances update after refunds are confirmed. Users without tenants can be deleted to release their bindings. Registered users keep their identities and bindings to protect recovery data.

User profiles are stored in `.devnet/example-users.json` (override with `EXAMPLE_USERS_FILE`). They contain names, public offckb wallet bindings, tenant IDs, and root public keys. Writes are serialized and replace the file atomically through a temporary file. Only one example server process may manage a file. Files are scoped to the chain genesis and LSP node identity. Use a new user file when rebuilding the devnet and keep old data needed for recovery.

Tenant keys, signing snapshots, and operation state are stored per user in IndexedDB. HTTPS/localhost uses the SDK's `BrowserStorage` to encrypt root private keys; plain HTTP uses the example's plaintext storage with a `-plaintext` database suffix. Payment records for display are stored in localStorage. For a local experience without passwords, the example uses a fixed, derivable development unlock password. **It provides no password protection and is for devnet use only.** offckb wallet private keys are read only for backend signing; they are never written to the user JSON or sent to the browser. Clearing browser data loses tenant keys, which the JSON user file cannot restore. Use the same browser and site address (`localhost` and `127.0.0.1` are different origins). Leaving one panel only hides it; started clients keep processing pending payments.

See [examples/README.md](examples/README.md) for integration details and [AccountSession](examples/business/account-session.ts) for the SDK lifecycle.

Directory layout:

- `examples/ui/` contains the page, styles, forms, and rendering. It calls the business layer for user and payment operations.
- `examples/business/` manages users and account sessions, integrates the SDK, and provides browser storage, chain, and funding wallet adapters.
- `examples/shared/` contains the request and response types shared with the backend.
- `examples/server/`: TypeScript HTTP backend, trusted configuration, JSON user storage, and offckb wallet verification and signing.
- `examples/devnet/`: offckb scripts to initialize, start, stop, clean, and reset the local environment.

`pnpm example` builds the SDK into `dist/`, compiles browser code into `.example/`, and runs the TypeScript backend directly. After browser changes, run `pnpm exec tsc -p examples/tsconfig.browser.json` and refresh. After backend changes, restart the example. App source files use `.ts`; environment scripts use `.sh`. The SDK's `.js` import suffixes and generated JavaScript follow ESM build conventions.

offckb defaults to CKB port `8114`, LSP HTTP `21716`, and WebSocket `21717`. The example page uses `8008`. `pnpm example:browser` is equivalent to `pnpm example`. The browser uses the same-origin `/devnet/ws` relay for subscriptions and RPC, with `/devnet/rpc` as the HTTP fallback, so node CORS needs no extra setup. The relay forwards only the browser's tenant credential. Existing browser tenants automatically adopt the configured WebSocket URL.

`pnpm test` runs the Node.js suite. It covers real Rust invoice and MuSig2 validation, channel opening and cooperative close, tamper rejection, lost payment responses, keysend correlation, recovery, cleanup, WebSocket reconnection, transactions, and encrypted storage. The tests use Rust-generated fixtures with local RPC and WebSocket servers. Fixture private keys are for tests only and must not hold real funds.

The examples support manual checks of payments between two users on a real LSP. Watchtower and on-chain withdrawals after forced closure are outside this version's public API.
