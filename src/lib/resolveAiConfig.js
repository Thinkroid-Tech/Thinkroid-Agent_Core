// Phase 16.L3'.A (Plan §L3'.3) — daemon-side AI config resolver.
//
// The Athena promotion path needs a single seam where the daemon's
// `brain.chat` handler decides which provider/model/api-key triple to
// drive a given turn. Two cases per Design §8.3.3:
//
//   1. Caller-supplied override   — `options.configOverride` (e.g. the
//      Space Athena route passing `getAthenaAIConfig()`). Used for
//      special-role agents whose config is NOT the DB-managed default.
//      Wins unconditionally so the caller stays in charge.
//
//   2. DB-managed default         — looked up from a process-local
//      cache keyed by agentId. The cache is primed at daemon init
//      from the supervisor's init payload (`config.brainConfig`,
//      Design §3.2 + INV-5: config flows Space → daemon, the daemon
//      never reaches back into the Space DB itself) and refreshed via
//      the supervisor's `config:changed` IPC notification (ADR §11 +
//      F.4 push channel).
//
// INV-5 is preserved: the resolver only reads from the local cache;
// if a key is missing it returns `undefined` and the caller decides
// how to fail (the brain.chat handler raises a structured error so
// the IPC envelope carries a real reason instead of a silent stall).
//
// The cache is module-scoped because each daemon process is a single
// agent (Design §3.1) — there's no multi-tenant concern within a
// process. Tests use `clearAiConfig` / `getAiConfigCache` for
// isolation.

const aiConfigCache = new Map();

/**
 * Resolve the AI config for a given agentId.
 *
 * Order of precedence per Design §8.3.3:
 *   1. `options.configOverride` (caller-supplied wins)
 *   2. process-local cache (populated via init payload + config:changed)
 *
 * Returns `undefined` if the cache has not been primed yet for this
 * agent and no override was supplied; callers MUST decide how to
 * handle the missing-config case (the brain.chat handler raises a
 * structured `daemon_ai_config_unavailable` error).
 *
 * @param {string} agentId
 * @param {{ configOverride?: object }} [options]
 * @returns {object | undefined}
 */
export function resolveAiConfig(agentId, options = {}) {
  if (options && options.configOverride) {
    return options.configOverride;
  }
  return aiConfigCache.get(agentId);
}

/**
 * Populate / overwrite the cached config for `agentId`.
 *
 * Called from two places:
 *   - daemon entrypoint S6/S7-equivalent post-init: seeds the cache
 *     with `payload.config.brainConfig` so the very first brain.chat
 *     turn sees a primed default.
 *   - `config:changed` IPC handler: refreshes the cache when the
 *     Space supervisor broadcasts a global / per-agent provider
 *     change (F.4 push channel).
 *
 * @param {string} agentId
 * @param {object} config
 */
export function setAiConfig(agentId, config) {
  if (typeof agentId !== 'string' || agentId.length === 0) return;
  if (config === null || config === undefined) {
    aiConfigCache.delete(agentId);
    return;
  }
  aiConfigCache.set(agentId, config);
}

/**
 * Drop a cached entry. Used by tests to keep cache state isolated
 * between cases; production callers should use `setAiConfig` with the
 * fresh value rather than clear-then-set so the window where the
 * cache reads `undefined` stays minimal.
 *
 * @param {string} [agentId] — when omitted, clears every entry.
 */
export function clearAiConfig(agentId) {
  if (agentId === undefined) {
    aiConfigCache.clear();
    return;
  }
  if (typeof agentId === 'string') {
    aiConfigCache.delete(agentId);
  }
}

/**
 * Read-only view of the underlying cache. Returned as a fresh Map
 * snapshot so callers can iterate without exposing live mutators.
 * Tests use this to assert init-payload / config:changed wiring
 * without poking at module internals.
 *
 * @returns {Map<string, object>}
 */
export function getAiConfigCache() {
  return new Map(aiConfigCache);
}
