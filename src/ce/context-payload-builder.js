/**
 * Context Payload builder for Brain.
 * Assembles Zone A/B/C + 4 cache breakpoints (BPs) per design doc 4.9.
 *
 * Zone / BP layout (strict order):
 *
 *   Zone A: System Prompt + Tools (never compressed)
 *   ─── BP1 ───
 *   Zone B: Memory summary + Dormant session reuse
 *   ─── BP2 ───
 *   Zone C-front: Old conversation (Stage 3 only — CE rehydrates from history)
 *   ─── BP3 ───
 *   Zone C-mid: Compact battlefield (CE Stage 2 accumulates summaries here)
 *   ─── BP4 ───
 *   Zone C-tail: Latest turns + current user message
 *
 * Fresh session (Stage 1):
 *   Zone B empty AND Zone C-front/C-mid empty
 *   → bp1 = system prompt last content block index, bp2 = bp3 = bp4 = null
 *   Only BP1 emits a cache_control marker.
 *
 * Invariant (always holds):
 *   - For non-null BPs: bp1 <= bp2 <= bp3 <= bp4
 *   - Null BPs must form a contiguous tail: once a BP is null, all subsequent must be null
 *     (e.g. [0, 1, null, null] legal; [0, null, 2, null] illegal — mid-gap)
 */

/**
 * Build an initial Brain Context Payload for a new session (Stage 1).
 *
 * @param {Object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.systemPrompt      - Zone A system message content
 * @param {Object[]} opts.toolDefinitions  - OpenAI-format tool definitions
 * @param {string} opts.zoneBContent        - Zone B: pre-built content from buildZoneBContent() ('' if empty)
 * @param {string} opts.userMessage        - Zone C-tail: user's incoming message
 * @returns {import('../types/context-payload.js').ContextPayload}
 */
export function buildInitialPayload({
  sessionId,
  systemPrompt,
  toolDefinitions,
  zoneBContent = '',
  chatHistory = [],
  userMessage,
}) {
  const messages = [];

  // Zone A: system message (index 0)
  messages.push({ role: 'system', content: systemPrompt });
  const zoneAEnd = 0; // index of the Zone A message

  // Zone B: pre-built content from buildZoneBContent() (P5-C)

  let zoneBEnd;
  if (zoneBContent.length > 0) {  // D-5: length-based check, not string truthiness
    messages.push({ role: 'system', content: zoneBContent });
    zoneBEnd = messages.length - 1;
  } else {
    // Zone B empty — collapses onto Zone A end
    zoneBEnd = zoneAEnd;
  }

  // Zone C chat history (DL-36): placed before user message in C-tail
  for (const msg of chatHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userMessage });

  // Breakpoints: fresh session → only BP1 is set.
  // BP2/BP3/BP4 null because their zones are empty.
  // zoneAEnd = system prompt last content block index
  const breakpoints = [
    { id: 'bp1', position: zoneAEnd },
    { id: 'bp2', position: zoneBContent.length > 0 ? zoneBEnd : null },
    { id: 'bp3', position: null },
    { id: 'bp4', position: null },
  ];

  // Zone C bookkeeping (used in zones return object, not BPs)
  const zoneCFrontEnd = zoneBEnd;
  const zoneCMidEnd = zoneBEnd;

  // Enforce the invariant before returning
  assertBpInvariant(breakpoints);

  // Rough token estimate: ~1 token per 3 characters
  const estimatedTokens = messages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : '';
    return sum + Math.ceil(text.length / 3);
  }, 0);

  return {
    session_id: sessionId,
    messages,
    tools: toolDefinitions,
    zones: {
      zone_a_end: zoneAEnd,
      zone_b_end: zoneBEnd,
      zone_c_front_end: zoneCFrontEnd,
      zone_c_mid_end: zoneCMidEnd,
    },
    breakpoints,
    estimated_tokens: estimatedTokens,
  };
}

