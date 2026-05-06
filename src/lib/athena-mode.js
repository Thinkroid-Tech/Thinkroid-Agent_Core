// Phase 16.L3'.B (Plan §L3'.1) — daemon-side Athena mode store + ticker
// interval mapping.
//
// Athena's runtime drives a four-state mode machine (Design §8.3.1):
//
//   | Mode    | Cerebellum L1 tick interval |
//   | ------- | --------------------------- |
//   | boot    | 2000 ms                     |
//   | awake   | 10000 ms                    |
//   | drowsy  | 60000 ms                    |
//   | dormant | null (ticker stops)         |
//
// The mode is a GLOBAL setting (lives in `global_settings.athena_mode`,
// not per-agent) — when the user toggles Athena via the Space-side
// route the supervisor calls `broadcastConfigChanged({ key:
// 'athena_mode', value, scope: 'global' })` which fans the
// notification out to every live daemon. The Athena daemon picks the
// notification up via `installRuntimePushHandlers`'s new
// `athenaModeSetter` arm and calls `setAthenaMode(value)` here.
//
// Subscribers can register via `subscribeToAthenaModeChange` so a
// future Brain-wire phase (when the cerebellum L1 ticker is registered
// inside the daemon process — currently it lives Space-side in
// `src/index.js`) can clearTimeout / setTimeout against the new
// interval. Until that wire exists this module supplies only the API
// surface; the L3'.1 integration test asserts the contract by
// observing subscriber callbacks rather than by waiting on real tick
// timing.
//
// INV-5 note: `athena_mode` is legitimately broadcast WITHOUT an
// `agentId` (it's a global setting). The setter wired in
// `bin/agent-core-daemon.js` is intentionally permissive about agentId
// — but strict about `key === 'athena_mode'` AND `value` being one of
// the four known modes. This is symmetric to L3'.A's two-layer filter
// for the per-agent `aiConfigSetter` arm (where ANY missing-agentId
// payload is rejected).

const ALLOWED_MODES = Object.freeze(['boot', 'awake', 'drowsy', 'dormant']);

const MODE_INTERVAL_MS = Object.freeze({
  boot: 2000,
  awake: 10000,
  drowsy: 60000,
  // `null` means "stop the ticker" — cerebellum L1 should clearTimeout
  // and not reschedule until a non-dormant mode is set.
  dormant: null,
});

let currentMode = null;
/** @type {Set<(mode: string) => void>} */
const subscribers = new Set();

/**
 * Return the currently-set Athena mode, or `null` if no mode has been
 * set yet (daemon just booted, no init payload field yet, no
 * config:changed notification observed).
 *
 * @returns {('boot'|'awake'|'drowsy'|'dormant'|null)}
 */
export function getAthenaMode() {
  return currentMode;
}

/**
 * Set the Athena mode and fire every registered subscriber.
 *
 * Validates `mode` against the four-state allowlist; unknown modes
 * are silently ignored (the supervisor's broadcast is best-effort and
 * a malformed value should not crash the daemon — the existing mode
 * stays in place).
 *
 * Subscribers fire in registration order. A throwing subscriber is
 * caught + logged so a single bad listener can't poison the rest of
 * the chain (matches `installRuntimePushHandlers`'s swallow-on-error
 * stance for best-effort refresh paths).
 *
 * @param {string} mode
 * @returns {boolean} true if the mode was accepted + subscribers fired.
 */
export function setAthenaMode(mode) {
  if (typeof mode !== 'string' || !ALLOWED_MODES.includes(mode)) {
    return false;
  }
  currentMode = mode;
  for (const cb of subscribers) {
    try { cb(mode); }
    catch (e) {
      try {
        process.stderr.write(
          `[athena-mode] subscriber threw on mode='${mode}': ${e?.message ?? e}\n`,
        );
      } catch { /* swallow */ }
    }
  }
  return true;
}

/**
 * Return the cerebellum L1 tick interval (ms) that corresponds to the
 * current mode.
 *
 *   - mode='boot'    → 2000
 *   - mode='awake'   → 10000
 *   - mode='drowsy'  → 60000
 *   - mode='dormant' → null (caller MUST clearTimeout and stop scheduling)
 *   - mode=null      → null (no mode set yet — caller decides default)
 *
 * @returns {(number|null)}
 */
export function getAthenaTickIntervalMs() {
  if (currentMode === null) return null;
  // currentMode is constrained by setAthenaMode's allowlist, so the
  // direct lookup is safe.
  return MODE_INTERVAL_MS[currentMode];
}

/**
 * Register a callback fired every time `setAthenaMode` accepts a new
 * mode. The callback receives the new mode string.
 *
 * Returns an unsubscribe function. Idempotent — calling unsubscribe
 * twice is a no-op.
 *
 * @param {(mode: string) => void} callback
 * @returns {() => void}
 */
export function subscribeToAthenaModeChange(callback) {
  if (typeof callback !== 'function') {
    return () => { /* no-op */ };
  }
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Test helper — reset module-level state. Production callers MUST NOT
 * use this; the cache is module-scoped because each daemon process is
 * a single agent, but tests forking + clearing in the parent process
 * need a way to drop subscribers between cases.
 */
export function clearAthenaMode() {
  currentMode = null;
  subscribers.clear();
}

/**
 * Read-only snapshot of the allowed modes table. Exposed for callers
 * (including the daemon entrypoint's `athenaModeSetter` filter) that
 * need to validate inbound values without re-importing the constant
 * shape.
 *
 * @returns {readonly string[]}
 */
export function getAthenaModeAllowlist() {
  return ALLOWED_MODES;
}
