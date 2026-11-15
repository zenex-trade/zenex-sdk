import { describe, it, expect, vi, afterEach } from 'vitest';
import { rpc, xdr, StrKey } from '@stellar/stellar-sdk';
import { Market, type MarketContracts } from '../../src/trading/market.js';
import { MarketStateError } from '../../src/entries.js';
import { contractInstanceLedgerKey } from '../../src/contracts/keys.js';
import { marketDataLedgerKey } from '../../src/contracts/market/keys.js';
import { tokenBalanceLedgerKey } from '../../src/token.js';
import { Status } from '../../src/contracts/market/types.js';
import type { Network } from '../../src/index.js';
import {
    contractInstance,
    makeConfig,
    marketDataScVal,
    marketInstanceScVal,
    vaultInstanceScVal,
    balanceMapScVal,
    ledgerEntryFor,
    TEST_FEED_ID,
} from '../helpers/market_state.js';
import {
    USER,
    fixtureMarket,
    flatPosition,
    linkedEntries,
    px,
    unit,
} from './market_fixture.js';
import { OrderIntent, previewOrder } from '../../src/trading/order.js';
import { MarketPosition } from '../../src/trading/position.js';

const MARKET = StrKey.encodeContract(Buffer.alloc(32, 1));
const MARKET_B = StrKey.encodeContract(Buffer.alloc(32, 9));
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 2));
const VAULT_B = StrKey.encodeContract(Buffer.alloc(32, 10));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));
const ORACLE = StrKey.encodeContract(Buffer.alloc(32, 4));
const TREASURY = StrKey.encodeContract(Buffer.alloc(32, 5));
const BALANCE = 50_000_000n;
const SUPPLY = 10_000_000_00n;

const network: Network = {
    rpc: 'http://localhost:1337',
    passphrase: 'Test SDF Network ; September 2015',
    opts: { allowHttp: true },
};

const contracts: MarketContracts = { market: MARKET, vault: VAULT, token: TOKEN };
const contractsB: MarketContracts = { market: MARKET_B, vault: VAULT_B, token: TOKEN };

function marketEntries(
    where: MarketContracts,
    overrides: {
        omitBalance?: boolean;
        omitData?: boolean;
        instance?: xdr.ScVal;
        liveUntil?: number;
        omitLinks?: boolean;
        spreadReductionFactor?: bigint;
        treasuryRate?: bigint;
    } = {},
) {
    const instance =
        overrides.instance ??
        marketInstanceScVal({
            vault: where.vault,
            token: where.token,
            oracle: ORACLE,
            treasury: TREASURY,
            adl: [true, false],
        });
    const entries = [
        ledgerEntryFor(contractInstanceLedgerKey(where.market), instance, overrides.liveUntil),
        ledgerEntryFor(
            contractInstanceLedgerKey(where.vault),
            vaultInstanceScVal({
                asset: where.token,
                strategy: where.market,
                totalSupply: SUPPLY,
                decimalsOffset: 1,
                shareDecimals: 8,
            }),
        ),
    ];
    if (!overrides.omitData) {
        entries.push(
            ledgerEntryFor(marketDataLedgerKey(where.market), marketDataScVal()),
        );
    }
    if (!overrides.omitBalance) {
        entries.push(
            ledgerEntryFor(
                tokenBalanceLedgerKey(where.token, where.vault),
                balanceMapScVal(BALANCE),
            ),
        );
    }
    if (!overrides.omitLinks) {
        entries.push(
            ...linkedEntries({
                spreadReductionFactor: overrides.spreadReductionFactor,
                treasuryRate: overrides.treasuryRate,
            }),
        );
    }
    return entries;
}

