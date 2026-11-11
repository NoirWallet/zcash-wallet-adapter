# Unified Address protocol fixtures

`unified-addresses.json` contains seven public address vectors selected from the
Zcash project's [Unified Address vectors](https://github.com/zcash/zcash-test-vectors/blob/113b3914c79dfe7eb68cb754cd7fea20b75e2e61/test-vectors/json/unified_address.json).
The source is pinned to commit `113b3914c79dfe7eb68cb754cd7fea20b75e2e61`.
`vectorIndex` is zero-based after the two header rows. Address strings are copied
unchanged; receiver labels and lengths are derived from those rows. Root seeds,
keys, and account derivation data are omitted.

The source is dual-licensed under MIT or Apache-2.0. These selected vectors are
used under its [MIT license](LICENSE-MIT), reproduced with the upstream copyright
notice. This license applies to the upstream fixture material only; it does not
select a license for the adapter repository.

Tests cover the adapter's 128-character session/getAddress limit and unchanged
transfer-recipient forwarding. Receiver labels describe the upstream vectors;
the adapter does not decode receivers, validate checksums, prove ownership, or
broadcast transactions in these tests. Synthetic 128/129-character boundary
fixtures in the test file remain separate from these real addresses.
