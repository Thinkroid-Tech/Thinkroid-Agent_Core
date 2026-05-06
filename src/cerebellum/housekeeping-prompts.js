/**
 * LLM prompt builders and parsers for L2 Phase 2 Steps 2-4.
 * Step 2: Memory organization (promotion, dedup, contradiction)
 * Step 3: Skill maintenance (identify, validate, obsolete)
 * Step 4: Cleanup (borderline decay review, orphan tag review)
 */

// ---- Step 2a: Promotion ----

/**
 * Build prompt to evaluate promotion candidates.
 * @param {Array<{id: number, content: string, layer: string, access_count: number, tags: string[]}>} candidates
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildPromotionPrompt(candidates, agentName) {
  const systemPrompt = `You are a memory management assistant for AI agent "${agentName}".

Evaluate each memory below for promotion from short-term to long-term storage.
A memory should be promoted if it contains:
- Persistent knowledge (facts that remain true over time)
- Important decisions or commitments
- User preferences or personal information
- Recurring patterns or established workflows

A memory should NOT be promoted if it:
- Is context-specific and temporary
- Will become outdated quickly
- Is already captured in a higher-level memory

## Output format (one per line, strict)
PROMOTE <id>
SKIP <id>

Evaluate each memory independently.`;

  const items = candidates.map(c =>
    `[ID:${c.id}] layer=${c.layer} access=${c.access_count} tags=[${c.tags.join(',')}]\n${c.content}`
  ).join('\n\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Evaluate these ${candidates.length} promotion candidates:\n\n${items}` },
  ];
}

/**
 * @param {string} text
 * @returns {Array<{action: 'promote'|'skip', id: number}>}
 */
export function parsePromotionResponse(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().toUpperCase();
    const promoteMatch = trimmed.match(/^PROMOTE\s+(\d+)/);
    if (promoteMatch) {
      results.push({ action: 'promote', id: parseInt(promoteMatch[1], 10) });
      continue;
    }
    const skipMatch = trimmed.match(/^SKIP\s+(\d+)/);
    if (skipMatch) {
      results.push({ action: 'skip', id: parseInt(skipMatch[1], 10) });
    }
  }
  return results;
}

// ---- Step 2b: Dedup ----

/**
 * Build prompt to evaluate dedup candidates (pairs with high keyword overlap).
 * @param {Array<{a: {id: number, content: string, layer: string, tags: string[]}, b: {id: number, content: string, layer: string, tags: string[]}}>} pairs
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildDedupBatchPrompt(pairs, agentName) {
  const systemPrompt = `You are a memory deduplication assistant for AI agent "${agentName}".

For each pair of memories below, decide if they are duplicates (same information) or distinct.
If DUPLICATE: specify which to keep (prefer higher access count or more complete content) and which to merge into it.
If DISTINCT: they contain different information and both should stay.

## Output format (one per pair, strict)
DUPLICATE <keepId> <mergeId>
DISTINCT <idA> <idB>`;

  const items = pairs.map((p, i) =>
    `--- Pair ${i + 1} ---\n[A: ID:${p.a.id}] layer=${p.a.layer} tags=[${p.a.tags.join(',')}]\n${p.a.content}\n\n[B: ID:${p.b.id}] layer=${p.b.layer} tags=[${p.b.tags.join(',')}]\n${p.b.content}`
  ).join('\n\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Evaluate these ${pairs.length} memory pairs:\n\n${items}` },
  ];
}

/**
 * @param {string} text
 * @returns {Array<{action: 'duplicate'|'distinct', keepId?: number, mergeId?: number, idA?: number, idB?: number}>}
 */
