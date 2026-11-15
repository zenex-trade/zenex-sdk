import type { OrderParams } from '../contracts/router/types.js';
import type { ZenexError } from '../errors.js';
import { zenexErrorFromGate } from './internal/gate.js';
import { OrderKind } from '../contracts/market/types.js';
import { formatPrice, formatToken, formatTokenFloor } from '../float.js';
import type { Market } from './market.js';
import { MarketPosition } from './position.js';
import type { PositionEstimate } from './position_est.js';
import { estimatePosition } from './position_est.js';
import { Price, marketPrice, quoteTime, resolvePrice } from './price.js';
import type { PriceInput } from './price.js';
import type { MarketContext } from './internal/apply.js';
import {
    applyOrder,
    orderPriceBound as enginePriceBound,
} from './internal/apply.js';
import { entryTokens, quoteTradeFees } from './internal/math.js';
import {
    closePositionParams,
    decreasePositionParams,
    addMarginParams,
    withdrawMarginParams,
    openLimitParams,
    openMarketParams,
    openStopParams,
    stopLossParams,
    takeProfitParams,
    isDecreaseOrderKind,
    isIncreaseOrderKind,
    isMarketOrderKind,
    isTriggerOrderKind,
} from './internal/order.js';

export {
    isDecreaseOrderKind,
    isIncreaseOrderKind,
    isMarketOrderKind,
    isTriggerOrderKind,
};

/**
 * Default lifetime of a market order, in ledgers: about five minutes. A
 * market order is meant to fill at once, so a short lifetime keeps a missed
 * one from filling later at a price the user no longer expects.
 */
export const DEFAULT_ORDER_TTL_LEDGERS = 60;

/**
 * The `expiration` of an order that never expires: the largest `u32` ledger
 * sequence. A trigger order (limit and stop opens, take-profit, stop-loss)
 * rests until the price crosses it or the owner cancels it, so it does not
 * expire by default.
 *
 * The contract bounds `expiration` only from below: creation rejects one
 * behind the current ledger (`OrderExpired`, 731), an order fills through
 * its `expiration` ledger inclusive, and any later `u32` is accepted.
 */
export const NO_EXPIRY_LEDGER = 0xffff_ffff;

/**
 * Order factory bound to one ticket's context: a market snapshot, an owner,
 * and a side. Each method builds one complete, signable `OrderParams` in a
 * single call. Preview it with `previewOrder` or `position.preview`, then
 * sign the identical object.
 *
 * The bound market supplies what a caller would otherwise wire by hand:
 * `expiration` derives from `market.ledger` plus a lifetime, and a fill
 * bound derives from `slippageBps` against the execution price the kind
 * fills at. The lifetime depends on the kind: market orders (`openMarket`,
 * `closePosition`, `decrease`, `addMargin`, `withdrawMargin`) live
 * `ttlLedgers`, 60 by default, and trigger orders (`openLimit`, `openStop`,
 * `takeProfit`, `stopLoss`) never expire unless `triggerTtlLedgers` is set.
 * An expired order no longer fills and its escrow stays in the market until
 * the order is cancelled.
 * The methods also encode the contract's conventions that `OrderKind` alone
 * does not express: the `FULL_CLOSE` sentinel, margin-only orders as
 * `notional: 0n`, and the trigger-direction rules for entries and TP/SL.
 */
export class OrderIntent {
    constructor(
        /** Market snapshot expirations and price bounds derive from. */
        public market: Market,
        /** The order owner. */
        public user: string,
        /** Side every built order targets. */
        public isLong: boolean,
        /** Lifetime of a market order in ledgers (`expiration = market.ledger + ttlLedgers`). Defaults to {@link DEFAULT_ORDER_TTL_LEDGERS}, 60. */
        public ttlLedgers: number = DEFAULT_ORDER_TTL_LEDGERS,
        /** Default maximum adverse slippage, basis points (10_000 = 100%). 0 = unbounded, matching the contract's own default. */
        public slippageBps: bigint = 0n,
        /**
         * Lifetime of a trigger order in ledgers
         * (`expiration = market.ledger + triggerTtlLedgers`): limit and stop
         * opens, take-profit and stop-loss. Left out, a trigger order never
         * expires: its `expiration` is {@link NO_EXPIRY_LEDGER}. `ttlLedgers`
         * does not apply to these kinds.
         */
        public triggerTtlLedgers?: number,
    ) {}

