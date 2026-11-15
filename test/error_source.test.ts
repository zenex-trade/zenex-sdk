import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Address, StrKey, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { ZenexError, ZenexErrorCode, parseContractErrorCode } from '../src/errors.js';
import { inferErrorSource } from '../src/error_source.js';
import { parseError } from '../src/response_parser.js';
import { simulateAndParse } from '../src/simulate.js';

// The source of a code the token and the price verifier share (2-13), read
// from the failed simulation itself.
//
// The fixtures under fixtures/simulations are raw `simulateTransaction`
// responses of the public testnet RPC, captured read-only against a testnet
// deployment of the v1.0.0 contracts: nothing was signed or submitted. The
// price report in them is hand-built, with a config digest no verifier has
// registered and placeholder signatures, and the only account is a
// throwaway one. Each test names the call that was simulated.

type Fixture =
    | 'token-transfer-balance'
    | 'token-transfer-from-allowance'
    | 'oracle-verify-price'
    | 'create-and-fill-token-balance'
    | 'create-and-fill-verifier'
    | 'forward-create-and-fill-token-balance'
    | 'forward-create-and-fill-token-trustline'
    | 'forward-create-and-fill-verifier';

/** A captured response, parsed the way `rpc.Server.simulateTransaction` parses it. */
function simulation(name: Fixture): rpc.Api.SimulateTransactionErrorResponse {
    const path = fileURLToPath(
        new URL(`./fixtures/simulations/${name}.json`, import.meta.url),
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        result: rpc.Api.RawSimulateTransactionResponse;
    };
    const parsed = rpc.parseRawSimulation(raw.result);
    if (!rpc.Api.isSimulationError(parsed)) {
        throw new Error(`fixture ${name} is not a failed simulation`);
    }
    return parsed;
}

/** The same response with other events. */
function withEvents(
    response: rpc.Api.SimulateTransactionErrorResponse,
    events: xdr.DiagnosticEvent[],
): rpc.Api.SimulateTransactionErrorResponse {
    return { ...response, events };
}

