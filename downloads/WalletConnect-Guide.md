# Noir WalletConnect: React Guide

Use WalletProvider to register the WalletConnect adapter, then useWallet() inside React components to connect, read addresses, and send ZEC.

## 1. Requirements & Installation

You need a Reown/WalletConnect project ID and an unlocked Noir extension build supporting WalletConnect and NOIR_WC_PAIR. Confirm support in the installed extension version.

```bash
pnpm add @rhea-finance/zcash-wallet-adapter
```

## 2. Configure the Provider

This example uses the headless React provider with custom buttons. Run it on the client (for Next.js, add 'use client'). Keep the adapters array stable outside the component.

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

Replace the project ID and application metadata. When Connect is clicked, the adapter passes a pairing URI to the extension. The user must approve the connection in Noir. autoConnect restores an existing compatible session when available.

## 3. Use the Hook in Your Component

The following component connects, displays addresses, sends ZEC, and disconnects. Replace the recipient placeholder before sending. The busy state prevents duplicate actions, and failures are shown to the user.

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

## 4. Connection & Transaction Notes

- Approve the connection and each transfer in the wallet. Amounts are decimal strings in ZEC; fundingSource can be shielded or transparent.
- For built-in wallet selection and a pairing QR code, import WalletProvider from the package root and import its styles.css. Keep useWallet imported from the /react entry. The built-in selector handles connecting, so the custom Connect button can be omitted.
- A custom QR interface can render the URI from onDisplayUri. The receiving wallet must support Zcash and provide a way to open or scan the URI.
- Network: Zcash Mainnet. Namespace: bip122. Chain ID: bip122:00040fe8ec8471911baa1db1266ea15d.
- Methods: zcash_getAddress, zcash_getBalance, zcash_transfer, and zcash_signMessage. Message signing requires wallet/session support. PCZT signing is not available.

An Ethereum-only WalletConnect configuration cannot handle this Zcash session. If pairing does not open the extension, check the installed extension's WalletConnect support, unlock it, and verify the project ID.
