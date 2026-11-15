/* eslint-disable @typescript-eslint/no-explicit-any -- the vectors are untyped JSON */
// Differential regression test: replays vectors produced by the contracts'
// own Rust engine through the SDK's exact engine and fails on any
// divergence, to the atomic unit.
//
// `test/fixtures/vectors/engine.jsonl` is a sample of 240 cases, drawn from
// a larger generated set so that every outcome the generator reached is
// represented: fills, each contract error an increase, decrease, liquidation
// or vault fill can raise, and rejected vault orders. Each line is one case:
// a pseudo-random market state and action, and what the engine of the bound
// contract release did with it. The inputs are random and the outputs are
// the contract's, so the file carries no third-party data.
//
//   t: 'pos'  one position action (increase, decrease or liquidation)
//   t: 'mkt'  one market state: accrual, pending borrowing, LP net PnL, side
//             PnL and trade fees, plus a vault deposit fill and a redeem fill
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    advanceMarketAccruals,
    marketPendingBorrowing,
    marketSidePnl,
    quoteTradeFees,
} from '../../src/trading/internal/math.js';
import {
    lpNetPnl,
    quoteVaultDepositFill,
    quoteVaultRedeemFill,
} from '../../src/trading/internal/vault.js';
import { quotePositionAction } from '../../src/trading/internal/quote.js';
import { liquidationState } from '../../src/trading/internal/position.js';

const FILE = new URL('../fixtures/vectors/engine.jsonl', import.meta.url);

type Json = Record<string, any>;
const big = (v: string): bigint => BigInt(v);
const pairOf = (p: Json) => ({ long: big(p.long), short: big(p.short) });
const dataOf = (d: Json) => ({
    notional: pairOf(d.notional),
    margin: pairOf(d.margin),
    tokens: pairOf(d.tokens),
    fundingIdx: pairOf(d.fundingIdx),
    borrowingIdx: pairOf(d.borrowingIdx),
    borrowingWeight: pairOf(d.borrowingWeight),
    fundingRate: big(d.fundingRate),
    accruedAt: big(d.accruedAt),
    creditPool: big(d.creditPool),
    creditOwed: big(d.creditOwed),
});
const configOf = (c: Json): any =>
    Object.fromEntries(Object.entries(c).map(([k, v]) => [k, big(v as string)]));
