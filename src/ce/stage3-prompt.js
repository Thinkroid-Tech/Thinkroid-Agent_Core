/**
 * Stage 3 extreme compression prompt builder.
 *
 * Targets 5-10% of original length (vs Stage 2's 20-30%).
 * Strongly biased toward delete/compact — keep only for critical user instructions.
 */

/**
 * Build the Stage 3 extreme compression prompt for a conversation block.
 *
 * @param {Array<{role: string, content: string}>} block - Messages in the block
 * @param {string} agentName - Agent name for orientation context
 * @returns {Array<{role: string, content: string}>} Prompt messages ready for ceChannel
 */
export function buildStage3Prompt(block, agentName) {
  const blockText = block.map(m => `[${m.role}] ${m.content}`).join('\n');

  const systemPrompt = `You are an EMERGENCY extreme compression assistant for an AI agent workspace.

CRITICAL SITUATION: The conversation context is overflowing and must be compressed aggressively.

Your task: analyze a conversation block and decide ONE action — biased STRONGLY toward delete or compact.

## Compression target
- compactedText should be ~5-10% of original length (EXTREME compression — much more aggressive than normal)
- Delete anything that is not absolutely essential
- Only keep content that is a critical user instruction with no other record of it

## Decision criteria
- keep: ONLY for critical user instructions that are irreplaceable and cannot be summarized (use sparingly)
- delete: Use liberally — tool outputs, verbose logs, pleasantries, failed attempts, superseded info, intermediate steps, chit-chat
- compact: Use for anything with residual value — crush to the bare minimum (5-10% target)

## Memory layer preservation (RF-4)
When compacting, preserve minimal signals for downstream memory extraction:
- User personal info (name, role, preferences) → maps to long-term memory
- Key decisions and final task results → maps to short-term memory
- Critical workflows and processes → maps to short-skill memory
- Verified core skills → maps to long-skill memory
Ruthlessly strip all filler and verbosity. Preserve only the signal, not the noise.

## Output format
Return exactly one JSON object, no markdown fences, no explanation outside the JSON:
{"verdict": "keep" | "delete" | "compact", "compactedText": "..." | null, "reason": "brief justification"}

Rules:
- verdict=keep → compactedText must be null
- verdict=delete → compactedText must be null
- verdict=compact → compactedText must be a non-empty string
- compactedText must be ~5-10% of original length (extreme compression)
- reason should be 1 sentence`;

  const userPrompt = `Context: Agent: ${agentName}

EMERGENCY compression — target 5-10% of original length. Be ruthless.

Conversation block to evaluate:

${blockText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}
