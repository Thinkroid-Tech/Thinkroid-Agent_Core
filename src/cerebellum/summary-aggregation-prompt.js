/**
 * Aggregation prompt builder for multi-level summaries.
 * One LLM call per summary level (§4.3 Step 1).
 */

const LEVEL_LABELS = {
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
};

const SOURCE_LEVEL_LABELS = {
  daily: 'session',
  weekly: 'daily',
  monthly: 'weekly',
  quarterly: 'monthly',
  yearly: 'quarterly',
};

/**
 * Build aggregation prompt for a given summary level.
 * @param {string} level - 'daily'|'weekly'|'monthly'|'quarterly'|'yearly'
 * @param {string[]} sourceSummaries - summaries to aggregate
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildAggregationPrompt(level, sourceSummaries, agentName) {
  const levelLabel = LEVEL_LABELS[level] || level;
  const sourceLabel = SOURCE_LEVEL_LABELS[level] || 'source';

  const systemPrompt = `You are a memory consolidation assistant for AI agent "${agentName}".

Your task: aggregate the following ${sourceLabel} summaries into a single ${levelLabel} summary.

## Guidelines
- Focus on patterns, key decisions, and notable events
- Preserve inter-agent collaboration details: which agents worked together, on what tasks, and outcomes. Include agent names — do not generalize as "collaborated with others"
- Be concise: 3-8 sentences for daily/weekly, 5-12 sentences for monthly and above
- Preserve specific details that matter (names, numbers, decisions) rather than vague generalities
- If multiple summaries mention the same topic, consolidate into one statement

## Output
Write ONLY the summary text. No headers, no formatting markers.`;

  const numbered = sourceSummaries.map((s, i) => `[${sourceLabel} ${i + 1}]\n${s}`).join('\n\n');
  const userPrompt = `Aggregate these ${sourceSummaries.length} ${sourceLabel} summaries into one ${levelLabel} summary:\n\n${numbered}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Parse aggregation response — simple text extraction.
 * @param {string} text
 * @returns {string}
 */
export function parseAggregationResponse(text) {
  return (text || '').trim();
}
