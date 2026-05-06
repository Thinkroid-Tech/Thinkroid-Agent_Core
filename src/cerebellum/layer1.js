/**
 * Cerebellum Layer 1 — extraction → dedup check → layer determination → write.
 *
 * Design constraints:
 *   DL-15: L1 does extraction + pre-write dedup ONLY. No merge, no probabilistic sweep.
 *   DL-16: Cursor advancement is all-or-nothing per session. Cursor update is inside
 *           memory.lock.withLock(), after all writes succeed. Any throw skips both.
 *   Lock scope: withLock wraps ONLY write + cursor-advance. Extraction and dedup LLM
 *               calls happen OUTSIDE the lock.
 *   Error isolation: per-session try/catch — one session's failure must not affect others.
 */

import { buildExtractionPrompt, parseExtractionResponse } from './extraction-prompt.js';
import { buildDedupPrompt, parseDedupResponse } from './dedup-prompt.js';
import { determineLayer } from './layer-heuristic.js';
import { similarityScore, SIMILARITY_THRESHOLD, MAX_DEDUP_CANDIDATES } from './similarity.js';

export class CerebellumL1 {
  /**
   * @param {Object} deps
   * @param {string} deps.agentId
   * @param {string} [deps.agentName]
   * @param {import('../../modules/thinkroid-memory/src/client.js').ThinkroidMemory} deps.memory
   * @param {import('../stores/agent-core-db/session-meta-store.js').SessionMetaStore} deps.metaStore
   * @param {import('../stores/agent-core-db/session-history-store.js').SessionHistoryStore} deps.historyStore
   * @param {Function} deps.cerebellumChannel - callCerebellum({ agentName, messages, maxTokens }) => Promise<string>
   */
  constructor({ agentId, agentName, memory, metaStore, historyStore, cerebellumChannel }) {
    this.agentId = agentId;
    this.agentName = agentName || agentId;
    this.memory = memory;
    this.metaStore = metaStore;
    this.historyStore = historyStore;
    this.channel = cerebellumChannel;
  }

  /**
   * Process all eligible (non-archived) sessions for this agent.
   * Per-session error boundary: one session's failure does not affect others (DL-16).
   */
  async tick() {
    const sessions = this.metaStore.list({ agentId: this.agentId });
    const eligible = sessions.filter(s =>
      s.status === 'awake' || s.status === 'drowsy' || s.status === 'dormant'
    );

    for (const session of eligible) {
      try {
        await this._processSession(session);
      } catch (err) {
        console.error(
          `[CerebellumL1:${this.agentName}] Error processing session ${session.session_id}:`,
          err.message,
        );
        // Continue to next session — error isolation per DL-16
      }
    }
  }

