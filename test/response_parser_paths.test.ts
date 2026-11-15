import { describe, it, expect } from 'vitest';
import { Address, StrKey, xdr, nativeToScVal } from '@stellar/stellar-sdk';
import { parseContractErrorCode } from '../src/errors.js';
import { parseError, parseResult, ZenexErrorCode } from '../src/response_parser.js';

// =============================================================================
// Exercises every parseError input shape: simulation errors (regex path),
// send-transaction errors (errorResult XDR), and get-transaction failures
// (resultXdr), plus both parseResult retrieval branches.
// =============================================================================

function simulationError(message: string, events: xdr.DiagnosticEvent[] = []) {
    return {
        id: 'sim-1',
        latestLedger: 1,
        events,
        error: message,
    } as never;
}

const ACCOUNT = StrKey.encodeContract(Buffer.alloc(32, 9));
const MARKET = StrKey.encodeContract(Buffer.alloc(32, 1));

/** A diagnostic `error` event, as the RPC returns it: decoded from its XDR. */
function diagnosticError(
    contract: string | null,
    error: xdr.ScError,
    data: xdr.ScVal,
): xdr.DiagnosticEvent {
    const event = new xdr.DiagnosticEvent({
        inSuccessfulContractCall: false,
        event: new xdr.ContractEvent({
            ext: new xdr.ExtensionPoint(0),
            contractId:
                contract === null ? null : (StrKey.decodeContract(contract) as unknown as xdr.Hash),
            type: xdr.ContractEventType.diagnostic(),
            body: new xdr.ContractEventBody(
                0,
                new xdr.ContractEventV0({
                    topics: [xdr.ScVal.scvSymbol('error'), xdr.ScVal.scvError(error)],
                    data,
                }),
            ),
        }),
    });
    return xdr.DiagnosticEvent.fromXDR(event.toXDR());
}

/**
 * The host's event for an account contract whose `__check_auth` failed with
 * `code`: no emitting contract, an `Error(Auth, InvalidAction)` topic, and
 * the account's own error last in the data.
 */
function authFailureEvent(code: number): xdr.DiagnosticEvent {
    return diagnosticError(
        null,
        xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction()),
        xdr.ScVal.scvVec([
            xdr.ScVal.scvString('failed account authentication with error'),
            Address.fromString(ACCOUNT).toScVal(),
            xdr.ScVal.scvError(xdr.ScError.sceContract(code)),
        ]),
    );
}

/** A contract error a caller caught: `contract try_call failed`. */
function contractErrorEvent(code: number): xdr.DiagnosticEvent {
    return diagnosticError(
        MARKET,
        xdr.ScError.sceContract(code),
        xdr.ScVal.scvVec([
            xdr.ScVal.scvString('contract try_call failed'),
            xdr.ScVal.scvSymbol('execute_order'),
            xdr.ScVal.scvVec([]),
        ]),
    );
}

function txFailedResult() {
    const operationTrapped = xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(
            xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
        ),
    );
    return new xdr.TransactionResult({
        feeCharged: new xdr.Int64(100),
        result: xdr.TransactionResultResult.txFailed([operationTrapped]),
        ext: new xdr.TransactionResultExt(0),
    });
}

function txBadSeqResult() {
    return new xdr.TransactionResult({
        feeCharged: new xdr.Int64(100),
        result: xdr.TransactionResultResult.txBadSeq(),
        ext: new xdr.TransactionResultExt(0),
    });
}

describe('parseError: simulation responses', () => {
    it('resolves a market code without any hint', () => {
        const error = parseError(simulationError('HostError: Error(Contract, #720)'));
        expect(error.code).toBe(ZenexErrorCode.PositionNotFound);
    });

    it('resolves 770 unhinted now that governance vacated the ADL range', () => {
        const error = parseError(simulationError('Error(Contract, #770)'));
        expect(error.code).toBe(ZenexErrorCode.AdlNotTriggered);
        expect(error.message).toMatch(/ADL/);
    });

    it('resolves merged-enum codes and falls back to UnknownError', () => {
        expect(parseError(simulationError('Error(Contract, #100)')).code).toBe(
            ZenexErrorCode.InsufficientBalance,
        );
        expect(parseError(simulationError('Error(Contract, #99999)')).code).toBe(
            ZenexErrorCode.UnknownError,
        );
        expect(parseError(simulationError('no code in this message')).code).toBe(
            ZenexErrorCode.UnknownError,
        );
    });
});