export function parseDedupBatchResponse(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().toUpperCase();
    const dupMatch = trimmed.match(/^DUPLICATE\s+(\d+)\s+(\d+)/);
    if (dupMatch) {
      results.push({ action: 'duplicate', keepId: parseInt(dupMatch[1], 10), mergeId: parseInt(dupMatch[2], 10) });
      continue;
    }
    const distMatch = trimmed.match(/^DISTINCT\s+(\d+)\s+(\d+)/);
    if (distMatch) {
      results.push({ action: 'distinct', idA: parseInt(distMatch[1], 10), idB: parseInt(distMatch[2], 10) });
    }
  }
  return results;
}

// ---- Step 2c: Contradiction ----

/**
 * Build prompt to detect contradictions between memory pairs.
 * @param {Array<{a: {id: number, content: string, tags: string[]}, b: {id: number, content: string, tags: string[]}}>} pairs
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildContradictionPrompt(pairs, agentName) {
  const systemPrompt = `You are a memory consistency assistant for AI agent "${agentName}".

For each pair of memories, determine if they contradict each other.
A contradiction means the memories state conflicting facts about the same topic.
If CONTRADICTION: keep the newer/more accurate one, and provide updated content that reflects the change
(e.g., "Originally used Redis, later switched to Memcached on 2026-04-15").
If NO_CONTRADICTION: both memories are consistent, no action needed.

## Output format (one per pair, strict)
CONTRADICTION <keepId> <removeId> | <updatedContent>
NO_CONTRADICTION`;

  const items = pairs.map((p, i) =>
    `--- Pair ${i + 1} ---\n[A: ID:${p.a.id}] tags=[${p.a.tags.join(',')}]\n${p.a.content}\n\n[B: ID:${p.b.id}] tags=[${p.b.tags.join(',')}]\n${p.b.content}`
  ).join('\n\n');

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Check these ${pairs.length} memory pairs for contradictions:\n\n${items}` },
  ];
}

/**
 * @param {string} text
 * @returns {Array<{action: 'contradiction'|'no_contradiction', keepId?: number, removeId?: number, updatedContent?: string}>}
 */
export function parseContradictionResponse(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const cMatch = trimmed.match(/^CONTRADICTION\s+(\d+)\s+(\d+)\s*\|\s*(.+)/i);
    if (cMatch) {
      results.push({
        action: 'contradiction',
        keepId: parseInt(cMatch[1], 10),
        removeId: parseInt(cMatch[2], 10),
        updatedContent: cMatch[3].trim(),
      });
      continue;
    }
    if (trimmed.toUpperCase().startsWith('NO_CONTRADICTION')) {
      results.push({ action: 'no_contradiction' });
    }
  }
  return results;
}

// ---- Step 3: Skill Review ----

/**
 * Build prompt to review skills against recent memory operations.
 * @param {Array<{id: number, content: string, tags: string[]}>} recentMemories
 * @param {Array<{id: number, content: string, tags: string[]}>} existingSkills
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildSkillReviewPrompt(recentMemories, existingSkills, agentName) {
  const systemPrompt = `You are a skill maintenance assistant for AI agent "${agentName}".

Review the recent memories and existing skills below. Determine:
1. NEW_SKILL: A repeated pattern in recent memories that should become a skill
2. UPDATE: An existing skill whose description needs updating based on recent evidence
3. OBSOLETE: An existing skill that contradicts recent behavior or was explicitly rejected

## Output format (one per line, strict)
NEW_SKILL [tags:tag1,tag2] <skill description>
UPDATE <skillId> | <updated description>
OBSOLETE <skillId>

If no changes needed, output:
NO_CHANGES`;

  let items = '';
  if (recentMemories.length > 0) {
    items += '[Recent Memories]\n' + recentMemories.map(m =>
      `[ID:${m.id}] tags=[${m.tags.join(',')}] ${m.content}`
    ).join('\n') + '\n\n';
  }
  if (existingSkills.length > 0) {
    items += '[Existing Skills]\n' + existingSkills.map(s =>
      `[ID:${s.id}] tags=[${s.tags.join(',')}] ${s.content}`
    ).join('\n');
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Review skills:\n\n${items}` },
  ];
}

/**
 * @param {string} text
 * @returns {Array<{action: 'new_skill'|'update'|'obsolete', id?: number, content?: string, newContent?: string, tags?: string[]}>}
 */
