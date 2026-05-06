/**
 * Keyword-based similarity scoring for Cerebellum L1 dedup pre-filter.
 * Formula from design doc: finalScore = keywordHits × (1 + 0.3 × decay_score)
 */

/**
 * Extract keywords from text for similarity matching.
 * Splits on whitespace/punctuation, lowercases, filters words shorter than 3 chars.
 * @param {string} text
 * @returns {string[]}
 */
export function extractKeywords(text) {
  return text
    .toLowerCase()
    .split(/[\s,.:;!?()\[\]{}"'`\-_/\\]+/)
    .filter(w => w.length >= 3);
}

/**
 * Calculate keyword similarity score between a proposal and existing memory.
 * Formula: finalScore = keywordHits × (1 + 0.3 × decay_score)
 *
 * @param {string} proposalContent
 * @param {string[]} proposalTags
 * @param {{ content: string, tags: string[], decay_score: number }} existing
 * @returns {number}
 */
export function similarityScore(proposalContent, proposalTags, existing) {
  const proposalKw = new Set([
    ...extractKeywords(proposalContent),
    ...proposalTags.map(t => t.toLowerCase()),
  ]);
  const existingKw = new Set([
    ...extractKeywords(existing.content),
    ...(existing.tags || []).map(t => t.toLowerCase()),
  ]);

  let hits = 0;
  for (const kw of proposalKw) {
    if (existingKw.has(kw)) hits++;
  }

  return hits * (1 + 0.3 * (existing.decay_score ?? 1.0));
}

/** Similarity threshold — candidates scoring above this go to LLM dedup. */
export const SIMILARITY_THRESHOLD = 2.0;

/** Max candidates to pass to LLM for dedup check. */
export const MAX_DEDUP_CANDIDATES = 5;
