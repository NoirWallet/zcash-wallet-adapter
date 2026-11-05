# Zcash Mobile Wallet Integration with WalletConnect

This guide is for mobile wallet teams, such as Zodl, that already provide Zcash accounts, balance synchronization, and transactions. It explains how to act as a **WalletConnect v2 wallet responder** for DApps using `@rhea-finance/zcash-wallet-adapter`.

Mentioning Zodl does not imply an existing integration or commitment. The Zcash RPC methods below are interoperability conventions used by this adapter; they are not supported by every WalletConnect wallet or DApp. The current scope is **Zcash Mainnet**.

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

### Chain and Accounts

| Field | Value |
| --- | --- |
| Namespace | `bip122` |
| CAIP-2 chain ID | `bip122:00040fe8ec8471911baa1db1266ea15d` |
| Adapter's internal chain name | `zcash:mainnet` (not a replacement for the session's CAIP-2 ID) |
| CAIP-10 account | `<CAIP-2 chain ID>:<Zcash address>` |

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

**New sessions must support all four methods and both events above.** A required namespace cannot be approved by silently removing unsupported methods. Reject an incompatible proposal. Negotiating fewer capabilities requires changing the DApp's proposal configuration first.

The adapter's compatibility check for existing sessions requires only the first three methods. Some older sessions can therefore be restored without `zcash_signMessage`, but signing will fail. This restoration behavior is not the minimum requirement for a new integration.

The approved `namespaces.bip122` must contain the actual authorized accounts:

```ts
// Replace placeholders with real mainnet addresses for one logical account.
const approvedNamespace = {
  chains: ['bip122:00040fe8ec8471911baa1db1266ea15d'],
  methods: [
    'zcash_getAddress', 'zcash_getBalance',
    'zcash_transfer', 'zcash_signMessage',
  ],
  events: ['accountsChanged', 'chainChanged'],
  accounts: [
    'bip122:00040fe8ec8471911baa1db1266ea15d:<shielded-address>',
    'bip122:00040fe8ec8471911baa1db1266ea15d:<transparent-address>',
  ],
};
```

Return both shielded and transparent addresses where available so the corresponding DApp fields can be populated. The current adapter maps these addresses to one logical account; do not mix multiple independent wallet accounts. Validate the network and actual receiver support in the wallet. A Unified Address prefix alone does not guarantee a particular receiver type.

## 4. Wallet Implementation Flow

Use the official WalletKit SDK for your platform. Follow its documentation for dependency versions, initialization, and storage. The following is platform-independent pseudocode, not compilable native SDK code.

```text
App startup
  -> Initialize one shared wallet client with project ID and wallet metadata
  -> Register proposal, request, deletion, and expiration listeners
  -> Restore sessions and pending requests

Receive a scanned, pasted, or deep-linked URI
  -> Validate the URI and call pair(uri)
  -> Receive session_proposal
  -> Validate chain, methods, events, and available accounts
  -> Show permissions to the user
  -> Approved: approveSession(id, namespaces)
  -> Rejected or incompatible: rejectSession(id, reason)

Receive session_request
  -> Validate topic, session expiry, chainId, authorized method, and account
  -> Dispatch to the wallet's Zcash implementation
  -> Wait for unlock, user approval, and processing as needed
  -> respondSessionRequest(topic, { id, jsonrpc: '2.0', result OR error })
```

Implementation requirements:

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

The current adapter sends `{}`. Return the authorized account's default address, preferably shielded. Wallets may additionally accept `type: 'shielded' | 'transparent'`, but the adapter's current `getAddress()` does not send that option.

```json
{
  "account": "bip122:00040fe8ec8471911baa1db1266ea15d:<address>",
  "address": "<address>",
  "type": "shielded"
}
```

Initial connection addresses come primarily from session accounts. This RPC does not replace correctly populated accounts in the approved session.

### `zcash_getBalance`

Request parameters: `{}`. Return all of these fields where possible, using strings:

```json
{
  "transparent": "0.1",
  "shielded": "0.2",
  "total": "0.3",
  "spendable": "0.29",
  "available": "0.29"
}
```

These represent transparent, shielded, total, spendable, and available balances. Calculate them from the wallet's actual synchronization and locking state; never label unspendable funds as available just to fill a field. The adapter tolerates missing fields but does not recalculate the total. Returning only the legacy `confirmed` field is discouraged.

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

| Scenario | Recommended handling |
| --- | --- |
| User rejects an authorized method request | JSON-RPC error, for example `5000`, with a clear message |
| Unsupported method | `4200`; do not advertise an unimplemented method during proposal approval |
| Invalid parameters | `-32602`, identifying the invalid field |
| Insufficient funds, network, proof, or broadcast failure | Structured error with a meaningful reason; no fabricated txid |
| Unsupported required chain, method, or event | Reject the proposal using the SDK's appropriate standard reason |

These application error codes are integration recommendations. Use the selected SDK's standard error types for session and lifecycle failures. Always respond to rejected or failed requests rather than leaving the DApp waiting indefinitely.

## 6. Events, Account Switching, and Network Limits

Emit `accountsChanged` and `chainChanged` under the authorized session's mainnet chain ID. When the user revokes a connection, use the SDK's session-disconnect API; the DApp clears its state on session deletion.

The current adapter accepts a single address, CAIP-10 string, or `{ address, account? }` for `accountsChanged`. For arrays it uses only the first item. **This event currently cannot reliably refresh both shielded and transparent addresses together**, and the adapter does not have a general session-update listener to rebuild the complete account. For account switching, disconnect and obtain a new authorization so session accounts provide the complete address pair.

For `chainChanged`, return the mainnet CAIP-2 ID. The current adapter does not support Zcash Testnet. It reports unsupported network changes, but wallets must not assume this automatically blocks every later DApp operation. Reject requests for a mismatched network or disconnect the mainnet session.

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

- [React Native wallet usage](https://github.com/WalletConnect/walletconnect-docs/blob/main/docs/walletkit/react-native/usage.mdx)
- [Android wallet usage](https://github.com/WalletConnect/walletconnect-docs/blob/main/docs/walletkit/android/usage.mdx)
- [WalletKit documentation, including other platforms](https://github.com/WalletConnect/walletconnect-docs/tree/main/docs/walletkit)
- [Session namespace specification](https://github.com/WalletConnect/walletconnect-specs/blob/main/docs/specs/clients/sign/namespaces.md)

This guide describes the [WalletConnect adapter](../src/wallets/walletconnect/WalletConnectZcashWalletAdapter.ts) and its [tests](../src/wallets/walletconnect/WalletConnectZcashWalletAdapter.test.ts) as of this document's commit. It also draws on the all-sdk-demo Zcash wallet integration specification and message-signing implementation. Pin the adapter version or commit for partner integration. Agree explicitly on versions of custom RPC and signature formats; SDK upgrades alone do not guarantee compatibility.
