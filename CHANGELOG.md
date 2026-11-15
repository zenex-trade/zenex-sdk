# Changelog

## 1.0.0

The initial release of `@zenex-trade/zenex-sdk`: contract bindings,
ledger-state loaders and exact quotes for the Zenex perpetuals DEX on Stellar.

### Contracts

- Core contracts (market, strategy vault, factory, oracle, treasury,
  governance):
  [zenex-contracts](https://github.com/zenex-trade/zenex-contracts) v1.0.0.
  The committed specs are generated from its release assets.
- Market router and fee forwarder: the Zenex utility contracts v0.0.2.

### Requirements

- `@stellar/stellar-sdk` `>=16.0.0 <17.0.0` (peer). Version 17 changed the XDR
  API the SDK calls.
- Node 22 or later.

### Stability

Semver covers the root export and the `./errors` subpath.
