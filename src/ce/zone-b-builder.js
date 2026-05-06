/**
 * Zone B block builder — assembles structured plain-text blocks for Zone B.
 *
 * Block categories (design doc §4.9):
 *   [Long-term Memory]        — user info, long-term preferences (layer='long')
 *   [Cooperation History]     — memories identified by CE as cooperation-related (max 10)
 *   [Learned Skills]          — procedural memory (layer='short_skill' or 'long_skill')
 *   [Related Context]         — other relevant memories
 *   [Dormant Session Context] — summaries from dormant sessions
 *
 * Output is plain text with explicit block headers. No JSON.
 */

/** Maximum number of cooperation history entries included in Zone B. */
export const MAX_COOPERATION_ENTRIES = 10;

/**
 * Build Zone B content string from memories and dormant summaries.
 *
 * @param {Array<{id: number, content: string, layer?: string, tags?: string[]}>} memories
 * @param {string[]} dormantSummaries
 * @param {Set<number>} cooperationMemoryIds - IDs of memories classified as cooperation history
 * @returns {{ content: string, blockCount: number }}
 */
export function buildZoneBContent(memories, dormantSummaries, cooperationMemoryIds = new Set()) {
  const blocks = [];

  const cooperation = [];
  const longTerm = [];
  const skills = [];
  const other = [];

  for (const m of memories) {
    // Cooperation memories are extracted first to avoid duplication in other blocks.
    if (cooperationMemoryIds.has(m.id)) {
      if (cooperation.length < MAX_COOPERATION_ENTRIES) {
        cooperation.push(m);
      }
    } else if (m.layer === 'short_skill' || m.layer === 'long_skill') {
      skills.push(m);
    } else if (m.layer === 'long') {
      longTerm.push(m);
    } else {
      other.push(m);
    }
  }

  if (longTerm.length > 0) {
    blocks.push(formatBlock('Long-term Memory', longTerm.map(m => m.content)));
  }
  if (cooperation.length > 0) {
    blocks.push(formatBlock('Cooperation History', cooperation.map(m => m.content)));
  }
  if (skills.length > 0) {
    blocks.push(formatBlock('Learned Skills', skills.map(m => m.content)));
  }
  if (other.length > 0) {
    blocks.push(formatBlock('Related Context', other.map(m => m.content)));
  }
  if (dormantSummaries.length > 0) {
    blocks.push(formatBlock('Dormant Session Context', dormantSummaries));
  }

  const content = blocks.join('\n\n');
  return { content, blockCount: blocks.length };
}

/**
 * Format a single block with header.
 * @param {string} title
 * @param {string[]} items
 * @returns {string}
 */
function formatBlock(title, items) {
  return `[${title}]\n${items.map(item => `- ${item}`).join('\n')}`;
}
