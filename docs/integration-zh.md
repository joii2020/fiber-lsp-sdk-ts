# 使用 TypeScript SDK 接入 Fiber LSP

浏览器和 Node.js 应用可以通过这个 SDK 连接启用了 LSP 的 Fiber 节点。SDK 管理租户身份，完成通道协议所需的签名，处理收付款，并在中断后恢复未完成的操作。应用需要提供租户注册后端、可信的 CKB 数据源和用于通道出资的钱包，并处理用户确认。

- [运行本地示例](#运行本地示例)
- [在应用中使用 SDK](#在应用中使用-sdk)
  - [创建 SDK 实例](#创建-sdk-实例)
  - [注册租户并创建客户端](#注册租户并创建客户端)
  - [订阅事件并同步界面](#订阅事件并同步界面)
  - [开启通道](#开启通道)
  - [创建账单并付款](#创建账单并付款)
  - [关闭通道](#关闭通道)
  - [恢复会话与释放资源](#恢复会话与释放资源)
- [参考代码](#参考代码)

## 运行本地示例

准备好 Node.js 24、pnpm 11.17.0 和 Rust，然后在 SDK 仓库根目录安装依赖和 WASM 工具链。

```sh
pnpm install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

### 准备 devnet 依赖

- **offckb** 用于运行本地 CKB 和 Fiber 节点。安装支持 `offckb fiber init --binary-path` 的版本。[offckb 安装说明](https://github.com/ckb-devrel/offckb#install)
- **biscuit-cli 0.6** 提供 `biscuit` 命令，初始化脚本用它生成 LSP operator token。[Biscuit CLI 安装说明](https://github.com/eclipse-biscuit/biscuit-cli#installation)
- **Fiber 源码**。示例所需的 LSP 暂无 release。请使用 devnet 指南指定的 Fiber 提交构建 `fnn`。[devnet 环境说明](../examples/devnet/README.md)

### 初始化和启动 devnet

初始化脚本默认使用 `../fiber/target/release/fnn`。如果二进制位于其他位置，在配置脚本中设置 `FNN_PATH`。[examples/devnet/config.sh](../examples/devnet/config.sh)

然后从 SDK 仓库根目录运行初始化脚本。

```sh
sh examples/devnet/init.sh
```

`init.sh` 会启动 CKB，用该二进制初始化三个 Fiber 节点，为 Node3 配置 LSP 并生成 operator token，最后启动 Fiber 节点。

停止后再次启动时，运行 `sh examples/devnet/start.sh`，沿用已有的节点配置和链数据。默认端口和脚本说明见 [devnet 环境说明](../examples/devnet/README.md)。

### 启动示例并完成付款

devnet 启动后，在 SDK 仓库根目录运行以下命令。示例服务会在前台运行。

```sh
pnpm example
```

1. 打开 <http://127.0.0.1:8008>，点击 **Add user** 添加两名用户，分别绑定一个未被占用的测试钱包。在两个面板中各选一名用户。
2. 在每个面板中依次点击 **Register tenant** 和 **Open channel**，确认出资金额。如果显示 **Resume opening**，点击它继续原操作。等两条通道都显示 **Ready**。
3. 在收款方的面板中点击 **Receive**，填写金额，再点击 **Create invoice**。复制生成的 invoice，然后在付款方的面板中点击 **Send**，粘贴并点击 **Pay invoice**。
4. 保持页面打开，直到这笔付款在两个面板的 **Payment activity** 中都显示为 **Complete**。

## 在应用中使用 SDK

下面以浏览器应用为例。每位应用用户使用自己的持久化存储和 `fiberlsp` 实例，再为要操作的租户创建 `FiberLspClient`。开通道、收款、付款和查询状态都通过租户客户端完成。构建本地 SDK 和加载 WASM 的要求见 [README 的构建说明](../README.md#build-and-check)。

升级到 V2 时，已有通道和未完成的开通操作继续使用旧版 SDK 管理。尚未生成通道密钥的租户可以沿用原身份。

### 创建 SDK 实例

```ts
import { BrowserStorage, FiberLspEvent, fiberlsp } from 'fiber-lsp-sdk';

const storage = new BrowserStorage({
  name: `fiber-lsp-${userId}`,
  onUnlock: ({ reason }) => requestStoragePassword(reason),
});
const lsp = new fiberlsp({ storage, chain, onConfirm: confirmOperation });
```

`userId` 是应用用户的稳定标识。再次打开应用时，同一用户沿用原来的存储名称。`onUnlock` 根据 `reason` 请求用户创建或输入密码。浏览器在 HTTPS 或 localhost 使用 `BrowserStorage` 持久化租户密钥、签名状态和待恢复的操作。Node.js 可以用 `MemoryStorage` 做临时测试，需要跨进程重启恢复时则提供持久化的 `Storage`，保证提交的原子性和 `withLock` 的互斥。 [Storage 接口](../src/storage.ts)

`chain` 实现 `ChainProvider`，供 SDK 独立核验通道的链上出资和退款。应用从可信的 CKB 数据源读取以下信息。查不到交易或 Cell 时返回 `null`。 [示例的 CKB 查询适配器](../examples/business/connection.ts)

- `getTransaction` 返回已确认的完整交易。
- `getLiveCell` 返回当前未花费的 Cell。
- `getCell` 返回交易输入引用的 Cell，包括已被花费的 Cell。
- `getMedianTime` 返回可信 CKB 节点的链上中位时间，格式为十六进制 Unix 毫秒值。支持收款的应用需要提供此方法。示例从 CKB 的 `get_blockchain_info` 读取 `median_time`。

`confirmOperation` 根据 `request.kind` 和 `request.details` 展示开通道、付款或关闭通道的内容，并返回用户是否同意。将 `signingPolicy` 设为 `'manual'` 时，也要处理 `kind: 'sign'` 的协议签名请求。

### 注册租户并创建客户端

首次为用户创建租户时，调用 `setup()`。应用提供 `FiberLspConfig`，其中 `rpcUrl`、`nodePublicKey` 和 `network` 来自可信配置。`network` 包含对应网络的锁脚本、交易依赖项和费用参数，`currency` 在主网、测试网和 devnet 分别为 `Fibb`、`Fibt` 和 `Fibd`。可选的 `wsUrl` 用于接收签名请求和发送 RPC。WebSocket 不可用时，SDK 可以通过 HTTP 发送后续请求。

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

`registerTenantThroughBackend` 实现 `TenantRegistration.register`。它把 SDK 生成的注册证明交给应用后端。后端验证当前用户，用服务端保存的 operator token 申请租户访问令牌，再将 `{ tenant, access_token, expires_at_ms }` 返回给 SDK。`expires_at_ms` 是十六进制 Unix 毫秒时间戳。注册和刷新令牌复用这个流程。 [示例的注册后端](../examples/server/registration.ts)

SDK 在发送注册证明前保存租户身份，核验后端响应后才将 `TenantInfo.ready` 设为 `true`。应用可以记录用户选中的 `tenantId`，下次打开时按这个 ID 恢复会话。

### 订阅事件并同步界面

`createClient()` 返回时会在后台启动恢复。应用先订阅事件，再查询通道和本地付款记录。下面的更新函数由应用实现。

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

查询结果和事件使用相同的 `ChannelInfo` 和 `PaymentInfo` 类型。合并状态时，用 `operationId` 识别同一条记录，保留 `version` 较大的记录。界面需要显示连接状态时，可以订阅 `ConnectionChanged`。

### 开启通道

```ts
const opening = await client.openChannel({ wallet });
```

把返回的 `opening` 交给界面，用 `operationId` 关联后续的 `ChannelChanged` 事件。拿到 `channelId` 且 `ready === true` 时，再启用收付款功能。此时节点已确认通道就绪，SDK 也已核验链上出资交易和用于恢复通道的本地签名。

传入的 `wallet` 实现 `FundingWallet`，负责确认出资条件和签署属于用户钱包的交易输入。 [示例的出资钱包适配器](../examples/business/connection.ts)

- `getFundingTerms` 返回双方的出资金额、退款脚本和费用上限等参数。
- `verifyFunding` 核对双方出资、输入归属、找零和费用。核验通过后，按交易顺序返回全部输入的 `OutPoint`。
- `signFundingTransaction` 仅为属于该钱包的交易输入签名，并保留原始交易结构。

SDK 会等双方交换 V2 承诺签名，并核验完整的本地承诺交易，再调用钱包签署资金交易。如果初始签名还在进行，`openChannel()` 可能返回 `needsWallet: true`。用原来出资的钱包再次调用 `openChannel({ wallet })`，继续同一操作。要为已有通道的租户再开一条通道，传入 `newChannel: true`。如果该租户还有正在开启的通道，SDK 会先恢复原操作。

### 创建账单并付款

付款方和收款方各自选择一条已就绪的通道。付款方通过 `localBalance` 确认可用余额，收款方通过 `remoteBalance` 确认可收款额度。

下面的 `receiver` 和 `payer` 是收款方和付款方各自的客户端。示例金额为 1 CKB，即 100,000,000 shannons。SDK 以 `bigint` 表示金额和手续费，通过 JSON 传输时应先转换成字符串。

```ts
// 收款方创建 invoice，并把它发给付款方。
const { invoice } = await receiver.createInvoice({
  channelId: receivingChannelId,
  amount: 100_000_000n,
});

// 付款方使用自己的通道，maxFee 是应用允许的手续费上限。
const { paymentHash } = payer.parseInvoice(invoice);
const payment = await payer.payInvoice({
  channelId: sendingChannelId,
  invoice,
  maxFee: 1_000_000n,
});
```

付款方用 `payInvoice()` 返回的记录和 `PaymentChanged` 更新界面，收款方通过 `InvoiceChanged` 跟踪账单。收款方需保持客户端运行，直到 SDK 完成这笔收款的签名和结算。

`complete === true` 表示 SDK 已完成本地处理。成功、失败或过期的记录都可能达到这个状态。**确认付款成功时，同时检查 `complete === true` 和 `status`。** 付款方检查 `status === 'Success'`，收款方检查 `status === 'Paid'`。

在 `confirmOperation` 中处理 `request.kind === 'payInvoice'` 时，用 `request.details.amount` 和 `request.details.feeBudget` 向用户展示金额和即将授权的手续费上限。确认回调在租户的操作锁内运行。等当前操作结束后，再调用 `listChannels()` 或 `getPayment()` 更新状态。

主动查询付款状态时，调用 `payer.getPayment({ paymentHash, direction: 'outgoing' })`。收款方用自己的客户端查询，将 `direction` 设为 `'incoming'`。离线时用 `listPayments()` 读取本地记录。开始下一笔收付款前，先等同一租户上一笔付款或账单处理完毕。

等待付款期间，同一租户的每种资产应只有一条通道可用于收款。LSP 在收到付款时选择收款通道，暂时离线或正在开启的通道届时也可能可用。若所选通道不可用，或节点还有其他可能接收同种资产的通道，`createInvoice()` 会抛出 `CONFLICT`。

也可以用 `keysend()` 指定目标节点的公钥直接付款。恢复期间 `paymentHash` 可能暂时为空，因此用 `operationId` 跟踪这笔付款。

### 关闭通道

通道已就绪且双方完成结算后，调用 `client.closeChannel(channelId)`。订阅 `ChannelChanged` 或调用 `listChannels()`，直到 `closed === true`。这表示 SDK 已在链上核验双方的退款。退款按开启通道时确认的脚本执行。

### 恢复会话与释放资源

#### 页面刷新或进程重启

用原来的持久化存储创建 SDK 实例，再调用 `lsp.listTenants()`。按保存的 `tenantId` 找到租户。凭据可用时，直接调用 `lsp.createClient(tenantId)`，并重新订阅事件和加载状态。

#### 注册中断或访问令牌失效

`TenantInfo.ready` 记录注册是否完成。用 `credentialStatus` 判断下一步。`unregistered` 表示注册待完成，`available` 表示凭据可用，`refreshRequired` 表示需要刷新。收到 `AUTH` 错误后，用 `listTenants()` 重新读取状态。

继续注册或刷新时，从 `listTenants()` 找到原来的租户记录 `savedTenant`，将它的 ID 和 LSP 配置传回 `setup()`。主动刷新可用令牌时，加上 `refresh: true`。

```ts
await lsp.setup({
  tenantId: savedTenant.tenantId,
  fiberLsp: savedTenant.fiberLsp,
  registration,
});
```

#### 付款请求超时或连接中断

用原来的 `paymentHash` 调用 `getPayment()`，或者用 `listPayments()` 找到原记录并等待事件更新。SDK 会核对已发出的请求并恢复原操作。界面此时应继续显示同一笔付款的进度。

#### 解锁存储与结束会话

用户解锁存储后，调用 `client.listChannels()` 恢复后台处理。如需迁移 V2 签名存储，先停止使用源存储的所有客户端，再调用 `storage.exportBackup(password)` 导出最新状态。用 `importBackup(backup, password)` 导入后，只从目标存储恢复签名。回滚旧状态或让同一个签名器的两份存储同时写入，可能导致 MuSig2 nonce 重用并泄露通道资金密钥。

页面组件卸载时，调用 `stopListeners` 中的每个函数取消订阅。客户端会继续处理签名和未完成的操作。应用会话结束时，调用 `await lsp.cleanup(tenant.tenantId)` 停止该租户的客户端。使用 `BrowserStorage` 时，等共享这份存储的客户端全部停止，再调用 `await storage.close()`。

## 参考代码

| 内容                             | 文件                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| 创建实例、注册、处理事件和结束会话 | [examples/business/account-session.ts](../examples/business/account-session.ts) |
| 浏览器 RPC、CKB 查询和钱包适配器 | [examples/business/connection.ts](../examples/business/connection.ts)           |
| 注册后端与访问令牌刷新           | [examples/server/registration.ts](../examples/server/registration.ts)           |
| SDK 类型、事件和错误码           | [src/types.ts](../src/types.ts) · [src/errors.ts](../src/errors.ts)             |
