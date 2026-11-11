# WalletConnect in React

Contract revision: **2026-11-10**. Implementation baseline: **0.2.5 (published)**, source [`f6938fd`](https://github.com/NoirWallet/zcash-wallet-adapter/commit/f6938fd6ba3dfffb28bcc9609c0c5c2ff0c09679). The [session contract](mobile-wallet-walletconnect.en.md#3-session-protocol-and-compatibility) defines the shared version, permissions, and address limits for this guide.

Use the UI-ready `WalletProvider` for a wallet selector and pairing QR code. Use the `/react` provider only when the application supplies its own pairing UI. This adapter is the DApp side of a WalletConnect v2 connection; the wallet must support the Zcash `bip122` methods below.

## Requirements

- A Reown/WalletConnect project ID and a client-side React application. In Next.js, put the provider and wallet actions in client components (`'use client'`).
- A compatible Zcash mainnet wallet that approves WalletConnect sessions, implements all four requested methods and both events, and authorizes supported addresses within the CAIP-10 limit. An Ethereum-only wallet cannot approve this namespace. For the Noir browser extension's pairing path, confirm the installed version supports `NOIR_WC_PAIR`.

Install the adapter in the DApp project:

```bash
pnpm add @rhea-finance/zcash-wallet-adapter@0.2.5
```

Version `0.2.5` is published. Use this exact version for the documented baseline. See the [RFC draft and implementation status](rfc/0001-zcash-walletconnect.md); compatibility with a particular mobile wallet requires its implementation and acceptance results.

## Built-in selector and QR code

Import the provider from the package root. It renders the selector and QR code automatically; the UI imports its own stylesheet. Keep the adapters array stable across renders.

```tsx
// App.tsx (client component)
import { WalletProvider } from '@rhea-finance/zcash-wallet-adapter';
import { WalletConnectZcashWalletAdapter } from '@rhea-finance/zcash-wallet-adapter/walletconnect';
import { WalletPanel } from './WalletPanel';

const adapters = [
  new WalletConnectZcashWalletAdapter({
    projectId: 'YOUR_REOWN_PROJECT_ID',
    metadata: {
      name: 'My Zcash App',
      description: 'My Zcash application',
      url: 'https://your-app.com',
      icons: ['https://your-app.com/icon.png'],
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

The user chooses `Noir Wallet (WalletConnect)`, scans the QR code with a compatible wallet, and approves the session. That label identifies the transport, not a wallet catalog or a guarantee that a particular mobile wallet supports the protocol. On the same phone, the selector also offers the complete pairing URI; wallet-specific deep links require application-specific integration. `autoConnect` restores an approved compatible session without showing a new QR code. The built-in selector handles connecting, so the panel below does not need another Connect button.

```tsx
// WalletPanel.tsx (client component)
import { useState } from 'react';
import { useWallet } from '@rhea-finance/zcash-wallet-adapter/react';

export function WalletPanel() {
  const {
    currentAdapter, isConnected, shieldedAddress, transparentAddress,
    disconnect, signMessage, signAndSendTransaction,
  } = useWallet();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setStatus('');
    try {
      const result = await action();
      setStatus(typeof result === 'string' ? result : 'Done');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      {isConnected && (
        <>
          <p>Shielded: {shieldedAddress ?? 'Unavailable'}</p>
          <p>Transparent: {transparentAddress ?? 'Unavailable'}</p>
          <button disabled={busy} onClick={() => run(async () => {
            if (!currentAdapter) return;
            const balance = await currentAdapter.getBalance();
            return `Available: ${balance.available} ZEC`;
          })}>Refresh balance</button>
          <button disabled={busy} onClick={() => run(async () => {
            const result = await signMessage('example.com sign-in nonce: REPLACE_WITH_SERVER_NONCE', {
              signingMode: 'derived',
            });
            return `Signed with ${result.address}`;
          })}>Sign message</button>
          <button disabled={busy} onClick={() => run(async () => {
            const txid = await signAndSendTransaction({
              to: 'REPLACE_WITH_VALID_MAINNET_ADDRESS',
              amount: '0.001',
              fundingSource: 'shielded',
            });
            return `Transaction: ${txid}`;
          })}>Send ZEC</button>
          <button disabled={busy} onClick={() => run(() => disconnect())}>
            Disconnect
          </button>
        </>
      )}
      <p role="status">{status}</p>
    </section>
  );
}
```

`useWallet()` provides connection state, addresses, signing, and transfers; it does not directly expose `getBalance()` or `getAddress()`. Call them on `currentAdapter` while connected. A production sign-in flow must generate and verify its nonce and signature server-side; the example message is only a placeholder. Replace the recipient and use a small test amount you control before transferring mainnet funds.

## Headless UI and Noir extension

For custom controls, import `WalletProvider` from `/react`. It does not render a selector or QR. Call `connect(adapter.name)` after a user action; the resulting `onDisplayUri` callback (or `displayUri` event) supplies the complete `wc:` URI to present to the user. Wait for wallet approval before treating the connection as active. The following Noir extension-specific callback is an alternative to rendering a QR code; mobile wallets do not implement `NOIR_WC_PAIR`.

```tsx
import { useState } from 'react';
import { WalletProvider, useWallet } from '@rhea-finance/zcash-wallet-adapter/react';
import { WalletConnectZcashWalletAdapter } from '@rhea-finance/zcash-wallet-adapter/walletconnect';

const projectId = 'YOUR_REOWN_PROJECT_ID';
const adapter = new WalletConnectZcashWalletAdapter({
  projectId,
  onDisplayUri: (uri) => {
    window.postMessage({ type: 'NOIR_WC_PAIR', uri, projectId }, window.location.origin);
  },
});
const adapters = [adapter];

export function App() {
  return (
    <WalletProvider adapters={adapters} autoConnect>
      <ConnectButton />
    </WalletProvider>
  );
}

function ConnectButton() {
  const { connect, isConnected } = useWallet();
  const [error, setError] = useState('');
  return <>
    <button disabled={isConnected} onClick={() => {
      void connect(adapter.name).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Connection failed');
      });
    }}>Connect with Noir</button>
    {error && <p role="alert">{error}</p>}
  </>;
}
```

For a custom mobile-wallet flow, replace the `onDisplayUri` callback with a QR renderer or a wallet-specific encoded deep link, and show pending, rejection, and expiration states. Do not log or send pairing URIs to analytics.

## Protocol and limits

See the [address support matrix](mobile-wallet-walletconnect.en.md#address-support-matrix) for the distinct session, address-query, and transfer-recipient rules. The [RFC status](rfc/0001-zcash-walletconnect.md#implementation-and-validation-status) separates adapter tests from real wallet acceptance.

New and restored sessions both require Zcash Mainnet (`bip122:00040fe8ec8471911baa1db1266ea15d`), methods `zcash_getAddress`, `zcash_getBalance`, `zcash_transfer`, `zcash_signMessage`, and events `accountsChanged`, `chainChanged`. A restored session missing any required permission is incompatible; reauthorize interactively rather than treating it as connected. Silent restoration does not open a new pairing QR.

Session accounts keep the existing `<mainnet chain ID>:<address>` format. The address segment must match `[-.%a-zA-Z0-9]{1,128}` and start with `t1`, `t3`, `zs1`, or `u1`. Only one logical account, with at most one distinct address per category, is represented. `getAddress()` still sends `{}` and returns `{ address, account?, type? }`; its address must be in the current selected set, initially the session accounts. An `accountsChanged` event replaces that set, and a single address clears the other category. The adapter checks syntax and prefixes, while the wallet must decode addresses, verify checksums/mainnet, and confirm UA receiver support.

A complete UA longer than 128 characters cannot be used in session accounts or returned by `getAddress()` under this contract. No short-ID substitution or automatic transparent-address disclosure is defined. This is a constraint of the existing account model, not a limit on `zcash_transfer.params.to`: a longer valid mainnet UA may still be a transfer recipient if supported by the wallet.

These Zcash RPC conventions belong to this adapter; they are not an official WalletConnect Zcash RPC standard. The revision constant is documentation metadata. No handshake, RPC version field, new method, or replacement address response is introduced. Pin the adapter version, commit, and contract revision with the integrating wallet team.

Amounts are decimal ZEC strings with at most eight decimal places. Transfers default to **shielded** funding when `fundingSource` is omitted; set `'transparent'` explicitly if intended. The wallet confirms and broadcasts a transfer before returning a transaction ID. PCZT signing is not supported over WalletConnect. For wallet-side implementation, see the [mobile wallet integration guide](mobile-wallet-walletconnect.en.md); for test cases, see the [acceptance specification](walletconnect-acceptance.en.md).

The approved `chains` array must explicitly contain only the mainnet chain ID. `getBalance()` requires all five decimal-string fields (`transparent`, `shielded`, `total`, `spendable`, `available`); missing or malformed fields fail instead of becoming zero. `chainChanged` data must be the exact mainnet CAIP-2 string, never an object. Method errors follow the required [error contract](mobile-wallet-walletconnect.en.md#error-responses).
