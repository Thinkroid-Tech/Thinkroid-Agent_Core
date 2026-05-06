// Phase 16.E.2 — DaemonIpcAdapter + SpaceIpcAdapter.
//
// Bridges the Space supervisor and the per-agent daemon process via the
// JSON-RPC 2.0 envelope on Node's IPC channel (Design §2.2 + §2.3 +
// §2.6). Both sides share the same wire format; only the transport
// hookup differs:
//
//   - DaemonIpcAdapter — runs inside the daemon child; uses
//     `process.send` / `process.on('message')`.
//   - SpaceIpcAdapter — runs in the Space parent; uses `child.send` /
//     `child.on('message')` against a specific ChildProcess handle.
//
// Wire envelope (JSON-RPC 2.0 strict):
//
//   Request:        { jsonrpc:'2.0', id, method, params }
//   Notification:   { jsonrpc:'2.0',     method, params }   // no id field
//   Response/ok:    { jsonrpc:'2.0', id, result }
//   Response/err:   { jsonrpc:'2.0', id, error: {code, message, data?} }
//
// Streaming extension (Design §2.6):
//
//   Partial chunk:  { jsonrpc:'2.0', id, result: { partial:true, chunk } }
//   Done marker:    { jsonrpc:'2.0', id, result: { done:true,    value } }
//
// The streaming envelope reuses the standard `result` field with an
// internal discriminator (`partial` vs `done`) so plain JSON-RPC tools
// can still parse it; only the streaming-aware caller (`requestStream`)
// distinguishes the two cases.

import { randomUUID } from 'node:crypto';
import { IPC_ERROR_CODES, makeError } from './ipc-errors.js';
import { resolveTimeoutMs } from './ipc-timeouts.js';
import { isJsonRpcError } from '../kernel.js';

const JSONRPC_VERSION = '2.0';

/**
 * Common machinery shared by daemon-side and space-side adapters.
 *
 * Subclasses provide:
 *   - `_send(envelope)` — push a message to the peer.
 *   - `_attachListener(onMessage)` — subscribe to incoming messages.
 *   - `_detachListener(onMessage)` — best-effort detach for cleanup.
 *
 * The base class owns id generation, request/response correlation,
 * timeout management, streaming chunk multiplexing, and the inbound
 * router that decides "this looks like a request → dispatch to kernel"
 * vs "this looks like a response → resolve the matching pending
 * request".
 */
class BaseIpcAdapter {
  /**
   * @param {{ kernel?: any, name?: string }} [opts]
   */
  constructor({ kernel = null, name = 'ipc' } = {}) {
    this.kernel = kernel;
    this._name = name;

    /**
     * @type {Map<string, {
     *   resolve: (v: any) => void,
     *   reject: (err: Error) => void,
     *   timer: NodeJS.Timeout|null,
     *   onChunk: ((chunk: any) => void)|null,
     *   method: string,
     *   timeoutMs: number,
     *   streaming: boolean,
     * }>}
     *
     * `streaming` is set by `requestStream()` (true) vs `request()`
     * (false). The response router uses it to disambiguate streaming
     * envelopes (`result.partial` / `result.done`) from a plain handler
     * payload that happens to carry a `partial` or `done` field as
     * normal business data. See M62.
     */
    this._pendingRequests = new Map();
    this._started = false;

    this._onMessage = (msg) => this._handleIncomingMessage(msg);
  }

  /**
   * Subclass hook — push a JSON-RPC envelope to the peer.
   * @param {object} _envelope
   */
  _send(_envelope) {
    throw new Error('BaseIpcAdapter._send must be implemented by subclass');
  }

  /**
   * Subclass hook — subscribe an `(msg) => void` listener to inbound
   * IPC messages.
   * @param {(msg: any) => void} _onMessage
   */
  _attachListener(_onMessage) {
    throw new Error('BaseIpcAdapter._attachListener must be implemented by subclass');
  }

  _detachListener(_onMessage) {
    // Optional override; default no-op.
  }

  /**
   * Begin listening for inbound IPC messages. Idempotent.
   */
  start() {
    if (this._started) return;
    this._started = true;
    this._attachListener(this._onMessage);
  }

