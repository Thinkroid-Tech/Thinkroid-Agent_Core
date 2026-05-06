// Context payload types assembled by CE (Context Engine) and passed to Brain.
// Describes the full message array and zone/cache-breakpoint layout for a single LLM call.

/**
 * Cache breakpoint marker
 * @typedef {Object} CacheBreakpoint
 * @property {string} id - 'bp1'|'bp2'|'bp3'|'bp4'
 * @property {number|null} position - Index in the messages array where this BP falls.
 *   null means the zone this BP guards is empty (zone not yet populated).
 *   BP1 is always non-null (Zone A always exists). null BPs must form a contiguous tail.
 */

/**
 * Brain Context Payload assembled by CE
 * @typedef {Object} ContextPayload
 * @property {string} session_id - Which session this payload belongs to
 * @property {Object[]} messages - The full message array sent to the LLM
 * @property {Object[]} tools - Tool definitions (OpenAI format)
 * @property {Object} zones - Zone boundary markers
 * @property {number} zones.zone_a_end - End index of Zone A (System Prompt + Tools)
 * @property {number} zones.zone_b_end - End index of Zone B (Memory summary + Dormant reuse)
 * @property {number} zones.zone_c_front_end - End index of Zone C front (old conversation)
 * @property {number} zones.zone_c_mid_end - End index of Zone C mid (CE compact battlefield)
 * @property {CacheBreakpoint[]} breakpoints - 4 cache breakpoints [BP1, BP2, BP3, BP4]
 * @property {number} estimated_tokens - Token estimate for this payload
 */

export {};