describe('parseError decides a shared code from the failed simulation', () => {
    it('the public RPC puts the failing call in the events, not in the error text', () => {
        const response = simulation('create-and-fill-verifier');
        expect(response.error).toBe('HostError: Error(Contract, #9)');
        expect(response.events.length).toBeGreaterThan(0);
    });

    it.each<[Fixture, number, string]>([
        // token.transfer of more than the sender holds.
        ['token-transfer-balance', 10, 'BalanceError'],
        // token.transfer_from with no allowance.
        ['token-transfer-from-allowance', 9, 'AllowanceError'],
        // router.create_and_fill whose escrow transfer exceeds the balance:
        // the token fails inside a call that would also verify a report.
        ['create-and-fill-token-balance', 10, 'BalanceError'],
        // fee_forwarder.forward_dynamic -> create_and_fill, fee above the balance.
        ['forward-create-and-fill-token-balance', 10, 'BalanceError'],
        // The same relay, paying a fee recipient with no trustline: two token
        // calls land before the third fails.
        ['forward-create-and-fill-token-trustline', 13, 'TrustlineMissingError'],
    ])('%s: code %i is the token\'s %s', (name, code, codeName) => {
        const error = parseError(simulation(name));
        expect(error.code).toBe(code);
        expect(error.source).toBe('token');
        expect(error.ambiguous).toBe(false);
        expect(error.codeName).toBe(codeName);
    });

    it.each<[Fixture]>([
        // oracle.verify_price with a report whose config digest is unknown.
        ['oracle-verify-price'],
        // router.create_and_fill: the escrow transfer lands, then the fill's
        // price report is rejected. A token call succeeded earlier in the
        // same invocation.
        ['create-and-fill-verifier'],
        // fee_forwarder.forward_dynamic -> create_and_fill: four token calls
        // land (approve, fee collection, fee payout, escrow), then the
        // report is rejected.
        ['forward-create-and-fill-verifier'],
    ])('%s: code 9 is the verifier\'s DigestNotSet', (name) => {
        const error = parseError(simulation(name));
        expect(error.code).toBe(9);
        expect(error.source).toBe('verifier');
        expect(error.ambiguous).toBe(false);
        expect(error.codeName).toBe('VerifierDigestNotSet');
        expect(error.message).not.toContain('allowance');
    });

    it('the same number reads two ways, by the call that raised it', () => {
        const token = parseError(simulation('token-transfer-from-allowance'));
        const verifier = parseError(simulation('create-and-fill-verifier'));
        expect(token.code).toBe(verifier.code);
        expect(token.code).toBe(ZenexErrorCode.AllowanceError);
        expect(token.codeName).toBe('AllowanceError');
        expect(verifier.codeName).toBe('VerifierDigestNotSet');
    });

    it('an explicit hint still wins over the events', () => {
        const response = simulation('create-and-fill-verifier');
        expect(parseError(response, 'token').source).toBe('token');
        expect(parseError(response, 'token').codeName).toBe('AllowanceError');
        expect(parseError(simulation('token-transfer-balance'), 'verifier').codeName)
            .toBe('VerifierDigestInactive');
    });

    it('simulateAndParse throws the decided error without an errorSource', async () => {
        const response = simulation('forward-create-and-fill-verifier');
        vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue(response);
        const operation = new xdr.Operation({
            sourceAccount: null,
            body: xdr.OperationBody.invokeHostFunction(
                new xdr.InvokeHostFunctionOp({
                    hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
                        new xdr.InvokeContractArgs({
                            contractAddress: Address.fromString(
                                StrKey.encodeContract(Buffer.alloc(32, 1)),
                            ).toScAddress(),
                            functionName: 'forward_dynamic',
                            args: [],
                        }),
                    ),
                    auth: [],
                }),
            ),
        }).toXDR('base64');
        const network = { rpc: 'https://rpc.invalid', passphrase: 'test' };
        const thrown = await simulateAndParse(network, operation, () => undefined).then(
            () => undefined,
            (error: unknown) => error,
        );
        expect(thrown).toBeInstanceOf(ZenexError);
        const error = thrown as ZenexError;
        expect(error.code).toBe(9);
        expect(error.source).toBe('verifier');
        expect(error.ambiguous).toBe(false);
        expect(error.message).toMatch(/^Simulation failed: Price /);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });
});

describe('parseError keeps a shared code ambiguous when the simulation does not decide', () => {
    const expectAmbiguous = (error: ZenexError, code: number) => {
        expect(error.code).toBe(code);
        expect(error.source).toBeUndefined();
        expect(error.ambiguous).toBe(true);
        expect(error.message).toMatch(/^Ambiguous contract error/);
    };

    it('the error text alone, with no events', () => {
        // The text of the real response: a bare host error, no event log.
        const response = withEvents(simulation('create-and-fill-verifier'), []);
        expectAmbiguous(parseError(response), 9);
        expect(inferErrorSource(response.error)).toBeUndefined();
    });

    it('events that stop short of the failure', () => {
        const response = simulation('create-and-fill-verifier');
        // Everything up to and including the call into the verifier, but not
        // the error it raised.
        const cut = response.events.findIndex((event) => topic(event, 2) === 'verify') + 1;
        expect(cut).toBeGreaterThan(0);
        expectAmbiguous(parseError(withEvents(response, response.events.slice(0, cut))), 9);
    });

    it('a failure with no call that leads to it', () => {
        const response = simulation('create-and-fill-verifier');
        // Only the unwinding errors: the fn_call events are gone.
        const errors = response.events.filter((event) => topic(event, 0) !== 'fn_call');
        expectAmbiguous(parseError(withEvents(response, errors)), 9);
    });

    it('a failing call that is neither the verifier\'s nor a token function', () => {
        const response = simulation('oracle-verify-price');
        // The same events with the verifier's entry point renamed.
        const renamed = response.events.map((event) =>
            topic(event, 2) === 'verify' ? retopic(event, 2, 'check_report') : event,
        );
        expectAmbiguous(parseError(withEvents(response, renamed)), 9);
    });

    it('a code outside 2-13 has one meaning and no source', () => {
        const response = simulation('create-and-fill-verifier');
        const error = parseError({ ...response, error: 'HostError: Error(Contract, #713)' });
        expect(error.code).toBe(713);
        expect(error.source).toBeUndefined();
        expect(error.ambiguous).toBe(false);
    });

    it('events that are not diagnostic events fall back to ambiguous, never throw', () => {
        const response = simulation('create-and-fill-verifier');
        const broken = { ...response, events: [{}, 42] } as unknown as typeof response;
        expectAmbiguous(parseError(broken), 9);
    });
});

