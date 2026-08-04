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
├── ui/                      # Wallet-selection button and modal only
├── aggregation/             # RHEA aggregation SDK and Noir Zcash bridge
├── lending/                 # RHEA lending SDK and Noir Zcash bridge
└── perps/                   # RHEA perpetuals SDK
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

## RHEA cross-chain SDK entries

The adapter depends on the unified `@rhea-finance/crosschain-sdk` package and
re-exports all three SDKs from isolated entry points:

| Adapter import | Unified SDK entry | Purpose |
| --- | --- | --- |
| `@noir-wallet/adapter/aggregation` | `@rhea-finance/crosschain-sdk/aggregation` | Cross-chain swaps and the Noir Zcash executor |
| `@noir-wallet/adapter/lending` | `@rhea-finance/crosschain-sdk/lending` | Cross-chain lending and the Noir Zcash bridge |
| `@noir-wallet/adapter/perps` | `@rhea-finance/crosschain-sdk/perps` | Perpetual markets, accounts, funding, and trading |

Applications install only the adapter package:

```bash
pnpm add @noir-wallet/adapter
```

The root entry does not import or re-export these SDKs. Each integration is an
independent package subpath, and both packages declare their modules as free of
side effects. A bundler can therefore omit all three SDKs when none is used, or
include only the selected entry while tree-shaking its unused exports.

## RHEA aggregation integration

The RHEA integration is available through an optional import path rather than
the default adapter entry point. The dedicated subpath exports the complete
aggregation SDK together with the Noir-specific bridge:

```ts
import { NoirZcashWalletAdapter } from '@noir-wallet/adapter';
import {
  createNoirSwapClient,
  parseUnits,
  type AssetRef,
} from '@noir-wallet/adapter/aggregation';

const noir = new NoirZcashWalletAdapter({ network: 'mainnet' });
await noir.connect();

const client = createNoirSwapClient({
  baseUrl: 'https://api.rhea.finance',
  wallet: noir,
});

// Use the exact asset identifiers returned by RHEA's token metadata API.
declare const zec: AssetRef;
declare const destinationAsset: AssetRef;
declare const destinationAddress: string;

const quote = await client.quote({
  fromChain: 'zcash',
  toChain: destinationAsset.chain,
  tokenIn: zec,
  tokenOut: destinationAsset,
  amountIn: parseUnits('0.1', zec.decimals ?? 8),
  slippageBps: 50,
  sender: noir.transparentAddress!,
  recipient: destinationAddress,
});

const result = await client.swap({
  quote,
  waitFor: 'submitted',
});

console.log(result.txHash);
```

The bridge converts RHEA's base-unit ZEC amount into the decimal string
expected by Noir Wallet and funds the deposit from the shielded balance by
default. Pass `zcash: { fundingSource: 'transparent' }` to
`createNoirSwapClient()` only when that privacy trade-off is intentional.

`waitFor: 'submitted'` works with the current Noir provider. To use
`'source-confirmed'` or `'completed'`, supply a confirmation implementation:

```ts
const client = createNoirSwapClient({
  baseUrl: 'https://api.rhea.finance',
  wallet: noir,
  zcash: {
    waitForTransaction: async (txHash, { signal }) => {
      const receipt = await waitForZcashReceipt(txHash, signal);
      return {
        status: receipt.confirmed ? 'confirmed' : 'failed',
        raw: receipt,
      };
    },
  },
});
```

RHEA's Zcash executor sends to the transparent deposit address returned by its
build API, so that address must start with a valid mainnet `t1`/`t3` prefix or
testnet `tm`/`t2` prefix. This restriction applies to the cross-chain deposit
step only; normal Noir wallet transfers may still use supported Unified or
shielded recipients.

`@noir-wallet/adapter` does not re-export this bridge from its root entry.
Bundlers do not include it unless the application imports
`@noir-wallet/adapter/aggregation`.

## RHEA cross-chain lending integration

The dedicated lending subpath exports the complete lending SDK and connects its
Zcash flows to Noir Wallet:

```ts
import { NoirZcashWalletAdapter } from '@noir-wallet/adapter';
import {
  createNoirCrossChainLendingBridge,
} from '@noir-wallet/adapter/lending';

const noir = new NoirZcashWalletAdapter({ network: 'mainnet' });
await noir.connect();

const lending = createNoirCrossChainLendingBridge(noir);

// The derived Noir public key is used as the Zcash MCA identity.
const mcaId = await lending.getMcaByWallet();

// Legacy RHEA Zcash MCA creation flow: request a deposit address and submit
// the ZEC transfer through Noir Wallet.
const deposit = await lending.createMcaDeposit({
  accountManagerId: 'multica.near',
  amount: '0.1',
});

console.log(deposit.txHash);

const status = await lending.getZcashDepositStatus(
  deposit.depositAddress,
);
console.log(status?.mca_id, status?.status);
```

Deposit transfers use the shielded balance by default. To make the funding
source explicit:

```ts
const lending = createNoirCrossChainLendingBridge(noir, {
  fundingSource: 'transparent',
});
```

The bridge also exposes the complete RHEA SDK for lending views, quote
preparation, health-factor calculations, MCA operations, and relayer flows:

```ts
const sdk = await lending.loadSdk();
const account = await sdk.batchViews(mcaId ?? undefined);
const assets = await sdk.getAssetsDetail();
```

`loadSdk()` uses the unified package's isolated lending entry. Importing the
adapter root, aggregation entry, or perps entry does not load lending code.

RHEA's Zcash deposit endpoints require a transparent address. The bridge
validates mainnet `t1`/`t3` and testnet `tm`/`t2` addresses before asking Noir
Wallet to send funds. It does not apply this restriction to ordinary wallet
transfers.

## RHEA perpetuals integration

The perps subpath re-exports the complete RHEA perpetuals SDK without adding it
to the adapter root or either of the other SDK entries:

```ts
import { PerpsClient } from '@noir-wallet/adapter/perps';

const perps = new PerpsClient();

try {
  const markets = await perps.markets.list();
  console.log(markets);
} finally {
  perps.destroy();
}
```

Import this entry only in applications that use perpetual markets. If it is not
imported, the perps SDK is excluded from the application bundle.

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

The selector uses the light theme by default:

```tsx
<WalletProvider adapters={adapters}>
  <AppContent />
</WalletProvider>
```

Set `theme="dark"` to use the dark theme:

```tsx
<WalletProvider adapters={adapters} theme="dark">
  <AppContent />
</WalletProvider>
```

The same `theme: 'light' | 'dark'` option is available on
`WalletSelector`, `WalletSelectorButton`, and `WalletSelectorModal` when they
are rendered separately. The theme is explicit and does not change
automatically with the operating-system color scheme.

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
  --nzwa-radius: 24px;
}

[data-nzwa-theme='light'] {
  --nzwa-surface: #ffffff;
  --nzwa-text: #18181a;
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
