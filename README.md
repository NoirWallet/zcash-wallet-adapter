# Noir Zcash Wallet Adapter

这是一个面向 **Zcash** 的浏览器钱包 Adapter。它按照“核心接口 + 钱包实现 + 框架封装”的结构组织，当前钱包实现对接 Noir Wallet 注入的 `window.noirwallet.zcash` Provider。

这里没有复用 NEAR、EVM 或 Solana 的交易模型：

- 主账户同时保留 Zcash `transparent` 和 `shielded` 地址。
- `address` 默认指向 shielded 地址，避免业务层无意中把 t-address 当成隐私地址。
- 金额始终使用 ZEC 十进制字符串，避免 JavaScript 浮点数精度问题。
- 发送交易调用 `zcash_sendTransaction`，由钱包完成 UTXO 选择、费用计算、shielded proof、授权与广播。
- 当前 Noir Provider 没有暴露 PCZT 签名，因此 `signTransaction()` 会明确抛出 `WalletMethodNotSupportedError`，不会假装成 NEAR/EVM 式的序列化交易签名。
- 消息签名使用 Zcash 透明地址的 secp256k1 key，并支持 Noir 的 `current`、`derived` 和 `legacy_index0` 模式。

## 包结构

```text
packages/
├── core/                    # 类型、错误、事件、Base Adapter、WalletStore
├── wallets/noir-wallet/     # Noir Wallet 的 Zcash Provider 适配
├── react/                   # WalletProvider 与 useWallet
└── ui/                      # 纯钱包选择按钮与弹窗
```

## 安装与验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## 原生 TypeScript 使用

```ts
import { WalletStore } from '@noir-adapter/core';
import { NoirZcashWalletAdapter } from '@noir-adapter/noir-wallet';

const store = new WalletStore();
const noir = new NoirZcashWalletAdapter({
  network: 'mainnet',
});

store.registerAdapter(noir);

// 用户点击“连接”后调用；会打开 Noir 授权窗口。
await store.connect(noir.name);

console.log(noir.shieldedAddress);
console.log(noir.transparentAddress);

const balance = await noir.getBalance();
console.log(balance.shielded, balance.available);

const signature = await noir.signMessage('example.com wants you to sign in', {
  // 身份登录建议使用 derived，减少与主 t-address 的公开关联。
  signingMode: 'derived',
});

const txid = await noir.signAndSendTransaction({
  to: 'u1...',
  amount: '0.1',
  memo: 'private memo',
  fundingSource: 'shielded',
});
```

页面刷新时可静默恢复之前授权过的连接。静默流程只调用 `zcash_getAccounts`，不会触发授权弹窗：

```ts
await store.autoConnect();
```

## 开箱即用的钱包选择 UI

UI 层只负责钱包选择：展示钱包名称、图标和安装状态，选择后连接钱包。它不会渲染账户、地址、余额、复制或断开连接界面。

```tsx
import { NoirZcashWalletAdapter } from '@noir-adapter/noir-wallet';
import { WalletProvider } from '@noir-adapter/react';
import { WalletSelector } from '@noir-adapter/ui';
import '@noir-adapter/ui/styles.css';

const adapters = [new NoirZcashWalletAdapter({ network: 'mainnet' })];

export function App() {
  return (
    <WalletProvider adapters={adapters} autoConnect>
      <WalletSelector />
    </WalletProvider>
  );
}
```

默认选择行为会调用 `store.connect(walletName)`。如果业务只想取得被选择的钱包、稍后自行连接，可以覆盖 `onSelect`：

```tsx
<WalletSelector
  onSelect={async adapter => {
    console.log('selected wallet:', adapter.name);
  }}
/>
```

组件支持覆盖中文文案以及样式变量：

```tsx
<WalletSelector
  labels={{
    selectWallet: '连接钱包',
    dialogTitle: '请选择钱包',
  }}
/>
```

```css
:root {
  --nzwa-accent: #f4b728;
  --nzwa-radius: 18px;
}
```

也可以分别使用受控的 `WalletSelectorButton` 和 `WalletSelectorModal`，将弹窗开关交给业务管理。

## React 状态层使用

```tsx
import { NoirZcashWalletAdapter } from '@noir-adapter/noir-wallet';
import { WalletProvider, useWallet } from '@noir-adapter/react';

const adapters = [new NoirZcashWalletAdapter({ network: 'mainnet' })];

export function App() {
  return (
    <WalletProvider adapters={adapters} autoConnect>
      <WalletPanel />
    </WalletProvider>
  );
}

function WalletPanel() {
  const {
    adapters,
    isConnected,
    shieldedAddress,
    transparentAddress,
    connect,
    disconnect,
    signAndSendTransaction,
  } = useWallet();

  if (!isConnected) {
    return (
      <button onClick={() => connect(adapters[0]!.name)}>
        Connect Noir Wallet
      </button>
    );
  }

  return (
    <section>
      <div>Shielded: {shieldedAddress}</div>
      <div>Transparent: {transparentAddress}</div>
      <button onClick={() => disconnect()}>Disconnect</button>
      <button
        onClick={() =>
          signAndSendTransaction({
            to: 'u1...',
            amount: '0.01',
            fundingSource: 'shielded',
          })
        }
      >
        Send ZEC
      </button>
    </section>
  );
}
```

`adapters` 数组应保持引用稳定（放在组件外或用 `useMemo` 创建），否则 React 会把它视作一组新钱包并重新注册。

## 事件

Adapter 统一提供：

- `connect`
- `disconnect`
- `accountChanged`
- `chainChanged`
- `error`
- `readyStateChanged`

```ts
noir.on('accountChanged', ({ shielded, transparent, accounts }) => {
  // accounts 包含本次授权的全部 Zcash wallet/account。
});
```

## Zcash 特有注意事项

1. `shielded` 字段由钱包返回，可能是 Unified Address 或钱包当前支持的 shielded 地址格式；DApp 不应只靠字符串前缀猜测 receiver 类型。
2. memo 最多 512 UTF-8 bytes，并且只有 shielded 接收方能获得私密 memo。
3. `fundingSource: 'transparent'` 会暴露并可能关联所选 UTXO；隐私优先场景应使用 `shielded`。
4. `available` 比简单的余额减固定手续费更适合作为最大可发送金额；精确 send-max 应调用 `getMaxTransfer()`。
5. 主网和测试网由不同的钱包构建版本决定。Adapter 的 `network` 配置用于 DApp 状态与校验，不会请求钱包切链。

## Provider RPC 映射

| Adapter API | Noir Zcash RPC |
| --- | --- |
| `connect()` | `zcash_requestAccounts` |
| `connect({ silent: true })` / `getAccounts()` | `zcash_getAccounts` |
| `getAddresses()` | `zcash_getAddresses` |
| `getBalance()` | `zcash_getBalance` |
| `getMaxTransfer()` | `zcash_getMaxTransfer` |
| `getPublicKey()` | `zcash_getPublicKey` |
| `signMessage()` | `zcash_signMessage` |
| `signAndSendTransaction()` | `zcash_sendTransaction` |
| `shieldFunds()` | `zcash_shieldFunds` |
| `getTransactionHistory()` | `zcash_getTransactionHistory` |
| `disconnect()` | Provider `disconnect()` / `zcash_disconnect` |

## 安全建议

用于登录的消息应由服务端生成并校验，至少包含域名、用途、nonce、签发时间和过期时间。不要让用户签署含义不清晰的任意文本；不要把 shielded 地址、授权账户数组或余额写入分析日志。
