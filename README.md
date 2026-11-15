# @zenex-trade/zenex-sdk

TypeScript SDK for the Zenex perpetuals DEX on Stellar (Soroban). It binds
every deployed Zenex contract, loads market and user state straight from the
ledger, and quotes orders with an exact engine that mirrors the on-chain math:
a preview that says an order fills, fills on chain with the same numbers.

1.0.0 binds the mainnet contracts: the core release (market, strategy vault,
factory, oracle, treasury, governance), which is
[zenex-contracts](https://github.com/zenex-trade/zenex-contracts) v1.0.0, and
the market router and fee forwarder, which are the Zenex utility contracts
v0.0.2. See [Versioning](#versioning).

## Install

```bash
npm install @zenex-trade/zenex-sdk @stellar/stellar-sdk@^16
```

- `@stellar/stellar-sdk` is a peer dependency, `>=16.0.0 <17.0.0`. Version
  17 changed the XDR API the SDK calls.
- Node 22 or later, the same floor as stellar-sdk 16.
- Browsers need no Node polyfills: the SDK imports `Buffer` from the
  `buffer` package.
- ESM and CommonJS, each with its own type declarations.
  `@zenex-trade/zenex-sdk/errors` is a standalone, import-free error
  catalog.
- The public API is the root export and `./errors`. Nothing else is
  importable, and semver covers only those two (see
  [Versioning](#versioning)).

## Conventions

- Amounts, prices and rates are `bigint`. Token amounts carry the token's
  decimals (7 for the settlement token), prices are 18-decimal, and rates and
  fractions are `SCALAR_18` fixed point. Estimates and previews also report
  `number` fields for display. Never feed a display number back into a
  transaction.
- A `Price` carries the bid and ask the market fills at. The oracle narrows
  every report's spread before the market sees it, so build a price from a raw
  report with `market.priceFromReport(bid, ask, publishTime)`. A bare `bigint`
  is a mid price with no spread.
- Every contract method returns a base64 XDR operation. You build, sign and
  submit the transaction with stellar-sdk.
- The SDK ships no contract addresses. You pass them in, and
  `Market.resolveContracts` derives the rest of a market's wiring from its id.

## Load a market

```ts
import { Networks } from '@stellar/stellar-sdk';
import { Market } from '@zenex-trade/zenex-sdk';

const network = { rpc: RPC_URL, passphrase: Networks.PUBLIC };

// One read: the market instance names its own vault, token, oracle and treasury.
const contracts = await Market.resolveContracts(network, MARKET_ID);

// One getLedgerEntries round trip for the market and the user together.
const { market, user } = await Market.loadWithUser(network, contracts, USER);
```

`Market.load(network, contracts)` reads the market alone. Pass the full
wiring that `resolveContracts` returns: without `oracle` and `treasury` the
load needs a second round trip to find them.

A `Market` holds the config, the market data, the status, the vault balance
and share supply, the treasury rate and the oracle's spread reduction factor.
On a market that is winding down it also holds `delistedAt` and, once set,
`terminalPrice`. A load fails closed with a `MarketStateError`: `MISSING_STATE`
if market-level state is absent or archived, `IDENTITY_MISMATCH` if an address
you passed disagrees with the market's own wiring.

A `Market` is an immutable snapshot with readonly fields, and it holds no
network. To build one by hand, for a test or from indexed state, pass its
fields as one object: `new Market({ id, ledger, config, data, treasuryRate,
... })`. `treasuryRate` is required, because a rate of 0 overstates a redeem
quote. Derive a changed copy by spreading: `new Market({ ...market, status })`.
The nested `config`, `data` and `adl` are frozen copies, so a write to one of
their fields throws, and the objects you passed in stay yours.

A `MarketUser` holds both positions (`user.long`, `user.short`), the order
counter, and claimable credit. After about 120 idle days a user's entries
archive. They still load from the archived values and are listed in
`user.archived`; the next transaction that touches them restores them.
`user.loadOrders(network)` lists pending orders straight from the chain.
`MarketUser.load(network, market.id, USER)` reads a user alone.

Build a position from a stored row with `MarketPosition.from(row, isLong)`,
or an empty side with `MarketPosition.zero(isLong)`. Like `Market`,
`MarketPosition` and `MarketUser` have readonly fields and take them as one
object, for a test or for state you indexed yourself:

```ts
const position = new MarketPosition({ isLong: true, margin, notional, tokens, ...rest });
const larger = new MarketPosition({ ...position, margin: position.margin + added });
const user = new MarketUser({
    marketId, userId, long: position, short: MarketPosition.zero(false),
    orderCounter: 1, claimableCredit: 0n,
});
```

## Preview an order

`OrderIntent` builds complete `OrderParams` for one market, owner and side:
the expiration comes from `market.ledger` plus a lifetime, and the fill bound
from `slippageBps`. `previewOrder` runs the exact engine over it.

```ts
import { OrderIntent, previewOrder } from '@zenex-trade/zenex-sdk';

const price = market.priceFromReport(report.bid, report.ask, report.publishTime);

// Market orders live 60 ledgers; 1% maximum slippage.
const intent = new OrderIntent(market, USER, true, 60, 100n);
const order = intent.openMarket({
    notional: 1_000_0000000n, // 1,000 USDC of size
    margin: 100_0000000n, // 100 USDC of margin
    price,
});

const preview = previewOrder(market, user.long, order, price);
if (preview.outcome === 'gate') throw preview.gate; // a ZenexError with the contract's code
// 'fills': preview.position is the exact position after the fill.
// 'rests': the order is valid but does not fill at this price (preview.reason).
```

The engine checks the contract's gates in the contract's order and returns
the contract's error code. Creating an order succeeds even when it can never
fill (for example a decrease that would break the margin floor, error 713),
so the preview is where you find out. Sign exactly the `OrderParams` you
previewed.

The other builders are `openLimit`, `openStop`, `closePosition`
(`FULL_CLOSE`, so the close stays whole if the size changes), `decrease`,
`addMargin`, `withdrawMargin`, `takeProfit` and `stopLoss`.

An order's lifetime depends on its kind:

| Kinds | Constructor argument | Default |
|---|---|---|
| Market: `openMarket`, `closePosition`, `decrease`, `addMargin`, `withdrawMargin` | `ttlLedgers` (4th) | 60 ledgers, about 5 minutes |
| Trigger: `openLimit`, `openStop`, `takeProfit`, `stopLoss` | `triggerTtlLedgers` (6th) | never expires (`NO_EXPIRY_LEDGER`) |

The contract accepts any expiration at or after the current ledger, and an
order fills through its expiration ledger. An expired order never fills, and
its escrow stays in the market until the order is cancelled.

`maxMarginForBalance` sizes the largest open a wallet balance affords at a
leverage, spending the whole balance. It returns three exact amounts in
atomic units:

| Field | Meaning |
|---|---|
| `notional` | the order's `notional` |
| `orderMargin` | the order's `margin`: `balance - execFee`, since the wallet pays `margin + execFee` |
| `positionMargin` | the margin the position holds after the fill, which takes the trade fees out of the order's margin |

```ts
import { maxMarginForBalance, formatTokenFloor } from '@zenex-trade/zenex-sdk';

const max = maxMarginForBalance(market, true, balance, 5, price);
const order = intent.openMarket({ notional: max.notional, margin: max.orderMargin });
formatTokenFloor(max.positionMargin, market.assetDecimals); // the margin to display
```

The order escrows exactly `balance` and opens at or under the leverage. A
leverage above what the market's initial margin allows is capped at that
maximum, so the order passes the margin gate (713). Do not pass
`positionMargin` as the order's `margin`: the fill would take the fees out of
it again.

For amounts, parse what the user typed with `parseAtomic(text, decimals)`,
which is exact. `toFixed(number, decimals)` converts a number that is already
a float, rounding to the nearest unit; floats are lossy, so do not route text
through it.

## Submit an order

There are three ways to put an order on chain.

**Resting order.** The user calls the market directly, and a keeper fills the
order once it is eligible.

```ts
import { MarketContract } from '@zenex-trade/zenex-sdk';

const createOp = new MarketContract(order.market).createOrder(
    order.user, order.isLong, order.kind, order.notional, order.margin,
    order.triggerPrice, order.priceBound, order.expiration,
);
```

**Create and fill in one transaction.** The market router creates the order
and fills it against a signed price report. The router has two variants:
`createAndFill` is fill-or-kill, and `createAndTryFill` leaves the order
resting if the fill misses.

```ts
import { MarketRouterContract, createOrderCall, simulateAndParse } from '@zenex-trade/zenex-sdk';

const router = new MarketRouterContract(ROUTER);
const fillOp = router.createAndFill([createOrderCall(order)], USER, USER, priceReport);

// The user's create_order authorization sits below the router's root call,
// so simulate with record_allow_nonroot.
const simulated = await simulateAndParse(
    network,
    fillOp,
    MarketRouterContract.parsers.createAndFill,
    { authMode: 'record_allow_nonroot' },
);
```

The same auth tree means stellar-sdk's `prepareTransaction` cannot prepare
this call. Simulate with `record_allow_nonroot` and assemble with
`rpc.assembleTransaction`. Passing the user as the keeper returns the fill
reward to the user.

**Relayed (gasless).** The fee forwarder wraps a router call, and a relayer
submits it and takes a fee from the user in the same transaction.

```ts
import { FeeForwarderContract, createOrderCall } from '@zenex-trade/zenex-sdk';

const fee = {
    feeToken: TOKEN,
    feeAmount: 1_0000000n, // set by the relayer
    maxFeeAmount: 2_0000000n, // signed by the user
    expirationLedger: market.ledger + 100,
    feeRecipient: RELAYER,
};
const relayOp = new FeeForwarderContract(FORWARDER).forwardCreateAndFill(
    ROUTER, [createOrderCall(order)], USER, USER, priceReport, fee,
);
// The arguments the user signs:
const signed = FeeForwarderContract.authorizedArgs('create_and_fill', ROUTER, [createOrderCall(order)], fee);
```

`forwardMulticall` relays a plain batch such as cancels, and the user signs
the calls themselves. The create-and-fill routes go through
`forward_dynamic`: the user signs the fee terms and the router target but not
the calls, the keeper or the price. A relayer can change those and still
collect the fee. The order's own authorization and its `priceBound` still
bind the fill.

## From an operation to a submitted transaction

Every binding returns a base64 XDR operation, and the SDK stops there: it
never signs or submits. The rest is plain `@stellar/stellar-sdk`. This is the
whole path for the resting order above.

```ts
import { BASE_FEE, Keypair, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';
import { MarketContract, parseError, parseResult } from '@zenex-trade/zenex-sdk';

const server = new rpc.Server(network.rpc);

// 1. Build a transaction around the operation.
const account = await server.getAccount(USER);
const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
})
    .addOperation(xdr.Operation.fromXDR(createOp, 'base64'))
    .setTimeout(60)
    .build();

// 2. Simulate. The result carries the footprint, the resource fee and the
//    authorization entries; assembleTransaction puts them on the transaction.
const simulated = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(simulated)) throw parseError(simulated);
const prepared = rpc.assembleTransaction(tx, simulated).build();

// 3. Sign. A wallet does this in a browser.
prepared.sign(Keypair.fromSecret(SECRET));

// 4. Send, then wait for the ledger to close.
const sent = await server.sendTransaction(prepared);
if (sent.status === 'ERROR') throw parseError(sent);
const final = await server.pollTransaction(sent.hash);
if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw final.status === rpc.Api.GetTransactionStatus.FAILED
        ? parseError(final)
        : new Error(`transaction ${sent.hash} not found`);
}
const orderId = parseResult(final, MarketContract.parsers.createOrder);
```

A failed simulation names the contract's error code. A failed transaction
does not: the ledger records only that the invocation trapped, so simulate
first.

**Where the price report comes from.** `createAndFill`, the keeper fills and
`OracleContract.verifyPrice` take a `priceReport`: the signed
[Chainlink Data Streams](https://docs.chain.link/data-streams) report for the
market's stream, `market.feedId`, as raw bytes. You fetch it from the Data
Streams API with your own credentials, or from a service that relays it; the
SDK does not fetch reports. The same report holds the `bid`, `ask` and
observation timestamp that `market.priceFromReport` takes, so the preview and
the fill price off one report. The oracle rejects a report older than its
staleness window, at most 15 seconds for a fill (`OraclePriceStale`, 782), so
fetch it just before you simulate.

For a router call, simulate with `simulateAndParse(..., { authMode:
'record_allow_nonroot' })` as shown above, or pass the same auth mode to
`server.simulateTransaction(tx, undefined, 'record_allow_nonroot')`, and
assemble the same way.

## Vault orders

Deposits and redeems are orders that a keeper fills.

```ts
import { VaultOrderIntent, VaultOrderKind } from '@zenex-trade/zenex-sdk';

// 100 USDC in, at most 0.5% below the expected share output.
const deposit = VaultOrderIntent.create(market, USER, VaultOrderKind.Deposit, 100_0000000n, 50n, price);
const advice = deposit.fills(market, price);
const depositOp = deposit.toOperation();
```

`minOut` is what the fill must pay, net of the vault fee: the shares a
deposit mints, or the assets a redeem pays. A keeper fill quoted below it
rejects the order. The principal returns to the user, the escrowed execution
fee goes to the keeper, and the market emits `reject_vault_order`. The vault
balance cap, the deposit pending-PnL gate and the redeem exit gates revert
instead, and the order keeps resting. `fills` is advisory: it reports whether
a fill at `price` would succeed, be rejected or revert. A redeem on a
`Retired` market fills at creation, with no execution fee and no `minOut`.

A fill prices shares on the vault balance net of trader PnL at the mark, plus
the vault's share of the borrowing positions have accrued and not yet settled
(`market.pendingBorrowing()` less the treasury cut). A deposit does not fill
while either side's unrealized profit is above `maxPnlTrader` of half the
vault (`PendingPnlExceeded`, 754). Shares carry 13 decimals: the vault's
decimals offset is fixed at 6.

`VaultOrderIntent.create`, `expectedOut` and `fills` accrue the market to
their own time first, as the fill does, so their quotes count the borrowing
accrued since the last on-chain accrual. Each takes an optional trailing
`now` (unix seconds, default the wall clock): `create` and `expectedOut`
quote at `now`, and `fills` evaluates at the earliest legal fill after it. A
fill lands later than the quote and accrues further, which lowers a deposit's
quote, so a deposit bound needs room for the borrowing of the wait.
`market.netPnl`, `pendingBorrowing`, `assetsToShares` and `sharesToAssets`
read the market as loaded: pass `market.accrue(price)` to count the borrowing
accrued since.

## Estimates

`estimateMarket(market, price)` and `estimatePosition(market, position, price)`
report display values at one price: utilization, funding and borrowing rates,
open capacity, share price, equity, health factor, liquidation price and the
maximum withdrawable amounts. `MarketPosition` and `Market` expose the same
quantities as methods. They are estimates for display; transactions quote
through `previewOrder`.

## Errors

`ZenexError` carries a `ZenexErrorCode`. The catalog covers every contract
the SDK binds, and the contracts a Zenex transaction passes through without
the SDK binding them: the settlement token, the price verifier behind the
oracle, and the smart-account wallet with its session policy and referral
contracts.

| Range | Source |
|---|---|
| 1-13 | Stellar Asset Contract (the settlement token) |
| 2-18 | Chainlink Data Streams verifier, called by the oracle |
| 100-114, 400-410 | vault share token |
| 600 | shared admin |
| 700-772 | market |
| 780-793 | oracle |
| 800-803 | strategy vault |
| 810-812 | governance |
| 900 | treasury |
| 2100-2102, 2200-2203 | ownership and role transfer |
| 3000-3016 | smart account |
| 4002-4007 | session policy |
| 5000-5006 | fee abstraction |
| 6001-6002 | fee forwarder |
| 7001 | referral |

The catalog also covers host and transaction codes and a few SDK-side
sentinels (negative codes).

```ts
import { parseError, ZenexErrorCode } from '@zenex-trade/zenex-sdk';

const sent = await server.sendTransaction(tx);
if (sent.status === 'ERROR') {
    const error = parseError(sent); // never throws
    if (error.code === ZenexErrorCode.InsufficientMargin) { /* ... */ }
}
```

`simulateAndParse` throws a `ZenexError` with the decoded code, and the raw
RPC text on `cause`. `parseContractErrorCode` reads the code of the error
that ended a simulation: the leading host error decides, and a contract error
the invocation caught and survived, which appears only in the event log, is
not reported.

**Codes 2-13 have two meanings.** The token and the price verifier both use
them, and the oracle passes the verifier's code through unchanged: 10 is an
insufficient balance from the token and a deactivated signing config from the
verifier.

On a failed simulation, `parseError` and `simulateAndParse` decide which one
it is from the simulation itself. Its diagnostic events name the contract
that raised the error and the call it was raised in: the verifier's `verify`,
or a token function such as `transfer`. This also holds for a call that does
both, such as `createAndFill` or a fee forwarder relay, where no caller-side
guess would be right:

```ts
const simulation = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(simulation)) {
    const error = parseError(simulation);
    error.source; // 'token' or 'verifier' for a code in 2-13
    error.codeName; // 'BalanceError', or 'VerifierDigestInactive'
}
```

The number alone never decides. When the events do not show the failing
call, the error is marked `ambiguous`: `codeName` joins both names
(`OverflowError|VerifierBadVerification`) and the message states both
meanings. `error.code` still equals the token member of `ZenexErrorCode`, so
check `error.ambiguous` or `error.source` before acting on a code in that
range. That is the case for a bare code, and for an error text with no event
log: the RPC's simulation error string carries none, so keep the response and
not only its `error` text.

You can also say which one you expect, and a hint overrides the events:

```ts
import { inferErrorSource, parseError } from '@zenex-trade/zenex-sdk';
import { zenexErrorFromCode } from '@zenex-trade/zenex-sdk/errors';

zenexErrorFromCode(12, 'verifier').codeName; // 'VerifierBadVerification'
zenexErrorFromCode(12, 'token').codeName; // 'OverflowError'
parseError(simulation, 'verifier'); // the hint wins
inferErrorSource(text); // from a text that includes the host's event log, as the CLI prints
```

`ZenexError` and `MarketStateError` are each defined once per build, so
`instanceof` does not hold across the ESM and CommonJS builds: compare
`error.name` (`'ZenexError'`, `'MarketStateError'`) or `error.code`.

## Events

Every event the bound contracts emit has a TypeScript type: `MarketEvent`,
`VaultEvent`, `FactoryEvent`, `GovernanceEvent`, `OracleEvent`,
`TreasuryEvent`, `FeeForwarderEvent` and `OwnableEvent`, all collected in
`ZenexEvent` and keyed by an `eventType` enum. The SDK ships types only, with
no decoder: you read events from RPC or an indexer and map them onto these
shapes. The mapping rules:

- Wire field names become camelCase.
- A market event's `id` becomes `orderId`.
- Some fields are derived rather than on the wire. For example, `source`
  tells a keeper fill from an ADL close by whether `id` is 0.

Each event's doc states its topics and fields.

## Contract bindings

| Class | Contract |
|---|---|
| `MarketContract` | market: orders, vault orders, keeper fills, liquidations, ADL, views, admin |
| `VaultContract` | strategy vault (the share token) |
| `FactoryContract` | factory: deploys a market with its vault |
| `OracleContract` | oracle: report verification and its settings |
| `TreasuryContract` | treasury: protocol fee rate and withdrawals |
| `GovernanceContract` | governance: timelocked calls |
| `MarketRouterContract` | market router: batches and create-and-fill |
| `FeeForwarderContract` | fee forwarder: relayed router calls |

Each class decodes results through `Class.parsers` and exposes its contract
spec as `Class.spec`. Ledger key builders (`marketPositionLedgerKey` and the
others) and instance parsers (`parseMarketInstance` and the others) support
custom reads.

## Versioning

The package follows semver. The contract covers what the root export
(`@zenex-trade/zenex-sdk`) and `@zenex-trade/zenex-sdk/errors` export and
document. Deep imports are blocked by the package's export map, and members
marked internal are stripped from the type declarations.

Each SDK release binds one release of the contracts, whose interface and
math it mirrors:

| SDK | Core contracts ([zenex-contracts](https://github.com/zenex-trade/zenex-contracts)) | Utility contracts (market router, fee forwarder) |
|---|---|---|
| 1.0.0 | v1.0.0 | v0.0.2 |

- A contract release that changes an interface, an error code, an event or
  the fill math needs a new SDK release. Until you upgrade, previews can
  disagree with the chain.
- The SDK takes a new major version when that contract release breaks the
  SDK's own API, and a minor or patch version otherwise.
- [CHANGELOG.md](./CHANGELOG.md) lists each release and the contracts it
  binds.

1.0.0 is the first release on npm.

## Development

```bash
npm test
npm run typecheck          # src and test
npm run lint
npm run architecture:check
npm run build
npm run specs:check        # needs the release WASMs, see below
```

`specs:check` compares the committed contract specs with the release WASMs,
and `specs:generate` rewrites them. Both read two directories:

- `ZENEX_CONTRACTS_WASM_DIR`: the core contracts. Download the assets of the
  bound [zenex-contracts release](https://github.com/zenex-trade/zenex-contracts/releases)
  into one directory. The script finds each contract under its published
  name (`market_v1.0.0.wasm`, `strategy-vault_v1.0.0.wasm`) or its plain
  crate name (`strategy_vault.wasm`), so a local build output works as well.
- `ZENEX_UTIL_CONTRACTS_WASM_DIR`: the market router and fee forwarder WASMs
  of the bound utility-contracts release, found by the same naming rule.
  `ZENEX_UTIL_CONTRACTS_ROOT` names a source checkout instead and reads its
  `target/wasm32v1-none/release`.

```bash
gh release download v1.0.0 --repo zenex-trade/zenex-contracts --dir ./release-wasm
ZENEX_CONTRACTS_WASM_DIR=./release-wasm \
ZENEX_UTIL_CONTRACTS_WASM_DIR=/path/to/utility-wasm \
npm run specs:check
```

`npm run live:check` validates a build, read-only, against a live market: set
`ZENEX_RPC` and `ZENEX_MARKET`, and see the header of
`scripts/live-check.mjs` for the rest.

## License

MIT
