/**
 * Internal Tool Registry — Agent Core owned, static Map.
 *
 * Internal tools are first-class Brain tools that never leave Agent Core
 * (no Space permission checks and no approval flow). They are assembled
 * into the tool list *before* Space tools, so the order is:
 *   [ ...internal (Map insertion order), ...space (alphabetical, Space-owned) ]
 *
 * Keeping the list order fixed protects the BP1 cache prefix from drifting
 * across modes or sessions.
 *
 * Runtime policy: internal tools go through the **same** runtime-policy
 * gate as Space tools (see `tool-loop.js` — the gate runs before dispatch).
 * For example, `recall` is rejected in linger mode because it is not in
 * `LINGER_SAFE_TOOLS`. If a future internal tool needs to bypass gating
 * in a particular mode, it must be explicitly allow-listed in
 * `runtime-policy.js`.
 *
 * Phase 16 (ADR §11 / Design §10) merged the legacy `think_deeper` Brain
 * tool and the Space-side `recall` tool into a single internal tool named
 * `recall`; the closure on toolContext is still called `thinkDeeper` for
 * historical compatibility with CE Stage 4.
 *
 * To add a new internal tool:
 *   1. Create `<name>.js` with named exports `schema` and `createHandler(ctx)`.
 *   2. Register it in `internalToolRegistry` below.
 *   3. (Optional) Ensure Supervisor injects any required closures into
 *      `toolContext` (see `thinkDeeper` for the canonical pattern).
 *   4. (Optional) If the tool should be callable in a restrictive mode
 *      (e.g. linger), update the corresponding allow-list in
 *      `runtime-policy.js`.
 */

import * as recall from './recall.js';

/** @type {Map<string, { schema: Object, createHandler: (ctx: Object) => Function }>} */
export const internalToolRegistry = new Map([
  ['recall', recall],
]);

/**
 * Return the schemas of all registered internal tools in insertion order.
 * Used by CE when assembling the tool list for Brain.
 * @returns {Object[]}
 */
export function listInternalTools() {
  return [...internalToolRegistry.values()].map((entry) => entry.schema);
}

/**
 * Check whether a tool name is handled by the internal registry.
 * Tool-loop uses this to dispatch internal vs Space tools.
 * @param {string} name
 * @returns {boolean}
 */
export function hasInternalTool(name) {
  return internalToolRegistry.has(name);
}

/**
 * Build an execution handler for the named internal tool, bound to `ctx`.
 * Throws if the tool is not registered.
 * @param {string} name
 * @param {Object} ctx
 * @returns {Function}
 */
export function createInternalHandler(name, ctx) {
  const entry = internalToolRegistry.get(name);
  if (!entry) {
    throw new Error(`Internal tool not found: ${name}`);
  }
  return entry.createHandler(ctx);
}
