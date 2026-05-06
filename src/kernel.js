// Phase 16.E.1 — Kernel: per-process method dispatcher.
//
// Owns the registry of `method → handler` entries that the IPC adapter
// hands incoming requests off to. The kernel itself is transport-agnostic
// — DaemonIpcAdapter (and SpaceIpcAdapter on the parent side) wrap it
// with the JSON-RPC 2.0 envelope, id correlation, timeouts, and stream
// chunk multiplexing (see `adapters/ipc.js`).
//
// Handler signature:
//
//   async function handler(params, ctx) { ... }
//
//   ctx fields the kernel always populates:
//     ctx.method      — the registered method name (so a single function
//                       can dispatch multiple methods)
//     ctx.requestId   — adapter-generated request id (or null for
//                       direct dispatches outside an IPC envelope)
//     ctx.emitChunk   — function(chunk) for streaming handlers; for
//                       request/response handlers it's a no-op so
//                       handlers can be defensively coded either way
//     ctx.signal      — AbortSignal forwarded by the adapter (optional;
//                       null for direct dispatches)
//
// Streaming handlers MUST call ctx.emitChunk(...) zero or more times
// to send partial chunks, then return the final "done" value. The
// adapter wraps each emitChunk into a `result.partial` IPC message and
// the return value into a single `result.done` message (see
// `adapters/ipc.js` for the wire format).
//
// Errors are mapped per Design §2.4 + JSON-RPC 2.0:
//   - unknown method                → -32601 METHOD_NOT_FOUND
//   - handler throw / rejection     → -32603 INTERNAL_ERROR (with
//                                     `data.cause` set to the original
//                                     error message)
//
// Application-level failures (timeout, tool failure, etc.) are encoded
// as -32099 by the adapter, not the kernel — the kernel's job is just
// to surface "your handler crashed" vs "no such method".

import { IPC_ERROR_CODES, makeError } from './adapters/ipc-errors.js';

/**
 * Sentinel used by the adapter to detect a kernel-thrown JSON-RPC error
 * (vs a plain JS Error from a handler).
 */
const KERNEL_ERROR_TAG = Symbol.for('thinkroid.kernel.jsonRpcError');

/**
 * Throw an error tagged with the JSON-RPC code so the adapter can wrap
 * it back into the response envelope without re-classifying.
 *
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function throwJsonRpcError(code, message, data) {
  const err = new Error(message);
  err[KERNEL_ERROR_TAG] = true;
  err.jsonRpc = makeError(code, message, data);
  throw err;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isJsonRpcError(err) {
  return Boolean(err && typeof err === 'object' && err[KERNEL_ERROR_TAG]);
}

/**
 * Per-process method registry + dispatcher.
 *
 * The kernel is intentionally synchronous in registration and async in
 * dispatch — `dispatch` always returns a Promise even if the handler is
 * sync, so callers can uniformly chain `.catch` / `await`.
 */
export class Kernel {
  constructor() {
    /** @type {Map<string, (params: any, ctx: any) => any>} */
    this._handlers = new Map();
  }

  /**
   * Register a handler for `method`. Duplicate registrations throw
   * synchronously — the daemon entrypoint must register every method
   * once during startup; later re-registration would silently shadow
   * earlier handlers.
   *
   * @param {string} method
   * @param {(params: any, ctx: any) => any} handler
   */
  registerHandler(method, handler) {
    if (typeof method !== 'string' || method.length === 0) {
      throw new TypeError('Kernel.registerHandler: method must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`Kernel.registerHandler: handler for '${method}' must be a function`);
    }
    if (this._handlers.has(method)) {
      throw new Error(`Kernel.registerHandler: duplicate registration for '${method}'`);
    }
    this._handlers.set(method, handler);
  }

  /**
   * Look up + invoke the handler for `method`. Returns the handler's
   * result (resolving streaming handlers' final return value) or throws
   * a JSON-RPC-tagged error.
   *
   * @param {string} method
   * @param {unknown} params
   * @param {object} [ctx]
   */
  async dispatch(method, params, ctx) {
    const handler = this._handlers.get(method);
    if (!handler) {
      throwJsonRpcError(
        IPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
        { method },
      );
    }

    // Always populate the context fields the adapter / handlers rely on.
    const fullCtx = {
      method,
      requestId: ctx?.requestId ?? null,
      emitChunk: typeof ctx?.emitChunk === 'function' ? ctx.emitChunk : () => {},
      signal: ctx?.signal ?? null,
      // Forward any additional fields the adapter wants to expose
      // (e.g. agentId, transport metadata).
      ...ctx,
    };

    try {
      return await handler(params, fullCtx);
    } catch (err) {
      if (isJsonRpcError(err)) {
        throw err;
      }
      // Wrap arbitrary throws in -32603. The original message is kept on
      // `data.cause` so callers can still diagnose without leaking the
      // full stack trace through the IPC envelope.
      const msg = err?.message ?? String(err);
      throwJsonRpcError(
        IPC_ERROR_CODES.INTERNAL_ERROR,
        `Internal error in handler '${method}': ${msg}`,
        { method, cause: msg },
      );
    }
  }

  /**
   * @returns {string[]} sorted list of registered method names
   */
  listMethods() {
    return [...this._handlers.keys()].sort();
  }
}
