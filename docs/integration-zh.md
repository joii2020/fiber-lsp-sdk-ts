# 使用 TypeScript SDK 接入 Fiber LSP

浏览器和 Node.js 应用可以通过这个 SDK 连接启用了 LSP 的 Fiber 节点。SDK 管理租户身份，完成通道协议所需的签名，处理收付款，并在中断后恢复未完成的操作。应用需要提供处理租户注册的后端接口、可信的 CKB 数据源和用于通道出资的钱包，并处理用户确认。

- [运行本地示例](#运行本地示例)
- [在应用中使用 SDK](#在应用中使用-sdk)
  - [创建 SDK 实例](#创建-sdk-实例)
  - [注册租户并创建客户端](#注册租户并创建客户端)
  - [订阅事件并同步界面](#订阅事件并同步界面)
  - [开通通道](#开通通道)
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

安装支持 `offckb fiber init --binary-path` 的 offckb 和 biscuit-cli 0.6，再按 devnet 指南构建 `fnn`。[offckb 安装说明](https://github.com/ckb-devrel/offckb#install) · [Biscuit CLI 安装说明](https://github.com/eclipse-biscuit/biscuit-cli#installation) · [devnet 指南](../examples/devnet/README.md)

首次运行时，在 SDK 仓库根目录启动 devnet，再启动示例。

```sh
sh examples/devnet/init.sh
pnpm example
```

devnet 停止后，运行 `sh examples/devnet/start.sh` 重启。脚本会沿用原配置和链数据。

### 完成一笔付款

1. 打开 <http://127.0.0.1:8008>，点击 **Add user** 添加两名用户，分别绑定一个未被占用的测试钱包。在两个面板中各选一名用户。
2. 两侧各点击 **Register tenant**，再点击 **Open channel** 并确认出资金额。若显示 **Resume opening**，点击它继续。等两条通道都显示 **Ready**。
3. 收款方点击 **Receive**，填写金额后点击 **Create invoice**。复制账单（invoice）。付款方点击 **Send**，粘贴账单后点击 **Pay invoice**。
4. 保持页面打开，直到这笔付款在两侧的 **Payment activity** 中都显示为 **Complete**。

## 在应用中使用 SDK

下面以浏览器应用为例。为每位应用用户创建独立的持久化存储和 `fiberlsp` 实例，再为用户选中的租户创建 `FiberLspClient`。

从源码构建 SDK 时，按[本地示例的准备步骤](#运行本地示例)安装依赖和 WASM 工具链，再运行 `pnpm build`。部署时，将 `dist/wasm/` 与生成的 JavaScript 一起发布，并为 `.wasm` 文件设置 `application/wasm` MIME 类型。浏览器需支持 ESM、顶层 `await`、BigInt、Web Crypto、IndexedDB 和 Web Locks。

升级到 V2 后，此前已开通或仍在开通的通道须继续用旧版 SDK 管理。尚未生成通道密钥的租户可以沿用原身份。

### 创建 SDK 实例

```ts
import { BrowserStorage, FiberLspEvent, fiberlsp } from 'fiber-lsp-sdk';

const storage = new BrowserStorage({
  name: `fiber-lsp-${userId}`,
  onUnlock: ({ reason }) => requestStoragePassword(reason),
});
const lsp = new fiberlsp({ storage, chain, onConfirm: confirmOperation });
```

`userId` 是用户在应用中固定的 ID。同一用户再次打开应用时，沿用原来的存储名称。`onUnlock` 根据 `reason` 提示用户设置或输入密码。在 HTTPS 页面或 localhost 上，使用 `BrowserStorage` 保存租户密钥、签名状态和未完成的操作。

在 Node.js 中，可以用 `MemoryStorage` 做临时测试。如果需要在进程重启后恢复状态，请实现持久化的 `Storage`。`commit` 必须以原子方式提交。多个实例共享同一存储时，`withLock` 必须保证同名锁互斥。这个要求同样适用于跨进程和跨标签页的调用。 [Storage 接口](../src/storage.ts)

`chain` 实现 `ChainProvider`，供 SDK 独立核验通道的链上出资和退款。应用从可信的 CKB 数据源读取以下信息。查不到交易或 Cell 时返回 `null`。 [示例的 CKB 查询适配器](../examples/business/connection.ts)

- `getTransaction` 返回已确认的完整交易。
- `getLiveCell` 返回当前未花费的 Cell。
- `getCell` 返回交易输入引用的 Cell，包括已被花费的 Cell。
- `getMedianTime` 返回可信 CKB 节点提供的区块时间戳中位数，以十六进制字符串表示，单位为毫秒。支持收款的应用需要实现此方法。示例从 CKB 的 `get_blockchain_info` 读取 `median_time`。

`confirmOperation` 根据 `request.kind` 和 `request.details` 向用户展示操作详情，并返回用户是否同意。将 `signingPolicy` 设为 `'manual'` 时，也要处理 `kind: 'sign'` 的协议签名请求。

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

`registerTenantThroughBackend` 实现 `TenantRegistration.register`，把 SDK 生成的注册证明交给应用后端。正式接入时，后端从已认证的会话确定当前用户，注册时绑定租户，刷新令牌前核对租户归属。后端用保存在服务端的 LSP 运营方令牌（operator token）申请租户访问令牌，并返回 `{ tenant, access_token, expires_at_ms }`。`expires_at_ms` 是以毫秒为单位的 Unix 时间戳，用十六进制字符串表示。

本地 devnet 路由从请求体读取 `userId`，用于选择测试用户。 [devnet 注册路由](../examples/server/index.ts) · [申请租户令牌的示例](../examples/server/registration.ts)

保存用户选中的 `tenantId`，以便下次恢复会话。

### 订阅事件并同步界面

创建客户端后，SDK 会在后台恢复未完成的操作。先订阅事件，再查询通道和本地付款记录。下面的更新函数由应用实现。

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

通道查询和通道事件都提供 `ChannelInfo`，付款和账单记录及其更新事件都使用 `PaymentInfo`。如果查询结果和事件中的 `operationId` 相同，保留 `version` 较大的记录。要在界面显示连接状态，可以订阅 `ConnectionChanged`。

### 开通通道

```ts
const opening = await client.openChannel({ wallet });
```

用返回的 `opening` 显示通道状态，再按 `operationId` 将后续的 `ChannelChanged` 事件与这条记录对应起来。取得 `channelId` 且 `ready === true` 后，再启用收付款功能。此时节点已确认通道就绪，SDK 也已核验链上出资交易和用于恢复通道的本地签名。

传入的 `wallet` 实现 `FundingWallet`，负责确认出资条件，并为该钱包控制的交易输入签名。 [FundingWallet 实现示例](../examples/business/connection.ts)

- `getFundingTerms` 返回双方的出资金额、退款脚本和费用上限等参数。
- `verifyFunding` 核对双方出资、输入归属、找零和费用。核验通过后，按交易顺序返回全部输入的 `OutPoint`。
- `signFundingTransaction` 仅为属于该钱包的交易输入签名，并保留原始交易结构。

双方交换 V2 承诺交易的签名后，SDK 核验完整的本地承诺交易，再调用钱包为出资交易签名。

- 返回 `needsWallet: true` 时，用原钱包再次调用 `openChannel({ wallet })`，继续开通。
- 要再开一条通道，传入 `newChannel: true`。SDK 会先处理尚在开通的通道。

### 创建账单并付款

本示例用两个不同的已注册租户。`payer` 和 `receiver` 分别是付款方和收款方的客户端。调用时传入各自已就绪的通道 ID。付款方用 `localBalance` 确认可用余额，收款方用 `remoteBalance` 确认可收款额度。

示例金额为 1 CKB，即 100,000,000 shannons。SDK 以 `bigint` 表示金额和手续费，通过 JSON 传输时应先转换成字符串。

```ts
// 收款方创建账单，并把它发给付款方。
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

在 `confirmOperation` 中处理 `request.kind === 'payInvoice'` 时，用 `request.details.amount` 和 `request.details.feeBudget` 向用户展示付款金额和这笔付款的手续费上限。SDK 在持有该租户的操作锁时调用确认回调。等回调返回且当前操作结束后，再调用 `listChannels()` 或 `getPayment()` 更新状态。

付款方可调用 `payer.getPayment({ paymentHash, direction: 'outgoing' })` 查询状态。收款方用自己的客户端查询，将 `direction` 设为 `'incoming'`。离线时用 `listPayments()` 读取本地记录。

发起下一笔付款或创建新账单前，先等同一租户所有付款和账单记录的 `complete` 都变为 `true`。

等待付款期间，同一租户的每种资产应只有一条通道可用于收款。LSP 在收到付款时选择通道，暂时离线或仍在开通的通道届时也可能可用。

所选通道尚未就绪时，`createInvoice()` 会抛出 `NOT_READY`。通过就绪检查后，SDK 从 LSP 返回的该租户通道中筛选同种资产的通道，排除正在关闭或已关闭的通道。如果所选通道不在筛选结果中，或结果中还有其他通道，SDK 会抛出 `CONFLICT`。

也可以用 `keysend()` 指定目标节点的公钥直接付款。

### 关闭通道

通道已就绪且双方完成结算后，调用 `client.closeChannel(channelId)`。订阅 `ChannelChanged` 或定期调用 `listChannels()` 跟踪关闭进度。`closed === true` 表示 SDK 已核验双方的链上退款。退款使用开通通道时确认的脚本。

### 恢复会话与释放资源

#### 页面刷新或进程重启

用原来的持久化存储创建 SDK 实例，再调用 `lsp.listTenants()`，按保存的 `tenantId` 找到租户。若 `credentialStatus` 为 `available`，调用 `lsp.createClient(tenantId)`，再订阅事件并加载状态。

#### 注册中断或访问令牌失效

SDK 在发送注册证明前保存租户身份，核验后端响应后才将 `TenantInfo.ready` 设为 `true`。首次 `setup()` 若在请求后端时失败，应用可能还没拿到 `tenantId`。这时用 `listTenants()` 在原存储中找到本次注册对应的 `unregistered` 记录。

需要提前记录 ID 时，先用 `beginRegistration({ fiberLsp })` 创建本地记录，保存返回的 `tenantId`，再带上该 ID 调用 `setup()`。

`available` 表示 SDK 已保存凭据，且尚未将其标记为需要刷新。即使令牌已经过期，在 LSP 拒绝请求前，`credentialStatus` 仍可能是 `available`。收到 `AUTH` 错误后，用 `listTenants()` 重新读取 `credentialStatus`。

要继续注册，或在 `credentialStatus` 为 `refreshRequired` 时刷新令牌，请将原租户记录 `savedTenant` 的 ID 和 LSP 配置传给 `setup()`。需要主动刷新令牌时，加上 `refresh: true`。

```ts
await lsp.setup({
  tenantId: savedTenant.tenantId,
  fiberLsp: savedTenant.fiberLsp,
  registration,
});
```

#### 付款请求超时或连接中断

超时或断线后，若已有 `paymentHash`，按[付款章节](#创建账单并付款)的查询方式跟踪原记录。

`keysend()` 可能在返回结果前抛错。可在 `onConfirm` 收到 `kind: 'keysend'` 时保存 `request.operationId`，再按该 ID 从 `listPayments()` 的结果中查找原记录。若 LSP 查不到匹配的付款，记录可能保持 `Unknown`，界面可以显示该状态并通过 `PaymentChanged` 接收后续更新。

#### 解锁存储与结束会话

用户解锁存储后，调用 `client.listChannels()` 恢复后台处理。

如果要迁移 V2 租户的密钥和签名状态，先停止所有使用原存储的客户端，再调用 `storage.exportBackup(password)` 导出最新状态。在新存储上调用 `importBackup(backup, password)` 导入后，只使用新存储继续签名。回滚到旧状态，或同时使用同一签名状态的两份副本，都可能导致 MuSig2 nonce 重复使用，进而泄露控制通道资金的私钥。

页面组件卸载时，调用 `stopListeners` 中的每个函数取消订阅。客户端会继续处理签名和未完成的操作。应用会话结束时，调用 `await lsp.cleanup(tenant.tenantId)` 停止该租户的客户端。使用 `BrowserStorage` 时，等共享这份存储的客户端全部停止，再调用 `await storage.close()`。

## 参考代码

| 内容                             | 文件                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| 创建实例、注册、处理事件和结束会话 | [examples/business/account-session.ts](../examples/business/account-session.ts) |
| 浏览器 RPC、CKB 查询和钱包适配器 | [examples/business/connection.ts](../examples/business/connection.ts)           |
| 注册后端与访问令牌刷新           | [examples/server/registration.ts](../examples/server/registration.ts)           |
| SDK 类型、事件和错误码           | [src/types.ts](../src/types.ts) · [src/errors.ts](../src/errors.ts)             |
