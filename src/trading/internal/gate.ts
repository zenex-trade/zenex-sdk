import { ZenexError, ZenexErrorCode, zenexErrorFromCode } from '../../errors.js';

/**
 * Resolve a quote/preview gate to a `ZenexError`: the canonical message for
 * a contract code, the gate's own `reason` for an SDK sentinel. A sentinel
 * reason is built in place and carries more context than the generic
 * sentinel message.
 */
export function zenexErrorFromGate(code: number, reason: string): ZenexError {
    if (code === ZenexErrorCode.QuoteInvalidInput || code === ZenexErrorCode.QuoteOverflow) {
        return new ZenexError(code, reason);
    }
    return zenexErrorFromCode(code);
}
