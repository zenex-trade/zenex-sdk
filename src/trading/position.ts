import type { OrderParams } from '../contracts/router/types.js';
import type { Position } from '../contracts/market/types.js';
import { SCALAR_18, mulDivCeil } from '../math/fixed.js';
import type { Market } from './market.js';
import type { OrderEstimate } from './order.js';
import { previewOrder } from './order.js';
import type { PositionEstimate } from './position_est.js';
import { estimatePosition } from './position_est.js';
import type { PriceInput } from './price.js';
import { marketPrice, quoteTime, resolvePrice, wallClock } from './price.js';
import { exitPrice } from './internal/math.js';
import {
    impliedEntryPrice,
    liquidationPrice,
    liquidationState,
    pendingBorrowing,
    pendingFunding,
    positionEquity,
    positionPnl,
    unlockedNotional,
} from './internal/position.js';

/**
 * The fields of a {@link MarketPosition}, as its constructor takes them: a
 * stored position row plus the side it was stored under. Derive a changed
 * copy by spreading a position: `new MarketPosition({ ...position, margin })`.
 */
export interface MarketPositionFields {
    /** The side this row was stored under. */
    readonly isLong: boolean;
    /** Posted margin, token-dec. */
    readonly margin: bigint;
    /** Open size, token-dec. Zero means no open position. */
    readonly notional: bigint;
    /** Base size, token-dec. */
    readonly tokens: bigint;
    /** Funding index snapshot at the last change. */
    readonly fundingIdx: bigint;
    /** Borrowing index snapshot at the last change. */
    readonly borrowingIdx: bigint;
    /** Notional under the decrease lock, token-dec. */
    readonly lockedNotional: bigint;
    /** Unix seconds the decrease lock lapses at. */
    readonly unlocksAt: bigint;
    /** Unix seconds of the last pricing touch. */
    readonly pricedAt: bigint;
    /** Ids of pending decrease orders riding this side. */
    readonly decreaseOrders: readonly number[];
}

/**
 * One stored position that knows its side. `MarketUser.load` stamps `isLong`
 * from the storage key it read, so the methods never ask for it. All exact
 * bigints; the float view of the same numbers is `PositionEstimate`. Plain
 * readonly fields, with its own copy of `decreaseOrders`.
 *
 * Methods that take a `market` measure against it as passed. Accrue first
 * (`market.accrue(price)`) when you want fill-grade numbers.
 *
 * Build one with {@link MarketPosition.from} from a stored row, with
 * {@link MarketPosition.zero} for an empty side, or from its fields with
 * `new MarketPosition({ ... })`.
 */
export class MarketPosition implements MarketPositionFields {
    /** The side this row was stored under. */
    readonly isLong: boolean;
    /** Posted margin, token-dec. */
    readonly margin: bigint;
    /** Open size, token-dec. Zero means no open position. */
    readonly notional: bigint;
    /** Base size, token-dec. */
    readonly tokens: bigint;
    /** Funding index snapshot at the last change. */
    readonly fundingIdx: bigint;
    /** Borrowing index snapshot at the last change. */
    readonly borrowingIdx: bigint;
    /** Notional under the decrease lock, token-dec. */
    readonly lockedNotional: bigint;
    /** Unix seconds the decrease lock lapses at. */
    readonly unlocksAt: bigint;
    /** Unix seconds of the last pricing touch. */
    readonly pricedAt: bigint;
    /** Ids of pending decrease orders riding this side. The position's own copy of the list. */
    readonly decreaseOrders: number[];

    /**
     * Build a position from its fields. `decreaseOrders` is copied.
     * @throws {TypeError} if called without a fields object, such as with
     *   the positional arguments it took before 1.0.0.
     */
    constructor(fields: MarketPositionFields) {
        // The constructor took ten positional arguments before 1.0.0.
        // Called that way from untyped code, it would build a position of
        // `undefined` fields without a complaint.
        if (
            typeof fields !== 'object' ||
            fields === null ||
            typeof fields.isLong !== 'boolean'
        ) {
            throw new TypeError(
                'new MarketPosition() takes one fields object: new MarketPosition({ isLong, margin, ... })',
            );
        }
        this.isLong = fields.isLong;
        this.margin = fields.margin;
        this.notional = fields.notional;
        this.tokens = fields.tokens;
        this.fundingIdx = fields.fundingIdx;
        this.borrowingIdx = fields.borrowingIdx;
        this.lockedNotional = fields.lockedNotional;
        this.unlocksAt = fields.unlocksAt;
        this.pricedAt = fields.pricedAt;
        // The position owns its list, so a later write to the caller's
        // array, or to a position derived from this one, cannot change it.
        this.decreaseOrders = [...fields.decreaseOrders];
    }

