# Zcash Mobile Wallet Integration with WalletConnect

Contract revision: **2026-11-10**. Implementation baseline: **0.2.5 source (unreleased)**. Pin the adapter release and source commit when starting an integration; do not assume the published `latest` package contains this revision.

This guide is for mobile wallet teams, such as Zodl, that already provide Zcash accounts, balance synchronization, and transactions. It explains how to act as a **WalletConnect v2 wallet responder** for DApps using `@rhea-finance/zcash-wallet-adapter`.

Mentioning Zodl does not imply an existing integration or commitment. The Zcash RPC methods below are application conventions maintained by this adapter, not an official WalletConnect Zcash RPC standard. They are not supported by every WalletConnect wallet or DApp. The current scope is **Zcash Mainnet**.

## 1. What the Wallet Team Needs to Build

| Work | Deliverable |
| --- | --- |
| Integrate the wallet SDK | Use WalletConnect WalletKit for iOS, Android, or React Native; receive pairing, session, and request events |
| Provide connection entry points | Scan a DApp's WalletConnect QR code and read the complete `wc:` URI; URI paste and mobile deep links are recommended |
| Implement session authorization | Show the DApp, requested chain, accounts, and permissions; approve or reject proposals |
| Implement four Zcash RPC methods | Map address, balance, transfer, and message-signing requests to existing wallet capabilities |
| Require user confirmation | Require approval for transfers and message signing; connecting does not authorize subsequent actions automatically |
| Manage sessions | Persist, restore, expire, revoke, and disconnect sessions; handle backgrounding and network reconnection |
| Deliver integration evidence | Provide a test build, version, scanner instructions, supported methods and funding sources, and test results |

**The wallet does not need to install this adapter.** The adapter runs in the DApp. The mobile wallet implements the WalletConnect session and RPC protocol below, while retaining responsibility for keys, Zcash synchronization, coin selection, fees, shielded proofs, signing, and broadcasting.

## 2. How Users Connect

### Desktop DApp and Mobile Wallet

1. Open a compatible DApp in a desktop browser and select WalletConnect.
2. The DApp displays a WalletConnect QR code.
3. Open the mobile wallet's scanner and scan it.
4. Review the DApp, Zcash Mainnet, selected account, and requested permissions; approve the connection.
5. The DApp displays the connected account.
6. Initiate a transfer or message-signing request in the DApp; review and approve it in the mobile wallet.
7. The wallet returns the transaction ID or signature, and the DApp updates its status.

### DApp and Wallet on the Same Phone

A DApp can open the wallet through a wallet-specific deep link, Universal Link, or App Link carrying the correctly encoded, complete `wc:` URI. The wallet must handle both cold starts and background activation, initialize its SDK, and pair with that URI. The wallet team must supply its link format; DApps cannot assume a common URL scheme across wallets.

Use a validated return link or let the user switch back to the browser manually. Opening the wallet does not mean the session was approved. Push notifications and wallet directory listings are optional enhancements, not substitutes for protocol support.

> `NOIR_WC_PAIR` is the Noir browser extension's web-message entry point. Mobile wallets do not need to implement it or depend on a Chrome extension. QR flows use the URI supplied by `onDisplayUri` or the adapter's built-in selector.

## 3. Session Protocol and Compatibility

This section defines the version, permission, and address constraints for this revision. The DApp guide and acceptance specification refer to this contract. The four RPC method names and their existing request/response shapes remain unchanged. There is no protocol-version handshake or version field on the wire: the exported `ZCASH_WALLETCONNECT_PROTOCOL_REVISION` is documentation metadata, not negotiated wallet capability. Record the adapter package version, source commit, this contract revision, and wallet build together. SDK version numbers alone do not establish compatibility.

### Chain and Accounts