function mockEntries(entries: unknown[], latestLedger = 4242) {
    return vi
        .spyOn(rpc.Server.prototype, 'getLedgerEntries')
        .mockResolvedValue({ entries, latestLedger } as never);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('Market.load', () => {
    it('reads the four market keys, then the oracle and treasury it names', async () => {
        const spy = mockEntries(marketEntries(contracts));
        const market = await Market.load(network, contracts);

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0]).toHaveLength(4);
        expect(spy.mock.calls[1].map((k) => (k as xdr.LedgerKey).toXDR('base64'))).toEqual([
            contractInstanceLedgerKey(ORACLE).toXDR('base64'),
            contractInstanceLedgerKey(TREASURY).toXDR('base64'),
        ]);

        expect(market.ledger).toBe(4242);
        expect(market.id).toBe(MARKET);
        expect(market.vault).toBe(VAULT);
        expect(market.token).toBe(TOKEN);
        expect(market.config).toEqual(makeConfig());
        expect(market.status).toBe(Status.Active);
        expect(market.adl).toEqual({ long: true, short: false });
        expect(market.oracle).toBe(ORACLE);
        expect(market.treasury).toBe(TREASURY);
        expect(market.data.notional).toEqual({ long: 1000n, short: 500n });
        expect(market.vaultAtomic()).toEqual({
            totalAssets: BALANCE,
            totalSupply: SUPPLY,
            decimalsOffset: 1,
        });
        expect(market.assetDecimals).toBe(7);
    });

    it('reads all six keys in one round trip when the contracts name the oracle and treasury', async () => {
        const spy = mockEntries(marketEntries(contracts));
        const full = { ...contracts, oracle: ORACLE, treasury: TREASURY };
        const market = await Market.load(network, full);

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toHaveLength(6);
        expect(market.oracle).toBe(ORACLE);
    });

    it('reads the spread reduction factor and the treasury rate', async () => {
        mockEntries(
            marketEntries(contracts, {
                spreadReductionFactor: 5n * 10n ** 17n,
                treasuryRate: 3n * 10n ** 17n,
            }),
        );
        const market = await Market.load(network, contracts);
        expect(market.spreadReductionFactor).toBe(5n * 10n ** 17n);
        expect(market.treasuryRate).toBe(3n * 10n ** 17n);
        // The accrual copy carries both.
        const accrued = market.accrue(10n ** 18n, 600n);
        expect(accrued.spreadReductionFactor).toBe(5n * 10n ** 17n);
        expect(accrued.treasuryRate).toBe(3n * 10n ** 17n);
    });

    it('fails closed when the oracle or treasury instance is missing', async () => {
        mockEntries(marketEntries(contracts, { omitLinks: true }));
        await expect(Market.load(network, contracts)).rejects.toMatchObject({
            code: 'MISSING_STATE',
            message: expect.stringContaining('oracle instance'),
        });
    });

    it('rejects an oracle or treasury the market is not wired to', async () => {
        mockEntries(marketEntries(contracts));
        await expect(
            Market.load(network, { ...contracts, oracle: TREASURY }),
        ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
        await expect(
            Market.load(network, { ...contracts, treasury: ORACLE }),
        ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    });

    it('resolves the full wiring from the market id', async () => {
        mockEntries(marketEntries(contracts));
        expect(await Market.resolveContracts(network, MARKET)).toEqual({
            market: MARKET,
            vault: VAULT,
            token: TOKEN,
            oracle: ORACLE,
            treasury: TREASURY,
        });
    });

    it('does not read a price, which is a caller input and never a ledger entry', async () => {
        mockEntries(marketEntries(contracts));
        const market = await Market.load(network, contracts);
        expect(market).not.toHaveProperty('price');
    });

    it('reads an absent vault Balance as zero, not as an error', async () => {
        mockEntries(marketEntries(contracts, { omitBalance: true }));
        const market = await Market.load(network, contracts);
        expect(market.vaultAtomic().totalAssets).toBe(0n);
    });

    it('reads the vault balance through the same key a wallet balance uses', async () => {
        const spy = mockEntries(marketEntries(contracts));
        await Market.load(network, contracts);
        const sent = spy.mock.calls[0].map((k) => (k as xdr.LedgerKey).toXDR('base64'));
        expect(sent).toContain(
            tokenBalanceLedgerKey(TOKEN, VAULT).toXDR('base64'),
        );
    });

    it('fails closed on a required entry the RPC omitted', async () => {
        mockEntries(marketEntries(contracts, { omitData: true }));
        await expect(Market.load(network, contracts)).rejects.toMatchObject({
            code: 'MISSING_STATE',
            message: expect.stringContaining('market data'),
        });
    });

    it('fails closed on an entry whose TTL has lapsed', async () => {
        // Returned, but expired-but-not-yet-evicted: liveUntil < latestLedger.
        mockEntries(marketEntries(contracts, { liveUntil: 4241 }), 4242);
        await expect(Market.load(network, contracts)).rejects.toThrow(
            /TTL-expired.*restore or extend/,
        );
    });

    it('keeps an entry live through its live-until ledger, inclusive', async () => {
        // Soroban's rule: live while liveUntil >= ledger. Equal is still live.
        mockEntries(marketEntries(contracts, { liveUntil: 4242 }), 4242);
        const market = await Market.load(network, contracts);
        expect(market.ledger).toBe(4242);
        // One ledger later the same entry has lapsed.
        mockEntries(marketEntries(contracts, { liveUntil: 4242 }), 4243);
        await expect(Market.load(network, contracts)).rejects.toMatchObject({
            name: 'MarketStateError',
            code: 'MISSING_STATE',
        });
    });

    it('fails closed with a typed error on an instance missing a required key', async () => {
        // A market instance that holds nothing.
        mockEntries(marketEntries(contracts, { instance: contractInstance([]) }));
        const failure = await Market.load(network, contracts).catch((error) => error);
        expect(failure).toBeInstanceOf(MarketStateError);
        expect(failure).toMatchObject({
            code: 'MISSING_STATE',
            message: expect.stringContaining('market instance is missing'),
        });
    });

    it('rejects contracts the market itself disagrees with', async () => {
        // Instance says VAULT_B; the caller asked with VAULT.
        const instance = marketInstanceScVal({
            vault: VAULT_B,
            token: TOKEN,
            oracle: ORACLE,
            treasury: TREASURY,
            adl: [false, false],
        });
        mockEntries(marketEntries(contracts, { instance }));
        await expect(Market.load(network, contracts)).rejects.toMatchObject({
            code: 'IDENTITY_MISMATCH',
        });
    });

    it('exposes plain public fields a cache can clone', async () => {
        mockEntries(marketEntries(contracts));
        const market = await Market.load(network, contracts);
        expect(structuredClone(market.data)).toEqual(market.data);
        expect(structuredClone(market.config)).toEqual(market.config);
    });
});

describe('Market accessors', () => {
    it('surfaces the owner from the same entry, with no extra call', async () => {
        const OWNER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 12));
        const instance = marketInstanceScVal({
            vault: VAULT,
            token: TOKEN,
            oracle: ORACLE,
            treasury: TREASURY,
            withOwner: OWNER,
        });
        const spy = mockEntries(marketEntries(contracts, { instance }));
        const market = await Market.load(network, {
            ...contracts,
            oracle: ORACLE,
            treasury: TREASURY,
        });
        expect(market.owner).toBe(OWNER);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reports no owner once ownership has been renounced', async () => {
        mockEntries(marketEntries(contracts));
        expect((await Market.load(network, contracts)).owner).toBeUndefined();
    });

    it('reports no wind-down while the market is live', async () => {
        mockEntries(marketEntries(contracts));
        const market = await Market.load(network, contracts);
        expect(market.terminalPrice).toBeUndefined();
        expect(market.delistedAt).toBeUndefined();
        expect(market.assetDecimals).toBe(7);
        expect(market.feedId).toEqual(TEST_FEED_ID);
    });

    it('reports delistedAt as soon as the market delists, before any terminal price', async () => {
        const instance = marketInstanceScVal({
            vault: VAULT,
            token: TOKEN,
            oracle: ORACLE,
            treasury: TREASURY,
            status: Status.Delisted,
            delistedAt: 1_700n,
        });
        mockEntries(marketEntries(contracts, { instance }));
        const market = await Market.load(network, contracts);
        expect(market.delistedAt).toBe(1_700n);
        expect(market.terminalPrice).toBeUndefined();
    });

    it('reports the terminal price and delistedAt as separate fields', async () => {
        const instance = marketInstanceScVal({
            vault: VAULT,
            token: TOKEN,
            oracle: ORACLE,
            treasury: TREASURY,
            status: Status.Delisted,
            delistedAt: 1_700n,
            terminalPrice: 99n,
        });
        mockEntries(marketEntries(contracts, { instance }));
        const market = await Market.load(network, contracts);
        expect(market.terminalPrice).toBe(99n);
        expect(market.delistedAt).toBe(1_700n);
    });

    it('refreshes by loading again', async () => {
        mockEntries(marketEntries(contracts), 5000);
        const market = await Market.load(network, contracts);
        vi.restoreAllMocks();
        mockEntries(marketEntries(contracts), 5001);
        const fresh = await Market.load(network, contracts);
        expect(market.ledger).toBe(5000);
        expect(fresh.ledger).toBe(5001);
    });
});

