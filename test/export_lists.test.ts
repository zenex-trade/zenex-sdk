import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import * as errors from '../src/errors.js';

// The runtime exports of the two entry points, name by name. An export that
// is added, renamed or removed fails here until the list is changed with
// it, so the public surface never moves by accident. Types have no runtime
// value: index_type_exports.test.ts covers those.

const ROOT_EXPORTS = [
    'BPS_DENOMINATOR',
    'DEFAULT_ORDER_TTL_LEDGERS',
    'DELIST_DEADLINE',
    'DELIST_GRACE',
    'FULL_CLOSE',
    'FactoryContract',
    'FactoryEventType',
    'FeeForwarderContract',
    'FeeForwarderEventType',
    'FixedMath',
    'GovernanceContract',
    'GovernanceEventType',
    'I128_MAX',
    'I128_MIN',
    'MAX_ORDERS_PER_SIDE',
    'Market',
    'MarketContract',
    'MarketEventType',
    'MarketPosition',
    'MarketRouterContract',
    'MarketStateError',
    'MarketUser',
    'NO_EXPIRY_LEDGER',
    'OracleContract',
    'OracleEventType',
    'OrderIntent',
    'OrderKind',
    'OwnableEventType',
    'Price',
    'SCALAR_18',
    'SECONDS_PER_YEAR',
    'Status',
    'TreasuryContract',
    'TreasuryEventType',
    'UNTYPED_FAILURE',
    'VIRTUAL_SHARES',
    'VaultContract',
    'VaultEventType',
    'VaultOrderIntent',
    'VaultOrderKind',
    'VerifierErrorCode',
    'ZenexContractType',
    'ZenexError',
    'ZenexErrorCode',
    'addI128',
    'callToScVal',
    'checkedBps',
    'checkedI128',
    'contractInstanceLedgerKey',
    'createOrderCall',
    'decodeEntryKey',
    'enumStorageKeyWithAddress',
    'estimateMarket',
    'estimatePosition',
    'formatAnnualPercent',
    'formatAtomic',
    'formatHourlyPercent',
    'formatPercent',
    'formatPrice',
    'formatRatio',
    'formatToken',
    'formatTokenFloor',
    'inferErrorSource',
    'instanceStorage',
    'isDecreaseOrderKind',
    'isIncreaseOrderKind',
    'isMarketOrderKind',
    'isTriggerOrderKind',
    'loadTokenBalance',
    'loadTokenBalances',
    'loadTreasuryInstance',
    'loadTreasuryRate',
    'marketClaimableCreditLedgerKey',
    'marketConfigToScVal',
    'marketDataLedgerKey',
    'marketOrderCounterLedgerKey',
    'marketOrderLedgerKey',
    'marketPositionLedgerKey',
    'marketPriceCacheLedgerKey',
    'marketVaultOrderLedgerKey',
    'maxMarginForBalance',
    'mulDivCeil',
    'mulDivFloor',
    'orderPriceBound',
    'parseAdlState',
    'parseAtomic',
    'parseCallOutcome',
    'parseContractErrorCode',
    'parseError',
    'parseFactoryInstance',
    'parseGovernanceInstance',
    'parseMarketConfig',
    'parseMarketData',
    'parseMarketInstance',
    'parseOracleInstance',
    'parseOrder',
    'parsePosition',
    'parseResult',
    'parseSidePair',
    'parseTokenBalance',
    'parseTreasuryInstance',
    'parseTreasuryRate',
    'parseVaultInstance',
    'parseVaultOrder',
    'persistentLedgerKey',
    'previewOrder',
    'reduceSpread',
    'simulateAndParse',
    'subI128',
    'temporaryLedgerKey',
    'toFixed',
    'toFloat',
    'tokenBalanceLedgerKey',
    'tokenBalanceOrZero',
    'zenexErrorFromCode',
];

const ERRORS_EXPORTS = [
    'VerifierErrorCode',
    'ZenexError',
    'ZenexErrorCode',
    'inferErrorSource',
    'parseContractErrorCode',
    'zenexErrorFromCode',
];

/** The module specifiers a source file imports or re-exports from. */
function dependencies(file: string): string[] {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const specifiers = source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gms);
    return [...specifiers].map((match) => match[1]).sort();
}

describe('exact export lists', () => {
    it('the root entry point exports exactly these names', () => {
        expect(Object.keys(root).sort()).toEqual(ROOT_EXPORTS);
    });

    it('the ./errors entry point exports exactly these names', () => {
        expect(Object.keys(errors).sort()).toEqual(ERRORS_EXPORTS);
    });

    it('every ./errors export is the root export of the same name', () => {
        const surface = root as Record<string, unknown>;
        for (const name of ERRORS_EXPORTS) {
            expect(surface[name], name).toBe((errors as Record<string, unknown>)[name]);
        }
    });

    it('./errors loads nothing but itself and the event-log reader', () => {
        // The subpath exists for callers that decode errors without the
        // Stellar SDK: neither module may reach a third module.
        expect(dependencies('errors.ts')).toEqual(['./error_source.js']);
        expect([...new Set(dependencies('error_source.ts'))]).toEqual(['./errors.js']);
    });
});