  /**
   * Stop listening + reject every pending request.
   */
  stop() {
    if (!this._started) return;
    this._started = false;
    this._detachListener(this._onMessage);
    for (const [id, pending] of this._pendingRequests.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`IPC adapter stopped before request '${pending.method}' (id=${id}) resolved`));
    }
    this._pendingRequests.clear();
  }

  // ──────────────────────────────────────────────────────────────────
  // Outbound API
  // ──────────────────────────────────────────────────────────────────

  /**
   * Send a notification (no id, no response expected).
   */
  send(method, params) {
    const envelope = { jsonrpc: JSONRPC_VERSION, method };
    if (params !== undefined) envelope.params = params;
    this._send(envelope);
  }

  /**
   * Send a request and await the matching response.
   */
  request(method, params, opts = {}) {
    return this._sendRequest(method, params, opts, /*onChunk*/ null);
  }

  /**
   * Send a streaming request. `onChunk(chunk)` fires for each
   * `result.partial` envelope; the returned promise resolves with the
   * final `result.done` value.
   */
  requestStream(method, params, opts = {}) {
    if (typeof opts.onChunk !== 'function') {
      throw new TypeError('requestStream: opts.onChunk must be a function');
    }
    return this._sendRequest(method, params, opts, opts.onChunk);
  }

  /**
   * Internal: shared request/response + streaming send path.
   */
  _sendRequest(method, params, opts, onChunk) {
    const id = randomUUID();
    const timeoutMs = resolveTimeoutMs(method, opts?.timeoutMs);
    const streaming = onChunk !== null;

    const promise = new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        timer: null,
        onChunk,
        method,
        timeoutMs,
        streaming,
      };

      pending.timer = setTimeout(() => {
        if (!this._pendingRequests.has(id)) return;
        this._pendingRequests.delete(id);
        const err = new Error(
          `IPC request '${method}' (id=${id}) timed out after ${timeoutMs}ms`,
        );
        err.code = 'IPC_TIMEOUT';
        err.jsonRpc = makeError(
          IPC_ERROR_CODES.APPLICATION,
          err.message,
          { method, timeoutMs },
        );
        reject(err);
      }, timeoutMs);
      pending.timer.unref?.();

      this._pendingRequests.set(id, pending);
    });

    const envelope = { jsonrpc: JSONRPC_VERSION, id, method };
    if (params !== undefined) envelope.params = params;
    try {
      this._send(envelope);
    } catch (err) {
      const pending = this._pendingRequests.get(id);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this._pendingRequests.delete(id);
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return promise;
  }

  // ──────────────────────────────────────────────────────────────────
  // Inbound dispatch
  // ──────────────────────────────────────────────────────────────────

  /**
   * Top-level inbound router.
   */
  _handleIncomingMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.jsonrpc !== JSONRPC_VERSION) return;

    const isResponse =
      Object.prototype.hasOwnProperty.call(msg, 'result') ||
      Object.prototype.hasOwnProperty.call(msg, 'error');
    if (isResponse && msg.id !== undefined && msg.id !== null) {
      this._handleResponse(msg);
      return;
    }

    if (typeof msg.method !== 'string') return;
    this._handleRequest(msg);
  }

  /**
   * Response router — resolve pending entry. Routes based on whether
   * the caller used `request()` (plain) or `requestStream()` (streaming),
   * NOT on a content-sniff of `result.partial` / `result.done`.
   *
   * M62 fix: a plain handler returning `{ partial: true, ... }` or
   * `{ done: true, value: ... }` as legitimate business payload must
   * be delivered verbatim to a `request()` caller, not misinterpreted
   * as a streaming envelope. Streaming-aware unwrap only happens for
   * `requestStream()` callers, which are the only ones that asked for
   * the streaming protocol in the first place.
   */
  _handleResponse(msg) {
    const pending = this._pendingRequests.get(msg.id);
    if (!pending) return;

    if (msg.error) {
      if (pending.timer) clearTimeout(pending.timer);
      this._pendingRequests.delete(msg.id);
      const err = new Error(msg.error.message ?? 'IPC error');
      err.code = msg.error.code;
      err.data = msg.error.data;
      err.jsonRpc = msg.error;
      pending.reject(err);
      return;
    }

    const result = msg.result;

    if (pending.streaming) {
      // Streaming caller — interpret the discriminator.
      if (result && typeof result === 'object' && result.partial === true) {
        // Reset the gap timer so a slow but still-flowing stream does
        // not trip the per-chunk timeout.
        //
        // TODO (Phase 16 G-stage / chat.completion wiring):
        // Per Design §2.3.3 stream timeout policy = "60s gap + total
        // cap". v1 implements gap-only (timer resets on each
        // result.partial). Total cap (e.g. 5min absolute from request
        // start, regardless of partial frequency) is not enforced.
        // When G-stage wires chat.completion streaming through this
        // adapter, evaluate whether long-running streams need the
        // total-cap to prevent runaway requests; if so, add
        // `totalCapMs` option to requestStream() and enforce via a
        // separate timer that does NOT reset on partials.
        if (pending.timer) {
          clearTimeout(pending.timer);
          pending.timer = setTimeout(() => {
            if (!this._pendingRequests.has(msg.id)) return;
            this._pendingRequests.delete(msg.id);
            const err = new Error(
              `IPC stream '${pending.method}' (id=${msg.id}) gap timeout after ${pending.timeoutMs}ms`,
            );
            err.code = 'IPC_TIMEOUT';
            err.jsonRpc = makeError(
              IPC_ERROR_CODES.APPLICATION,
              err.message,
              { method: pending.method, timeoutMs: pending.timeoutMs },
            );
            pending.reject(err);
          }, pending.timeoutMs);
          pending.timer.unref?.();
        }
        // Phase 16 L2'.B (review fix MAJOR [22]) — serialize onChunk
        // dispatch per pending request via a chained promise. The
        // bridge's onChunk may return a Promise to signal "I'm currently
        // full, hold the next chunk until I drain"; we honour that by
        // queueing every subsequent chunk on the tail of `pending.chunkChain`.
        // This does NOT throttle Node's IPC pipe itself (`child.on('message')`
        // has no flow-control hook — messages keep arriving and queueing in
        // the event loop), but it guarantees serialized invocation: each
        // chunk's onChunk runs to completion before the next chunk's onChunk
        // begins, giving the bridge a real opportunity to apply
        // memory-bounded backpressure on its own queue before pulling more.
        // If onChunk is synchronous, the chained promise resolves on the
        // next microtask and ordering still holds.
        const chunkPayload = result.chunk;
        pending.chunkChain = (pending.chunkChain ?? Promise.resolve())
          .then(async () => {
            try {
              await pending.onChunk?.(chunkPayload);
            } catch (e) {
              try {
                process.stderr.write(
                  `[${this._name}] onChunk for '${pending.method}' threw: ${e?.message ?? e}\n`,
                );
              } catch { /* swallow */ }
            }
          });
        return;
      }

      // Streaming caller, non-partial envelope — must be `done` (final
      // value) or, for handlers that never emitted a chunk, a plain
      // result. Either way the request is complete.
      // L2'.B fix: drain the chunkChain before resolving so the caller's
      // final-value handler doesn't observe an unflushed onChunk pipeline.
      if (pending.timer) clearTimeout(pending.timer);
      this._pendingRequests.delete(msg.id);
      const chainTail = pending.chunkChain ?? Promise.resolve();
      chainTail.finally(() => {
        if (result && typeof result === 'object' && result.done === true) {
          pending.resolve(result.value);
        } else {
          // Streaming caller asked for streaming but the handler returned
          // a plain (non-emitChunk) value — surface it directly so the
          // caller still gets a usable resolution.
          pending.resolve(result);
        }
      });
      return;
    }

    // Plain request/response caller (M62 v3) — must NOT resolve on
    // partial chunks. A streaming handler emits one or more
    // `result.partial` envelopes followed by a `result.done` envelope;
    // a `request()` caller asked for a single response, so we drop
    // every partial chunk on the floor and wait for the terminal
    // envelope (done or error). On `done`, we resolve with the entire
    // result object verbatim (i.e. `{ done: true, value: X }`) — we do
    // NOT unwrap `value`, because the caller did not opt into the
    // streaming protocol and the discriminator object is the honest
    // shape of what the wire carried.
    //
    // For non-streaming handlers, the responder never wraps the result
    // (see `_handleRequest` — `streamingFlag.used` stays false), so
    // `result` arrives verbatim with no `partial`/`done` discriminator,
    // and we resolve it as-is. Plain handlers whose legitimate business
    // payload happens to use `{ done: true, ... }` or
    // `{ partial: true, ... }` as field names are NOT misinterpreted,
    // because the disambiguation is tracked via `pending.streaming`
    // (request-time intent), not via content sniffing — see M62 v2.
    //
    // The earlier-than-v3 behaviour resolved on the FIRST envelope of
    // any kind, which truncated streaming responses to their first
    // chunk for plain callers. v3 fixes that: callers that
    // accidentally use `request()` against a streaming handler still
    // receive the complete final result (wrapped in the done envelope),
    // not a partial fragment.
    if (
      result
      && typeof result === 'object'
      && result.partial === true
      && Object.prototype.hasOwnProperty.call(result, 'chunk')
    ) {
      // Drop streaming partial chunks for plain callers; wait for the
      // done envelope (or an error). Do NOT clear the timer or delete
      // the pending entry — the request is still in flight.
      //
      // Tight discriminator: the responder's `emitChunk` (see
      // `_handleRequest`) always sends streaming partials as
      // `{partial: true, chunk}` — exactly those two keys. We check
      // for the `chunk` key as well as `partial: true` so that a plain
      // handler returning a business payload like
      // `{partial: true, items: [...]}` (M62 v2 collision case) is NOT
      // misinterpreted as a streaming frame and dropped.
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this._pendingRequests.delete(msg.id);
    pending.resolve(result);
  }

  /**
   * Request / notification router — dispatch to the kernel and (for
   * requests) ship the response back. Streaming handlers get
   * `ctx.emitChunk` wired to the partial-chunk envelope.
   */
  _handleRequest(msg) {
    const isNotification = msg.id === undefined || msg.id === null;
    const requestId = isNotification ? null : msg.id;

    if (!this.kernel) {
      if (!isNotification) {
        this._send({
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          error: makeError(
            IPC_ERROR_CODES.METHOD_NOT_FOUND,
            `IPC adapter '${this._name}' has no kernel attached; cannot dispatch '${msg.method}'`,
            { method: msg.method },
          ),
        });
      }
      return;
    }

    // Track whether the handler actually emitted any partial chunks so
    // we can decide whether to wrap the final value in a `done:true`
    // envelope or surface it as a plain non-streaming result.
    const streamingFlag = { used: false };
    const emitChunk = (chunk) => {
      if (isNotification) return;
      streamingFlag.used = true;
      this._send({
        jsonrpc: JSONRPC_VERSION,
        id: requestId,
        result: { partial: true, chunk },
      });
    };

    Promise.resolve()
      .then(() => this.kernel.dispatch(msg.method, msg.params, {
        method: msg.method,
        requestId,
        emitChunk,
      }))
      .then((value) => {
        if (isNotification) return;
        const result = streamingFlag.used
          ? { done: true, value }
          : value;
        this._send({
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          result,
        });
      })
      .catch((err) => {
        if (isNotification) {
          try {
            process.stderr.write(
              `[${this._name}] notification '${msg.method}' handler error: ${err?.message ?? err}\n`,
            );
          } catch { /* swallow */ }
          return;
        }
        const errorObj = isJsonRpcError(err)
          ? err.jsonRpc
          : makeError(
            IPC_ERROR_CODES.INTERNAL_ERROR,
            err?.message ?? String(err),
            { method: msg.method },
          );
        this._send({
          jsonrpc: JSONRPC_VERSION,
          id: requestId,
          error: errorObj,
        });
      });
  }
}

