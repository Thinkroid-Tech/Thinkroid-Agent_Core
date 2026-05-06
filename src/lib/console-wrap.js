// Phase 16.C v3 (M57) — agentId-prefix console wrap.
//
// Extracted from the daemon entrypoint into a standalone module so the
// idempotency invariant can be tested directly (rather than relying on
// the indirect "count prefix occurrences in a live daemon's stdout"
// heuristic the v2 test used).
//
// Idempotency is enforced via a sentinel installed on the global
// `console` object itself (`console._daemonWrapped`) — a module-scoped
// boolean would only guard against re-entry inside the same module
// instance, but a future hot-reload path (re-importing this module)
// would re-arm a fresh module flag and stack prefixes. Tagging the
// console object survives across module instances within the same
// process, which is the surface that actually matters.

/**
 * Wrap `console.log`, `console.error`, and `console.warn` with a
 * `[daemon:<agentId-short>] ` prefix (Design §5.6 / Q22). Idempotent:
 * repeated calls (including from a re-imported module instance) are
 * no-ops, so no caller can accidentally produce
 * `[daemon:xxx] [daemon:xxx] hi`.
 *
 * @param {string} agentId - The full agent UUID; only the first 8
 *   characters are surfaced in the prefix.
 * @returns {void}
 */
export function wrapConsole(agentId) {
  if (console._daemonWrapped) return;

  const prefix = `[daemon:${String(agentId).slice(0, 8)}] `;
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => origLog(prefix, ...args);
  console.error = (...args) => origErr(prefix, ...args);
  console.warn = (...args) => origWarn(prefix, ...args);

  console._daemonWrapped = true;
}