/**
 * Assert the BP invariant. Three rules:
 *   1. BP1 must always be non-null (Zone A always exists).
 *   2. Non-null BPs must be non-decreasing: bp1 <= bp2 <= bp3 <= bp4.
 *   3. Null BPs must form a contiguous tail: once a BP is null, all subsequent must be null.
 *      e.g. [0, 1, null, null] is legal; [0, null, 2, null] is illegal (mid-gap).
 *
 * Must be called every time a payload is assembled or mutated (Stage 2 advance, Stage 3 rehydrate).
 *
 * @param {Array<{id: string, position: number|null}>} breakpoints
 * @throws {Error} if any invariant rule is violated
 */
export function assertBpInvariant(breakpoints) {
  if (breakpoints[0].position === null) {
    throw new Error('BP invariant violated: bp1 must always be non-null (Zone A always exists)');
  }
  let seenNull = false;
  let lastNonNullPosition = breakpoints[0].position;
  for (let i = 1; i < breakpoints.length; i++) {
    const bp = breakpoints[i];
    if (bp.position === null) { seenNull = true; continue; }
    if (seenNull) {
      throw new Error(`BP invariant violated: ${bp.id} is non-null but a preceding BP is null (mid-gap). Null BPs must form a contiguous tail.`);
    }
    if (bp.position < lastNonNullPosition) {
      const prev = breakpoints[i - 1];
      throw new Error(`BP invariant violated: ${prev.id}(${prev.position}) > ${bp.id}(${bp.position}). Non-null BPs must be non-decreasing.`);
    }
    lastNonNullPosition = bp.position;
  }
}

/**
 * Build the list of cache_control markers to emit for an LLM request.
 *
 * Rules (ref: 顶层设计 4.9):
 *   - null BPs are skipped (zone is empty, no marker needed).
 *   - Collapsed positions (bp.position <= last emitted) are skipped to avoid
 *     wasting a marker slot on a duplicate index.
 *   - index = messages array content block index where cache_control lands.
 *   - Anthropic API allows max 4 ephemeral markers per request; throws if exceeded.
 *
 * @param {Array<{id: string, position: number|null}>} breakpoints
 * @returns {Array<{id: string, index: number, type: 'ephemeral'}>}
 * @throws {Error} if more than 4 markers would be emitted
 */
export function buildCacheControlMarkers(breakpoints) {
  const markers = [];
  let lastEmittedPosition = -1;
  for (const bp of breakpoints) {
    if (bp.position === null) continue;
    if (bp.position <= lastEmittedPosition) continue;
    markers.push({ id: bp.id, index: bp.position, type: 'ephemeral' });
    lastEmittedPosition = bp.position;
  }
  if (markers.length > 4) {
    throw new Error(`Too many cache_control markers (${markers.length}). Anthropic API allows max 4 ephemeral markers per request.`);
  }
  return markers;
}

/**
 * Apply cache_control markers to a messages array by converting marked
 * messages to Anthropic content-block format.
 *
 * Only messages at marker indices are converted (DL-53: minimal conversion).
 * Other messages remain as-is (string content).
 *
 * @param {Array<Object>} messages - OpenAI-format messages array
 * @param {Array<{id: string, index: number, type: string}>} markers - from buildCacheControlMarkers()
 * @returns {Array<Object>} New array with cache_control applied (does NOT mutate original)
 * @throws {Error} if a marker index is out of range
 */
export function applyCacheMarkers(messages, markers, providerType) {
  // Skip cache markers for non-Anthropic providers (P10-B / DL-60)
  if (providerType && providerType !== 'anthropic') return messages;
  if (!markers || markers.length === 0) return messages;

  // Shallow-copy so we don't mutate the caller's array
  const result = messages.map(m => ({ ...m }));

  for (const marker of markers) {
    if (marker.index < 0 || marker.index >= result.length) {
      throw new Error(
        `Cache marker ${marker.id} index ${marker.index} out of range (messages length: ${result.length})`,
      );
    }

    const msg = result[marker.index];
    if (typeof msg.content === 'string') {
      // Convert string content to content-block format with cache_control
      msg.content = [
        { type: 'text', text: msg.content, cache_control: { type: marker.type } },
      ];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      // Content already in block format — shallow-copy the last block and add cache_control
      const blocks = [...msg.content];
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: marker.type },
      };
      msg.content = blocks;
    }
    // If content is empty/null/undefined, skip silently (no content to cache)
  }

  return result;
}