    private base(
        ttlLedgers: number = this.ttlLedgers,
    ): { market: string; user: string; isLong: boolean; expiration: number } {
        return {
            market: this.market.id,
            user: this.user,
            isLong: this.isLong,
            expiration: this.market.ledger + ttlLedgers,
        };
    }

    /** The base of a trigger order: as `base`, with the trigger lifetime, or no expiry without one. */
    private triggerBase(): ReturnType<OrderIntent['base']> {
        if (this.triggerTtlLedgers === undefined) {
            return { ...this.base(), expiration: NO_EXPIRY_LEDGER };
        }
        const base = this.base(this.triggerTtlLedgers);
        return { ...base, expiration: Math.min(base.expiration, NO_EXPIRY_LEDGER) };
    }

    /** @throws {RangeError} when a slippage bound is configured but no price was given to measure it against. */
    private bound(
        kind: OrderKind,
        price?: PriceInput,
        slippageBps: bigint = this.slippageBps,
    ): bigint {
        if (slippageBps === 0n) return 0n;
        // A wound-down market fills at its terminal price, whatever the
        // caller passes, so the bound measures against that.
        const terminal = this.market.terminalPrice;
        const measured = terminal !== undefined ? Price.from(terminal) : price;
        if (measured === undefined) {
            throw new RangeError(
                'slippageBps is set, so a price is required to derive the fill bound',
            );
        }
        return orderPriceBound(measured, this.isLong, kind, slippageBps);
    }

    /** Open or increase a position at market. */
    openMarket(args: {
        /** Size to open, token-dec. */
        notional: bigint;
        /** Margin to escrow with the position, token-dec. */
        margin: bigint;
        /** Execution price the slippage bound is measured against. Required only when `slippageBps` is nonzero. */
        price?: PriceInput;
    }): OrderParams {
        return openMarketParams({
            ...this.base(),
            notional: args.notional,
            margin: args.margin,
            priceBound: this.bound(OrderKind.MarketIncrease, args.price),
        });
    }

    /**
     * Open once the price crosses the trigger FAVORABLY: `LimitIncrease`,
     * which a long fills at or below the trigger and a short at or above.
     * The bound is measured against the trigger.
     */
    openLimit(args: {
        /** Size to open, token-dec. */
        notional: bigint;
        /** Margin to escrow with the position, token-dec. */
        margin: bigint;
        /** Crossing price that makes the order eligible, 18-dec. Must be positive. */
        triggerPrice: bigint;
    }): OrderParams {
        return openLimitParams({
            ...this.triggerBase(),
            notional: args.notional,
            margin: args.margin,
            triggerPrice: args.triggerPrice,
            priceBound: this.bound(
                OrderKind.LimitIncrease,
                Price.from(args.triggerPrice),
            ),
        });
    }

    /**
     * Open once the price crosses the trigger ADVERSELY: `StopIncrease`, a
     * breakout entry that a long fills at or above the trigger and a short
     * at or below. The bound is measured against the trigger, so a nonzero
     * `slippageBps` caps how far past it a gap may fill; beyond that the
     * order rests (error 741) until the price comes back.
     */
    openStop(args: {
        /** Size to open, token-dec. */
        notional: bigint;
        /** Margin to escrow with the position, token-dec. */
        margin: bigint;
        /** Crossing price that makes the order eligible, 18-dec. Must be positive. */
        triggerPrice: bigint;
    }): OrderParams {
        return openStopParams({
            ...this.triggerBase(),
            notional: args.notional,
            margin: args.margin,
            triggerPrice: args.triggerPrice,
            priceBound: this.bound(
                OrderKind.StopIncrease,
                Price.from(args.triggerPrice),
            ),
        });
    }

