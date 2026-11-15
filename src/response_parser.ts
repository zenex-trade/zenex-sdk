import { StrKey, rpc, xdr } from '@stellar/stellar-sdk';
import {
    ZenexError,
    ZenexErrorCode,
    zenexErrorFromCode,
    parseContractErrorCode,
} from './errors.js';
import type { ZenexErrorSource } from './errors.js';
import { callEventsFromLog, sourceOfFailingCall } from './error_source.js';
import type { CallEvent } from './error_source.js';
import { Buffer } from 'buffer';

export { ZenexError, ZenexErrorCode, zenexErrorFromCode } from './errors.js';

/** The first host error in an RPC error string, e.g. `Error(Auth, InvalidAction)`: the one that ended the invocation. */
const HOST_ERROR_PATTERN = /Error\((\w+), ([^)]*)\)/;
/** The recording-mode diagnostic for a `require_auth` below the root invocation. */
const NON_ROOT_AUTH = 'not tied to the root contract invocation';
/** The diagnostic section of a simulation error: `Event log (newest first):`. */
const EVENT_LOG_PATTERN = /Event log\b/;
/**
 * The message of the host's diagnostic for an account contract whose
 * `__check_auth` failed. The account's own error follows it in the event.
 */
const ACCOUNT_AUTH_FAILURE = 'failed account authentication';
/**
 * The code ranges the catalog assigns to account-side contracts: the smart
 * account (3000-3016) and the session policy (4002-4007).
 */
const ACCOUNT_CODE_RANGES: readonly (readonly [number, number])[] = [
    [3000, 3016],
    [4002, 4007],
];
/** Longest raw text an UnknownError message carries. */
const MAX_DETAIL = 200;

/**
 * Parse a failed simulation, send-transaction, or get-transaction response
 * into a ZenexError.
 *
 * Never throws. A recognized contract, transaction or host-function code
 * resolves to its `ZenexErrorCode`. Anything else returns `UnknownError`
 * with a message that names what failed: the host error of a failed
 * simulation, such as `Error(Auth, InvalidAction)`, or the operation
 * result of a failed transaction.
 *
 * A failed simulation is read by the rule `parseContractErrorCode` states:
 * the host error that ended the invocation decides, and a contract error
 * the invocation survived, listed only in the event log, is not reported.
 *
 * A leading `Error(Auth, ...)` is an account contract's failed
 * `__check_auth`. The account's own code sits on the
 * `failed account authentication` diagnostic event: it is read from the
 * response's `events`, then from an event log in the error text. Only a
 * smart-account (3000-3016) or session-policy (4002-4007) code is decoded
 * there. An account that is not a Zenex smart account numbers its errors as
 * it likes, so any other number returns `UnknownError` with the number in
 * its message, never the market or verifier error of the same number.
 *
 * A contract code in 2-13, the range the token and the price verifier
 * share, is decided from the failed simulation itself. Its diagnostic events
 * name the contract that raised the error and the call it was raised in: the
 * verifier's `verify`, or a token function such as `transfer`. That holds
 * for a call that does both, such as the router's create-and-fill or a fee
 * forwarder relay. The response's `events` are read first, then an event log
 * in the error text. When neither shows the failing call, the code resolves
 * to an `ambiguous` error that states both meanings. The number alone never
 * decides. A send-transaction or get-transaction response carries a result
 * code only, never a contract code, so the question does not arise there.
 *
 * @param source Overrides the inference: `'token'` or `'verifier'` for a
 *   code in 2-13, whatever the events show. See `zenexErrorFromCode`.
 */
export function parseError(
    errorResponse:
        | rpc.Api.GetFailedTransactionResponse
        | rpc.Api.SendTransactionResponse
        | rpc.Api.SimulateTransactionErrorResponse,
    source?: ZenexErrorSource,
): ZenexError {
    try {
        return decodeErrorResponse(errorResponse, source);
    } catch {
        return new ZenexError(ZenexErrorCode.UnknownError);
    }
}

function resolve(code: number, source?: ZenexErrorSource): ZenexError | undefined {
    const resolved = zenexErrorFromCode(code, source);
    return resolved.code === ZenexErrorCode.UnknownError ? undefined : resolved;
}