// SYNTHETIC from here on: the public RPC returns no event log in its error
// text, so no real response exercises the text path. These texts are the
// captured events above, written in the host's documented text form (the
// `Display` of a host event, under `Event log (newest first):`), which is
// what the CLI and a host error's debug output print.
describe('inferErrorSource reads the host\'s event log text (synthetic text of the captured events)', () => {
    it.each<[Fixture, 'token' | 'verifier']>([
        ['token-transfer-balance', 'token'],
        ['create-and-fill-token-balance', 'token'],
        ['forward-create-and-fill-token-trustline', 'token'],
        ['oracle-verify-price', 'verifier'],
        ['create-and-fill-verifier', 'verifier'],
        ['forward-create-and-fill-verifier', 'verifier'],
    ])('%s is the %s', (name, source) => {
        const response = simulation(name);
        const text = response.error + eventLog(response.events);
        expect(text).toContain('Event log (newest first):');
        expect(inferErrorSource(text)).toBe(source);
        // parseError falls back to the text when the response has no events.
        const error = parseError({ ...response, error: text, events: [] });
        expect(error.source).toBe(source);
        expect(error.ambiguous).toBe(false);
        // A JSON dump of the text escapes its line breaks and quotes.
        expect(inferErrorSource(JSON.stringify({ error: text }))).toBe(source);
    });

    it('prints the failing call the way the host does', () => {
        const response = simulation('oracle-verify-price');
        const lines = eventLog(response.events).split('\n');
        expect(lines).toContainEqual(
            expect.stringMatching(
                /^ {3}\d: \[Failed Diagnostic Event \(not emitted\)\] contract:C[A-Z2-7]{55}, topics:\[fn_call, C[A-Z2-7]{55}, verify\], data:\[Bytes\([0-9a-f]+\), C[A-Z2-7]{55}\]$/,
            ),
        );
        expect(lines).toContainEqual(
            expect.stringMatching(
                /topics:\[error, Error\(Contract, #9\)\], data:\["contract call failed", verify, \[/,
            ),
        );
    });

    it('a token failure the invocation caught does not decide a later verifier failure', () => {
        // A payout the market tried and caught (code 10 from the token),
        // then a report the verifier rejected with its own code 10.
        const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));
        const MARKET = StrKey.encodeContract(Buffer.alloc(32, 1));
        const ORACLE = StrKey.encodeContract(Buffer.alloc(32, 4));
        const VERIFIER = StrKey.encodeContract(Buffer.alloc(32, 9));
        const text = [
            'HostError: Error(Contract, #10)',
            '',
            'Event log (newest first):',
            `   0: [Diagnostic Event] contract:${MARKET}, topics:[error, Error(Contract, #10)], data:["contract call failed", verify_price, [Bytes(00), false]]`,
            `   1: [Diagnostic Event] contract:${ORACLE}, topics:[error, Error(Contract, #10)], data:["contract call failed", verify, [Bytes(00), ${ORACLE}]]`,
            `   2: [Diagnostic Event] contract:${VERIFIER}, topics:[error, Error(Contract, #10)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`,
            `   3: [Diagnostic Event] contract:${ORACLE}, topics:[fn_call, ${VERIFIER}, verify], data:[Bytes(00), ${ORACLE}]`,
            `   4: [Diagnostic Event] contract:${MARKET}, topics:[fn_call, ${ORACLE}, verify_price], data:[Bytes(00), false]`,
            `   5: [Diagnostic Event] contract:${MARKET}, topics:[error, Error(Contract, #10)], data:["contract try_call failed", transfer, [${MARKET}, ${ORACLE}, 5]]`,
            `   6: [Diagnostic Event] contract:${TOKEN}, topics:[error, Error(Contract, #10)], data:["balance is not sufficient to spend", 0, 5]`,
            `   7: [Diagnostic Event] contract:${MARKET}, topics:[fn_call, ${TOKEN}, transfer], data:[${MARKET}, ${ORACLE}, 5]`,
            `   8: [Diagnostic Event] topics:[fn_call, ${MARKET}, execute_order], data:[1]`,
        ].join('\n');
        expect(parseContractErrorCode(text)).toBe(10);
        expect(inferErrorSource(text)).toBe('verifier');
        // With the verifier's failure removed the invocation's last failure
        // is the caught transfer, which is not what ended it: undecided.
        const caughtOnly = text.split('\n').filter((line) => !/^ {3}[0-4]: /.test(line)).join('\n');
        expect(inferErrorSource(caughtOnly)).toBeUndefined();
    });

    it('text with no event log, or no contract error, has no source', () => {
        expect(inferErrorSource('HostError: Error(Contract, #10)')).toBeUndefined();
        expect(inferErrorSource('HostError: Error(Budget, ExceededLimit)')).toBeUndefined();
        expect(inferErrorSource('')).toBeUndefined();
    });
});

