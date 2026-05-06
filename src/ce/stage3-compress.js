/**
 * Stage 3 extreme compression.
 *
 * Called when the tool-loop detects context overflow (>85% of context limit).
 * Performs zone-aware compaction:
 *   Zone A: messages[0] (system prompt) — always pinned
 *   Zone B: messages[1] if role==='system' — always pinned
 *   Zone C: everything else — compacted in chunks of 5 turns
 *
 * If pinned zones alone exceed threshold, throws UnrecoverableOverflowError.
 * If Zone C compression is insufficient, falls back to hard-truncation of oldest turns.
 */

import { estimateConversationTokens } from '../ai/token-estimator.js';
import { parseCompactionVerdict } from './compaction-prompt.js';
import { buildStage3Prompt } from './stage3-prompt.js';
import { UnrecoverableOverflowError } from '../errors.js';
import { assertBpInvariant } from './context-payload-builder.js';

/**
 * Convenience alias so internal code reads cleanly.
 * @param {Array} messages
 * @returns {number}
 */
function estimateTokens(messages) {
  return estimateConversationTokens(messages);
}

/**
 * Compact a single block of messages using Stage 3 extreme compression.
 * Mirrors the retry structure of context-engine.js _compactOneBlock exactly.
 *
 * @param {Array<{role: string, content: string}>} block
 * @param {Function} ceChannel - async ({ agentId, agentName, messages, maxTokens }) => string
 * @param {{ agentId: string, agentName: string }} agentRef
 * @returns {Promise<{ succeeded: boolean, messages: Array<{role: string, content: string}> }>}
 */
async function _compactOneBlockStage3(block, ceChannel, agentRef) {
  const { agentId, agentName } = agentRef;
  const displayName = agentName ?? agentId;
  const promptMessages = buildStage3Prompt(block, displayName);

  // Try up to 2 times (retry once on error)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const responseText = await ceChannel({
        agentId,
        agentName: displayName,
        messages: promptMessages,
        maxTokens: 1024,
      });

      const verdict = parseCompactionVerdict(responseText);

      switch (verdict.verdict) {
        case 'keep':
          return {
            succeeded: true,
            messages: block.map(t => ({ role: t.role, content: t.content || '' })),
          };
        case 'delete':
          return { succeeded: true, messages: [] };
        case 'compact':
          return {
            succeeded: true,
            messages: [{ role: 'system', content: `[Compacted] ${verdict.compactedText}` }],
          };
        default:
          // Safety fallback — should not happen after parseCompactionVerdict
          return {
            succeeded: true,
            messages: block.map(t => ({ role: t.role, content: t.content || '' })),
          };
      }
    } catch (err) {
      if (attempt === 0) {
        console.warn(
          `[Stage3:${displayName}] Compaction attempt ${attempt + 1} failed, retrying:`, err.message
        );
        continue; // retry once
      }
      console.warn(
        `[Stage3:${displayName}] Compaction failed after retry, falling back to keep:`, err.message
      );
      return {
        succeeded: false,
        messages: block.map(t => ({ role: t.role, content: t.content || '' })),
      };
    }
  }

  // Should not reach here, but safety fallback
  return {
    succeeded: false,
    messages: block.map(t => ({ role: t.role, content: t.content || '' })),
  };
}

/**
 * Stage 3 extreme compression entry point.
 *
 * @param {Array<{role: string, content: string}>} messages - Full conversation messages
 * @param {Function} ceChannel - async ({ agentId, agentName, messages, maxTokens }) => string
 * @param {string|{agentId: string, agentName: string}} agentRef - Phase 13
 *   I5: either a legacy agentName string (for test fixtures) or the full
 *   `{ agentId, agentName }` shape that production callers now pass.
 * @param {number} contextLimit - Model context window size in tokens
 * @returns {Promise<{ messages: Array<{role: string, content: string}>, truncated: boolean }>}
 * @throws {UnrecoverableOverflowError} When Zone A+B alone exceed the 85% threshold
 */
export async function stage3ExtremeCompress(messages, ceChannel, agentRef, contextLimit, zoneBEnd = null) {
  // Normalise the identity argument so we can keep passing a uniform
  // `{ agentId, agentName }` envelope down into the CE channel call.
  const normalized = typeof agentRef === 'string'
    ? { agentId: agentRef, agentName: agentRef }
    : { agentId: agentRef?.agentId, agentName: agentRef?.agentName ?? agentRef?.agentId };
  const displayName = normalized.agentName ?? normalized.agentId;

  const threshold = Math.floor(contextLimit * 0.85);

  // Identify pinned zones
  const zoneA = [messages[0]];
  // Explicit zone boundary when available; heuristic fallback for legacy callers
  const zoneB = zoneBEnd !== null
    ? messages.slice(1, zoneBEnd + 1).filter(m => m.role === 'system')
    : (messages[1]?.role === 'system') ? [messages[1]] : [];
  const zoneCStart = zoneA.length + zoneB.length;
  const zoneC = messages.slice(zoneCStart);

  // Pre-check: if pinned zones alone exceed threshold, no Zone C compaction can help
  const pinnedTokens = estimateTokens([...zoneA, ...zoneB]);
  if (pinnedTokens > threshold) {
    throw new UnrecoverableOverflowError(displayName, estimateTokens(messages), pinnedTokens);
  }

  // Split Zone C into chunks of 5 turns
  const CHUNK_SIZE = 5;
  const chunks = [];
  for (let i = 0; i < zoneC.length; i += CHUNK_SIZE) {
    chunks.push(zoneC.slice(i, i + CHUNK_SIZE));
  }

  // Compact each chunk independently
  const compressedParts = await Promise.all(
    chunks.map(chunk => _compactOneBlockStage3(chunk, ceChannel, normalized))
  );

  let compressedC = compressedParts.flatMap(part => part.messages);

  // Reconstruct conversation
  let result = [...zoneA, ...zoneB, ...compressedC];

  // Hard-truncation loop: remove oldest Zone C turns until under threshold
  let truncated = false;
  while (estimateTokens(result) > threshold && compressedC.length > 0) {
    compressedC.shift();
    result = [...zoneA, ...zoneB, ...compressedC];
    console.warn(`[Stage3] ${displayName}: hard-truncating oldest Zone C turn`);
    truncated = true;
  }

  // Post-loop defensive guard: if still over threshold after emptying Zone C
  // (should not happen given pre-check, but defensive programming)
  if (estimateTokens(result) > threshold) {
    throw new UnrecoverableOverflowError(displayName, estimateTokens(result), pinnedTokens);
  }

  // Reconstruct breakpoints for the compressed messages (P8-A3).
  // After Stage 3: Zone A + Zone B survive, Zone C-front/C-mid are destroyed.
  // BP1 = Zone A end (always 0), BP2 = Zone B end (if non-empty), BP3 = BP4 = null.
  const bp1Position = 0; // Zone A is always messages[0]
  const bp2Position = zoneB.length > 0 ? zoneA.length + zoneB.length - 1 : null;
  const breakpoints = [
    { id: 'bp1', position: bp1Position },
    { id: 'bp2', position: bp2Position },
    { id: 'bp3', position: null },
    { id: 'bp4', position: null },
  ];
  assertBpInvariant(breakpoints);

  return { messages: result, breakpoints, truncated };
}