function unknown(detail: string): ZenexError {
    const trimmed = detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}...` : detail;
    return new ZenexError(ZenexErrorCode.UnknownError, trimmed);
}

function decodeErrorResponse(
    errorResponse: unknown,
    source: ZenexErrorSource | undefined,
): ZenexError {
    if (typeof errorResponse !== 'object' || errorResponse === null) {
        return new ZenexError(ZenexErrorCode.UnknownError);
    }
    const response = errorResponse as {
        error?: unknown;
        events?: unknown;
        errorResult?: xdr.TransactionResult;
        resultXdr?: xdr.TransactionResult;
    };

    // Simulation Error
    if (typeof response.error === 'string') {
        return fromSimulationError(response.error, source, response.events);
    }
    // Send Transaction Error
    if (response.errorResult) {
        return fromTransactionResult(response.errorResult);
    }
    // Get Transaction Error
    if (response.resultXdr) {
        return fromTransactionResult(response.resultXdr);
    }
    return new ZenexError(ZenexErrorCode.UnknownError);
}

function fromSimulationError(
    raw: string,
    hint: ZenexErrorSource | undefined,
    events: unknown,
): ZenexError {
    if (leadingHostError(raw) === 'Auth') {
        // The code of a failed account authentication is the account's own.
        const account = accountAuthCode(events) ?? parseContractErrorCode(raw);
        if (account !== undefined) return fromAccountCode(account);
    }
    const code = parseContractErrorCode(raw);
    const resolved =
        code === undefined ? undefined : resolve(code, hint ?? failingSource(code, raw, events));
    if (resolved) return resolved;

    const host = HOST_ERROR_PATTERN.exec(raw);
    if (host === null) {
        const line = raw.split('\n', 1)[0].trim();
        return line.length > 0 ? unknown(line) : new ZenexError(ZenexErrorCode.UnknownError);
    }
    if (host[1] === 'Contract') {
        return unknown(`Unknown contract error ${host[0]}`);
    }
    if (raw.includes(NON_ROOT_AUTH)) {
        return unknown(
            `Host error ${host[0]}: a require_auth below the root invocation; simulate with authMode 'record_allow_nonroot'`,
        );
    }
    return unknown(`Host error ${host[0]}`);
}

/**
 * The type of the host error that ended the invocation: the first one ahead
 * of the event log, as `parseContractErrorCode` reads it.
 */
function leadingHostError(raw: string): string | undefined {
    const log = EVENT_LOG_PATTERN.exec(raw);
    const header = log === null ? raw : raw.slice(0, log.index);
    return HOST_ERROR_PATTERN.exec(header)?.[1];
}

/**
 * The account contract's own code from the newest
 * `failed account authentication` event of a simulation's diagnostic
 * events, or `undefined` when they hold none. The public RPC returns the
 * events and no event log in the error text, so the code is only here.
 */
function accountAuthCode(events: unknown): number | undefined {
    if (!Array.isArray(events)) return undefined;
    try {
        const diagnostics = events as xdr.DiagnosticEvent[];
        // Newest first, as the event log lists them.
        for (let index = diagnostics.length - 1; index >= 0; index--) {
            const event = diagnostics[index].event();
            if (event.type().name !== 'diagnostic') continue;
            const body = event.body().v0();
            if (text(body.topics()[0]) !== 'error') continue;
            // The host logs [message, account address, the account's error].
            const data = body.data();
            const values = data.switch().name === 'scvVec' ? (data.vec() ?? []) : [];
            if (text(values[0])?.startsWith(ACCOUNT_AUTH_FAILURE) !== true) continue;
            for (const value of values) {
                const code = contractErrorCode(value);
                if (code !== undefined) return code;
            }
            return undefined;
        }
    } catch {
        // Not the events of a simulation: the text decides.
    }
    return undefined;
}

/**
 * The error for a code an account contract failed its authentication with.
 * Only the catalog's account-side codes decode; another number is the
 * account's own business and stays unknown, with the number kept.
 */
function fromAccountCode(code: number): ZenexError {
    const known = ACCOUNT_CODE_RANGES.some(([first, last]) => code >= first && code <= last);
    return (
        (known ? resolve(code) : undefined) ??
        unknown(`Unknown account contract error Error(Contract, #${code})`)
    );
}

/**
 * Which contract raised `code`, from the simulation's diagnostic events, or
 * from the event log in its error text when the response carries no events.
 */
