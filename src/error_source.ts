import { parseContractErrorCode } from './errors.js';
import type { ZenexErrorSource } from './errors.js';

// Which contract raised a failed invocation's error, read from its diagnostic
// events. `parseError` and `inferErrorSource` are the public paths; the rest
// is internal.
//
// The host logs one event per step of an invocation. A call into a contract
// logs `fn_call` with the callee and the function, and a return logs
// `fn_return`. A contract that fails logs an `error` event under its own id.
// Each caller the failure unwinds through then logs `contract call failed`,
// plus the VM's own escalation and trap lines. So the events that end a
// failed invocation are a run of error lines, all with the code that ended
// it, and the oldest one in that run was logged by the contract that raised
// the code, inside the call whose `fn_call` is still open at that point.
// A caller that catches a failure logs `contract try_call failed` and goes
// on, so the run never reaches back past one: what lies before it is a
// failure the invocation survived.

/** @internal One diagnostic event, reduced to what locating the failing call needs. */
export type CallEvent =
    /** `fn_call`: a call into `callee`'s function `fn`. */
    | { kind: 'call'; callee: string; fn: string }
    /** `fn_return`: the innermost open call returned. */
    | { kind: 'return' }
    /**
     * Logged by the caller: the innermost open call failed. `caught` for
     * `contract try_call failed`, where the caller survives the failure, and
     * not for `contract call failed`, where it fails with it.
     */
    | { kind: 'callFailed'; code: number; caught: boolean }
    /** A contract error logged by `contract` itself. */
    | { kind: 'error'; contract: string | undefined; code: number }
    /** A VM trap line (`log`): part of an unwinding failure, with no frame effect. */
    | { kind: 'trap' }
    /** Anything else: a contract's own event, or a diagnostic of another shape. */
    | { kind: 'other' };

// The entry point the oracle calls on the Chainlink Data Streams verifier.
const VERIFIER_FUNCTIONS: ReadonlySet<string> = new Set(['verify']);
// The Stellar Asset Contract interface: the token interface and its admin
// functions.
const TOKEN_FUNCTIONS: ReadonlySet<string> = new Set([
    'allowance',
    'approve',
    'balance',
    'transfer',
    'transfer_from',
    'burn',
    'burn_from',
    'decimals',
    'name',
    'symbol',
    'mint',
    'clawback',
    'set_admin',
    'admin',
    'set_authorized',
    'authorized',
    'trust',
]);

/**
 * @internal
 * The contract whose call raised `code`, the contract error that ended the
 * invocation `events` describe (oldest first), or `undefined` when the
 * events do not show it.
 *
 * Decided by the failing call, never by the number: the oldest event of the
 * failure that ends the log names the contract that raised the code, and the
 * call still open at that point names the function. `verify` is the price
 * verifier, a token interface function is the token. Anything else, a log
 * that does not end in the failure, a failure that was caught, or a failing
 * contract that is not the callee of the open call, is undecided.
 */
export function sourceOfFailingCall(
    events: readonly CallEvent[],
    code: number,
): ZenexErrorSource | undefined {
    // The failure that ended the invocation: the trailing run of error and
    // trap lines carrying the code.
    let origin = events.length;
    while (origin > 0 && unwinds(events[origin - 1], code)) origin--;
    // The run starts at the contract's own error. Trap lines carry no code.
    while (origin < events.length && events[origin].kind === 'trap') origin++;
    const raised = events[origin];
    if (raised?.kind !== 'error' || raised.contract === undefined) {
        return undefined;
    }

    // The call open when the error was raised.
    const open: { callee: string; fn: string }[] = [];
    for (const event of events.slice(0, origin)) {
        if (event.kind === 'call') open.push(event);
        else if (event.kind === 'return' || event.kind === 'callFailed') open.pop();
    }
    const failing = open[open.length - 1];
    if (failing === undefined || failing.callee !== raised.contract) {
        return undefined;
    }
    if (VERIFIER_FUNCTIONS.has(failing.fn)) return 'verifier';
    if (TOKEN_FUNCTIONS.has(failing.fn)) return 'token';
    return undefined;
}

function unwinds(event: CallEvent, code: number): boolean {
    if (event.kind === 'trap') return true;
    if (event.kind === 'callFailed') return !event.caught && event.code === code;
    return event.kind === 'error' && event.code === code;
}

