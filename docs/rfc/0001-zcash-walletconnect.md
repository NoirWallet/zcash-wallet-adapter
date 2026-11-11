# RFC 0001: Zcash Wallet Interoperability over WalletConnect v2

- Status: **Draft / Request for Comments**
- Draft date: **2026-11-11**
- Existing contract revision: **2026-11-10**
- Published reference implementation: **@rhea-finance/zcash-wallet-adapter 0.2.5**
- Reference source: [`f6938fd6ba3dfffb28bcc9609c0c5c2ff0c09679`](https://github.com/NoirWallet/zcash-wallet-adapter/commit/f6938fd6ba3dfffb28bcc9609c0c5c2ff0c09679)
- Discussion: [repository issues](https://github.com/NoirWallet/zcash-wallet-adapter/issues)

## Purpose and status

This draft invites Zcash wallet and DApp developers to review an interoperability
profile built on WalletConnect v2. It documents the published adapter's existing
application conventions and identifies decisions needed for broader adoption.
It has not been accepted as a Zcash ZIP, a CAIP profile, or an official
WalletConnect Zcash RPC standard. WalletConnect support alone does not implement
these custom methods. Mentioning a wallet, including Zodl, is not evidence that
it supports this profile or has committed to an integration.

The goal is a shared contract for authorization, account state, balance queries,
message signing, and wallet-confirmed transfers. The reference implementation
currently supports Zcash Mainnet, one logical account, and at most one selected
transparent and one selected shielded address. Testnet, PCZT signing, arbitrary
multi-account sessions, and complete support for all Unified Addresses are
outside this implementation's scope.

## Documents and protocol authority

The existing [session contract](../mobile-wallet-walletconnect.en.md#3-session-protocol-and-compatibility)
and [RPC contract](../mobile-wallet-walletconnect.en.md#5-zcash-rpc-contract)
define the 2026-11-10 profile. Their MUST requirements describe interoperability
with that implementation; they do not imply community ratification. This RFC
references those definitions rather than maintaining another copy of the method
schemas, error codes, signature encoding, or event payloads.

| Document | Role |
| --- | --- |
| [Wallet-side integration guide](../mobile-wallet-walletconnect.en.md) | Session, RPC, signing, error, and event contract; wallet responsibilities |
| [React DApp guide](../walletconnect-react.en.md) | Adapter registration, pairing UI, and DApp method examples |
| [Acceptance specification](../walletconnect-acceptance.en.md) | Required cases and evidence for a particular wallet/application build |

The profile uses `bip122:00040fe8ec8471911baa1db1266ea15d` and the four methods
`zcash_getAddress`, `zcash_getBalance`, `zcash_transfer`, and `zcash_signMessage`.
Both `accountsChanged` and `chainChanged` are required. New and restored sessions
have the same permission and address checks. Wallets retain custody of keys,
fully decode addresses, authorize account access, calculate balances and fees,
confirm signing/transfers, and broadcast transactions. An approved session does
not authorize automatic spending or signing.

The contract revision constant is documentation metadata, not a wire handshake.
This RFC introduces no new method, parameter, identity format, or version field.
Future incompatible changes need an explicit compatibility and capability design
before being implemented or advertised.

## Published baseline and reproducibility

As checked on **2026-11-11**, the [npm registry record](https://registry.npmjs.org/@rhea-finance%2fzcash-wallet-adapter/0.2.5)
reports version `0.2.5` and the source commit above. The downloaded package's
SHA-512 integrity was checked against that record:

```text
sha512-Lx9DMTJe+nAmuGXUonR4Y/GPPDRI0lItcwSCc2EFEJ+p7Lzuz2IHe4rrcLqfn2zxQYL1rBioyjOgZHAB7mqWCw==
```

Pin `@rhea-finance/zcash-wallet-adapter@0.2.5` for this baseline and record its
source commit, contract revision, and the integrating wallet's build. Later
`latest` releases or later source checkouts are separate artifacts. The RFC and
additional real-UA fixture tests are later source additions; they are not part
of the immutable `0.2.5` package. These additions do not change its runtime RPC
contract. Future package changes, including a project LICENSE, require a new
release; they cannot modify the already published tarball.

## Unified Address compatibility

The [address support matrix](../mobile-wallet-walletconnect.en.md#address-support-matrix)
is the current compatibility boundary. Session account identifiers embed a
payment address directly into CAIP-10, whose address segment is limited to
128 characters. ZIP 316 does not impose that CAIP-10 limit on UAs. Some valid UAs
fit; others cannot be represented by this session model.

The pinned [Zcash test vectors](../../src/wallets/walletconnect/__fixtures__/README.md)
include single Sapling and Orchard UAs of 106 characters, transparent-plus-shielded
UAs of 141, Sapling-plus-Orchard UAs of 178, and three-receiver UAs of 213. These
are concrete examples, not fixed lengths for every future UA. The tests preserve
the complete addresses: short examples work as session/getAddress values, long
examples fail those paths, and transfer recipients are forwarded unchanged.
This proves adapter boundaries, not checksum/receiver decoding or real payments.

A wallet whose user authorizes only an address outside this profile cannot
complete this account-authorization model. Truncating addresses, inventing hashes
as accounts, extracting/disclosing transparent addresses without consent, or
silently downgrading a requested funding pool are not compatible workarounds.

Full UA support needs a separately specified design. Community review should
resolve:

1. Whether session account identity and full receiving addresses should be
   distinct, and what valid chain-specific identity belongs in CAIP-10. A
   WalletConnect session public key is not proof of Zcash address ownership.
2. How a wallet authorizes and binds that identity to complete addresses, scopes
   their disclosure, and represents rotation and current selection.
3. Whether existing RPC shapes can remain meaningful, or a new method/revision
   is required; how capabilities are advertised and incompatible peers reject
   each other rather than silently interpreting different contracts.
4. How to preserve shielded privacy for wallets that do not expose transparent
   addresses, and whether the currently mandatory message-signing convention
   should become a negotiated capability in a future revision.
5. Which positive and negative address vectors, network/receiver checks, and
   wallet interoperability runs are required before claiming full UA support.

The current `u1` session prefix targets ZIP 316 Revision 0. Revision 2 is currently
listed as Draft in [ZIP 316](https://zips.z.cash/zip-0316); its `zu`/`tu` formats are
not implicitly added to this session profile. Transfer-recipient decoding and
receiver selection remain wallet responsibilities.

## Implementation and validation status

| Area | Status as of 2026-11-11 | Evidence and limits |
| --- | --- | --- |
| DApp adapter | Published reference implementation | `0.2.5`, source commit and package integrity above |
| Adapter protocol simulations | Passed locally in this RFC source checkout: 162 tests | `pnpm test`, `pnpm typecheck`, `pnpm build`; includes 19 added real-UA cases covering session/getAddress limits and recipient forwarding |
| Real UA fixtures | Adapter boundary tests included | Pinned upstream examples; no claim of wallet-side decoding or broadcast |
| React Native wallet example | Handler outline available | Requires an existing wallet engine; not a compiled or end-to-end tested wallet |
| Native Swift/Kotlin examples | Complete Zcash examples not provided | [Official platform references](../mobile-wallet-walletconnect.en.md#native-platform-references) and the shared protocol are available |
| Real Zodl mobile integration | **Not verified** | No wallet build or executed end-to-end report is recorded here |
| Community standardization | Draft for discussion | No acceptance or universal wallet compatibility is asserted |
| Project licensing | **Pending maintainer decision** | No project LICENSE or package license declaration selected; upstream fixture licensing is separate |

The acceptance document is a specification, not an executed wallet test report.
For a real integration, record the wallet and application builds, adapter version
and source commit, OS/browser, each case's Pass/Fail/Blocked result, signature
verification, and transaction broadcast/receipt evidence. Tests not run are not
Pass. Do not include private keys, recovery phrases, or complete pairing URIs.

## Decisions and next steps

Reviewers are invited to comment on the session/account model, complete-UA
support, signing capabilities and privacy, and compatibility negotiation. Native
wallet teams can map the existing contract onto the official platform SDKs and
supply test builds and acceptance results. A complete native example or a real
wallet result must be reviewed and recorded before its status changes above.

The repository maintainer still needs to select the project license and
copyright holder, then add a root LICENSE, package metadata, and README link and
check their inclusion in the next package. The selected upstream vectors retain
their own MIT notice; that notice does not license this adapter project. This
licensing decision is deferred and is not resolved by publishing an RFC draft.