/**
 * Daemon-side adapter. Runs INSIDE the forked child; talks to the
 * supervisor via `process.send` / `process.on('message')`.
 */
export class DaemonIpcAdapter extends BaseIpcAdapter {
  /**
   * @param {{ kernel?: any, processRef?: NodeJS.Process }} [opts]
   */
  constructor({ kernel = null, processRef = process } = {}) {
    super({ kernel, name: 'daemon-ipc' });
    this._process = processRef;
  }

  _send(envelope) {
    if (!this._process.send || !this._process.connected) {
      return;
    }
    try {
      this._process.send(envelope);
    } catch (err) {
      try {
        process.stderr.write(
          `[daemon-ipc] send failed: ${err?.message ?? err}\n`,
        );
      } catch { /* swallow */ }
    }
  }

  _attachListener(onMessage) {
    this._process.on('message', onMessage);
  }

  _detachListener(onMessage) {
    this._process.off?.('message', onMessage);
  }
}

/**
 * Space-side adapter. Runs in the supervisor parent; talks to a
 * specific ChildProcess handle (FakeChildProcess in unit tests; real
 * `child_process.fork` return value in production).
 */
export class SpaceIpcAdapter extends BaseIpcAdapter {
  /**
   * @param {{ child: any, kernel?: any, name?: string }} opts
   */
  constructor({ child, kernel = null, name = 'space-ipc' } = {}) {
    super({ kernel, name });
    if (!child) {
      throw new TypeError('SpaceIpcAdapter: `child` is required');
    }
    this._child = child;
  }

  _send(envelope) {
    if (this._child.killed) return;
    if (typeof this._child.send !== 'function') return;
    try {
      this._child.send(envelope);
    } catch (err) {
      try {
        process.stderr.write(
          `[${this._name}] send failed: ${err?.message ?? err}\n`,
        );
      } catch { /* swallow */ }
    }
  }

  _attachListener(onMessage) {
    this._child.on('message', onMessage);
  }

  _detachListener(onMessage) {
    this._child.off?.('message', onMessage);
  }
}
