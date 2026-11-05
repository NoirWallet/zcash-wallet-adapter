# Noir WalletConnect：React 接入指南

通过 WalletProvider 注册 WalletConnect 适配器，在 React 组件中使用 useWallet() 连接钱包、读取地址并发送 ZEC。

## 1. 准备与安装

准备 Reown/WalletConnect 项目 ID，并安装、解锁支持 WalletConnect 和 NOIR_WC_PAIR 消息的 Noir 扩展。请确认实际安装版本支持这些功能。

```bash
pnpm add @rhea-finance/zcash-wallet-adapter
```

## 2. 配置 Provider

以下示例使用无界面的 React Provider 和自定义按钮。代码需在客户端执行；Next.js 项目请添加 'use client'。将 adapters 数组放在组件外，保持引用稳定。

```tsx
// App.tsx
import { WalletProvider } from
  '@rhea-finance/zcash-wallet-adapter/react';
import { WalletConnectZcashWalletAdapter } from
  '@rhea-finance/zcash-wallet-adapter/walletconnect';
import { WalletPanel } from './WalletPanel';

const projectId = 'YOUR_REOWN_PROJECT_ID';
const adapters = [
  new WalletConnectZcashWalletAdapter({
    projectId,
    metadata: {
      name: 'My Zcash App',
      description: 'My Zcash application',
      url: 'https://your-app.com',
      icons: ['https://your-app.com/icon.png'],
    },
    onDisplayUri: (uri) => {
      window.postMessage(
        { type: 'NOIR_WC_PAIR', uri, projectId },
        window.location.origin,
      );
    },
  }),
];

export function App() {
  return (
    <WalletProvider adapters={adapters} autoConnect>
      <WalletPanel />
    </WalletProvider>
  );
}
```

将 projectId、应用名称、URL 和图标替换为实际值。用户点击连接后，适配器将配对 URI 传给扩展，用户需在 Noir 内批准连接。autoConnect 会尝试恢复已有的兼容会话。

## 3. 在组件中使用 Hook

以下组件演示连接、显示地址、发送 ZEC 和断开连接。发送前必须替换收款地址占位符。busy 状态用于防止重复点击，status 显示操作结果或错误。代码对应上一节导入的 WalletPanel.tsx。

```tsx
// WalletPanel.tsx
import { useState } from 'react';
import { useWallet } from
  '@rhea-finance/zcash-wallet-adapter/react';

export function WalletPanel() {
  const { adapters, isConnected, shieldedAddress,
    transparentAddress, connect, disconnect,
    signAndSendTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setStatus('');
    try {
      const result = await action();
      setStatus(typeof result === 'string'
        ? `Transaction: ${result}` : 'Done');
    } catch (error) {
      setStatus(error instanceof Error
        ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {!isConnected ? (
        <button disabled={busy || !adapters.length}
          onClick={() => run(() =>
            connect(adapters[0]!.name))}>
          Connect Noir via WalletConnect
        </button>
      ) : (<>
        <p>Shielded: {shieldedAddress ?? 'Unavailable'}</p>
        <p>Transparent: {transparentAddress ?? 'Unavailable'}</p>
        <button disabled={busy} onClick={() => run(() =>
          signAndSendTransaction({
            to: 'REPLACE_WITH_VALID_MAINNET_ADDRESS',
            amount: '0.1', fundingSource: 'shielded',
          }))}>Send 0.1 ZEC</button>
        <button disabled={busy}
          onClick={() => run(() => disconnect())}>
          Disconnect
        </button>
      </>)}
      <p role="status">{status}</p>
    </section>
  );
}
```

## 4. 使用说明

- 用户需在钱包中批准连接与转账。amount 是以 ZEC 为单位的十进制字符串；fundingSource 可选 shielded（隐私余额）或 transparent（透明余额）。
- 如需内置钱包选择和配对二维码，从包根入口导入 WalletProvider，并导入 @rhea-finance/zcash-wallet-adapter/styles.css。useWallet 仍从 /react 入口导入。内置选择器负责连接，可省略示例中的自定义连接按钮。
- 自定义二维码界面可显示 onDisplayUri 返回的 URI。接收方钱包必须支持相同的 Zcash 协议，并提供扫码或打开 URI 的入口。
- 网络：Zcash 主网。Namespace：bip122。Chain ID：bip122:00040fe8ec8471911baa1db1266ea15d。
- 支持的方法：zcash_getAddress、zcash_getBalance、zcash_transfer、zcash_signMessage。消息签名需钱包和会话支持；当前不提供 PCZT 签名。

仅支持 Ethereum 的 WalletConnect 配置无法处理此 Zcash 会话。如扩展没有响应，请检查安装版本是否支持 WalletConnect 和 NOIR_WC_PAIR、钱包是否解锁，以及项目 ID 是否有效。