| Field | Value |
| --- | --- |
| Namespace | `bip122` |
| CAIP-2 chain ID | `bip122:00040fe8ec8471911baa1db1266ea15d` |
| Adapter's internal chain name | `zcash:mainnet` (not a replacement for the session's CAIP-2 ID) |
| CAIP-10 account | `<CAIP-2 chain ID>:<authorized mainnet address>` |
| Address segment syntax | `[-.%a-zA-Z0-9]{1,128}`; the 128-character limit excludes the chain ID and separator |
| Supported session-address prefixes | `t1` / `t3` (transparent), `zs1` (Sapling), `u1` (Unified Address with a wallet-validated shielded receiver) |
| Account grouping | One logical account; at most one distinct transparent and one distinct shielded address. Identical duplicate entries are tolerated |

The current adapter sends this `requiredNamespaces` proposal for new sessions:

```json
{
  "bip122": {
    "chains": ["bip122:00040fe8ec8471911baa1db1266ea15d"],
    "methods": [
      "zcash_getAddress",
      "zcash_getBalance",
      "zcash_transfer",
      "zcash_signMessage"
    ],
    "events": ["accountsChanged", "chainChanged"]
  }
}
```

**New and restored sessions must support all four methods and both events above.** A required namespace cannot be approved by silently removing unsupported methods or events. Reject an incompatible proposal. The adapter does not provide a reduced-permission legacy mode in this revision.

An older session missing any required permission or containing unsupported account data is not eligible for restoration. Silent connection must fail without showing a new pairing QR when no compatible session exists; an interactive connection may request a new authorization. A compatible session is subject to the same address constraints whether newly approved or restored.

The approved `namespaces.bip122` MUST explicitly contain `chains: ["bip122:00040fe8ec8471911baa1db1266ea15d"]` and the actual authorized accounts. Missing, empty, or additional chains are rejected for both approval and restoration. This is a requirement of this adapter profile:

```ts
// Replace placeholders with actual authorized mainnet addresses, each <=128
// characters, for one logical account. Placeholders are not valid addresses.
const approvedNamespace = {
  chains: ['bip122:00040fe8ec8471911baa1db1266ea15d'],
  methods: [
    'zcash_getAddress', 'zcash_getBalance',
    'zcash_transfer', 'zcash_signMessage',
  ],
  events: ['accountsChanged', 'chainChanged'],
  accounts: [
    'bip122:00040fe8ec8471911baa1db1266ea15d:<supported-shielded-address>',
    'bip122:00040fe8ec8471911baa1db1266ea15d:<transparent-address>',
  ],
};
```

Authorize both supported shielded and transparent addresses when available and permitted by the user so the corresponding DApp fields can be populated. Do not mix independent wallet accounts, or return two different addresses of the same category. All session accounts must use the exact mainnet chain ID above; testnet, empty, unknown-prefix, and overlength addresses are unsupported.

The adapter checks the chain, address character set, length, and supported prefixes. These are syntax checks, **not full address decoding, checksum verification, ownership proof, or validation of UA receivers**. The wallet MUST decode each address, verify its checksum and mainnet network, and confirm that a UA used as `shielded` has a supported shielded receiver. A `u1` prefix alone is not evidence of this capability. Sprout, TEX, and testnet addresses are outside this revision's session/get-address support.

**A complete UA longer than 128 characters is not supported in session accounts by this contract.** Do not truncate it, substitute a hash or invented ID, or silently expose a transparent address to bypass the restriction. If the wallet cannot obtain the user's authorization for an actual supported address, this session/address model cannot represent that wallet account. Supporting it requires a separately specified future protocol change; this guide does not introduce an alternative identity or address RPC.

