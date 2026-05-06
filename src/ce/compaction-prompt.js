/**
 * Build the compaction prompt for a single Y-block.
 *
 * The prompt asks the LLM to classify the block as keep/delete/compact
 * and return strict JSON. Includes RF-4 4-layer mapping hints so compacted
 * text preserves signals that Cerebellum L1 extraction needs.
 *
 * @param {Array<{role: string, content: string}>} yBlock - Messages in this Y-block
 * @param {string} [orientation=''] - Brief context line (e.g., agent name / session topic)
 * @returns {Array<{role: string, content: string}>} Messages array ready for callContextEngine
 */
export function buildCompactionPrompt(yBlock, orientation = '') {
  const blockText = yBlock.map(m => `[${m.role}] ${m.content}`).join('\n');

  const systemPrompt = `You are a context compaction assistant for an AI agent workspace.

Your task: analyze a conversation block and decide ONE action.

## Decision criteria
- keep: Content is important — user instructions, key decisions, requirements, unresolved questions
- delete: Content is low-value — failed tool calls with retries, redundant verbose output, pure pleasantries, already-superseded information
- compact: Content has valuable facts that can be summarized concisely — preserve facts and decisions, remove verbosity and filler

## Memory layer preservation (RF-4)
When compacting, preserve signals that downstream memory extraction needs:
- User personal info (name, role, preferences) → maps to long-term memory
- Decisions and task results → maps to short-term memory
- Workflows and processes → maps to short-skill memory
- Critical verified skills → maps to long-skill memory
Do NOT strip these signals from compacted text. A good summary retains who/what/when/why.

## Output format
Return exactly one JSON object, no markdown fences, no explanation outside the JSON:
{"verdict": "keep" | "delete" | "compact", "compactedText": "..." | null, "reason": "brief justification"}

Rules:
- verdict=keep → compactedText must be null
- verdict=delete → compactedText must be null
- verdict=compact → compactedText must be a non-empty string
- compactedText should be ~20-30% of original length
- reason should be 1 sentence`;

  const userPrompt = `${orientation ? `Context: ${orientation}\n\n` : ''}Conversation block to evaluate:\n\n${blockText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Parse the LLM response string into a structured verdict.
 * Returns a default keep verdict on any parse failure.
 *
 * @param {string} responseText - Raw LLM response
 * @returns {{ verdict: 'keep'|'delete'|'compact', compactedText: string|null, reason: string }}
 */
export function parseCompactionVerdict(responseText) {
  try {
    // Try to extract JSON from the response (LLM may wrap in markdown fences)
    let jsonStr = responseText.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    const parsed = JSON.parse(jsonStr);
    const verdict = parsed.verdict;
    if (!['keep', 'delete', 'compact'].includes(verdict)) {
      return { verdict: 'keep', compactedText: null, reason: 'Invalid verdict, defaulting to keep' };
    }
    if (verdict === 'compact' && (!parsed.compactedText || typeof parsed.compactedText !== 'string')) {
      return { verdict: 'keep', compactedText: null, reason: 'Compact verdict without compactedText, defaulting to keep' };
    }
    return {
      verdict,
      compactedText: verdict === 'compact' ? parsed.compactedText : null,
      reason: parsed.reason || '',
    };
  } catch {
    return { verdict: 'keep', compactedText: null, reason: 'Failed to parse LLM response, defaulting to keep' };
  }
}