describe('Market constructor (one fields object)', () => {
    const fields = {
        id: MARKET,
        ledger: 7,
        vault: VAULT,
        token: TOKEN,
        oracle: ORACLE,
        treasury: TREASURY,
        feedId: Buffer.from(TEST_FEED_ID),
        status: Status.Active,
        config: makeConfig(),
        data: fixtureMarket().data,
        adl: { long: false, short: false },
        vaultAssets: unit(1000),
        vaultShares: unit(1000) * 1_000_000n,
        vaultDecimalsOffset: 6,
        assetDecimals: 7,
        treasuryRate: 5n * 10n ** 16n,
    };

    it('builds a snapshot from named fields', () => {
        const market = new Market(fields);
        expect(market.id).toBe(MARKET);
        expect(market.ledger).toBe(7);
        expect(market.treasuryRate).toBe(5n * 10n ** 16n);
        // The optional fields read undefined, and the spread reduction 0.
        expect(market.owner).toBeUndefined();
        expect(market.terminalPrice).toBeUndefined();
        expect(market.delistedAt).toBeUndefined();
        expect(market.spreadReductionFactor).toBe(0n);
    });

    it('requires the treasury rate', () => {
        const { treasuryRate: _rate, ...rest } = fields;
        // @ts-expect-error treasuryRate has no default: a 0 rate overstates a redeem quote.
        expect(new Market(rest).treasuryRate).toBeUndefined();
    });

    it('rejects the positional arguments it took before 1.0.0', () => {
        const positional = Market as unknown as new (...args: unknown[]) => Market;
        expect(() => new positional(network, MARKET, 7, VAULT, TOKEN)).toThrow(TypeError);
        expect(() => new positional()).toThrow(/takes one fields object/);
    });

    it('holds no network, only the snapshot fields', () => {
        const market = new Market(fields);
        expect('network' in market).toBe(false);
        expect(Object.keys(market).sort()).toEqual([
            'adl', 'assetDecimals', 'config', 'data', 'delistedAt', 'feedId', 'id',
            'ledger', 'oracle', 'owner', 'spreadReductionFactor', 'status',
            'terminalPrice', 'token', 'treasury', 'treasuryRate', 'vault',
            'vaultAssets', 'vaultDecimalsOffset', 'vaultShares',
        ]);
    });

    it('derives a changed copy by spreading a snapshot', () => {
        const market = new Market(fields);
        const frozen = new Market({ ...market, status: Status.Frozen });
        expect(frozen.status).toBe(Status.Frozen);
        expect(market.status).toBe(Status.Active);
        expect(frozen.data).toBe(market.data);
        expect(frozen).toBeInstanceOf(Market);
    });

    it('declares its fields readonly', () => {
        const market = new Market(fields);
        // @ts-expect-error fields are readonly: build a new snapshot instead.
        const assign = () => { market.status = Status.Frozen; };
        expect(assign).toBeTypeOf('function');
    });

    it('withTreasuryRate copies every field and changes the rate', () => {
        const market = new Market({ ...fields, spreadReductionFactor: 3n, owner: USER });
        const rated = market.withTreasuryRate(1n);
        expect(rated.treasuryRate).toBe(1n);
        expect({ ...rated, treasuryRate: market.treasuryRate }).toEqual({ ...market });
    });
});