function failingSource(code: number, raw: string, events: unknown): ZenexErrorSource | undefined {
    if (Array.isArray(events) && events.length > 0) {
        try {
            const calls = (events as xdr.DiagnosticEvent[]).map(callEvent);
            return sourceOfFailingCall(calls, code);
        } catch {
            // Not the events of a simulation: fall through to the text.
        }
    }
    return sourceOfFailingCall(callEventsFromLog(raw), code);
}

/** The text of a symbol or string value, or `undefined` for another type. */
function text(value: xdr.ScVal | undefined): string | undefined {
    const kind = value?.switch().name;
    if (kind === 'scvSymbol') return value?.sym().toString();
    if (kind === 'scvString') return value?.str().toString();
    return undefined;
}

/** The code of an `Error(Contract, #N)` value, or `undefined` for anything else. */
function contractErrorCode(value: xdr.ScVal | undefined): number | undefined {
    if (value?.switch().name !== 'scvError') return undefined;
    const error = value.error();
    return error.switch().name === 'sceContract' ? error.contractCode() : undefined;
}

/** Reduce one diagnostic event to what locating the failing call needs. */
function callEvent(diagnostic: xdr.DiagnosticEvent): CallEvent {
    const event = diagnostic.event();
    if (event.type().name !== 'diagnostic') return { kind: 'other' };
    const body = event.body().v0();
    const topics = body.topics();
    const topic = text(topics[0]);

    if (topic === 'fn_call') {
        const callee = topics[1];
        const fn = text(topics[2]);
        if (callee?.switch().name !== 'scvBytes' || fn === undefined) {
            return { kind: 'other' };
        }
        return { kind: 'call', callee: StrKey.encodeContract(callee.bytes()), fn };
    }
    if (topic === 'fn_return') return { kind: 'return' };
    if (topic === 'log') return { kind: 'trap' };
    if (topic !== 'error') return { kind: 'other' };

    const code = contractErrorCode(topics[1]);
    if (code === undefined) return { kind: 'other' };
    // A caller logs a failed call as [message, function, arguments].
    const data = body.data();
    const message = data.switch().name === 'scvVec' ? text(data.vec()?.[0]) : undefined;
    if (message === 'contract call failed') {
        return { kind: 'callFailed', code, caught: false };
    }
    if (message === 'contract try_call failed') {
        return { kind: 'callFailed', code, caught: true };
    }
    const emitter = event.contractId();
    return {
        kind: 'error',
        contract:
            emitter === null || emitter === undefined
                ? undefined
                : // The id is 32 raw bytes, whatever the generated type says.
                  StrKey.encodeContract(Buffer.from(emitter as unknown as Uint8Array)),
        code,
    };
}

function fromTransactionResult(result: xdr.TransactionResult): ZenexError {
    const outcome = result.result();
    if (outcome.switch().name !== 'txFailed') {
        // TransactionResultCode sits 7 above the ZenexErrorCode tx range.
        return (
            resolve(outcome.switch().value - 7) ??
            unknown(`Transaction failed: ${outcome.switch().name}`)
        );
    }
    const operations = outcome.results();
    if (operations.length !== 1) {
        return unknown(`Transaction failed with ${operations.length} operation results`);
    }
    return fromOperationResult(operations[0]);
}

function fromOperationResult(operation: xdr.OperationResult): ZenexError {
    if (operation.switch().name !== 'opInner') {
        return unknown(`Operation failed: ${operation.switch().name}`);
    }
    const inner = operation.tr();
    if (inner.switch().name !== 'invokeHostFunction') {
        // A restore, a TTL extension or a classic operation: its result arm
        // names the failure, but no ZenexErrorCode covers it.
        const arm = inner.value() as { switch(): { name: string } };
        return unknown(`Operation failed: ${arm.switch().name}`);
    }
    const hostFunction = inner.invokeHostFunctionResult().switch();
    return resolve(hostFunction.value) ?? unknown(`Operation failed: ${hostFunction.name}`);
}

/**
 * Decode the return value of a successful simulation or transaction, using
 * `parser` to decode the XDR. Returns `undefined` when the response carries
 * no return value.
 */
export function parseResult<T>(
    response: rpc.Api.SimulateTransactionSuccessResponse | rpc.Api.GetSuccessfulTransactionResponse,
    parser: (xdr: string) => T,
): T | undefined {
    if ('result' in response && response.result) {
        return parser(response.result.retval.toXDR('base64'));
    } else if ('returnValue' in response && response.returnValue) {
        return parser(response.returnValue.toXDR('base64'));
    } else {
        return undefined;
    }
}