    /**
     * Fully close the position at market. Encodes the `FULL_CLOSE` sentinel
     * (`2^127 - 1`) rather than the current size, so the close cannot turn
     * partial by racing a size change.
     */
    closePosition(price?: PriceInput): OrderParams {
        return closePositionParams({
            ...this.base(),
            priceBound: this.bound(OrderKind.MarketDecrease, price),
        });
    }

    /** Decrease at market, optionally withdrawing margin. A notional at or above the open size closes fully. */
    decrease(args: {
        notional: bigint;
        /** Margin to withdraw, token-dec. Defaults to 0 (keep the current margin). */
        margin?: bigint;
        /** Required only when `slippageBps` is nonzero. */
        price?: PriceInput;
    }): OrderParams {
        return decreasePositionParams({
            ...this.base(),
            notional: args.notional,
            margin: args.margin ?? 0n,
            priceBound: this.bound(OrderKind.MarketDecrease, args.price),
        });
    }

    /**
     * Add margin without changing size. Encodes the margin-only convention:
     * `MarketIncrease` with `notional: 0n` and the amount on `margin`.
     */
    addMargin(amount: bigint): OrderParams {
        return addMarginParams({ ...this.base(), amount });
    }

    /** Withdraw margin without changing size (`MarketDecrease`, `notional: 0n`). */
    withdrawMargin(amount: bigint): OrderParams {
        return withdrawMarginParams({ ...this.base(), amount });
    }

    /**
     * Close (part of) the position once the price crosses the trigger
     * FAVORABLY: `LimitDecrease`, which a long fills at or above the trigger
     * and a short at or below. It fills unbounded unless the call passes
     * `slippageBps`; the intent's own default does not apply.
     */
    takeProfit(args: {
        /** Crossing price, 18-dec. Must be positive. */
        triggerPrice: bigint;
        /** Size to close on trigger, token-dec. Defaults to `FULL_CLOSE`. */
        notional?: bigint;
        /** Maximum adverse slippage from the trigger, basis points. Defaults to `0n`, unbounded. */
        slippageBps?: bigint;
    }): OrderParams {
        return takeProfitParams({
            ...this.triggerBase(),
            triggerPrice: args.triggerPrice,
            notional: args.notional,
            priceBound: this.bound(
                OrderKind.LimitDecrease,
                Price.from(args.triggerPrice),
                args.slippageBps ?? 0n,
            ),
        });
    }

    /**
     * Close (part of) the position once the price crosses the trigger
     * ADVERSELY: `StopDecrease`, which a long fills at or below the trigger
     * and a short at or above. A stop exists to exit, so it fills unbounded
     * unless the call passes `slippageBps`; the intent's own default does not
     * apply. A nonzero bound keeps a stop that gaps past it from filling
     * (error 741) until the price recovers.
     */
    stopLoss(args: {
        /** Crossing price, 18-dec. Must be positive. */
        triggerPrice: bigint;
        /** Size to close on trigger, token-dec. Defaults to `FULL_CLOSE`. */
        notional?: bigint;
        /** Maximum adverse slippage from the trigger, basis points. Defaults to `0n`, unbounded. */
        slippageBps?: bigint;
    }): OrderParams {
        return stopLossParams({
            ...this.triggerBase(),
            triggerPrice: args.triggerPrice,
            notional: args.notional,
            priceBound: this.bound(
                OrderKind.StopDecrease,
                Price.from(args.triggerPrice),
                args.slippageBps ?? 0n,
            ),
        });
    }
}

/**
 * Derive the adverse `priceBound` for an order kind from a maximum slippage
 * in basis points against the execution price the kind fills at. Exposed for
 * callers writing `OrderParams` literals; `OrderIntent` applies it
 * internally.
 */
export function orderPriceBound(
    price: PriceInput,
    isLong: boolean,
    kind: OrderKind,
    maxSlippageBps: bigint,
): bigint {
    return enginePriceBound(resolvePrice(price), isLong, kind, maxSlippageBps);
}

/**
 * The transition record {@link previewOrder} returns: whether the order
 * fills, what it costs, and the resulting position when it does.
 */
