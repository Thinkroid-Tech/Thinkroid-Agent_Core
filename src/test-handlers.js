// Phase 16.E.5 — _test.* handler factories.
//
// Two minimal handlers used by the IPC contract test (Plan §E.6) and
// the in-process kernel unit tests:
//
//   _test.echo         — request/response: returns `{ echoed: text, ts }`.
//   _test.echo_stream  — streaming: emits one chunk per token, then a
//                        done summary with the count.
//
// They live OUTSIDE `bin/agent-core-daemon.js` so the daemon entrypoint
// stays focused on lifecycle, and so unit tests can register them
// against a kernel without forking. The contract test imports the same
// factories into the minimal echo daemon fixture (Plan §E.6).

/**
 * @returns {(params: { text: string }, ctx: any) => Promise<{ echoed: string, ts: number }>}
 */
export function makeTestEchoHandler({ now = () => Date.now() } = {}) {
  return async function handleTestEcho(params) {
    const text = typeof params?.text === 'string' ? params.text : '';
    return { echoed: text, ts: now() };
  };
}

/**
 * @returns {(params: { tokens: string[] }, ctx: any) => Promise<{ done: true, totalCount: number }>}
 */
export function makeTestEchoStreamHandler() {
  return async function handleTestEchoStream(params, ctx) {
    const tokens = Array.isArray(params?.tokens) ? params.tokens : [];
    for (const token of tokens) {
      // Each chunk fires as its own `result.partial` envelope; the
      // adapter wraps the raw value, so the handler just hands over
      // the raw token here.
      ctx.emitChunk(token);
    }
    return { done: true, totalCount: tokens.length };
  };
}

/**
 * Phase 16.I.7 — daemon-side `console.log` trigger. The daemon's
 * `wrapConsole` (S5) tags every line with `[daemon:<agentId-first-8>] `;
 * this handler is the deterministic emitter the I.7 e2e test pings to
 * verify that prefix survives the supervisor's `child.stdout` →
 * `process.stdout` pipe. Production daemons never invoke it (no caller
 * sends `_test.echo_log` outside the test fixture).
 *
 * @returns {(params: { text: string }) => Promise<{ logged: true }>}
 */
export function makeTestEchoLogHandler() {
  return async function handleTestEchoLog(params) {
    const text = typeof params?.text === 'string' ? params.text : '';
    console.log(`echo-log: ${text}`);
    return { logged: true };
  };
}

/**
 * Convenience registrar — wires `_test.echo`, `_test.echo_stream`, and
 * `_test.echo_log` onto the supplied kernel in one call. Used by the
 * daemon entrypoint S8 and by the minimal-echo-daemon test fixture.
 *
 * @param {{ registerHandler: (method: string, handler: Function) => void }} kernel
 */
export function registerTestEchoHandlers(kernel) {
  kernel.registerHandler('_test.echo', makeTestEchoHandler());
  kernel.registerHandler('_test.echo_stream', makeTestEchoStreamHandler());
  kernel.registerHandler('_test.echo_log', makeTestEchoLogHandler());
}