// The host's text form of the same events, one per line, newest first:
//   0: [Diagnostic Event] contract:C..., topics:[error, Error(Contract, #9)], data:"..."
//   1: [Diagnostic Event] contract:C..., topics:[fn_call, C..., verify], data:[...]
// An event of a failed call reads `[Failed Diagnostic Event (not emitted)]`.
// A value quoted in an event's data can repeat any of this text, so every
// pattern below is anchored: the event line's own prefix first, then the
// topics that follow it.
const EVENT_LOG_PATTERN = /Event log\b/;
const LINE_BREAK_PATTERN = /\r?\n|(?:\\r)?\\n/;
// The line up to its topics: the index, the event type, the emitting
// contract when there is one, and the opening of the topic list.
const EVENT_LINE_PATTERN =
    /^\s*\d+: \[(?:Failed )?(\w+) Event(?: \(not emitted\))?\] (?:contract:(C[A-Z2-7]{55}), )?topics:\[/;
// The rest of the line, from its first topic.
const CALL_PATTERN = /^fn_call, (C[A-Z2-7]{55}), (\w+)\]/;
const RETURN_PATTERN = /^fn_return, \w+\]/;
const ERROR_PATTERN = /^error, Error\(Contract, #(\d{1,10})\)\], data:(.*)$/;
// The data of the event a caller logs for a failed call. The quotes are
// escaped in text that went through a JSON dump.
const CALL_FAILED_PATTERN = /^\[\\?"contract (try_)?call failed\\?"/;
const TRAP_PATTERN = /^log\]/;

/**
 * @internal
 * The events of a simulation error text's event log, oldest first. Empty
 * when the text carries no event log.
 */
export function callEventsFromLog(rpcError: string): CallEvent[] {
    const log = EVENT_LOG_PATTERN.exec(rpcError);
    if (log === null) return [];
    const events: CallEvent[] = [];
    for (const line of rpcError.slice(log.index).split(LINE_BREAK_PATTERN)) {
        const prefix = EVENT_LINE_PATTERN.exec(line);
        if (prefix === null) continue;
        events.push(callEventFromTopics(line.slice(prefix[0].length), prefix[1], prefix[2]));
    }
    // The log lists the newest event first.
    return events.reverse();
}

/**
 * One event from the text after `topics:[`, the event type and the emitting
 * contract of its line.
 */
function callEventFromTopics(topics: string, type: string, emitter: string | undefined): CallEvent {
    if (type !== 'Diagnostic') return { kind: 'other' };
    const call = CALL_PATTERN.exec(topics);
    if (call !== null) return { kind: 'call', callee: call[1], fn: call[2] };
    if (RETURN_PATTERN.test(topics)) return { kind: 'return' };
    const error = ERROR_PATTERN.exec(topics);
    if (error !== null) {
        const code = Number(error[1]);
        const failed = CALL_FAILED_PATTERN.exec(error[2]);
        if (failed !== null) {
            return { kind: 'callFailed', code, caught: failed[1] !== undefined };
        }
        return { kind: 'error', contract: emitter, code };
    }
    if (TRAP_PATTERN.test(topics)) return { kind: 'trap' };
    return { kind: 'other' };
}

/**
 * Which contract raised the error that ended an invocation, read from the
 * event log of a raw simulation or diagnostic string: `'token'`,
 * `'verifier'`, or `undefined` when the text does not show it. Exported
 * from the root and from the `./errors` subpath.
 *
 * It answers the question a code in 2-13 leaves open (see
 * `zenexErrorFromCode`), and it answers from the failing call, never from
 * the number. The event log shows the contract that raised the error and the
 * call it was raised in: the verifier's `verify`, or a token function such
 * as `transfer`. A call that both moves tokens and verifies a price report,
 * such as the router's create-and-fill, is decided the same way.
 *
 * Only an event's own line is read: its index, type and emitting contract,
 * then its topics. Text that a value in an event's data merely quotes, such
 * as a contract's `log` of a line that looks like a call, is never an event.
 *
 * `undefined` when the text has no event log (the RPC's simulation error
 * string carries none; `parseError` reads the response's events instead),
 * when no contract error ended the invocation, or when the failing call is
 * neither of the two.
 */
export function inferErrorSource(rpcError: string): ZenexErrorSource | undefined {
    const code = parseContractErrorCode(rpcError);
    if (code === undefined) return undefined;
    return sourceOfFailingCall(callEventsFromLog(rpcError), code);
}