export interface OrderEstimate {
    /** `fills`: exact transition below. `rests`: creates but does not fill at this price. `gate`: can never fill. */
    outcome: 'fills' | 'rests' | 'gate';
    /**
     * The gate when `outcome === 'gate'`, else `undefined`: `code` is the
     * mirrored contract error (e.g. 713), or an SDK sentinel
     * (`QuoteInvalidInput`, `QuoteOverflow`) for a failure the contract
     * never sees.
     */
    gate: ZenexError | undefined;
    /** Why a `rests` outcome rests at this price, else `undefined`. */
    reason: string | undefined;
    /** Skew-split base fee, token units. */
    baseFee: number;
    /** Size-quadratic impact fee, token units. */
    impactFee: number;
    /** Flat keeper execution fee escrowed with the order, token units. */
    execFee: number;
    /** baseFee + impactFee + execFee, token units. */
    totalFees: number;
    /** Funding settled by the fill over the pre-fill notional, token units. Positive is paid by the trader, negative earned. */
    funding: number;
    /** Borrowing settled by the fill, token units (never negative). */
    borrowing: number;
    /** Escrowed at creation: margin + execFee on an increase, execFee alone otherwise. Token units. */
    escrowed: number;
    /** Execution price the fill is sized at (entry side for an increase, exit side for a decrease). */
    executionPrice: number;
    /**
     * What a decrease pays out (the paid withdrawal plus the profit the fees
     * did not consume), token units. A full close also refunds the escrowed
     * fee of each pending decrease order it sweeps, which is not included.
     */
    payout: number;
    /** The position after the fill. `undefined` unless `outcome === 'fills'`; a full close yields a flat position. */
    position: PositionEstimate | undefined;
}

/**
 * @internal Assemble the engine's context record from the public objects.
 * The ledger time is `now` (default: the wall clock), never before the
 * market's stored accrual. A bare bigint price is stamped at that time, but
 * never behind the position's own last mark, since a keeper fills with a
 * report at least that fresh. A terminal price replaces `price` entirely.
 */
export function marketContext(
    market: Market,
    position: MarketPosition,
    price: PriceInput,
    now?: bigint,
    user = '',
): MarketContext {
    const ledgerTime = quoteTime(market, now);
    const stamp =
        position.pricedAt > ledgerTime ? position.pricedAt : ledgerTime;
    return {
        subject: { user, isLong: position.isLong },
        ledger: market.ledger,
        ledgerTime,
        status: market.status,
        config: market.config,
        market: market.data,
        position,
        price: marketPrice(market, price, ledgerTime, stamp),
        vault: market.vaultAtomic(),
        treasuryRate: market.treasuryRate,
        adl: market.adl,
        terminalPrice: market.terminalPrice,
    };
}

/**
 * The creation pre-flight: preview applying `order` (the same `OrderParams`
 * you will sign, e.g. from `OrderIntent`) to `position` at `price`. Runs
 * the exact fill engine, so what you preview is what the chain would do.
 * This catches what creation does not: the chain accepts orders that can
 * never fill (a decrease that would break the margin gate, error 713).
 *
 * @param price The fill price. A bare bigint is published at the quote
 *   time, but never behind the position's last fill. A market's terminal
 *   price replaces it.
 * @param now Quote time, unix seconds. Defaults to the wall clock and never
 *   reads earlier than the market's stored accrual.
 */