describe('the treasury rate in previews', () => {
    // The treasury's cut leaves the vault, so the settled balance that gates
    // an open (#714) is smaller at a nonzero rate. A load reads the live rate;
    // previewing at 0 would pass an open the chain rejects.
    it('gates at the loaded rate an open that a zero rate would fill', () => {
        const market = fixtureMarket({ vaultAssets: unit(1000) });
        const outcome = (rate: bigint, notional: bigint) => {
            const order = new OrderIntent(market, USER, true).openMarket({
                notional,
                margin: notional / 5n,
            });
            return previewOrder(
                market.withTreasuryRate(rate),
                flatPosition(),
                order,
                px(1),
                1n,
            );
        };
        let low = unit(100);
        let high = unit(600);
        while (low < high) {
            const mid = low + (high - low + 1n) / 2n;
            if (outcome(0n, mid).outcome === 'fills') low = mid;
            else high = mid - 1n;
        }
        expect(outcome(0n, low).outcome).toBe('fills');
        expect(outcome(0n, low + 1n).gate?.code).toBe(714);
        expect(outcome(3n * 10n ** 17n, low).gate?.code).toBe(714);
    });
});

describe('MarketPosition.zero', () => {
    it('is the contract Position::zeroed for the side', () => {
        const long = MarketPosition.zero(true);
        expect(long).toEqual(
            MarketPosition.from(
                {
                    margin: 0n,
                    notional: 0n,
                    tokens: 0n,
                    fundingIdx: 0n,
                    borrowingIdx: 0n,
                    lockedNotional: 0n,
                    unlocksAt: 0n,
                    pricedAt: 0n,
                    decreaseOrders: [],
                },
                true,
            ),
        );
        expect(long.isLong).toBe(true);
        expect(long.isOpen()).toBe(false);
        expect(MarketPosition.zero(false).isLong).toBe(false);
    });

    it('gives each call its own decreaseOrders array', () => {
        expect(MarketPosition.zero(true).decreaseOrders).not.toBe(
            MarketPosition.zero(true).decreaseOrders,
        );
    });
});
