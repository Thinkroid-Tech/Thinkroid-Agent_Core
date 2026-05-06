/**
 * Layer determination heuristic for Cerebellum L1.
 *
 * Rules trace back to:
 *   - 老代码挖掘.md §3 lines 51-52: major events → long; recurring workflows → short_skill
 *   - 顶层设计 4.6 lines 897-913: user personal info / explicit remember → long
 *   - DL-15: long_skill NEVER produced by L1 (L2 promotion only)
 */

/**
 * Determine final layer for an extracted memory proposal.
 * The extraction LLM already suggests a layer — this function validates and overrides
 * based on design-doc rules.
 *
 * @param {{ layer: string, content: string, tags: string[], importance: number }} proposal
 * @returns {'short'|'long'|'short_skill'} Final layer — never 'long_skill' (DL-15)
 */
export function determineLayer(proposal) {
  const { layer, content, tags } = proposal;
  const lc = content.toLowerCase();
  const tagSet = new Set(tags.map(t => t.toLowerCase()));

  // Rule: long_skill never produced by L1 (DL-15 — L2 promotion only)
  if (layer === 'long_skill') return 'short_skill';

  // Rule: user personal info → long (顶层设计 L905)
  if (tagSet.has('user-info') || tagSet.has('personal') || tagSet.has('preference')) {
    return 'long';
  }

  // Rule: user explicit "remember" → long (顶层设计 L906)
  if (lc.includes('remember') && lc.includes('user')) {
    return 'long';
  }

  // Rule: workflow/process patterns → short_skill (老代码挖掘 §3 L52)
  if (tagSet.has('workflow') || tagSet.has('process') || tagSet.has('procedure')) {
    return 'short_skill';
  }

  // Accept LLM's suggestion if it's a valid L1 layer
  if (layer === 'short' || layer === 'long' || layer === 'short_skill') {
    return layer;
  }

  // Fallback: short (safe default — better to over-remember than under-remember)
  return 'short';
}
