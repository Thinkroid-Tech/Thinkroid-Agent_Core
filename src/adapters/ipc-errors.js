// Phase 16.E.4 — IPC error envelope codes (locked).
//
// JSON-RPC 2.0 reserves -32768 to -32000 for the protocol; -32601 and
// -32603 are the standard "method not found" / "internal error" codes
// we use unchanged. -32099 is in the "application-defined" range
// (-32099 to -32000) and we use it as the catch-all for application
// failures the kernel didn't classify (timeouts, tool failures, etc.)
// per Design §2.4.
//
// The codes here are part of the IPC contract — once they ship to a
// production daemon, supervisor / Space code will branch on them. Don't
// renumber.

export const IPC_ERROR_CODES = Object.freeze({
  /** No handler registered for the requested method. */
  METHOD_NOT_FOUND: -32601,
  /** Handler crashed (uncaught throw). */
  INTERNAL_ERROR: -32603,
  /**
   * Application-level failure: timeout waiting for response, tool
   * execution failure, validation rejection inside a handler that
   * chose to surface a structured failure instead of crashing.
   */
  APPLICATION: -32099,
});

/**
 * Build a JSON-RPC 2.0 error object. The shape is locked by the spec:
 * `{ code, message }` always; `data` optional and free-form.
 *
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 * @returns {{code: number, message: string, data?: unknown}}
 */
export function makeError(code, message, data) {
  if (!Number.isInteger(code)) {
    throw new TypeError('makeError: code must be an integer');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('makeError: message must be a non-empty string');
  }
  const out = { code, message };
  if (data !== undefined) out.data = data;
  return out;
}