The limit comes from the account-address segment in [CAIP-10](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-10.md), not the [Zcash Unified Address encoding](https://zips.z.cash/zip-0316). It also applies to the authorized address returned by `zcash_getAddress`. **It does not apply to `zcash_transfer.params.to`**: a transfer recipient is a payment address, not a CAIP-10 account. A wallet may accept a longer mainnet UA recipient after validating the full address and receiver support.

## 4. Mobile Wallet Implementation

### React Native / TypeScript WalletKit Starter

Install the wallet-side SDKs in the **mobile wallet project**, not this adapter. Follow the [React Native WalletKit installation](https://docs.walletconnect.com/wallets/react-native/installation) for storage, polyfills, and app lifecycle before using this example:

```bash
pnpm add @reown/walletkit @walletconnect/core @walletconnect/react-native-compat
```

Install the additional React Native storage and polyfill dependencies listed in the platform guide. Import `@walletconnect/react-native-compat` **before** WalletKit or Core in your application's entry point.

The following shows the WalletConnect boundary. `selectAccountAndConfirm`, `confirmAndBroadcast`, and `confirmAndSign` are **wallet application functions you must implement** using your existing Zcash wallet engine and screens. Replace the metadata, project ID, and URI input with your application's values.

```ts
import '@walletconnect/react-native-compat';
import { Core } from '@walletconnect/core';
import { WalletKit } from '@reown/walletkit';

const CHAIN = 'bip122:00040fe8ec8471911baa1db1266ea15d';
const METHODS = [
  'zcash_getAddress', 'zcash_getBalance',
  'zcash_transfer', 'zcash_signMessage',
];
const EVENTS = ['accountsChanged', 'chainChanged'];

const walletKit = await WalletKit.init({
  core: new Core({ projectId: 'YOUR_REOWN_PROJECT_ID' }),
  metadata: {
    name: 'Your Zcash Wallet',
    description: 'Zcash mobile wallet',
    url: 'https://your-wallet.example',
    icons: ['https://your-wallet.example/icon.png'],
  },
});

// Register handlers once at app startup, before accepting a QR or deep link.
walletKit.on('session_proposal', async ({ id, params }) => {
  const requested = params.requiredNamespaces.bip122;
  const supported = Object.keys(params.requiredNamespaces).length === 1 &&
    requested?.chains?.length === 1 && requested.chains[0] === CHAIN &&
    requested.methods.every((method) => METHODS.includes(method)) &&
    requested.events.every((event) => EVENTS.includes(event));
  if (!supported) {
    await walletKit.rejectSession({
      id, reason: { code: 5100, message: 'Unsupported Zcash permissions' },
    });
    return;
  }

  // Show the DApp origin, requested permissions, network, and account.
  const account = await selectAccountAndConfirm(params.proposer.metadata);
  if (!account) {
    await walletKit.rejectSession({
      id, reason: { code: 5000, message: 'User rejected' },
    });
    return;
  }
  // The wallet engine must first decode/checksum-check these addresses,
  // verify mainnet and receiver support, and obtain user authorization.
  // Both addresses must belong to the same logical account.
  const addresses = [account.shieldedAddress, account.transparentAddress]
    .filter((address): address is string => Boolean(address));
  if (addresses.length === 0 || addresses.some((address) =>
    address.length > 128 ||
    !/^(?:t1|t3|zs1|u1)[-.%a-zA-Z0-9]+$/.test(address))) {
    await walletKit.rejectSession({
      id, reason: { code: 5103, message: 'Unsupported session address format' },
    });
    return;
  }
  await walletKit.approveSession({
    id,
    namespaces: {
      bip122: {
        chains: [CHAIN],
        methods: METHODS,
        events: EVENTS,
        accounts: addresses.map((address) => `${CHAIN}:${address}`),
      },
    },
  });
});

// Call this with the complete URI returned by the QR scanner or app link.
export async function openPairingUri(uri: string) {
  if (!uri.startsWith('wc:')) throw new Error('Invalid pairing URI');
  await walletKit.pair({ uri });
}
```

Persist the authorized account and its current address selection *per session topic* after approval and restore both on app startup. In the handler below, `account.shieldedAddress` and `account.transparentAddress` are the current selection, constrained by the immutable session authorization set; update these when emitting `accountsChanged`. Do not use whichever account is currently selected in the wallet for an old DApp session. Register request listeners before calling `pair`, including when a deep link launches the app from a cold start. WalletKit owns relay transport and session persistence; the wallet owns account authorization and signing.

Dispatch each request to your existing wallet engine. The request's `topic` and `id` identify the response, and `params.chainId` must match the approved chain. The example below is a handler outline: `authorizedAccountForSession` must read the actual approved WalletKit session and your persisted account mapping; `readBalance`, `confirmAndBroadcast`, and `confirmAndSign` must be implemented by the mobile wallet. These engine wrappers must map native failures to the required method-error codes in Section 5; the handler preserves those codes and falls back to `-32603` for an unclassified internal exception.

```ts
walletKit.on('session_request', async ({ topic, id, params }) => {
  try {
    const account = await authorizedAccountForSession(topic);
    if (!account || params.chainId !== CHAIN) {
      throw Object.assign(new Error('Unauthorized session or network'), { code: 4100 });
    }
    const { method, params: input } = params.request;
    if (!METHODS.includes(method) || !account.allowedMethods.includes(method)) {
      throw Object.assign(new Error('Method not authorized for this session'), { code: 4200 });
    }

    let result: unknown;
    switch (method) {
      case 'zcash_getAddress':
        // Return an address from this topic's persisted current selection;
        // do not substitute a newly selected or unsupported long UA.
        result = {
          account: `${CHAIN}:${account.shieldedAddress || account.transparentAddress}`,
          address: account.shieldedAddress || account.transparentAddress,
          type: account.shieldedAddress ? 'shielded' : 'transparent',
        };
        break;
      case 'zcash_getBalance':
        result = await readBalance(account); // Decimal ZEC strings; see Section 5.
        break;
      case 'zcash_transfer':
        // Validate recipient, decimal amount, fees, memo, and funding source.
        // Show confirmation, broadcast once, then return the real txid.
        result = { txid: await confirmAndBroadcast(account, input, `${topic}:${id}`) };
        break;
      case 'zcash_signMessage':
        // Show the original text and mode; return signature, publicKey,
        // transparent address, and signingMode in the format in Section 5.
        result = await confirmAndSign(account, input);
        break;
    }
    await walletKit.respondSessionRequest({
      topic, response: { id, jsonrpc: '2.0', result },
    });
  } catch (error) {
    const failure = error as { code?: unknown; message?: unknown } | null;
    await walletKit.respondSessionRequest({
      topic,
      response: {
        id, jsonrpc: '2.0',
        error: {
          code: typeof failure?.code === 'number' && Number.isInteger(failure.code)
            ? failure.code : -32603,
          message: typeof failure?.message === 'string' ? failure.message : 'Request failed',
        },
      },
    });
  }
});
```

These wallet functions are intentionally not part of this repository. They must validate the request fields and obtain user approval; returning `txid` without a real broadcast or returning a dummy signature will not pass the acceptance tests. Store `topic:id -> txid` across process restarts so a redelivered request cannot broadcast twice. Use the SDK's standard rejection/error helpers where available, and distinguish user rejection (`5000`), invalid parameters (`-32602`), and unsupported methods (`4200`). Do not turn technical failures into user rejection; the outline preserves an existing numeric error code and uses `-32603` for an unclassified internal failure. On `session_delete` or expiry, remove the topic's account mapping and pending approvals; provide a connected-DApps screen to call `disconnectSession` when the user revokes access.

### Native iOS and Android

The wire contract in Sections 3 and 5 is platform-independent. If the wallet is native rather than React Native, use the official [iOS](https://docs.walletconnect.com/wallets/ios/installation) or [Android](https://docs.walletconnect.com/wallets/android/installation) WalletKit SDK and implement the same steps: initialize before processing a scanned/deep-linked `wc:` URI, approve a `bip122` proposal with CAIP-10 accounts, dispatch the four Zcash methods, return a JSON-RPC result/error for each request, and manage session deletion and expiry. Do not copy the TypeScript APIs into Swift or Kotlin; follow the platform SDK's event and response signatures.

### Lifecycle and Safety



- Register listeners before pairing. Pairing does not imply session approval.
- Read requests may expose only authorized account information, not arbitrary wallet accounts.
- Transfer confirmation must show the requesting DApp, account, network, recipient, amount, funding source, fees, and memo. Message-signing confirmation must show the original message, purpose, and signing mode.
- Track requests by `topic + request.id` to prevent duplicate broadcasts. SDK reconnection, App restoration, or repeated taps must not create additional unintended transfers.
- Handle lock screens, timeouts, cancellation, and process restarts. If a transaction was broadcast but its response was lost, retain the request-to-transaction mapping so it can be recovered without sending again.
- Let users inspect and revoke connected DApps. Do not log or disclose recovery phrases, private keys, or pairing URIs.

A wallet SDK JSON-RPC response has this shape:

```ts
// Illustrative: topic and id must belong to the same received request.
await walletKit.respondSessionRequest({
  topic,
  response: { id, jsonrpc: '2.0', result: { txid } },
});
// On failure, return error instead of result. Never return both.
```

## 5. Zcash RPC Contract

Requests arrive through `session_request`. The event's `params.chainId` uses the CAIP-2 ID above; `params.request` contains `method` and object-shaped `params`. These are Zcash methods, not Ethereum RPC or the complete Noir injected-provider API.

Amounts are **decimal strings in ZEC with at most eight decimal places**. Use integer zatoshi for internal calculations rather than floating-point arithmetic.

### `zcash_getAddress`

The adapter sends `{}`. Return one of this session's currently selected addresses, preferably shielded. Initially the current address set is the approved session account set; a valid `accountsChanged` event replaces the current set without expanding the session authorization set. `address` is required; `account` and `type` are optional. If supplied, `account` MUST equal `<mainnet CAIP-2 ID>:<address>` and belong to the approved session. If supplied, `type` MUST be `transparent` for `t1`/`t3`, or `shielded` for a wallet-validated `zs1`/`u1` address. The same character, prefix, and 128-character address limit in Section 3 applies. Wallets may additionally accept `type: 'shielded' | 'transparent'` in requests, but the adapter's `getAddress()` does not send that option.

```json
{
  "account": "bip122:00040fe8ec8471911baa1db1266ea15d:<address>",
  "address": "<address>",
  "type": "shielded"
}
```

Connection addresses come from session accounts. This RPC does not replace correctly populated accounts, initialize a second address pair, authorize a new address, or provide a long-UA workaround. Returning an address outside the current set is rejected even if it remains in the session authorization set. Any accepted account-selection event invalidates an in-flight address response; retry against the new state. `getAddress()` itself never changes the current set. On restoration the adapter initializes its local selection from session accounts; the wallet must emit its persisted selection again if narrower. No selection is inferred from a `getAddress()` response.

### `zcash_getBalance`

Request parameters: `{}`. All five fields below are REQUIRED, using non-negative decimal ZEC strings with at most eight decimal places (no signs, exponent notation, whitespace, or leading zeroes except `0`):

```json
{
  "transparent": "0.1",
  "shielded": "0.2",
  "total": "0.3",
  "spendable": "0.29",
  "available": "0.29"
}
```

These represent transparent, shielded, total, spendable, and available balances. Calculate them from the wallet's actual synchronization and locking state; never label unspendable funds as available just to fill a field. The adapter rejects missing or malformed fields; it neither substitutes zero nor derives missing values from other fields. The legacy `confirmed` field is not a replacement for any required field. `"0"` means a known zero balance, never unknown or unavailable data. If the wallet cannot determine a required balance, it MUST return an error. The adapter validates balance sums and bounds in integer zatoshi. The wallet MUST calculate `total = transparent + shielded` in integer zatoshi; `available` and `spendable` describe its actual spendability constraints and MUST NOT exceed total.

### `zcash_transfer`

```ts
{
  to: string;
  amount: string;
  memo?: string;
  fundingSource?: 'shielded' | 'transparent';
  type?: 'shielded' | 'transparent';
}
```

The current adapter defaults to `shielded` and sends matching values for `fundingSource` and the compatibility field `type`. Treat `fundingSource` as authoritative; older requests may fall back to `type`. If both are absent, a shielded default is recommended. Reject conflicting values explicitly.

Validate the address, positive amount, balance including fees, network, and receiver support. Memos must not exceed 512 UTF-8 bytes and require a shielded receiver that supports memos. Do not silently change the funding pool or downgrade a shielded request to transparent funding. Return a clear error for unsupported funding sources or address types and disclose those limitations.

After user approval, the wallet performs coin selection, fee calculation, any required shielded proofs, signing, and broadcasting. **Return a real transaction ID only after successful broadcast.** This means submitted, not necessarily confirmed on-chain.

```json
{ "txid": "<broadcast-transaction-id>" }
```

Returning the transaction ID directly as a string is also accepted.

### `zcash_signMessage`

The current adapter sends an object and defaults to `signingMode: 'derived'`:

```ts
{
  message: string; // Non-empty UTF-8 text
  signingMode: 'derived' | 'current' | 'legacy_index0';
}
```

For compatibility with the reference Noir verifier, use the secp256k1 key associated with a transparent address, not a shielded transaction-signing key:

| Mode | Convention |
| --- | --- |
| `derived` | BIP-44 `m/44'/133'/2147483647'/0/0`; default identity-signing mode |
| `current` | Key for the current transparent address; must match the returned address |
| `legacy_index0` | BIP-44 `m/44'/133'/0'/0/0`; legacy identity compatibility |

Noir-compatible encoding:

1. Encode the prefix `Zcash Signed Message:\n` (ending with a newline) and the original message as UTF-8 bytes.
2. Construct `CompactSize(prefixByteLength) || prefix || CompactSize(messageByteLength) || message`.
3. Apply double SHA-256 to the payload, then produce a recoverable secp256k1 signature.
4. Return 65 bytes as hex: `header || r || s`. The compressed header is `31 + recoveryId` (31–34). This is not Ethereum `personal_sign` or a format with `v` at the end.

```ts
{
  signature: string; // 65-byte hex: 130 hexadecimal characters
  publicKey: string; // secp256k1 public key hex; pubkey is an accepted alias
  address: string;   // Transparent address corresponding to the signing key
  signingMode: 'derived' | 'current' | 'legacy_index0';
  originAddress?: string;
}
```

The adapter checks required response fields and forwards the result; **it does not perform cryptographic signature verification**. Test ASCII, Chinese, newline-containing, and long messages with the consuming application's actual verifier. Lengths must count UTF-8 bytes. The returned public key, signature, and address must agree.

A `derived` address may still be linked through `originAddress` or application identity relationships; do not describe it as fully anonymous. If the wallet cannot derive the specified key, agree on an alternative with the integrator rather than signing with another key and labeling it `derived`. Array parameters `[message, { signingMode }]` are optional legacy compatibility; the current adapter does not require them.

### Error Responses

For method requests, wallets MUST return a JSON-RPC 2.0 error with an integer `code` and non-empty `message`, using this contract:

| Scenario | Required code | DApp adapter result |
| --- | --- | --- |
| User rejects an authorized method request | `5000` | `UserRejectedError` (`USER_REJECTED`); original error in `cause` |
| Session/account is not authorized or request chain is outside session authorization | `4100` | `WalletProviderError`, `providerCode: 4100` |
| Method unsupported or not authorized | `4200` | `WalletMethodNotSupportedError` (`UNSUPPORTED_METHOD`) |
| Invalid parameters, including unsupported parameter values or conflicting fields | `-32602` | `WalletInvalidInputError` (`INVALID_INPUT`); original error in `cause` |
| Insufficient funds, proof generation failure, or broadcast failure | `-32000` | `WalletProviderError`, `providerCode: -32000`; message identifies the failure |
| Unclassified internal wallet failure | `-32603` | `WalletProviderError`, `providerCode: -32603` |

These are required application conventions for this revision, not recommendations. A wallet MUST NOT report technical failures as user rejection, fabricate a successful result, or leave a request unanswered. Request errors do not by themselves disconnect an otherwise valid session. Unknown codes remain `WalletProviderError` with the numeric `providerCode`; this preserves diagnostics and does not make a nonconforming wallet compliant. The adapter also recognizes legacy `4001` as rejection and `-32601` as unsupported method, but wallets implementing this revision MUST use the codes above.

Proposal rejection and session lifecycle errors use the selected WalletConnect SDK's standard reasons; they are separate from this method-request error table. Reject proposals with unsupported required chains, methods, or events.

## 6. Events, Account Switching, and Network Limits

Emit `accountsChanged` and `chainChanged` under the authorized session's mainnet chain ID. When the user revokes a connection, use the SDK's session-disconnect API; the DApp clears its state on session deletion.

For `accountsChanged`, use a supported approved address, its CAIP-10 string, an array of approved address strings/CAIP-10 strings, or `{ address, account? }`. The event envelope's `chainId` MUST be the exact mainnet CAIP-2 ID. Addresses remain subject to Section 3 and MUST already be authorized in this session; an event is not permission to introduce another account. An array replaces the current selected address pair atomically; `null` or an empty array disconnects. A single-address payload replaces the current set with only that address and clears the other category. `getAddress()` MUST return an address in this current set; it MUST NOT return a deselected address merely because it remains session-authorized. A later approved-address event may select it again. Wallets MUST persist this current selection per topic and update it before emitting the event; balance, transfer, and signing requests remain scoped to the same authorized logical account. The adapter does not implement general `session_update` handling. For a switch to another logical account or a newly authorized address, disconnect and obtain new authorization.

For `chainChanged`, both the event envelope's `chainId` and its data MUST each be a string equal to the exact mainnet CAIP-2 ID, not `mainnet` or the adapter's internal `zcash:mainnet` alias. Object payloads such as `{ chainId }` or `{ network }` are invalid and are not unwrapped. An event with a missing or different envelope chain ID is rejected without changing account/connection state. In a correctly scoped mainnet event, an unsupported `chainChanged` data value disconnects the adapter and blocks subsequent requests until reconnection. The wallet must independently reject requests outside its authorized mainnet session.

## 7. Displaying a QR Code in the DApp

This example is for integration testing on the DApp side. Wallet teams do not put it in the mobile App.

```ts
import { WalletConnectZcashWalletAdapter } from
  '@rhea-finance/zcash-wallet-adapter/walletconnect';

const wallet = new WalletConnectZcashWalletAdapter({
  projectId: 'YOUR_REOWN_PROJECT_ID',
  onDisplayUri: (uri) => {
    // DApp implementation: render the complete URI as QR or use a wallet link.
    renderPairingQr(uri);
  },
});

// Call after a user clicks Connect; wait for mobile wallet approval.
await wallet.connect();
const balance = await wallet.getBalance();
const signed = await wallet.signMessage('Integration test: nonce-123', {
  signingMode: 'derived',
});
const txid = await wallet.signAndSendTransaction({
  to: 'REPLACE_WITH_VALID_MAINNET_ADDRESS',
  amount: '0.001',
  fundingSource: 'shielded',
});
```

`renderPairingQr` is a placeholder function implemented by the DApp. Production applications should bind actions to separate buttons, handle errors, and display approval and transaction states. React applications can use `WalletProvider` and `useWallet()`; the built-in wallet selector renders the QR code. See the [README](../README.md#walletconnect).

The adapter currently displays `Noir Wallet (WalletConnect)`, but transport compatibility depends on the namespace and methods, not the peer wallet's brand. Showing Zodl branding or a button that opens its mobile App requires additional DApp UI and wallet-link configuration; implementing wallet RPC does not add those features automatically.

## 8. Integration and Acceptance Checklist

This revision defines adapter-side protocol constraints; it is not a report of a completed Zodl integration. Native Swift/Kotlin sample applications and real-wallet end-to-end runs are separate follow-up deliverables. The wallet team owns its platform SDK and wallet implementation. Adapter contract tests can establish the behavior described in Section 3; they do not prove actual mobile authorization, signature verification, or on-chain delivery.

Agree on the test DApp URL, wallet installation link and version, device and OS, mainnet test amount, and recipient address before testing. A generic Ethereum WalletConnect test page does not replace Zcash RPC integration testing. Mainnet tests require a small amount of real ZEC plus fees.

| Test | Pass criteria |
| --- | --- |
| Desktop QR pairing | Phone receives a permission request; approval gives the DApp the correct chain and address pair |
| Same-phone deep link, if provided | Cold starts and background activation receive the complete URI; user can return or switch back to the DApp |
| Connection rejection and expired QR | Clear failure state; a new pairing can be initiated |
| Address and balance | Match the authorized account; amounts are ZEC strings; available excludes unspendable funds |
| Message signing | Test derived, current, and legacy_index0 separately; consuming verifier accepts valid signatures and rejects the wrong message |
| UTF-8 messages | Chinese, newlines, and long messages use byte lengths and agree with the verifier |
| Shielded and transparent funding | Test each supported source; return a real txid and verify confirmation and receipt |
| Signing or transfer rejection | Return an error without generating a signature or broadcasting; subsequent requests still work |
| Invalid parameters and insufficient funds | No broadcast; clear error; no silent funding-source change |
| App restoration and duplicate delivery | Sessions and requests recover; the same request cannot trigger duplicate transfers |
| Disconnect, revocation, and expiration | Both sides clear state; the old session cannot operate; a new connection succeeds |
| Account or network change | No spending from an old account authorization or wrong network; reauthorize as described in Section 6 |

Record device, wallet and DApp versions, actual results, and screenshots or recordings. For transfers, record txid, funding source, and confirmation status. For signatures, record the test message and verification result. Shielded receipt details may not be visible in a public explorer; verify them in the receiving wallet. Test evidence must not include private keys, recovery phrases, or complete pairing URIs.

## 9. Official Resources and Repository Implementation

Follow the official WalletConnect documentation for wallet initialization, pairing, proposal approval, request responses, and platform APIs:

- [React Native WalletKit usage](https://docs.walletconnect.com/wallets/react-native/usage)
- [Android WalletKit installation](https://docs.walletconnect.com/wallets/android/installation)
- [iOS WalletKit installation](https://docs.walletconnect.com/wallets/ios/installation)
- [Session namespace specification](https://github.com/WalletConnect/walletconnect-specs/blob/main/docs/specs/clients/sign/namespaces.md)

This guide describes the [WalletConnect adapter](../src/wallets/walletconnect/WalletConnectZcashWalletAdapter.ts) and its [tests](../src/wallets/walletconnect/WalletConnectZcashWalletAdapter.test.ts) at the implementation baseline and contract revision above. It also draws on the all-sdk-demo Zcash wallet integration specification and message-signing implementation. Pin the adapter version and source commit for partner integration. Agree explicitly on custom RPC and signature formats; SDK upgrades alone do not guarantee compatibility. For this revision, do not add a version field to RPC parameters or change their response shape.
