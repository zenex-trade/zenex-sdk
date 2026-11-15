import { describe, expect, it } from 'vitest';
import { SCALAR_18 } from '../../src/math/fixed.js';
import type { MarketConfig, MarketData } from '../../src/contracts/market/types.js';
import type { Market } from '../../src/trading/market.js';
import { MarketPosition } from '../../src/trading/position.js';
import { OrderIntent, marketContext, maxMarginForBalance } from '../../src/trading/order.js';
import { applyOrder } from '../../src/trading/internal/apply.js';
import { USER, fixtureMarket, pair, px } from './market_fixture.js';

// `maxMarginForBalance` against the fill engine, which mirrors the contract:
// the order it sizes is filled on a flat position, and so is the order one
// atomic unit larger.

const LEVERAGE_SCALE = 10_000n;
const NONE = { orderMargin: 0n, notional: 0n, positionMargin: 0n };

/** The leverage as the function reads it: four decimals. */
const scaled = (leverage: number) => BigInt(Math.round(leverage * Number(LEVERAGE_SCALE)));

/** Fill an open of `notional` carrying `margin` on a flat side. */
function fill(market: Market, isLong: boolean, notional: bigint, margin: bigint, price: bigint) {
    const order = new OrderIntent(market, USER, isLong).openMarket({ notional, margin });
    return applyOrder(marketContext(market, MarketPosition.zero(isLong), price, 1n, USER), order, {
        executionFee: market.config.execFee,
    });
}

/**
 * Whether an open of `notional` carrying `budget` as its margin fits at the
 * leverage, by the engine's own fees: the margin the position keeps clears
 * the initial-margin gate, `ceil(initMargin * notional)`, and carries the
 * size at the leverage. The fees are read from a fill of the same size with
 * ample margin, which no margin gate stops.
 */
function fits(
    market: Market,
    isLong: boolean,
    notional: bigint,
    budget: bigint,
    price: bigint,
    leverage: number,
): boolean {
    // Ample: the size twice over, plus the value of the one base unit the
    // entry rounds against the trader.
    const ample = fill(market, isLong, notional, 2n * (notional + price / SCALAR_18 + 1n), price);
    if (ample.kind !== 'fills') throw new Error(`the ample fill is a ${ample.kind}`);
    const fees = ample.outcome.fees;
    const margin = budget - fees.base - fees.impact;
    const required = (notional * market.config.initMargin + SCALAR_18 - 1n) / SCALAR_18;
    return margin >= required && notional * LEVERAGE_SCALE <= margin * scaled(leverage);
}

/** A market where only the fees and the initial margin can bind. */
function market(config: Partial<MarketConfig>, data: Partial<MarketData> = {}): Market {
    return fixtureMarket({
        config: {
            minPositionNotional: 0n,
            minOrderNotional: 0n,
            minOrderMargin: 0n,
            maxPositionNotional: 10n ** 30n,
            maxOpenInterest: 10n ** 30n,
            maintenanceMargin: 0n,
            ...config,
        },
        data,
        vaultAssets: 10n ** 30n,
    });
}

/** A seeded generator (mulberry32), so every run draws the same cases. */
function seeded(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
    };
    /** An integer in `[low, high]`. */
    const int = (low: number, high: number) => low + Math.floor(next() * (high - low + 1));
    /** A bigint spread evenly over the orders of magnitude up to `10^digits`. */
    const magnitude = (digits: number) =>
        BigInt(int(1, 9_999)) * 10n ** BigInt(int(0, digits - 4)) + BigInt(int(0, 9_999));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
    return { next, int, magnitude, pick };
}

const LEVERAGES = [0.5, 1, 2, 2.5, 5, 7.3333, 10, 20, 50, 100, 1_000] as const;

