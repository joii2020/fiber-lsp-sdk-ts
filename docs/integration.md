# Integrate Fiber LSP with the TypeScript SDK

Browser and Node.js apps can use this SDK to connect to a Fiber node with LSP enabled. The SDK manages tenant identities, handles signing for the channel protocol, sends and receives payments, and resumes unfinished operations after an interruption. Your app provides a backend endpoint for tenant registration, a trusted source of CKB data, and a wallet to fund channels. It also asks users to confirm operations.

- [Run the local example](#run-the-local-example)
- [Use the SDK in your app](#use-the-sdk-in-your-app)
  - [Create an SDK instance](#create-an-sdk-instance)
  - [Register a tenant and create a client](#register-a-tenant-and-create-a-client)
  - [Subscribe to events and update the UI](#subscribe-to-events-and-update-the-ui)
  - [Open a channel](#open-a-channel)
  - [Create and pay an invoice](#create-and-pay-an-invoice)
  - [Close a channel](#close-a-channel)
  - [Restore a session and release resources](#restore-a-session-and-release-resources)
- [Reference code](#reference-code)

## Run the local example

You need Node.js 24, pnpm 11.17.0, and Rust. Run these commands from the SDK repository root to install the dependencies and the WASM toolchain.

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

Install a version of offckb that supports `offckb fiber init --binary-path` and install biscuit-cli 0.6. Then follow the devnet guide to build `fnn`. [offckb installation](https://github.com/ckb-devrel/offckb#install) · [Biscuit CLI installation](https://github.com/eclipse-biscuit/biscuit-cli#installation) · [Devnet guide](../examples/devnet/README.md)

The first time you run the example, start devnet and then start the example from the SDK repository root.

```sh
sh examples/devnet/init.sh
pnpm example
```

After devnet stops, run `sh examples/devnet/start.sh` to start it again with the existing configuration and chain data.

### Make a payment

1. Open <http://127.0.0.1:8008> and click **Add user** to add two users. Assign each user an unused test wallet. Select one user in each panel.
2. In each panel, click **Register tenant**, then click **Open channel** and confirm the funding amount. If you see **Resume opening**, click it to continue. Wait until both channels show **Ready**.
3. In the receiver's panel, click **Receive**, enter an amount, and click **Create invoice**. Copy the invoice. In the payer's panel, click **Send**, paste the invoice, and click **Pay invoice**.
4. Keep the page open until the payment shows **Complete** under **Payment activity** in both panels.

## Use the SDK in your app

This example uses a browser app. Create separate persistent storage and a separate `fiberlsp` instance for each app user. Then create a `FiberLspClient` for the tenant the user selects.

To build the SDK from source, follow the [local example setup](#run-the-local-example) to install the dependencies and WASM toolchain, then run `pnpm build`. When you deploy, publish `dist/wasm/` alongside the generated JavaScript and serve `.wasm` files with the `application/wasm` MIME type. The browser must support ESM, top-level `await`, BigInt, Web Crypto, IndexedDB, and Web Locks.

After upgrading to V2, keep using the older SDK to manage channels that were already open or still opening before the upgrade. Tenants that have yet to generate channel keys can keep their existing identities.

### Create an SDK instance

```ts
import { BrowserStorage, FiberLspEvent, fiberlsp } from 'fiber-lsp-sdk';

const storage = new BrowserStorage({
  name: `fiber-lsp-${userId}`,
  onUnlock: ({ reason }) => requestStoragePassword(reason),
});
const lsp = new fiberlsp({ storage, chain, onConfirm: confirmOperation });
```

`userId` is the user's stable ID in your app. Use the same storage name when the user opens the app again. In `onUnlock`, use `reason` to ask the user to set or enter a password. On HTTPS pages or localhost, use `BrowserStorage` to keep tenant keys, signing state, and unfinished operations.

In Node.js, you can use `MemoryStorage` for temporary tests. To recover state after a process restart, implement a persistent `Storage`. `commit` must apply all changes atomically. When multiple instances share the same storage, `withLock` must allow only one caller at a time to hold a lock with a given name, even across processes or browser tabs. [Storage interface](../src/storage.ts)

`chain` implements `ChainProvider`. The SDK uses it to independently verify channel funding and refunds on chain. Your app reads the following data from a trusted CKB source. Return `null` if the transaction or Cell cannot be found. [Example CKB adapter](../examples/business/connection.ts)

- `getTransaction` returns the full committed transaction.
- `getLiveCell` returns the Cell if it is still unspent.
- `getCell` returns the Cell referenced by a transaction input, even if that Cell has already been spent.
- `getMedianTime` returns the median block timestamp from a trusted CKB node as a hex string in milliseconds. Apps that receive payments must implement this method. The example reads `median_time` from CKB's `get_blockchain_info` response.

`confirmOperation` uses `request.kind` and `request.details` to show the operation details and returns whether the user approves. If you set `signingPolicy` to `'manual'`, also handle protocol signing requests with `kind: 'sign'`.

### Register a tenant and create a client

To register a new tenant for a user, call `setup()`. Your app supplies a `FiberLspConfig` with `rpcUrl`, `nodePublicKey`, and `network` from trusted configuration. `network` includes the lock scripts, transaction dependencies, and fee settings for the network. Set `currency` to `Fibb` for mainnet, `Fibt` for testnet, or `Fibd` for devnet. You can set `wsUrl` to receive signing requests and make RPC calls over WebSocket. If WebSocket is unavailable, the SDK can send subsequent requests over HTTP.

```ts
const registration = {
  register: registerTenantThroughBackend,
};
const tenant = await lsp.setup({
  fiberLsp: { rpcUrl, nodePublicKey, network },
  registration,
});
const client = lsp.createClient(tenant.tenantId);
```

`registerTenantThroughBackend` implements `TenantRegistration.register` and sends the registration proof generated by the SDK to your backend. In production, the backend identifies the current user from the authenticated session, links the tenant to that user during registration, and checks that the tenant belongs to the user before refreshing a token. The backend uses the LSP operator token stored on the server to request a tenant access token and returns `{ tenant, access_token, expires_at_ms }`. `expires_at_ms` is a Unix timestamp in milliseconds, encoded as a hex string.

The local devnet route reads `userId` from the request body to select a test user. [Devnet registration route](../examples/server/index.ts) · [Example tenant token request](../examples/server/registration.ts)

Save the selected `tenantId` so you can restore the session later.

### Subscribe to events and update the UI

After you create a client, the SDK resumes unfinished operations in the background. Subscribe to events before loading channels and local payment records. Your app supplies the update functions below.

```ts
const stopListeners = [
  client.on(FiberLspEvent.ChannelChanged, updateChannel),
  client.on(FiberLspEvent.BalanceChanged, updateChannel),
  client.on(FiberLspEvent.PaymentChanged, updatePayment),
  client.on(FiberLspEvent.InvoiceChanged, updatePayment),
  client.on(FiberLspEvent.Error, reportError),
];

for (const channel of await client.listChannels()) updateChannel(channel);
for (const payment of await client.listPayments()) updatePayment(payment);
```

Channel queries and channel events provide `ChannelInfo`. Payment and invoice records and their update events use `PaymentInfo`. When a query result and an event have the same `operationId`, keep the record with the higher `version`. To show the connection status in the UI, subscribe to `ConnectionChanged`.

### Open a channel

```ts
const opening = await client.openChannel({ wallet });
```

Use the returned `opening` record to show the channel status. Match later `ChannelChanged` events to the record by `operationId`. Enable payments once the record has a `channelId` and `ready === true`. At that point, the node has confirmed that the channel is ready, and the SDK has verified the on-chain funding transaction and the local signature used to recover the channel.

The `wallet` implements `FundingWallet`. It approves the funding terms and signs the transaction inputs it controls. [Example `FundingWallet` implementation](../examples/business/connection.ts)

- `getFundingTerms` returns both parties' contributions, the refund script, fee limits, and other funding terms.
- `verifyFunding` checks both contributions, input ownership, change, and fees. If the checks pass, return the `OutPoint` for every input in transaction order.
- `signFundingTransaction` signs only the inputs the wallet controls and preserves the raw transaction.

After both parties exchange signatures for the V2 commitment transactions, the SDK verifies the fully signed local commitment transaction before asking the wallet to sign the funding transaction.

- If the result has `needsWallet: true`, call `openChannel({ wallet })` again with the same wallet to resume opening the channel.
- To open another channel, pass `newChannel: true`. The SDK resumes any channel that is still opening first.

### Create and pay an invoice

The `payer` and `receiver` clients belong to two different registered tenants. Pass the receiver's ready channel ID to `createInvoice()` and the payer's to `payInvoice()`. The payer uses `localBalance` to check how much it can spend. The receiver uses `remoteBalance` to check how much it can receive.

The example amount is 1 CKB, or 100,000,000 shannons. The SDK uses `bigint` for amounts and fees. Convert them to strings before sending them as JSON.

```ts
// The receiver creates an invoice and sends it to the payer.
const { invoice } = await receiver.createInvoice({
  channelId: receivingChannelId,
  amount: 100_000_000n,
});

// The payer uses its own channel. maxFee is the highest fee the app allows.
const { paymentHash } = payer.parseInvoice(invoice);
const payment = await payer.payInvoice({
  channelId: sendingChannelId,
  invoice,
  maxFee: 1_000_000n,
});
```

The payer updates the UI using the record returned by `payInvoice()` and `PaymentChanged` events. The receiver tracks the invoice through `InvoiceChanged` events. The receiver must keep its client running until the SDK finishes signing and settling the payment.

`complete === true` means the SDK has finished processing the record locally. Successful, failed, and expired records can all reach this state. **To confirm success, check both `complete === true` and `status`.** The payer checks for `status === 'Success'`. The receiver checks for `status === 'Paid'`.

When `confirmOperation` handles `request.kind === 'payInvoice'`, show the user the payment amount and maximum fee from `request.details.amount` and `request.details.feeBudget`. The SDK holds the tenant's operation lock when it calls the confirmation callback. Wait until the callback returns and the operation finishes before calling `listChannels()` or `getPayment()` to update the status.

The payer can check the status with `payer.getPayment({ paymentHash, direction: 'outgoing' })`. The receiver uses its own client with `direction: 'incoming'`. When offline, use `listPayments()` to read local records.

Before sending another payment or creating another invoice, wait until all payment and invoice records for that tenant have `complete === true`.

While waiting for a payment, make sure the tenant has only one channel that can receive payments for any given asset. The LSP chooses the channel when it receives the payment. A channel that is temporarily offline or still opening may be available by then.

If the selected channel is not ready, `createInvoice()` throws `NOT_READY`. Once the channel passes that check, the SDK looks at the channels the LSP returned for that tenant. It keeps channels for the same asset and skips those that are closing or closed. It throws `CONFLICT` if the selected channel is missing from that list or if the list includes another channel.

You can also call `keysend()` to pay a node directly using its public key.

### Close a channel

Once the channel is ready and both sides have settled all pending payments, call `client.closeChannel(channelId)`. Subscribe to `ChannelChanged` or call `listChannels()` periodically to track the closing progress. `closed === true` means the SDK has verified both refunds on chain. The refunds use the scripts approved when the channel was opened.

### Restore a session and release resources

#### After a page refresh or process restart

Create an SDK instance with the same persistent storage. Call `lsp.listTenants()` and find the tenant by the saved `tenantId`. If its `credentialStatus` is `available`, call `lsp.createClient(tenantId)`, then subscribe to events and load the current state.

#### If registration is interrupted or the access token becomes invalid

The SDK saves the tenant identity before sending the registration proof. It sets `TenantInfo.ready` to `true` only after verifying the backend response. The first `setup()` call can fail while contacting your backend, before your app receives the `tenantId`. With the same storage, call `listTenants()` and find the `unregistered` record for that registration attempt.

If you need to save the ID ahead of time, first call `beginRegistration({ fiberLsp })` to create the local record. Save the returned `tenantId`, then pass it to `setup()`.

`available` means the SDK has saved credentials and has yet to mark them for refresh. After a token expires, `credentialStatus` can stay `available` until the LSP rejects a request. After an `AUTH` error, call `listTenants()` to read `credentialStatus` again.

To resume registration, pass the ID and LSP configuration from the existing tenant record, `savedTenant`, to `setup()`. Follow the same steps when `credentialStatus` is `refreshRequired`. To refresh the token on demand, also pass `refresh: true`.

```ts
await lsp.setup({
  tenantId: savedTenant.tenantId,
  fiberLsp: savedTenant.fiberLsp,
  registration,
});
```

#### If a payment request times out or the connection drops

After a timeout or disconnect, if you already have the `paymentHash`, use it to look up the existing record as described in [Create and pay an invoice](#create-and-pay-an-invoice).

`keysend()` may throw before returning a result. Save `request.operationId` when `onConfirm` receives `kind: 'keysend'`, then use that ID to find the original record in `listPayments()`. If the LSP cannot find a matching payment, the record may stay `Unknown`. The UI can show that status and use `PaymentChanged` to receive later updates.

#### Unlock storage and end the session

After the user unlocks storage, call `client.listChannels()` to resume background processing.

To move a V2 tenant's keys and signing state, stop all clients using the current storage, then call `storage.exportBackup(password)` to export the latest state. Call `importBackup(backup, password)` on the new storage, and use only the new storage for signing from then on. Restoring an older state or using two copies of the same signing state at once can cause MuSig2 nonce reuse, which can expose the private key that controls the channel funds.

When a UI component unmounts, call each function in `stopListeners` to unsubscribe. The client continues handling signing and unfinished operations. When the app session ends, call `await lsp.cleanup(tenant.tenantId)` to stop that tenant's client. If you use `BrowserStorage`, wait until all clients sharing it have stopped, then call `await storage.close()`.

## Reference code

| Topic                                                | File                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| SDK setup, registration, event handling, and cleanup | [examples/business/account-session.ts](../examples/business/account-session.ts) |
| Browser RPC, CKB queries, and wallet adapter         | [examples/business/connection.ts](../examples/business/connection.ts)           |
| Backend registration and access token refresh        | [examples/server/registration.ts](../examples/server/registration.ts)           |
| SDK types, events, and error codes                   | [src/types.ts](../src/types.ts) · [src/errors.ts](../src/errors.ts)             |
