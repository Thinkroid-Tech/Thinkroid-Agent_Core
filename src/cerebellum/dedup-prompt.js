/**
 * Dedup prompt builder and response parser for Cerebellum L1.
 * Per DL-15: L1 dedup has only [duplicate] (skip) and [new] (write). NO [merge] — merge is L2 only.
 */

/**
 * Build dedup prompt for LLM comparison.
 * @param {string} newMemoryContent
 * @param {Array<{id: number, content: string}>} candidates
 * @returns {Array<{role: string, content: string}>}
 */
export function buildDedupPrompt(newMemoryContent, candidates) {
  const existingText = candidates
    .map(c => `[id:${c.id}] ${c.content}`)
    .join('\n');

  const systemPrompt = `You are a memory deduplication assistant.

Compare the new memory against existing candidates. Determine if it is:
- A duplicate or near-duplicate of an existing entry → [duplicate] [id:NNN]
- Independent new information → [new]

Output exactly one line. No explanation.
Note: do NOT merge entries. Only classify as duplicate or new.`;

  const userPrompt = `New memory: ${newMemoryContent}\n\nExisting candidates:\n${existingText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Parse dedup LLM response.
 * @param {string} responseText
 * @returns {{ isDuplicate: boolean, existingId: number|null }}
 */
export function parseDedupResponse(responseText) {
  const trimmed = responseText.trim();
  const dupMatch = trimmed.match(/^\[duplicate\]\s*\[id:(\d+)\]/i);
  if (dupMatch) {
    return { isDuplicate: true, existingId: parseInt(dupMatch[1], 10) };
  }
  // Default: treat as new (conservative — if we can't parse, don't skip)
  return { isDuplicate: false, existingId: null };
}