describe('maxMarginForBalance: the largest order', () => {
    it('returns the larger size the margin search missed', () => {
        // Budget 13 at 5x with no base fee and an impact fee of
        // ceil(notional^2 / 1500). A margin of 10 carries 50 for a fee of 2,
        // and a margin of 11 would carry 55 for a fee of 3, one over the
        // budget. But 54 costs only 2 and leaves a margin of 11, which
        // carries it: 54 <= 55.
        const tiny = market({ execFee: 0n, feeDom: 0n, feeNonDom: 0n, impactScalar: 1_500n });
        const max = maxMarginForBalance(tiny, true, 13n, 5, SCALAR_18);
        expect(max).toEqual({ orderMargin: 13n, notional: 54n, positionMargin: 11n });

        const applied = fill(tiny, true, 54n, 13n, SCALAR_18);
        if (applied.kind !== 'fills') throw new Error(`expected a fill, got ${applied.kind}`);
        expect(applied.outcome.postPosition.margin).toBe(11n);
        expect(fits(tiny, true, 54n, 13n, SCALAR_18, 5)).toBe(true);
        expect(fits(tiny, true, 55n, 13n, SCALAR_18, 5)).toBe(false);
    });

    it('fills, escrows no more than the balance, and leaves no room for one more unit', () => {
        const random = seeded(0x5eed_0001);
        const cases = 4_000;
        let sized = 0;
        let mildFills = 0;
        let harshFills = 0;
        let liquidatable = 0;
        for (let index = 0; index < cases; index++) {
            // A mild case keeps the fees well under the initial margin, so
            // no gate but the one solved for can bind. A harsh one runs the
            // impact fee up to its 10% cap on balances down to one unit.
            const mild = index % 2 === 0;
            const isLong = random.next() < 0.5;
            const leverage =
                random.next() < 0.7
                    ? random.pick(LEVERAGES)
                    : Math.round(random.next() * 400_000) / 10_000;
            const initMargin =
                SCALAR_18 /
                BigInt(random.pick(mild ? [2, 5, 10, 20, 50] : [2, 5, 10, 20, 50, 100]));
            const execFee = BigInt(random.pick([0, 1, 7, 100_000]));
            const balance =
                execFee +
                (mild
                    ? 10n ** 9n + random.magnitude(14)
                    : random.magnitude(random.pick([4, 7, 10, 14])));
            // The impact rate at the largest size the balance could carry:
            // 0.1% when mild, else from negligible to past the cap.
            const impactScalar = mild
                ? balance * 50n * 1_000n
                : (balance * BigInt(random.pick([1, 10, 100, 10_000]))) / 3n + 1n;
            const feeSteps = mild ? 20 : 80;
            const config = {
                execFee,
                initMargin,
                impactScalar,
                feeDom: BigInt(random.int(0, feeSteps)) * 10n ** 14n,
                feeNonDom: BigInt(random.int(0, feeSteps)) * 10n ** 14n,
            };
            const skew = random.magnitude(10);
            const side = random.int(0, 2);
            const book = market(config, {
                tokens: side === 0 ? pair() : side === 1 ? pair(skew, 0n) : pair(0n, skew),
            });
            const budget = balance - execFee;
            // A small balance is priced at or under one, so that every
            // atomic unit of size buys a base unit: a dust size that rounds
            // to no base size at all is its own gate (716).
            const price = px(
                budget < 10n ** 9n
                    ? random.pick([0.37, 0.5, 1])
                    : random.pick([0.37, 1, 1.000001, 10, 97.5, 3_456.789, 64_000]),
            );
            const label = JSON.stringify(
                { index, isLong, leverage, balance, price, side, skew, config },
                (_, value) => (typeof value === 'bigint' ? value.toString() : (value as unknown)),
            );

            const max = maxMarginForBalance(book, isLong, balance, leverage, price);
            if (max.notional === 0n) {
                expect(max, label).toEqual(NONE);
                // Nothing fits: not even one atomic unit.
                expect(fits(book, isLong, 1n, budget, price, leverage), label).toBe(false);
                continue;
            }
            sized++;
            // The escrow of an increase is its margin plus the execution
            // fee: the whole balance, and no more.
            expect(max.orderMargin + execFee, label).toBe(balance);

            // The size fits, and the position margin clears the
            // initial-margin gate as the contract measures it.
            expect(fits(book, isLong, max.notional, budget, price, leverage), label).toBe(true);
            const required = (max.notional * initMargin + SCALAR_18 - 1n) / SCALAR_18;
            expect(max.positionMargin, label).toBeGreaterThanOrEqual(required);
            expect(max.notional * LEVERAGE_SCALE, label).toBeLessThanOrEqual(
                max.positionMargin * scaled(leverage),
            );

            // One atomic unit more does not fit.
            expect(fits(book, isLong, max.notional + 1n, budget, price, leverage), label).toBe(
                false,
            );

            // The order itself fills. The one gate that can stop it is the
            // maintenance gate (723), which the function does not solve for,
            // and only in a harsh case: the fees of closing the new position
            // exceed the margin it is left with.
            const applied = fill(book, isLong, max.notional, max.orderMargin, price);
            if (applied.kind === 'gate') {
                expect(applied.code, label).toBe(723);
                expect(mild, label).toBe(false);
                liquidatable++;
                continue;
            }
            expect(applied.kind, label).toBe('fills');
            if (applied.kind !== 'fills') continue;
            expect(applied.outcome.postPosition.margin, label).toBe(max.positionMargin);
            expect(applied.outcome.postPosition.notional, label).toBe(max.notional);
            if (mild) mildFills++;
            else harshFills++;
        }
        // The cases are not vacuous: nearly every one sizes an order, every
        // mild one fills, and the harsh ones reach both outcomes.
        expect(sized).toBeGreaterThan(cases * 0.9);
        expect(mildFills).toBe(cases / 2);
        expect(harshFills).toBeGreaterThan(cases / 8);
        expect(liquidatable).toBeGreaterThan(0);
        expect(mildFills + harshFills + liquidatable).toBe(sized);
    });

    it('is the largest size of all, by a scan of every size a small balance could carry', () => {
        const random = seeded(0x5eed_0002);
        for (let index = 0; index < 600; index++) {
            const isLong = random.next() < 0.5;
            const leverage = random.pick([1, 2.5, 5, 10, 33.3333]);
            const execFee = BigInt(random.pick([0, 3]));
            const balance = execFee + BigInt(random.int(1, 120));
            // A flat book, where a larger open provably never pays less,
            // and books skewed either way, where the fee splits in two.
            const skew = BigInt(random.int(1, 200));
            const side = index % 3;
            const book = market(
                {
                    execFee,
                    initMargin: SCALAR_18 / BigInt(random.pick([5, 20, 50])),
                    impactScalar: BigInt(random.int(50, 50_000)),
                    feeDom: BigInt(random.int(0, 300)) * 10n ** 14n,
                    feeNonDom: BigInt(random.int(0, 300)) * 10n ** 14n,
                },
                { tokens: side === 0 ? pair() : side === 1 ? pair(skew, 0n) : pair(0n, skew) },
            );
            const price = px(random.pick([0.25, 0.5, 1]));
            const label = `case ${index}: balance ${balance}, leverage ${leverage}, isLong ${isLong}`;

            const max = maxMarginForBalance(book, isLong, balance, leverage, price);
            const budget = balance - execFee;
            // Every size up to what the whole budget could carry.
            const ceiling = (budget * scaled(leverage)) / LEVERAGE_SCALE + 2n;
            let largest = 0n;
            for (let notional = 1n; notional <= ceiling; notional++) {
                if (fits(book, isLong, notional, budget, price, leverage)) largest = notional;
            }
            expect(max.notional, label).toBe(largest);
        }
    });
});

describe('maxMarginForBalance: a leverage that is no leverage', () => {
    const book = market({});

    it.each([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 0, -0, -5])(
        'returns zeros for a leverage of %s',
        (leverage) => {
            expect(maxMarginForBalance(book, true, 10n ** 9n, leverage, px(100))).toEqual(NONE);
            expect(maxMarginForBalance(book, false, 10n ** 9n, leverage, px(100))).toEqual(NONE);
        },
    );

    it('returns zeros for a leverage that rounds to nothing at four decimals', () => {
        expect(maxMarginForBalance(book, true, 10n ** 9n, 0.00001, px(100))).toEqual(NONE);
    });

    it('caps a huge finite leverage at the initial margin', () => {
        const capped = maxMarginForBalance(book, true, 10n ** 9n, 1e12, px(100));
        expect(capped).toEqual(maxMarginForBalance(book, true, 10n ** 9n, 10, px(100)));
        expect(capped.notional).toBeGreaterThan(0n);
    });
});
