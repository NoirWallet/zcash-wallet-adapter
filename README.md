# Noir Zcash Wallet Adapter

A browser wallet adapter built specifically for **Zcash**. The project follows a layered internal architecture consisting of a core interface, wallet-specific implementations, framework bindings, and an optional wallet-selection UI. All layers are distributed as one `@noir-wallet/adapter` package. The current wallet implementation integrates with the `window.noirwallet.zcash` provider injected by Noir Wallet.

This implementation does not reuse NEAR, EVM, or Solana transaction models:

- Each account retains both its Zcash `transparent` and `shielded` addresses.
- The adapter's primary `address` points to the shielded address by default, preventing applications from accidentally treating a t-address as private.
- ZEC amounts are represented as decimal strings to avoid JavaScript floating-point precision issues.
- Transactions are sent through `zcash_sendTransaction`, allowing the wallet to handle UTXO selection, fee calculation, shielded proof generation, authorization, and broadcasting.
- The current Noir provider does not expose PCZT signing. Calling `signTransaction()` therefore throws `WalletMethodNotSupportedError` instead of pretending that Zcash uses a NEAR- or EVM-style serialized transaction flow.
- Message signing uses the secp256k1 key associated with a Zcash transparent address and supports Noir's `current`, `derived`, and `legacy_index0` signing modes.

## Internal structure

```text
src/
├── core/                    # Types, errors, events, base adapter, and WalletStore
├── wallets/noir-wallet/     # Noir Wallet Zcash provider implementation
├── react/                   # WalletProvider and useWallet
└── ui/                      # Wallet-selection button and modal only
```

These directories are implementation layers, not separate npm packages. Applications install a single dependency:

```bash
pnpm add @noir-wallet/adapter
```

To develop and verify this repository:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## TypeScript usage

```ts
import {
  NoirZcashWalletAdapter,
  WalletStore,
} from '@noir-wallet/adapter';

const store = new WalletStore();
const noir = new NoirZcashWalletAdapter({
  network: 'mainnet',
});

store.registerAdapter(noir);

// Call this after the user clicks Connect. Noir Wallet will display an
// authorization prompt.
await store.connect(noir.name);

console.log(noir.shieldedAddress);
console.log(noir.transparentAddress);

const balance = await noir.getBalance();
console.log(balance.shielded, balance.available);

const signature = await noir.signMessage('example.com wants you to sign in', {
  // Derived signing is recommended for identity flows because it reduces
  // public linkage to the user's primary t-address.
  signingMode: 'derived',
});

const txid = await noir.signAndSendTransaction({
  to: 'u1...',
  amount: '0.1',
  memo: 'private memo',
  fundingSource: 'shielded',
});
```

A previously authorized connection can be restored silently after a page reload. The silent flow only calls `zcash_getAccounts` and never opens an approval prompt:

```ts
await store.autoConnect();
```

## Ready-to-use wallet selector

The UI package is intentionally limited to wallet selection. It displays wallet names, icons, and installation status, then connects the selected wallet. It does not render accounts, addresses, balances, copy actions, or a disconnect panel.

```tsx
import {
  NoirZcashWalletAdapter,
  WalletProvider,
} from '@noir-wallet/adapter';
import '@noir-wallet/adapter/styles.css';

const adapters = [new NoirZcashWalletAdapter({ network: 'mainnet' })];

export function App() {
  return (
    <WalletProvider adapters={adapters} autoConnect>
      <AppContent />
    </WalletProvider>
  );
}
```

The UI-ready `WalletProvider` renders `WalletSelector` automatically. The application does not need to import or mount the selector separately. By default, selecting a wallet calls `store.connect(walletName)`.

Pass `walletSelectorProps` to customize the built-in selector:

```tsx
<WalletProvider
  adapters={adapters}
  walletSelectorProps={{
    labels: {
      selectWallet: 'Connect wallet',
      dialogTitle: 'Choose a wallet',
    },
  }}
>
  <AppContent />
</WalletProvider>
```

The built-in selector can be disabled when a page does not need wallet-selection UI:

```tsx
<WalletProvider adapters={adapters} showWalletSelector={false}>
  <AppContent />
</WalletProvider>
```

CSS variables can be customized:

```css
:root {
  --nzwa-accent: #f4b728;
  --nzwa-radius: 18px;
}
```

`WalletSelector`, `WalletSelectorButton`, and `WalletSelectorModal` remain available as separate exports for applications that need full control over selector placement or modal state.

## Headless React state bindings

Use the `@noir-wallet/adapter/react` subpath when the application needs state management without any built-in UI. This is a subpath of the same installed package, not another dependency.

```tsx
import { NoirZcashWalletAdapter } from '@noir-wallet/adapter';
import {
  WalletProvider,
  useWallet,
} from '@noir-wallet/adapter/react';

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

Keep the `adapters` array reference stable by defining it outside the component or creating it with `useMemo`. Passing a new array on every render causes React to treat it as a new set of wallets and register the adapters again.

## Events

Every adapter exposes the following events:

- `connect`
- `disconnect`
- `accountChanged`
- `chainChanged`
- `error`
- `readyStateChanged`

```ts
noir.on('accountChanged', ({ shielded, transparent, accounts }) => {
  // accounts contains every Zcash wallet/account authorized by the user.
});
```

Transaction and signing failures emit `error` without clearing the active connection. The adapter only enters the disconnected state after an explicit provider `disconnect` event, an `accountsChanged` event carrying `null`, or an application call to `disconnect()`.

## Zcash-specific considerations

1. The wallet provides the `shielded` value. It may be a Unified Address or another shielded address format supported by the wallet. Applications should not infer receiver capabilities from the string prefix alone.
2. A memo is limited to 512 UTF-8 bytes, and only a shielded recipient can receive a private memo.
3. `fundingSource: 'transparent'` reveals and may link the selected UTXOs. Privacy-first applications should use `shielded`.
4. `available` is more accurate for a maximum payment than subtracting a fixed fee from the balance. Use `getMaxTransfer()` for an exact send-max estimate.
5. Mainnet and testnet are distributed as separate wallet builds. The adapter's `network` option controls application state and validation; it does not ask the wallet to switch networks.

## Provider RPC mapping

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

## Security recommendations

Authentication messages should be generated and verified by the server. At minimum, include the domain, intended action, nonce, issued-at time, and expiration time. Never ask users to sign ambiguous text, and never send shielded addresses, authorized account lists, or balances to analytics services.