  /**
   * Process a single session: extract → dedup → write → advance cursor.
   * DL-16: cursor advancement is all-or-nothing — both writes and cursor update happen
   *        inside memory.lock.withLock().
   * @param {import('../types/session-meta.js').SessionMeta} session
   */
  async _processSession(session) {
    const sessionId = session.session_id;
    const cursor = session.cerebellum_l1_cursor || 0;
    const length = this.historyStore.length(sessionId);

    if (length <= cursor) return; // no new turns to process

    // Read new turns since cursor
    const newTurns = this.historyStore.readRange({
      sessionId,
      startIndex: cursor,
      endIndex: length - 1,
    });

    if (newTurns.length === 0) return;

    // --- Step 1: Extract (OUTSIDE lock) ---
    // One LLM call per session — batches all new turns together
    let proposals;
    try {
      const promptMessages = buildExtractionPrompt(
        newTurns.map(t => ({ role: t.role, content: t.content || '' })),
        this.agentName,
      );
      const responseText = await this._callWithRetry(promptMessages);
      proposals = parseExtractionResponse(responseText);
    } catch (err) {
      console.warn(
        `[CerebellumL1:${this.agentName}] Extraction failed for session ${sessionId}, skipping:`,
        err.message,
      );
      // Conservative: 0 proposals on LLM failure. Cursor still advances (no writes = safe).
      proposals = [];
    }

    if (proposals.length === 0) {
      // 0 proposals → 0 writes — safe to advance cursor per DL-16
      await this.memory.lock.withLock(() => {
        this.metaStore.update(sessionId, { cerebellum_l1_cursor: length }, 'ce');
      });
      return;
    }

    // --- Step 2: Dedup check each proposal (OUTSIDE lock) ---
    const l1ViewForSearch = this.memory.viewForCerebellumL1();
    const survivors = [];
    for (const proposal of proposals) {
      const isDup = await this._dedupCheck(proposal, l1ViewForSearch);
      if (!isDup) {
        survivors.push(proposal);
      }
    }

    // --- Step 3: Write survivors + advance cursor (INSIDE lock, all-or-nothing per DL-16) ---
    await this.memory.lock.withLock(() => {
      const l1View = this.memory.viewForCerebellumL1();
      for (const s of survivors) {
        const layer = determineLayer(s);
        l1View.write({
          content: s.content,
          layer,
          tags: s.tags,
          source_session: sessionId,
          source_timestamp: Date.now(),
          confidence: s.importance >= 0.8 ? 'high' : s.importance >= 0.6 ? 'medium' : 'low',
        });
      }
      // Cursor always advances after this block (whether survivors > 0 or all were duplicates)
      this.metaStore.update(sessionId, { cerebellum_l1_cursor: length }, 'ce');
    });
  }

  /**
   * Call cerebellum channel with one retry on failure.
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  async _callWithRetry(messages) {
    // Phase 13 I5.10: cerebellum channel entry is keyed by agents.id
    // UUID. agentName still travels as display metadata for log labels.
    try {
      return await this.channel({
        agentId: this.agentId,
        agentName: this.agentName,
        messages,
        maxTokens: 2048,
      });
    } catch (firstErr) {
      console.warn(
        `[CerebellumL1:${this.agentName}] LLM call failed, retrying:`,
        firstErr.message,
      );
      // If second call also fails, the error propagates to _processSession catch
      return await this.channel({
        agentId: this.agentId,
        agentName: this.agentName,
        messages,
        maxTokens: 2048,
      });
    }
  }

  /**
   * Dedup check: keyword pre-filter first, then LLM only if pre-filter hits.
   * @param {{ content: string, tags: string[] }} proposal
   * @param {import('../../modules/thinkroid-memory/src/views.js').CerebellumL1View} l1View
   * @returns {Promise<boolean>} true if proposal is a duplicate (should be skipped)
   */
  async _dedupCheck(proposal, l1View) {
    // Keyword pre-filter: search existing memories using first few content words
    const searchKw = proposal.content.split(/\s+/).slice(0, 3).join(' ');
    const candidates = l1View.search({ kw: searchKw, limit: 20 });
    if (candidates.length === 0) return false; // nothing to compare against

    // Score candidates by keyword similarity
    const scored = candidates
      .map(c => ({
        ...c,
        score: similarityScore(proposal.content, proposal.tags, c),
      }))
      .filter(c => c.score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_DEDUP_CANDIDATES);

    if (scored.length === 0) return false; // no candidates above threshold

    // LLM dedup check for high-similarity candidates
    try {
      const promptMessages = buildDedupPrompt(
        proposal.content,
        scored.map(c => ({ id: c.id, content: c.content })),
      );
      const responseText = await this.channel({
        agentId: this.agentId,
        agentName: this.agentName,
        messages: promptMessages,
        maxTokens: 256,
      });
      const result = parseDedupResponse(responseText);
      return result.isDuplicate;
    } catch (err) {
      // LLM error → treat as duplicate (conservative: skip rather than write duplicate)
      console.warn(
        `[CerebellumL1:${this.agentName}] Dedup LLM failed, treating proposal as duplicate:`,
        err.message,
      );
      return true;
    }
  }
}