describe('parseError: the host error that ended the simulation decides', () => {
    const LOG = '\n\nEvent log (newest first):\n';

    it('reports the leading contract error in the normal case', () => {
        const error = parseError(
            simulationError(
                'HostError: Error(Contract, #713)' +
                    LOG +
                    '   0: [Diagnostic Event] contract:CA, topics:[error, Error(Contract, #713)], data:"escalating error to panic"\n' +
                    '   1: [Diagnostic Event] contract:CA, topics:[error, Error(Contract, #713)], data:["contract call failed", create_order, []]',
            ),
        );
        expect(error.code).toBe(ZenexErrorCode.InsufficientMargin);
    });

    it('reports a top-level budget error, not the contract error a contract caught', () => {
        const error = parseError(
            simulationError(
                'HostError: Error(Budget, ExceededLimit)' +
                    LOG +
                    '   0: [Diagnostic Event] topics:[error, Error(Budget, ExceededLimit)], data:["operation instructions exceeds amount specified", 100000000]\n' +
                    '   1: [Diagnostic Event] contract:CB, topics:[error, Error(Contract, #741)], data:["contract try_call failed", execute_order, []]',
            ),
        );
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Host error Error(Budget, ExceededLimit)');
    });

    it('still decodes an account contract reject behind a leading auth error', () => {
        const error = parseError(
            simulationError(
                'HostError: Error(Auth, InvalidAction)' +
                    LOG +
                    '   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CACCOUNT, Error(Contract, #4004)]',
            ),
        );
        expect(error.code).toBe(ZenexErrorCode.SessionTransferNotAllowed);
    });

    it('reads the account code from the response events, which the public RPC returns in place of a log', () => {
        // The RPC's error text is the host error alone: the account's own
        // code is only on the diagnostic event.
        const response = simulationError('HostError: Error(Auth, InvalidAction)', [
            authFailureEvent(4004),
        ]);
        expect(parseContractErrorCode('HostError: Error(Auth, InvalidAction)')).toBeUndefined();
        const error = parseError(response);
        expect(error.code).toBe(ZenexErrorCode.SessionTransferNotAllowed);
        expect(error.source).toBeUndefined();

        const smartAccount = parseError(
            simulationError('HostError: Error(Auth, InvalidAction)', [authFailureEvent(3003)]),
        );
        expect(smartAccount.code).toBe(ZenexErrorCode.SmartAccountExternalVerificationFailed);
    });

    it('takes the newest account-authentication event, and the events before the text', () => {
        const events = [authFailureEvent(3003), contractErrorEvent(741), authFailureEvent(4002)];
        const text =
            'HostError: Error(Auth, InvalidAction)' +
            LOG +
            '   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CACCOUNT, Error(Contract, #4006)]';
        expect(parseError(simulationError(text, events)).code).toBe(
            ZenexErrorCode.SessionContractNotAllowed,
        );
        // Events that hold no such event leave the text to decide.
        expect(parseError(simulationError(text, [contractErrorEvent(741)])).code).toBe(4006);
    });

    it('never takes a contract error the invocation survived from the events', () => {
        const error = parseError(
            simulationError('HostError: Error(Auth, InvalidAction)', [contractErrorEvent(741)]),
        );
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Host error Error(Auth, InvalidAction)');
    });

    it.each([
        // A market code, a code the token and the verifier share, a governance
        // code, and the gaps beside the two account ranges.
        713, 12, 810, 2999, 3017, 4001, 4008, 99_999,
    ])('does not decode %i from an account that is not a Zenex smart account', (code) => {
        const expected = `Unknown account contract error Error(Contract, #${code})`;
        const fromEvents = parseError(
            simulationError('HostError: Error(Auth, InvalidAction)', [authFailureEvent(code)]),
        );
        expect(fromEvents.code).toBe(ZenexErrorCode.UnknownError);
        expect(fromEvents.message).toBe(expected);

        const fromText = parseError(
            simulationError(
                'HostError: Error(Auth, InvalidAction)' +
                    LOG +
                    `   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", CACCOUNT, Error(Contract, #${code})]`,
            ),
        );
        expect(fromText.code).toBe(ZenexErrorCode.UnknownError);
        expect(fromText.message).toBe(expected);
        // A hint does not turn the account's number into a verifier error.
        const hinted = parseError(
            simulationError('HostError: Error(Auth, InvalidAction)', [authFailureEvent(code)]),
            'verifier',
        );
        expect(hinted.code).toBe(ZenexErrorCode.UnknownError);
    });

    it('keeps the number of an account code inside the ranges that the catalog does not define', () => {
        // 3001 sits inside 3000-3016 but no contract defines it.
        const error = parseError(
            simulationError('HostError: Error(Auth, InvalidAction)', [authFailureEvent(3001)]),
        );
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Unknown account contract error Error(Contract, #3001)');
    });

    it('decodes every catalogued account code behind a leading auth error', () => {
        const accountCodes = Object.values(ZenexErrorCode).filter(
            (value): value is number =>
                typeof value === 'number' &&
                ((value >= 3000 && value <= 3016) || (value >= 4002 && value <= 4007)),
        );
        expect(accountCodes.length).toBeGreaterThan(20);
        for (const code of accountCodes) {
            const error = parseError(
                simulationError('HostError: Error(Auth, InvalidAction)', [authFailureEvent(code)]),
            );
            expect(error.code, `code ${code}`).toBe(code);
        }
    });

    it('still decodes a market code that ended the invocation itself', () => {
        // The range applies to the authentication path only.
        const error = parseError(
            simulationError('HostError: Error(Contract, #713)', [contractErrorEvent(713)]),
        );
        expect(error.code).toBe(ZenexErrorCode.InsufficientMargin);
    });

    it('names a leading auth error that hides no contract code', () => {
        const error = parseError(
            simulationError(
                'HostError: Error(Auth, InvalidAction)' +
                    LOG +
                    '   0: [Diagnostic Event] topics:[error, Error(Auth, InvalidAction)], data:"Unauthorized function call for address"',
            ),
        );
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Host error Error(Auth, InvalidAction)');
    });
});

describe('parseError: send-transaction responses', () => {
    it('maps a trapped host function through errorResult', () => {
        // InvokeHostFunctionResultCode: trapped = -2 = InvokeHostFunctionTrapped
        const error = parseError({ status: 'ERROR', errorResult: txFailedResult() } as never);
        expect(error.code).toBe(ZenexErrorCode.InvokeHostFunctionTrapped);
    });

    it('maps a tx-level error code through the switch-value offset', () => {
        // TransactionResultCode txBadSeq = -5; parser offset -7 lands on -12 = txBadSeq
        const error = parseError({ status: 'ERROR', errorResult: txBadSeqResult() } as never);
        expect(error.code).toBe(ZenexErrorCode.txBadSeq);
    });
});

describe('parseError: get-transaction responses', () => {
    it('maps a trapped host function through resultXdr', () => {
        const error = parseError({ resultXdr: txFailedResult() } as never);
        expect(error.code).toBe(ZenexErrorCode.InvokeHostFunctionTrapped);
    });

    it('maps a tx-level error code through resultXdr', () => {
        const error = parseError({ resultXdr: txBadSeqResult() } as never);
        expect(error.code).toBe(ZenexErrorCode.txBadSeq);
    });
});

function txFailedWith(operation: xdr.OperationResult) {
    return new xdr.TransactionResult({
        feeCharged: new xdr.Int64(100),
        result: xdr.TransactionResultResult.txFailed([operation]),
        ext: new xdr.TransactionResultExt(0),
    });
}

describe('parseError: never throws', () => {
    it('names an operation-level failure instead of throwing', () => {
        const error = parseError({
            status: 'ERROR',
            errorResult: txFailedWith(xdr.OperationResult.opBadAuth()),
        } as never);
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Operation failed: opBadAuth');
    });

    it('names a failed TTL extension or restore instead of throwing', () => {
        const extend = parseError({
            resultXdr: txFailedWith(
                xdr.OperationResult.opInner(
                    xdr.OperationResultTr.extendFootprintTtl(
                        xdr.ExtendFootprintTtlResult.extendFootprintTtlMalformed(),
                    ),
                ),
            ),
        } as never);
        expect(extend.code).toBe(ZenexErrorCode.UnknownError);
        expect(extend.message).toBe('Operation failed: extendFootprintTtlMalformed');

        const restore = parseError({
            status: 'ERROR',
            errorResult: txFailedWith(
                xdr.OperationResult.opInner(
                    xdr.OperationResultTr.restoreFootprint(
                        xdr.RestoreFootprintResult.restoreFootprintResourceLimitExceeded(),
                    ),
                ),
            ),
        } as never);
        expect(restore.message).toBe('Operation failed: restoreFootprintResourceLimitExceeded');
    });

    it('returns UnknownError for a shape it cannot read', () => {
        for (const input of [null, undefined, {}, { errorResult: {} }, 'boom']) {
            expect(parseError(input as never).code).toBe(ZenexErrorCode.UnknownError);
        }
    });
});

describe('parseError: host errors outside any contract', () => {
    it('surfaces a non-root auth failure with the simulation fix', () => {
        const error = parseError(
            simulationError(
                'HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ' +
                    '[recording authorization only] encountered authorization not tied to the root contract invocation for an address.',
            ),
        );
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toContain('Error(Auth, InvalidAction)');
        expect(error.message).toContain('record_allow_nonroot');
    });

    it('names a storage or budget host error', () => {
        const error = parseError(simulationError('HostError: Error(Storage, MissingValue)\n...'));
        expect(error.message).toBe('Host error Error(Storage, MissingValue)');
    });

    it('keeps an unrecognized contract code in the message', () => {
        const error = parseError(simulationError('HostError: Error(Contract, #99999)'));
        expect(error.code).toBe(ZenexErrorCode.UnknownError);
        expect(error.message).toBe('Unknown contract error Error(Contract, #99999)');
    });

    it('reads a simulation error that carries no id', () => {
        const error = parseError({ error: 'HostError: Error(Contract, #720)' } as never);
        expect(error.code).toBe(ZenexErrorCode.PositionNotFound);
    });
});

describe('parseResult', () => {
    const returnValue = nativeToScVal(42n, { type: 'i128' });
    const parser = (base64Xdr: string) => xdr.ScVal.fromXDR(base64Xdr, 'base64');

    it('reads a simulation result', () => {
        const parsed = parseResult({ result: { retval: returnValue } } as never, parser);
        expect(parsed).toBeDefined();
    });

    it('reads a transaction returnValue', () => {
        const parsed = parseResult({ returnValue } as never, parser);
        expect(parsed).toBeDefined();
    });

    it('returns undefined when neither is present', () => {
        expect(parseResult({} as never, parser)).toBeUndefined();
    });
});
