// Phase 16.E.3 — Per-method IPC timeouts (Design §2.3.3).
//
// The IPC adapter uses these defaults when the caller does not pass an
// explicit `opts.timeoutMs`. Per-method tuning matters because:
//
//   - daemon.ready: 30s — covers the cold-start init handshake (DB
//     open, recovery sweep, kernel handler registration).
//   - space.tool.invoke: 60s — tools may shell out / hit MCP servers.
//   - chat.completion: 60s — streaming gap cap; the adapter resets the
//     timer on each `result.partial` so a slow-but-progressing stream
//     stays alive.
//   - _test.echo / _test.echo_stream: 5s — tight bound for the contract
//     test fixture; failures should surface fast.
//
// Methods absent from the table fall through to DEFAULT_TIMEOUT_MS.

export const IPC_METHOD_TIMEOUTS_MS = Object.freeze({
  'daemon.ready': 30_000,
  'space.tool.invoke': 60_000,
  'chat.completion': 60_000,
  'ce.tick': 30_000,
  'cerebellum.l1Tick': 60_000,
  'cerebellum.l2Tick': 120_000,
  'memory.read': 30_000,
  'memory.write': 30_000,
  'session.receiveEvent': 30_000,
  'governance.delegate': 120_000,
  'brain.toolLoop': 300_000,
  '_test.echo': 5_000,
  '_test.echo_stream': 5_000,
});

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the timeout for `method` — caller-supplied opts override the
 * per-method default which overrides the global default.
 *
 * @param {string} method
 * @param {number} [optsTimeoutMs]
 * @returns {number}
 */
export function resolveTimeoutMs(method, optsTimeoutMs) {
  if (Number.isFinite(optsTimeoutMs) && optsTimeoutMs > 0) {
    return optsTimeoutMs;
  }
  if (Object.prototype.hasOwnProperty.call(IPC_METHOD_TIMEOUTS_MS, method)) {
    return IPC_METHOD_TIMEOUTS_MS[method];
  }
  return DEFAULT_TIMEOUT_MS;
}
