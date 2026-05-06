/**
 * Extraction prompt builder and response parser for Cerebellum L1.
 * One LLM call per session's new turns batch.
 */

/** Importance threshold — proposals below this are discarded. */
export const EXTRACTION_IMPORTANCE_THRESHOLD = 0.5;

/** Floor for short_skill importance per RF-7. */
export const SKILL_IMPORTANCE_FLOOR = 0.8;

/**
 * Build extraction prompt for a batch of new turns.
 * @param {Array<{role: string, content: string}>} turns
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>} messages for callCerebellum
 */
export function buildExtractionPrompt(turns, agentName) {
  const systemPrompt = `You are a memory extraction assistant for AI agent "${agentName}".

Your task: extract valuable information from the conversation below as structured memories.

## Memory Layer System (4 layers)
L1 extraction produces only 3 initial layers. long_skill is created by L2 promotion only.

| Layer | When to use | Examples |
|-------|------------|---------|
| [short] | Decisions, task results, collaboration, context info | "Decided to use Redis", "Deployed to port 3000" |
| [long] | User personal info, user explicitly says "remember this" | "User name is Alice", "User prefers TypeScript" |
| [short_skill] | Workflows, processes, methodologies taught by user | "Always run prisma generate before deploy" |
| [none] | Small talk, tool call details, thinking process, repeated info | Greetings, verbose npm output |

Do NOT use [long_skill] — that layer is created only by L2 promotion.

## Rules
- Extract only valuable information, do not copy verbatim
- Each memory must include tags (comma-separated) and importance (0.0-1.0)
- Importance guide: 0.9-1.0 critical decisions/events; 0.7-0.8 patterns/workflows; 0.5-0.6 contextual; <0.5 skip
- User personal info → [long] (name, role, preferences, timezone)
- User explicit "remember this" → [long]
- Important decisions/conclusions → [short]
- Task execution results → [short]
- Record/note references and write_record tool calls → [short] (extract as index pointer, not full content)
- Collaboration experiences → [short] — MUST include 'collaboration' tag
  When agents work together, delegate tasks, attend meetings, or coordinate:
  - Include both agent names and what they collaborated on
  - Note cooperation quality if observable (effective, struggled, complementary skills)
  - Examples:
    "Worked with Bob on API migration — Bob handled database schema, effective division"
    "Delegated security audit to Charlie — completed successfully, Charlie strong at compliance"
    "Meeting with Alice and Bob: agreed on Redis caching strategy"
- Environment/context info → [short]
- User-taught methods/processes → [short_skill]
- Skill importance floor: minimum 0.8
- When in doubt, extract (better to over-remember than under-remember)

## Record Tool Call Recognition (§1.7)
When you see a write_record tool call in the conversation, extract a [short] memory that serves as an index:
- Include the record ID, title, and tags in the memory content
- Format: "Stored record '{title}' (rec-{id}) about {brief summary}. Tags: [tag1, tag2]."
- Importance: 0.7 (these are reference pointers, not the content itself)
- Tags: include 'record-index' plus any tags from the record itself
- This creates an indirect reference: Memory index → Brain can later use read_record to retrieve full content
- Do NOT extract the full record content — only the index/pointer

## Output format (one per line, strict)
[short] [tags:tag1,tag2] [importance:0.7] Extracted memory content
[long] [tags:user-info] [importance:0.9] Important personal info
[short_skill] [tags:workflow,deploy] [importance:0.8] Step-by-step process
[short] [tags:collaboration,api-migration] [importance:0.7] Worked with Bob on API migration — effective task division
[none]

If nothing is worth extracting, output only:
[none]`;

  const turnText = turns.map(t => `[${t.role}] ${t.content || ''}`).join('\n');
  const userPrompt = `Extract memories from the following conversation:\n\n${turnText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * Parse extraction LLM response into proposals.
 * @param {string} responseText
 * @returns {Array<{layer: string, tags: string[], importance: number, content: string}>}
 */
export function parseExtractionResponse(responseText) {
  const REGEX = /^\[(short|long|short_skill)\]\s*\[tags:([^\]]*)\]\s*\[importance:([\d.]+)\]\s*(.+)/;
  const proposals = [];
  for (const line of responseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '[none]') continue;
    const match = trimmed.match(REGEX);
    if (!match) continue;
    const [, layer, tagsStr, importanceStr, content] = match;
    const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
    const importance = parseFloat(importanceStr);
    if (importance < EXTRACTION_IMPORTANCE_THRESHOLD) continue;
    // short_skill importance floor: minimum 0.8
    const finalImportance = layer === 'short_skill'
      ? Math.max(importance, SKILL_IMPORTANCE_FLOOR)
      : importance;
    proposals.push({ layer, tags, importance: finalImportance, content });
  }
  return proposals;
}
