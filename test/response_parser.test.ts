import { describe, it, expect } from 'vitest';
import { rpc } from '@stellar/stellar-sdk';
import { parseError } from '../src/response_parser.js';
import { ZenexError, ZenexErrorCode } from '../src/errors.js';

// =============================================================================
// parseError code resolution against the disjoint v2 namespaces:
// market 700-772, price-verifier 780-791, strategy-vault 800-803,
// governance 810-812, treasury 900. No contract-type hint exists anymore.
// =============================================================================

function simulationError(code: number): rpc.Api.SimulateTransactionErrorResponse {
    return {
        id: '1',
        latestLedger: 1,
        events: [],
        error: `HostError: Error(Contract, #${code})`,
    } as unknown as rpc.Api.SimulateTransactionErrorResponse;
}

describe('parseError: the source hint decides only the shared range', () => {
    it('a hint is inert outside codes 2-13', () => {
        expect(parseError(simulationError(770), 'verifier').code).toBe(
            ZenexErrorCode.AdlNotTriggered,
        );
        expect(parseError(simulationError(810), 'token').code).toBe(ZenexErrorCode.GovNotQueued);
        expect(parseError(simulationError(770), 'verifier').source).toBeUndefined();
    });

    it('an unknown hint value resolves as no hint', () => {
        const parseWithAnyHint = parseError as unknown as (
            response: unknown,
            hint?: string,
        ) => ZenexError;
        expect(parseWithAnyHint(simulationError(770), 'governance').code).toBe(
            ZenexErrorCode.AdlNotTriggered,
        );
        expect(parseWithAnyHint(simulationError(12), 'governance').ambiguous).toBe(true);
    });

    it('a rejected price report reads as the verifier error with the hint', () => {
        const error = parseError(simulationError(12), 'verifier');
        expect(error.code).toBe(12);
        expect(error.source).toBe('verifier');
        expect(error.ambiguous).toBe(false);
        expect(error.codeName).toBe('VerifierBadVerification');
        expect(error.message).toBe('Price report signatures failed verification');
    });

    it('the same code reads as the token error with the token hint', () => {
        const error = parseError(simulationError(10), 'token');
        expect(error.code).toBe(ZenexErrorCode.BalanceError);
        expect(error.source).toBe('token');
        expect(error.codeName).toBe('BalanceError');
        expect(error.message).toBe('Insufficient token balance');
    });

    it('without a hint a shared code states both meanings', () => {
        const error = parseError(simulationError(10));
        expect(error.code).toBe(10);
        expect(error.ambiguous).toBe(true);
        expect(error.source).toBeUndefined();
        expect(error.codeName).toBe('BalanceError|VerifierDigestInactive');
        expect(error.message).toContain('Insufficient token balance');
        expect(error.message).toContain('deactivated verifier config');
    });

    it('verifier codes 14-18 resolve without a hint', () => {
        const error = parseError(simulationError(14));
        expect(error.code).toBe(ZenexErrorCode.VerifierIncorrectSignatureCount);
        expect(error.ambiguous).toBe(false);
    });
});

describe('parseError: new market codes resolve unhinted', () => {
    it('733 -> TooManyOrders', () => {
        expect(parseError(simulationError(733)).code).toBe(ZenexErrorCode.TooManyOrders);
    });

    it('734 -> UnknownKind', () => {
        expect(parseError(simulationError(734)).code).toBe(ZenexErrorCode.UnknownKind);
    });

    it('742 -> TriggerNotMet', () => {
        expect(parseError(simulationError(742)).code).toBe(ZenexErrorCode.TriggerNotMet);
    });

    it('752 -> UnknownError (retired: a missed min_out rejects the order, it does not revert)', () => {
        expect(parseError(simulationError(752)).code).toBe(ZenexErrorCode.UnknownError);
    });

    it('754 -> PendingPnlExceeded', () => {
        const error = parseError(simulationError(754));
        expect(error.code).toBe(ZenexErrorCode.PendingPnlExceeded);
        expect(error.message).toMatch(/PnL/i);
    });

    it('760 -> NothingToClaim', () => {
        expect(parseError(simulationError(760)).code).toBe(ZenexErrorCode.NothingToClaim);
    });

    it('770-772 resolve unhinted to the market ADL errors', () => {
        const adlNotTriggered = parseError(simulationError(770));
        expect(adlNotTriggered.code).toBe(ZenexErrorCode.AdlNotTriggered);
        expect(adlNotTriggered.message).toMatch(/ADL/);
        expect(adlNotTriggered.message).not.toMatch(/queued/i);

        expect(parseError(simulationError(771)).code).toBe(ZenexErrorCode.AdlOvershoot);
        expect(parseError(simulationError(772)).code).toBe(ZenexErrorCode.AdlNotEligible);
    });
});

describe('parseError: periphery namespaces resolve unhinted', () => {
    it('governance 810-812', () => {
        const notQueued = parseError(simulationError(810));
        expect(notQueued.code).toBe(ZenexErrorCode.GovNotQueued);
        expect(notQueued.message).toMatch(/queued/i);
        expect(notQueued.message).not.toMatch(/ADL/);

        expect(parseError(simulationError(811)).code).toBe(ZenexErrorCode.GovNotUnlocked);
        expect(parseError(simulationError(812)).code).toBe(ZenexErrorCode.GovInvalidDelay);
    });

    it('strategy-vault 800-803', () => {
        expect(parseError(simulationError(800)).code).toBe(ZenexErrorCode.StrategyInvalidAmount);
        expect(parseError(simulationError(801)).code).toBe(ZenexErrorCode.StrategyPnlExceedsAssets);
        expect(parseError(simulationError(802)).code).toBe(
            ZenexErrorCode.StrategySupplyLimitExceeded,
        );
        expect(parseError(simulationError(803)).code).toBe(
            ZenexErrorCode.StrategyPayoutExceedsAssets,
        );
    });

    it('oracle feed/clock pair 790/793 (no longer strategy-vault codes)', () => {
        expect(parseError(simulationError(790)).code).toBe(ZenexErrorCode.OracleFeedMismatch);
        expect(parseError(simulationError(793)).code).toBe(ZenexErrorCode.OraclePriceAhead);
    });

    it('oracle Chainlink report rejects 784/785; the Lazer parser range is retired', () => {
        expect(parseError(simulationError(784)).code).toBe(ZenexErrorCode.OracleReportExpired);
        expect(parseError(simulationError(785)).code).toBe(
            ZenexErrorCode.OracleInvalidSpreadReduction,
        );
        for (const code of [786, 787, 788, 789, 791, 792]) {
            expect(parseError(simulationError(code)).code, `code ${code}`).toBe(
                ZenexErrorCode.UnknownError,
            );
        }
    });

    it('treasury 900', () => {
        expect(parseError(simulationError(900)).code).toBe(ZenexErrorCode.TreasuryInvalidRate);
    });
});

describe('parseError: fallbacks', () => {
    it('a non-colliding market code resolves with its message (704 -> MarketFrozen)', () => {
        const error = parseError(simulationError(704));
        expect(error.code).toBe(ZenexErrorCode.MarketFrozen);
        expect(error.code).toBe(704);
        expect(error.message).not.toContain('Unknown');
    });

    it('unknown codes fall back to UnknownError', () => {
        expect(parseError(simulationError(999)).code).toBe(ZenexErrorCode.UnknownError);
        expect(parseError(simulationError(707)).code).toBe(ZenexErrorCode.UnknownError);
    });
});