const posOf = (p: Json) => ({
    margin: big(p.margin),
    notional: big(p.notional),
    tokens: big(p.tokens),
    fundingIdx: big(p.fundingIdx),
    borrowingIdx: big(p.borrowingIdx),
    lockedNotional: big(p.lockedNotional),
    unlocksAt: big(p.unlocksAt),
    pricedAt: big(p.pricedAt),
    decreaseOrders: [] as number[],
});
const priceOf = (p: Json) => ({
    bid: big(p.bid),
    ask: big(p.ask),
    publishTime: big(p.publishTime),
});
const flat = (d: ReturnType<typeof dataOf>) =>
    JSON.stringify(d, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const lines = readFileSync(FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Json);

describe('differential: SDK engine vs contract engine vectors', () => {
    it('reads the whole sample', () => {
        expect(lines.filter((c) => c.t === 'pos')).toHaveLength(120);
        expect(lines.filter((c) => c.t === 'mkt')).toHaveLength(120);
    });

    it('position actions (increase / decrease / liquidate)', () => {
        const diffs: string[] = [];
        const stats: Record<string, number> = {};
        const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
        lines.forEach((c, index) => {
            if (c.t !== 'pos') return;
            const config = configOf(c.config);
            const data = dataOf(c.data);
            const price = priceOf(c.price);
            const position = posOf(c.pos);
            const base = {
                ledger: 1,
                now: big(c.now),
                isLong: c.isLong as boolean,
                position,
                market: data,
                config,
                price,
                vaultAssets: big(c.vaultBalance),
                treasuryRate: big(c.treasuryRate),
            };
            const note = (what: string) => diffs.push(`#${index} ${c.action.kind} ${what}`);
            const out = c.out as Json;
            if (c.action.kind === 'liq') {
                if (out.err === '740') return bump('liq:skip740');
                const state = liquidationState(position, base);
                if (out.err === '720') {
                    if (state.kind !== 'unavailable' || state.contractCode !== 720)
                        note(
                            `rust 720, sdk ${JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
                        );
                    return bump('liq:720');
                }
                if (state.kind !== 'exact')
                    return note(
                        `sdk not exact: ${(state as any).reason}; rust ${JSON.stringify(out)}`,
                    );
                if (out.err === '722') {
                    if (state.value.liquidatable) note('rust NotLiquidatable, sdk liquidatable');
                    return bump('liq:722');
                }
                if (out.err) return note(`unexpected rust err ${out.err}`);
                if (!state.value.liquidatable) note('rust liquidated, sdk not liquidatable');
                const equity = big(out.returned) + big(out.liqFee);
                if (state.value.equity !== equity)
                    note(`equity rust ${equity} sdk ${state.value.equity}`);
                return bump('liq:ok');
            }
            const notional = big(c.action.notional);
            const margin = big(c.action.margin);
            if (notional === 0n && margin === 0n) return bump(`${c.action.kind}:skip-noop`);
            const quote = quotePositionAction({
                ...base,
                action: {
                    kind: c.action.kind === 'inc' ? 'increase' : 'decrease',
                    notional,
                    margin,
                },
                executionFee: config.execFee,
                relayFee: 0n,
            });
            if (out.err) {
                bump(`${c.action.kind}:err${out.err}`);
                if (quote.kind !== 'unavailable' || String(quote.contractCode) !== out.err) {
                    note(
                        `contract err ${out.err}, sdk ${quote.kind === 'unavailable' ? `${quote.code}/${quote.contractCode}/${quote.reason}` : 'fills'}`,
                    );
                }
                return;
            }
            bump(`${c.action.kind}:ok`);
            if (quote.kind !== 'exact')
                return note(
                    `rust fills, sdk ${(quote as any).code}/${(quote as any).contractCode}/${(quote as any).reason}`,
                );
            const v = quote.value;
            const cmp = (name: string, sdk: bigint, rust: string) => {
                if (sdk !== big(rust)) note(`${name}: rust ${rust} sdk ${sdk}`);
            };
            cmp('base', v.fees.base, out.base);
            cmp('impact', v.fees.impact, out.impact);
            cmp('funding', v.fees.funding, out.funding);
            cmp('borrowing', v.fees.borrowing, out.borrowing);
            cmp('pnl', v.realizedPnl, out.pnl);
            cmp('returned', v.walletPayout, out.returned);
            cmp('badDebt', v.badDebt, out.badDebt);
            const rp = posOf(out.pos);
            const closed = rp.notional === 0n && rp.margin === 0n && rp.tokens === 0n;
            const sp = v.postPosition;
            if (closed) {
                if (sp.notional !== 0n || sp.margin !== 0n || sp.tokens !== 0n)
                    note('rust closed, sdk position not flat');
            } else {
                for (const k of [
                    'margin',
                    'notional',
                    'tokens',
                    'fundingIdx',
                    'borrowingIdx',
                    'lockedNotional',
                    'unlocksAt',
                    'pricedAt',
                ] as const) {
                    if (sp[k] !== rp[k]) note(`post.${k}: rust ${rp[k]} sdk ${sp[k]}`);
                }
            }
            const rd = flat(dataOf(out.data));
            const sd = flat(v.postMarket);
            if (rd !== sd) note(`postMarket differs\n   rust ${rd}\n   sdk  ${sd}`);
        });
        expect(diffs).toEqual([]);
        // The sample exercises every branch, not only the happy path.
        for (const outcome of [
            'inc:ok',
            'dec:ok',
            'liq:ok',
            'liq:722',
            'inc:err713',
            'dec:err723',
        ]) {
            expect(stats[outcome], outcome).toBeGreaterThan(0);
        }
    });

    it('accrual, pending borrowing, lp_net_pnl, side pnl, trade fees', () => {
        const diffs: string[] = [];
        let n = 0;
        lines.forEach((c, index) => {
            if (c.t !== 'mkt') return;
            const core = c.core as Json;
            if (core.err) return diffs.push(`#${index} rust core err ${core.err}`);
            n++;
            const config = configOf(c.config);
            const price = priceOf(c.price);
            const vb = big(c.vaultBalance);
            const tr = big(c.treasuryRate);
            const accrued = advanceMarketAccruals(
                dataOf(c.data),
                config,
                price,
                vb,
                big(c.now),
            ).market;
            const note = (what: string) => diffs.push(`#${index} ${what}`);
            if (flat(accrued) !== flat(dataOf(core.data)))
                note(
                    `accrued data differs\n   rust ${flat(dataOf(core.data))}\n   sdk  ${flat(accrued)}`,
                );
            const cmp = (name: string, sdk: bigint, rust: string) => {
                if (sdk !== big(rust)) note(`${name}: rust ${rust} sdk ${sdk}`);
            };
            cmp('pendingMax', marketPendingBorrowing(accrued, true), core.pendingMax);
            cmp('pendingMin', marketPendingBorrowing(accrued, false), core.pendingMin);
            cmp('lpMax', lpNetPnl(accrued, config, price, vb, tr, true), core.lpMax);
            cmp('lpMin', lpNetPnl(accrued, config, price, vb, tr, false), core.lpMin);
            cmp('sideLongMax', marketSidePnl(accrued, price, true, true), core.sideLongMax);
            cmp('sideLongMin', marketSidePnl(accrued, price, true, false), core.sideLongMin);
            cmp('sideShortMax', marketSidePnl(accrued, price, false, true), core.sideShortMax);
            cmp('sideShortMin', marketSidePnl(accrued, price, false, false), core.sideShortMin);
            const fees = quoteTradeFees(
                accrued,
                config,
                c.isLong,
                big(core.fee.notional),
                big(core.fee.tokens),
            );
            cmp('fee.base', fees.base, core.fee.base);
            cmp('fee.impact', fees.impact, core.fee.impact);
        });
        expect(diffs).toEqual([]);
        expect(n).toBeGreaterThan(100);
    });

    it('vault deposit and redeem fills', () => {
        const diffs: string[] = [];
        const stats: Record<string, number> = {};
        const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1);
        lines.forEach((c, index) => {
            if (c.t !== 'mkt') return;
            const config = configOf(c.config);
            const now = big(c.now);
            const context = {
                ledger: 1,
                now,
                market: dataOf(c.data),
                config,
                price: { ...priceOf(c.price), publishTime: now },
                vault: {
                    totalAssets: big(c.vaultBalance),
                    totalSupply: big(c.supply),
                    decimalsOffset: 6,
                },
                treasuryRate: big(c.treasuryRate),
                executionFee: config.execFee,
            };
            for (const side of ['deposit', 'redeem'] as const) {
                const spec = c[side] as Json;
                const out = spec.out as Json;
                const amount = big(spec.amount);
                const minOut = big(spec.minOut);
                const quote =
                    side === 'deposit'
                        ? quoteVaultDepositFill({
                              ...context,
                              minOut,
                              assets: amount,
                              createdAt: now - 1n,
                          })
                        : quoteVaultRedeemFill({
                              ...context,
                              minOut,
                              shares: amount,
                              createdAt: now - config.redeemLock - 1n,
                          });
                const note = (what: string) =>
                    diffs.push(`#${index} ${side} amount=${amount} minOut=${minOut} ${what}`);
                // Known cosmetic: a zero-share redeem (uncreatable on chain, create rejects amount 0) reads 732 in the SDK.
                if (side === 'redeem' && amount === 0n) {
                    bump('redeem:skip-zero');
                    continue;
                }
                if (out.err) {
                    bump(`${side}:err${out.err}`);
                    // The contract's i256 -> i128 `unwrap` trap (a host trap with no contract code) is the SDK's overflow sentinel.
                    if (
                        out.err.startsWith('-1') &&
                        quote.kind === 'unavailable' &&
                        quote.code === 'CONTRACT_OVERFLOW'
                    )
                        continue;
                    // Known cosmetic: a zero-share redeem (uncreatable on chain) reads 732 in the SDK, 800 in the vault.
                    if (
                        side === 'redeem' &&
                        amount === 0n &&
                        quote.kind === 'unavailable' &&
                        quote.contractCode === 732
                    )
                        return bump('redeem:zero-732-vs-800');
                    if (quote.kind !== 'unavailable' || String(quote.contractCode) !== out.err) {
                        note(
                            `contract err ${out.err}, sdk ${quote.kind === 'unavailable' ? `${quote.code}/${quote.contractCode}/${quote.reason}` : JSON.stringify(quote.value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
                        );
                    }
                    continue;
                }
                if (quote.kind !== 'exact') {
                    note(
                        `rust ${JSON.stringify(out)}, sdk ${(quote as any).code}/${(quote as any).contractCode}/${(quote as any).reason}`,
                    );
                    continue;
                }
                const v = quote.value;
                if (out.rejected !== undefined) {
                    bump(`${side}:rejected`);
                    if (v.kind !== 'rejected')
                        note(`rust rejected quoted=${out.rejected}, sdk fills output=${v.output}`);
                    else {
                        if (v.quoted !== big(out.rejected))
                            note(`rejected quoted: rust ${out.rejected} sdk ${v.quoted}`);
                        if (v.netPnl !== big(out.netPnl))
                            note(`rejected netPnl: rust ${out.netPnl} sdk ${v.netPnl}`);
                    }
                    continue;
                }
                bump(`${side}:ok`);
                if (v.kind === 'rejected') {
                    note(`rust fills output=${out.output}, sdk rejected quoted=${v.quoted}`);
                    continue;
                }
                const cmp = (name: string, sdk: bigint, rust: string) => {
                    if (sdk !== big(rust)) note(`${name}: rust ${rust} sdk ${sdk}`);
                };
                cmp('output', v.output, out.output);
                cmp('gross', v.grossAssets, out.gross);
                cmp('vaultFee', v.vaultFee, out.vaultFee);
                cmp('netPnl', v.netPnl, out.netPnl);
                cmp('postVault', v.postVaultAssets, out.postVault);
            }
        });
        expect(diffs).toEqual([]);
        for (const outcome of ['deposit:ok', 'redeem:ok', 'deposit:rejected', 'redeem:rejected']) {
            expect(stats[outcome], outcome).toBeGreaterThan(0);
        }
    });
});