export function previewOrder(
    market: Market,
    position: MarketPosition,
    order: OrderParams,
    price: PriceInput,
    now?: bigint,
): OrderEstimate {
    const decimals = market.assetDecimals;
    const execFee = formatToken(market.config.execFee, decimals);
    const escrowedAtomic =
        (isIncreaseOrderKind(order.kind) ? order.margin : 0n) +
        market.config.execFee;
    const escrowed = formatToken(escrowedAtomic, decimals);

    const empty = {
        baseFee: 0,
        impactFee: 0,
        execFee,
        totalFees: execFee,
        funding: 0,
        borrowing: 0,
        escrowed,
        executionPrice: 0,
        payout: 0,
        position: undefined,
    };

    // One clock for the fill and the resulting position.
    const at = quoteTime(market, now);
    const context = marketContext(market, position, price, at, order.user);
    const applied = applyOrder(context, order, {
        executionFee: market.config.execFee,
    });

    if (applied.kind === 'rests') {
        return {
            outcome: 'rests',
            gate: undefined,
            reason: applied.reason,
            ...empty,
        };
    }
    if (applied.kind === 'gate') {
        return {
            outcome: 'gate',
            gate: zenexErrorFromGate(applied.code, applied.reason),
            reason: undefined,
            ...empty,
        };
    }

    const outcome = applied.outcome;
    const fees = outcome.fees;
    const post = MarketPosition.from(outcome.postPosition, position.isLong);
    return {
        outcome: 'fills',
        gate: undefined,
        reason: undefined,
        baseFee: formatToken(fees.base, decimals),
        impactFee: formatToken(fees.impact, decimals),
        execFee,
        totalFees: formatToken(
            fees.base + fees.impact + market.config.execFee,
            decimals,
        ),
        funding: formatToken(fees.funding, decimals),
        borrowing: formatToken(fees.borrowing, decimals),
        escrowed,
        executionPrice: formatPrice(outcome.executionPrice),
        payout: formatToken(outcome.walletPayout, decimals),
        position: estimatePosition(
            market.withData(outcome.postMarket),
            post,
            price,
            at,
        ),
    };
}

const LEVERAGE_SCALE = 10_000n;

/**
 * Largest position margin a wallet balance affords at a chosen leverage,
 * AFTER the opening fees: the margin the position holds once the fill has
 * debited them. The order ticket's "Max" button.
 *
 * This is not the order's `margin` argument. On chain an increase escrows
 * `margin + execFee` from the wallet, and the fill then takes the base and
 * impact fees out of that margin, so the position keeps `margin - fees`.
 * The result solves `balance = positionMargin + tradeFee(positionMargin *
 * leverage) + execFee` against the fee model (base fee at the side's rate
 * plus the size-quadratic impact fee).
 *
 * To spend the whole balance at the leverage, size the order from the
 * result and pass the fees along in the escrow:
 *
 * - `notional = result * leverage`
 * - `margin = balance - market.config.execFee`
 *
 * Passing the result itself as `margin` leaves the fees unspent in the
 * wallet and opens above the chosen leverage, since the fill debits them
 * from the smaller margin. At the market's maximum leverage that fill fails
 * the initial-margin gate (`InsufficientMargin`, 713).
 *
 * The fees are those of an open on a flat side at this snapshot. An
 * increase of an existing position also settles its pending funding and
 * borrowing out of the margin, which this does not count.
 *
 * @returns Token units, floor-rounded so the value round-trips through an
 *   input field and `parseAtomic` without exceeding the true maximum. `0`
 *   when the balance cannot cover the fees.
 */
export function maxMarginForBalance(
    market: Market,
    isLong: boolean,
    balance: bigint,
    leverage: number,
    price: PriceInput,
): number {
    if (balance <= market.config.execFee || leverage <= 0) return 0;
    const priceData = marketPrice(market, price, quoteTime(market));
    const entry = isLong ? priceData.ask : priceData.bid;
    if (entry <= 0n) return 0;
    const leverageScaled = BigInt(Math.round(leverage * Number(LEVERAGE_SCALE)));
    const budget = balance - market.config.execFee;

    const cost = (margin: bigint): bigint => {
        const notional = (margin * leverageScaled) / LEVERAGE_SCALE;
        const tokens = entryTokens(notional, entry, isLong);
        const fees = quoteTradeFees(
            market.data,
            market.config,
            isLong,
            notional,
            tokens,
        );
        return margin + fees.base + fees.impact;
    };

    // cost() grows monotonically with margin, so binary search the largest
    // margin whose all-in cost still fits the budget.
    let low = 0n;
    let high = budget;
    while (low < high) {
        const mid = low + (high - low + 1n) / 2n;
        if (cost(mid) <= budget) low = mid;
        else high = mid - 1n;
    }
    return formatTokenFloor(low, market.assetDecimals);
}
