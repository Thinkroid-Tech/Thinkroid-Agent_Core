/**
 * Summarization prompt builder and response parser for Cerebellum L2 Phase 1.
 * One LLM call per Dormant session (§4.3 line 703-715).
 */

import { EXTRACTION_IMPORTANCE_THRESHOLD, SKILL_IMPORTANCE_FLOOR } from './extraction-prompt.js';

/**
 * Build summarization prompt for a session's history.
 * @param {Array<{role: string, content: string}>} turns
 * @param {string} agentName
 * @param {string} [priorSummary] - Summary from previous batch (for batched processing)
 * @returns {Array<{role: string, content: string}>}
 */
export function buildSummarizationPrompt(turns, agentName, priorSummary = '') {
  const systemPrompt = `You are a memory consolidation assistant for AI agent "${agentName}".

Your task: analyze the session history below and produce three outputs:

## 1. Session Summary
Write a concise summary (2-5 sentences) capturing the key events, decisions, outcomes, and context of this session. Focus on WHAT happened and WHY, not low-level details.

## 2. Memory Extraction
Extract valuable memories using the same format as L1 extraction:

| Layer | When to use |
|-------|------------|
| [short] | Decisions, task results, collaboration, context info |
| [long] | User personal info, explicit "remember this" |
| [short_skill] | Workflows, processes, methodologies |

Format: [layer] [tags:tag1,tag2] [importance:0.0-1.0] Memory content

## 3. Skill Identification
Identify any repeated patterns, workflows, or methodologies that appeared in this session.
Format: [short_skill] [tags:tag1,tag2] [importance:0.8] Skill description

## Collaboration Memory (§3.4)
When the session involves inter-agent cooperation (task delegation, meetings, joint work):
- Extract as [short] with 'collaboration' tag — this is the canonical tag
- Include: who collaborated, on what, and outcome/quality
- Example: [short] [tags:collaboration,code-review] [importance:0.7] Collaborated with Alice on code review — Alice identified 3 security issues, thorough reviewer

## Output format (strict sections)
## Summary
(2-5 sentence summary)

## Memories
[short] [tags:...] [importance:...] content
...or:
[none]

## Skills
[short_skill] [tags:...] [importance:0.8] content
...or:
[none]`;

  let userContent = '';
  if (priorSummary) {
    userContent += `Previous batch context:\n${priorSummary}\n\n---\n\n`;
  }
  const turnText = turns.map(t => `[${t.role}] ${t.content || ''}`).join('\n');
  userContent += `Analyze the following session history:\n\n${turnText}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/**
 * Parse summarization LLM response into structured output.
 * @param {string} responseText
 * @returns {{ summary: string, memories: Array<{layer: string, tags: string[], importance: number, content: string}>, skills: Array<{layer: string, tags: string[], importance: number, content: string}> }}
 */
export function parseSummarizationResponse(responseText) {
  const MEMORY_REGEX = /^\[(short|long|short_skill)\]\s*\[tags:([^\]]*)\]\s*\[importance:([\d.]+)\]\s*(.+)/;

  // Split into sections by ## headers
  const sections = responseText.split(/^## /m).filter(Boolean);

  let summary = '';
  const memories = [];
  const skills = [];

  for (const section of sections) {
    const firstNewline = section.indexOf('\n');
    const header = (firstNewline >= 0 ? section.slice(0, firstNewline) : section).trim().toLowerCase();
    const body = firstNewline >= 0 ? section.slice(firstNewline + 1).trim() : '';

    if (header.startsWith('summary')) {
      summary = body;
    } else if (header.startsWith('memories') || header.startsWith('memory')) {
      for (const line of body.split('\n')) {
        const parsed = _parseLine(line, MEMORY_REGEX);
        if (parsed) memories.push(parsed);
      }
    } else if (header.startsWith('skill')) {
      for (const line of body.split('\n')) {
        const parsed = _parseLine(line, MEMORY_REGEX);
        if (parsed) skills.push(parsed);
      }
    }
  }

  return { summary, memories, skills };
}

function _parseLine(line, regex) {
  const trimmed = line.trim();
  if (!trimmed || trimmed === '[none]') return null;
  const match = trimmed.match(regex);
  if (!match) return null;
  const [, layer, tagsStr, importanceStr, content] = match;
  const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
  const importance = parseFloat(importanceStr);
  if (importance < EXTRACTION_IMPORTANCE_THRESHOLD) return null;
  const finalImportance = layer === 'short_skill'
    ? Math.max(importance, SKILL_IMPORTANCE_FLOOR)
    : importance;
  return { layer, tags, importance: finalImportance, content };
}
