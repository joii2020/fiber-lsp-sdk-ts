# Fiber LSP SDK for TypeScript

A TypeScript SDK for connecting browser and Node.js apps to Fiber LSP. It handles tenant registration, payment channels, sending and receiving payments, and recovery of interrupted operations.

## Install

```sh
npm install fiber-lsp-sdk
```

Node.js apps require Node.js 24 or later.

## Quick start

Provide your LSP configuration, a trusted CKB chain provider, and callbacks for user confirmation and backend registration. This browser example uses `BrowserStorage` on HTTPS or localhost.

```ts
import { BrowserStorage, fiberlsp } from 'fiber-lsp-sdk';

const storage = new BrowserStorage({ onUnlock: requestStoragePassword });
const lsp = new fiberlsp({ storage, chain, onConfirm: confirmOperation });

const tenant = await lsp.setup({
  fiberLsp: { rpcUrl, nodePublicKey, network },
  registration: { register: registerTenantThroughBackend },
});
const client = lsp.createClient(tenant.tenantId);
console.log(await client.listChannels());
```

Open a channel with `client.openChannel({ wallet })`. Once it is ready, use `client.createInvoice` to receive a payment or `client.payInvoice` to send one.

[中文接入指南](docs/integration-zh.md) · [Local demo](examples/README.md)