    /** Wrap a parsed storage row (e.g. from an indexer) with its side. */
    static from(row: Position, isLong: boolean): MarketPosition {
        return new MarketPosition({
            isLong,
            margin: row.margin,
            notional: row.notional,
            tokens: row.tokens,
            fundingIdx: row.fundingIdx,
            borrowingIdx: row.borrowingIdx,
            lockedNotional: row.lockedNotional,
            unlocksAt: row.unlocksAt,
            pricedAt: row.pricedAt,
            decreaseOrders: row.decreaseOrders,
        });
    }

    /**
     * A side with no position: every amount zero and no pending decrease
     * orders, as the contract's `Position::zeroed`. What a never-opened side
     * loads as, and the position to preview a first open against.
     */
    static zero(isLong: boolean): MarketPosition {
        return new MarketPosition({
            isLong,
            margin: 0n,
            notional: 0n,
            tokens: 0n,
            fundingIdx: 0n,
            borrowingIdx: 0n,
            lockedNotional: 0n,
            unlocksAt: 0n,
            pricedAt: 0n,
            decreaseOrders: [],
        });
    }

    /** Whether this side carries any size. */
    isOpen(): boolean {
        return this.notional > 0n;
    }

    /** Mark-to-market PnL at exactly `price` (exit side), token-dec. Signed. Takes no market, so no terminal price applies. */
    pnl(price: PriceInput): bigint {
        const mark = exitPrice(resolvePrice(price), this.isLong);
        return positionPnl(this, mark, SCALAR_18, this.isLong);
    }

    /**
     * Margin + PnL - pending accruals at `price`, token-dec: the mark before
     * close fees and the profit haircut. The maintenance gate measures
     * settled equity, which nets both, so use `isLiquidatable` for the gate.
     */
    equity(market: Market, price: PriceInput): bigint {
        const mark = exitPrice(
            marketPrice(market, price, quoteTime(market)),
            this.isLong,
        );
        return positionEquity(this, market.data, mark, SCALAR_18, this.isLong);
    }

    /**
     * Funding accrued since this row's snapshot of the market index,
     * token-dec. Positive is owed by the trader, negative is earned.
     */
    pendingFunding(market: Market): bigint {
        return pendingFunding(this, market.data, this.isLong);
    }

    /** Borrowing accrued since this row's index snapshot, token-dec (never negative). */
    pendingBorrowing(market: Market): bigint {
        return pendingBorrowing(this, market.data, this.isLong);
    }

    /** Average entry price of the stored size (18-dec); `0n` with no open size. */
    entryPrice(): bigint {
        return impliedEntryPrice(this) ?? 0n;
    }

    /** The margin the maintenance requirement demands, token-dec, rounded up as the contract rounds. */
    maintenanceMargin(market: Market): bigint {
        return mulDivCeil(
            this.notional,
            market.config.maintenanceMargin,
            SCALAR_18,
        );
    }

    /**
     * Price (18-dec) at which settled equity, net of a full close's fees at
     * the current book, meets the maintenance margin: a long is liquidatable
     * below it, a short above it. Assumes no profit haircut and the accruals
     * as passed. `0n` with no open size.
     */
    liquidationPrice(market: Market): bigint {
        return liquidationPrice(this, market.config, market.data, this.isLong);
    }

    /**
     * Whether a keeper liquidation would succeed at `price`: settled equity
     * below the maintenance requirement, measured exactly as
     * `execute_liquidation` does (close fees included). On a `Delisted`
     * market past `delistedAt + DELIST_DEADLINE`, every open position is
     * liquidatable. The deadline is measured at the snapshot's accrual time,
     * so accrue first to measure it now. `false` with no open size.
     */
    isLiquidatable(market: Market, price: PriceInput): boolean {
        // The market as passed: elapsed 0 against the stored accrual.
        const now = market.data.accruedAt;
        const state = liquidationState(this, {
            ledger: market.ledger,
            now,
            isLong: this.isLong,
            position: this,
            market: market.data,
            config: market.config,
            price: marketPrice(market, price, now),
            vaultAssets: market.vaultAssets,
            treasuryRate: market.treasuryRate,
            status: market.status,
            delistedAt: market.delistedAt,
        });
        return state.kind === 'exact' ? state.value.liquidatable : false;
    }

    /** Notional not under the decrease lock at `now` (defaults to the wall clock), token-dec. */
    unlockedNotional(now?: bigint): bigint {
        return unlockedNotional(this, now ?? wallClock());
    }

    /** This position's display estimate at `price`. Delegates to {@link estimatePosition}. */
    estimate(market: Market, price: PriceInput, now?: bigint): PositionEstimate {
        return estimatePosition(market, this, price, now);
    }

    /** Pre-flight `order` against this position at `price`. Delegates to {@link previewOrder}. */
    preview(
        market: Market,
        order: OrderParams,
        price: PriceInput,
        now?: bigint,
    ): OrderEstimate {
        return previewOrder(market, this, order, price, now);
    }
}