/** A topic of a diagnostic event as text, or `undefined`. */
function topic(event: xdr.DiagnosticEvent, index: number): string | undefined {
    const value = event.event().body().v0().topics()[index];
    const kind = value?.switch().name;
    return kind === 'scvSymbol' || kind === 'scvString'
        ? String(scValToNative(value))
        : undefined;
}

/** A copy of `event` with one topic replaced by a symbol. */
function retopic(event: xdr.DiagnosticEvent, index: number, symbol: string): xdr.DiagnosticEvent {
    const copy = xdr.DiagnosticEvent.fromXDR(event.toXDR());
    const body = copy.event().body().v0();
    const topics = body.topics();
    topics[index] = xdr.ScVal.scvSymbol(symbol);
    body.topics(topics);
    return copy;
}

/**
 * The events as the host prints them under a host error: newest first, one
 * `Display` line each (soroban-env-host, `events/mod.rs` and
 * `host/error.rs`).
 */
function eventLog(events: xdr.DiagnosticEvent[]): string {
    const lines = [...events].reverse().map((diagnostic, index) => {
        const event = diagnostic.event();
        const type = event.type().name === 'diagnostic' ? 'Diagnostic' : 'Contract';
        const label = diagnostic.inSuccessfulContractCall()
            ? `[${type} Event]`
            : `[Failed ${type} Event (not emitted)]`;
        const id = event.contractId();
        const contract =
            id === null || id === undefined
                ? ''
                : `contract:${StrKey.encodeContract(Buffer.from(id as unknown as Uint8Array))}, `;
        const body = event.body().v0();
        const topics = body.topics();
        const isCall = display(topics[0]) === 'fn_call';
        const shown = topics.map((value, position) =>
            isCall && position === 1 && value.switch().name === 'scvBytes'
                ? StrKey.encodeContract(value.bytes())
                : display(value),
        );
        return `   ${index}: ${label} ${contract}topics:[${shown.join(', ')}], data:${display(body.data())}`;
    });
    return `\n\nEvent log (newest first):\n${lines.join('\n')}\n`;
}

/** One value in the host's `display_scval` form. */
function display(value: xdr.ScVal): string {
    switch (value.switch().name) {
        case 'scvVoid':
            return 'Void';
        case 'scvBytes':
            return `Bytes(${value.bytes().toString('hex')})`;
        case 'scvString':
            return `"${value.str().toString()}"`;
        case 'scvSymbol':
            return value.sym().toString();
        case 'scvVec':
            return `[${(value.vec() ?? []).map(display).join(', ')}]`;
        case 'scvMap':
            return `{${(value.map() ?? [])
                .map((entry) => `${display(entry.key())}: ${display(entry.val())}`)
                .join(', ')}}`;
        case 'scvError': {
            const error = value.error();
            return error.switch().name === 'sceContract'
                ? `Error(Contract, #${error.contractCode()})`
                : `Error(${error.switch().name}, ${String(error.value())})`;
        }
        default:
            // Booleans, integers and addresses print as their plain value.
            return String(scValToNative(value));
    }
}