export function parseSkillReviewResponse(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    // NEW_SKILL [tags:tag1,tag2] description
    const newMatch = trimmed.match(/^NEW_SKILL\s+\[tags:([^\]]*)\]\s+(.+)/i);
    if (newMatch) {
      const tags = newMatch[1].split(',').map(t => t.trim()).filter(Boolean);
      results.push({ action: 'new_skill', content: newMatch[2].trim(), tags });
      continue;
    }

    // UPDATE <id> | <new content>
    const updateMatch = trimmed.match(/^UPDATE\s+(\d+)\s*\|\s*(.+)/i);
    if (updateMatch) {
      results.push({ action: 'update', id: parseInt(updateMatch[1], 10), newContent: updateMatch[2].trim() });
      continue;
    }

    // OBSOLETE <id>
    const obsoleteMatch = trimmed.match(/^OBSOLETE\s+(\d+)/i);
    if (obsoleteMatch) {
      results.push({ action: 'obsolete', id: parseInt(obsoleteMatch[1], 10) });
    }
  }
  return results;
}

// ---- Step 4: Cleanup Review ----

/**
 * Build prompt to review borderline memories and orphan tags.
 * @param {Array<{id: number, content: string, decay_score: number, tags: string[]}>} borderlineMemories
 * @param {string[]} orphanTags
 * @param {string} agentName
 * @returns {Array<{role: string, content: string}>}
 */
export function buildCleanupReviewPrompt(borderlineMemories, orphanTags, agentName) {
  const systemPrompt = `You are a memory cleanup assistant for AI agent "${agentName}".

Review borderline memories (low decay score, rarely accessed) and orphan tags (tags with no associated memories).

For memories: decide KEEP (still valuable) or PRUNE (safe to remove).
For tags: decide KEEP_TAG (may be useful for future tagging) or DELETE_TAG (no longer relevant).

## Output format (one per line, strict)
KEEP <id>
PRUNE <id>
KEEP_TAG <tagName>
DELETE_TAG <tagName>`;

  let items = '';
  if (borderlineMemories.length > 0) {
    items += '[Borderline Memories]\n' + borderlineMemories.map(m =>
      `[ID:${m.id}] decay=${m.decay_score?.toFixed(3)} tags=[${(m.tags || []).join(',')}]\n${m.content}`
    ).join('\n\n') + '\n\n';
  }
  if (orphanTags.length > 0) {
    items += '[Orphan Tags (no memories)]\n' + orphanTags.join(', ');
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Review for cleanup:\n\n${items}` },
  ];
}

/**
 * @param {string} text
 * @returns {Array<{action: 'keep'|'prune'|'keep_tag'|'delete_tag', id?: number, tagName?: string}>}
 */
export function parseCleanupReviewResponse(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    const keepMatch = trimmed.match(/^KEEP\s+(\d+)/i);
    if (keepMatch) {
      results.push({ action: 'keep', id: parseInt(keepMatch[1], 10) });
      continue;
    }

    const pruneMatch = trimmed.match(/^PRUNE\s+(\d+)/i);
    if (pruneMatch) {
      results.push({ action: 'prune', id: parseInt(pruneMatch[1], 10) });
      continue;
    }

    const keepTagMatch = trimmed.match(/^KEEP_TAG\s+(\S+)/i);
    if (keepTagMatch) {
      results.push({ action: 'keep_tag', tagName: keepTagMatch[1] });
      continue;
    }

    const deleteTagMatch = trimmed.match(/^DELETE_TAG\s+(\S+)/i);
    if (deleteTagMatch) {
      results.push({ action: 'delete_tag', tagName: deleteTagMatch[1] });
    }
  }
  return results;
}
