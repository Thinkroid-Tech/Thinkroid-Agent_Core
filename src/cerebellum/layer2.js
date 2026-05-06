/**
 * Cerebellum Layer 2 — Per-Session Summarization + Housekeeping Tick.
 *
 * Phase 1 (DL-49, runs first): LLM summarization of Dormant sessions
 *   - Iterates ALL Dormant sessions where cursor < history length (DL-47)
 *   - Summarizes, extracts memories/skills, writes to Memory, advances cursor
 *
 * Phase 2 (existing): SQL-only housekeeping
 *   - Only runs when eligible sessions have gap >= 100 AND interval >= 4h
 *   - recomputeDecayScores → promote → prune → detectLoops
 *
 * After: update last_l2_at for ALL sessions of this agent.
 */

import { buildSummarizationPrompt, parseSummarizationResponse } from './summarization-prompt.js';
import { getSummaryLevelsToRun, getSummaryPeriod } from './summary-schedule.js';
import { buildAggregationPrompt, parseAggregationResponse } from './summary-aggregation-prompt.js';
import {
  buildPromotionPrompt, parsePromotionResponse,
  buildDedupBatchPrompt, parseDedupBatchResponse,
  buildContradictionPrompt, parseContradictionResponse,
  buildSkillReviewPrompt, parseSkillReviewResponse,
  buildCleanupReviewPrompt, parseCleanupReviewResponse,
} from './housekeeping-prompts.js';

/** Minimum unprocessed turns required to trigger Phase 2 housekeeping. */
const L2_TRIGGER_TURN_GAP = 100;

/** Minimum milliseconds between L2 runs per agent. */
const L2_TRIGGER_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Decay score below which memories are pruned. */
const PRUNE_THRESHOLD = 0.1;

/** Max turns per LLM batch for summarization (§4.3 line 713-714). */
const MAX_TURNS_PER_BATCH = 100;

export class CerebellumL2 {
  /**
   * @param {Object} options
   * @param {string} options.agentId
   * @param {string} [options.agentName]
   * @param {import('../../modules/thinkroid-memory/src/client.js').ThinkroidMemory} options.memory
   * @param {import('../stores/agent-core-db/session-meta-store.js').SessionMetaStore} options.metaStore
   * @param {import('../stores/agent-core-db/session-history-store.js').SessionHistoryStore} options.historyStore
   * @param {Function} options.cerebellumChannel - callCerebellum({ agentName, messages, maxTokens }) => Promise<string>
   */
  constructor({ agentId, agentName, memory, metaStore, historyStore, cerebellumChannel,
                pruneThreshold, promotionThresholds }) {
    if (!agentId) throw new Error('CerebellumL2 requires agentId');
    if (!memory)  throw new Error('CerebellumL2 requires memory');
    if (!metaStore) throw new Error('CerebellumL2 requires metaStore');
    if (!historyStore) throw new Error('CerebellumL2 requires historyStore');
    if (!cerebellumChannel) throw new Error('CerebellumL2 requires cerebellumChannel');

    this.agentId     = agentId;
    this.agentName   = agentName ?? agentId;
    this.memory      = memory;
    this.metaStore   = metaStore;
    this.historyStore = historyStore;
    this.channel     = cerebellumChannel;
    this._pruneThreshold = typeof pruneThreshold === 'number' ? pruneThreshold : PRUNE_THRESHOLD;
    this._promotionThresholds = promotionThresholds || null;
  }

  /**
   * Run one L2 cycle: Phase 1 (summarization) + Phase 2 (housekeeping).
   * Errors are caught and logged — callers should not expect throws.
   */
  async tick() {
    try {
      await this._runTick();
    } catch (err) {
      console.error(`[CerebellumL2] ${this.agentId}:`, err.message);
    }
  }

  async _runTick() {
    const now = Date.now();
    const allSessions = this.metaStore.list({ agentId: this.agentId });

    // ---- Phase 1: Per-session summarization (DL-49: runs first) ----
    // Eligible: ALL Dormant sessions with cursor < history length (DL-47)
    const dormantSessions = allSessions.filter(s => s.status === 'dormant');
    for (const session of dormantSessions) {
      try {
        await this._summarizeSession(session);
      } catch (err) {
        console.error(
          `[CerebellumL2:${this.agentName}] Summarization failed for ${session.session_id}:`,
          err.message,
        );
        // Per-session error isolation — continue to next
      }
    }

    // ---- Phase 2: SQL housekeeping (existing trigger conditions) ----
    const eligible = allSessions.filter(s => {
      if (s.status !== 'dormant') return false;
      if (s.turn_count - s.cerebellum_l2_cursor < L2_TRIGGER_TURN_GAP) return false;
      if (s.last_l2_at !== null && s.last_l2_at !== undefined &&
          now - s.last_l2_at < L2_TRIGGER_MIN_INTERVAL_MS) return false;
      return true;
    });

    if (eligible.length > 0) {
      // Step 1: Multi-level summaries (§4.3 line 720-729)
      try {
        await this._runMultiLevelSummaries();
      } catch (err) {
        console.error(`[CerebellumL2:${this.agentName}] Multi-level summaries failed:`, err.message);
      }

      // TODO: Phase 8+ move LLM calls outside lock, hold lock only for writes (L1 pattern)
      await this.memory.lock.withLock(async () => {
        const l2View = this.memory.viewForCerebellumL2();

        // Step 2: Memory organization (promote → dedup → contradiction)
        try {
          await this._step2MemoryOrganization(l2View);
        } catch (err) {
          console.error(`[CerebellumL2:${this.agentName}] Step 2 failed:`, err.message);
        }

        // Step 3: Skill maintenance
        try {
          await this._step3SkillMaintenance(l2View);
        } catch (err) {
          console.error(`[CerebellumL2:${this.agentName}] Step 3 failed:`, err.message);
        }

        // Step 4: Cleanup (must be last — Steps 2-3 may change entries/tags)
        try {
          await this._step4Cleanup(l2View);
        } catch (err) {
          console.error(`[CerebellumL2:${this.agentName}] Step 4 failed:`, err.message);
        }
      });

      // Update last_l2_at for ALL sessions of this agent
      const updatedAt = Date.now();
      const refreshed = this.metaStore.list({ agentId: this.agentId });
      for (const s of refreshed) {
        this.metaStore.update(s.session_id, { last_l2_at: updatedAt }, 'cerebellum');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Per-session summarization (§4.3 L2 Phase 1, line 703-715)
  // ---------------------------------------------------------------------------

  /**
   * Summarize a single Dormant session: LLM call → extract memories/skills → write → advance cursor.
   * DL-47: uses existing cerebellum_l2_cursor to track per-session progress.
   */
  async _summarizeSession(session) {
    const sessionId = session.session_id;
    const cursor = session.cerebellum_l2_cursor || 0;
    const length = this.historyStore.length(sessionId);

    // DL-47: cursor >= length means already processed
    if (length <= cursor) return;

    // Read session history from cursor to end
    const turns = this.historyStore.readRange({
      sessionId,
      startIndex: cursor,
      endIndex: length - 1,
    });
    if (turns.length === 0) return;

    // Process in batches (§4.3 line 713-714: later batches carry prior summary)
    let allMemories = [];
    let allSkills = [];
    let lastSummary = '';

    for (let i = 0; i < turns.length; i += MAX_TURNS_PER_BATCH) {
      const batch = turns.slice(i, i + MAX_TURNS_PER_BATCH);
      const promptTurns = batch.map(t => ({ role: t.role, content: t.content || '' }));

      const messages = buildSummarizationPrompt(promptTurns, this.agentName, lastSummary);
      const responseText = await this._callWithRetry(messages);
      const { summary, memories, skills } = parseSummarizationResponse(responseText);

      lastSummary = summary;
      allMemories.push(...memories);
      allSkills.push(...skills);
    }

    // Persist session summary to meta for daily aggregation (P7-B1)
    if (lastSummary) {
      this.metaStore.update(sessionId, { summary: lastSummary }, 'cerebellum');
    }

    // Dedup against existing Memory before writing
    const combined = [...allMemories, ...allSkills];
    const survivors = this._dedupProposals(combined);

    // Write survivors + advance cursor inside lock
    await this.memory.lock.withLock(() => {
      // Use L1View with 'cerebellum-l2' writer (already whitelisted in changed_by CHECK)
      const l1View = this.memory.viewForCerebellumL1({ writer: 'cerebellum-l2' });
      for (const s of survivors) {
        l1View.write({
          content: s.content,
          layer: s.layer,
          tags: s.tags,
          source_session: sessionId,
          source_timestamp: Date.now(),
          confidence: s.importance >= 0.8 ? 'high' : s.importance >= 0.6 ? 'medium' : 'low',
        });
      }
      // DL-47: advance per-session cursor
      this.metaStore.update(sessionId, { cerebellum_l2_cursor: length }, 'cerebellum');
    });
  }

  /**
   * Call cerebellum channel with one retry on failure (same as L1 pattern).
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
        `[CerebellumL2:${this.agentName}] LLM call failed, retrying:`,
        firstErr.message,
      );
      return await this.channel({
        agentId: this.agentId,
        agentName: this.agentName,
        messages,
        maxTokens: 2048,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1: Multi-level summaries (§4.3 L2 Phase 2 Step 1, line 720-729)
  // ---------------------------------------------------------------------------

  /**
   * Run multi-level summary aggregation for all due levels.
   */
  async _runMultiLevelSummaries() {
    const l2View = this.memory.viewForCerebellumL2();

    // Determine which levels need running
    const latestByLevel = {};
    for (const level of ['daily', 'weekly', 'monthly', 'quarterly', 'yearly']) {
      const latest = l2View.latestSummary({ level });
      latestByLevel[level] = latest?.period_end ?? null;
    }

    const now = Date.now();
    const levelsToRun = getSummaryLevelsToRun(latestByLevel, now);

    for (const level of levelsToRun) {
      try {
        await this._aggregateSummary(level, l2View, now);
      } catch (err) {
        console.error(`[CerebellumL2:${this.agentName}] ${level} summary failed:`, err.message);
        // Per-level error isolation — continue to next level
      }
    }
  }

  /**
   * Aggregate summaries for a single level.
   */
  async _aggregateSummary(level, l2View, now) {
    const { sourceLevel, periodStart, periodEnd } = getSummaryPeriod(level, now);

    let sourceSummaries;
    if (level === 'daily') {
      // Daily aggregates per-session summaries from today's dormant sessions
      const sessions = this.metaStore.list({ agentId: this.agentId });
      const todaySessions = sessions.filter(s =>
        s.status === 'dormant' && s.last_active_at >= periodStart && s.last_active_at < periodEnd
      );
      sourceSummaries = todaySessions.map(s => s.summary).filter(Boolean);
    } else {
      // Higher levels aggregate the level below
      const sources = l2View.findSummaries({ level: sourceLevel, periodStart, periodEnd });
      sourceSummaries = sources.map(s => s.content).filter(Boolean);
    }

    if (sourceSummaries.length === 0) return; // Nothing to aggregate

    // LLM aggregation
    const messages = buildAggregationPrompt(level, sourceSummaries, this.agentName);
    const responseText = await this._callWithRetry(messages);
    const content = parseAggregationResponse(responseText);

    if (!content) return;

    // Write summary inside lock
    await this.memory.lock.withLock(() => {
      l2View.writeSummary({ level, periodStart, periodEnd, content, sourceIds: [] });
    });
  }

  /**
   * Keyword-based dedup against existing Memory (no LLM call — fast path for L2).
   * Returns proposals that do NOT match existing memories.
   */
  _dedupProposals(proposals) {
    if (proposals.length === 0) return [];
    const l1View = this.memory.viewForCerebellumL1();
    const survivors = [];

    for (const p of proposals) {
      const searchKw = p.content.split(/\s+/).slice(0, 5).join(' ');
      const candidates = l1View.search({ kw: searchKw, limit: 10 });

      if (candidates.length === 0) {
        survivors.push(p);
        continue;
      }

      // Check keyword overlap with each candidate
      const isDup = candidates.some(c => {
        const pWords = new Set(p.content.toLowerCase().split(/\s+/));
        const cWords = new Set(c.content.toLowerCase().split(/\s+/));
        const overlap = [...pWords].filter(w => cWords.has(w)).length;
        const maxLen = Math.max(pWords.size, cWords.size);
        return maxLen > 0 && (overlap / maxLen) > 0.8;
      });

      if (!isDup) survivors.push(p);
    }

    return survivors;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Memory organization (§4.3 line 731-736)
  // Order: promote → dedup → contradiction (promote first → then dedup → then contradiction → then merge)
  // ---------------------------------------------------------------------------

  async _step2MemoryOrganization(l2View) {
    // a. Recompute decay scores (unchanged SQL baseline)
    l2View.recomputeDecayScores();

    // b. LLM-enhanced promotion (falls back to SQL-only promote if LLM unavailable)
    for (const layer of ['short', 'short_skill']) {
      const candidates = l2View.findPromotable({
        layer,
        threshold: this._promotionThresholds?.[layer],
      });
      if (candidates.length === 0) continue;

      // If l2View supports full content reads, attempt LLM evaluation
      if (typeof l2View.read === 'function') {
        const withContent = candidates.map(c => {
          const mem = l2View.read(c.id);
          return mem ? { ...c, content: mem.content, access_count: mem.access_count, tags: mem.tags } : null;
        }).filter(Boolean);

        if (withContent.length > 0) {
          try {
            const messages = buildPromotionPrompt(withContent, this.agentName);
            const response = await this._callWithRetry(messages);
            const decisions = parsePromotionResponse(response);
            for (const d of decisions) {
              if (d.action === 'promote') {
                const candidate = candidates.find(c => c.id === d.id);
                if (candidate) l2View.promote({ id: d.id, newLayer: candidate.newLayer });
              }
            }
            continue; // LLM handled this layer — skip SQL fallback
          } catch (err) {
            console.warn(`[CerebellumL2:${this.agentName}] LLM promotion failed for ${layer}, falling back to SQL:`, err.message);
          }
        }
      }

      // SQL-only fallback: promote all SQL-eligible candidates unconditionally
      for (const { id, newLayer } of candidates) {
        l2View.promote({ id, newLayer });
      }
    }

    // c. Cross-layer dedup (requires l2View.recent — skip if not available)
    if (typeof l2View.recent !== 'function') return;

    const recentShort = l2View.recent({ layer: 'short', limit: 25 });
    const recentLong = l2View.recent({ layer: 'long', limit: 25 });
    const allRecent = [...recentShort, ...recentLong];

    const dedupPairs = this._findDedupCandidates(allRecent);
    if (dedupPairs.length > 0) {
      const messages = buildDedupBatchPrompt(dedupPairs, this.agentName);
      const response = await this._callWithRetry(messages);
      const decisions = parseDedupBatchResponse(response);

      for (const d of decisions) {
        if (d.action === 'duplicate') {
          try {
            l2View.merge({ sourceId: d.mergeId, targetId: d.keepId });
          } catch (err) {
            console.warn(`[CerebellumL2:${this.agentName}] Merge failed for ${d.mergeId}→${d.keepId}:`, err.message);
          }
        }
      }
    }

    // d. Contradiction detection
    if (dedupPairs.length > 0) {
      const messages = buildContradictionPrompt(dedupPairs, this.agentName);
      const response = await this._callWithRetry(messages);
      const decisions = parseContradictionResponse(response);

      for (const d of decisions) {
        if (d.action === 'contradiction') {
          try {
            l2View.update({ id: d.keepId, patch: { content: d.updatedContent } });
            l2View.delete({ id: d.removeId });
          } catch (err) {
            console.warn(`[CerebellumL2:${this.agentName}] Contradiction resolution failed:`, err.message);
          }
        }
      }
    }
  }

  /**
   * Find memory pairs with high keyword overlap (>50%) for dedup/contradiction review.
   * Capped at 10 pairs per tick to limit LLM cost.
   */
  _findDedupCandidates(memories) {
    const pairs = [];
    for (let i = 0; i < memories.length && pairs.length < 10; i++) {
      for (let j = i + 1; j < memories.length && pairs.length < 10; j++) {
        const a = memories[i], b = memories[j];
        const aWords = new Set(a.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        const bWords = new Set(b.content.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        if (aWords.size === 0 || bWords.size === 0) continue;
        const overlap = [...aWords].filter(w => bWords.has(w)).length;
        const maxLen = Math.max(aWords.size, bWords.size);
        if ((overlap / maxLen) > 0.5) {
          pairs.push({ a, b });
        }
      }
    }
    return pairs;
  }

  // ---------------------------------------------------------------------------
  // Step 3: Skill maintenance (§4.3 line 738-740)
  // ---------------------------------------------------------------------------

  async _step3SkillMaintenance(l2View) {
    // Requires l2View.recent — skip if not available (e.g. lightweight mock views)
    if (typeof l2View.recent !== 'function') return;

    const shortSkills = l2View.recent({ layer: 'short_skill', limit: 20 });
    const longSkills = l2View.recent({ layer: 'long_skill', limit: 20 });
    const existingSkills = [...shortSkills, ...longSkills];

    const recentMemories = l2View.recent({ layer: 'short', limit: 30 });

    if (recentMemories.length === 0 && existingSkills.length === 0) return;

    const messages = buildSkillReviewPrompt(recentMemories, existingSkills, this.agentName);
    const response = await this._callWithRetry(messages);
    const decisions = parseSkillReviewResponse(response);

    for (const d of decisions) {
      try {
        if (d.action === 'new_skill') {
          l2View.write({
            content: d.content,
            layer: 'short_skill',
            tags: d.tags || [],
            source_session: 'l2-skill-maintenance',
            source_timestamp: Date.now(),
            confidence: 'high',
          });
        } else if (d.action === 'update' && d.id) {
          l2View.update({ id: d.id, patch: { content: d.newContent } });
        } else if (d.action === 'obsolete' && d.id) {
          l2View.delete({ id: d.id });
        }
      } catch (err) {
        console.warn(`[CerebellumL2:${this.agentName}] Skill action ${d.action} failed:`, err.message);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Step 4: Cleanup (§4.3 line 742-746, must be last)
  // ---------------------------------------------------------------------------

  async _step4Cleanup(l2View) {
    // a. Find borderline memories (decay 0.1-0.3) for LLM review
    const borderline = this._findBorderlineMemories(l2View);

    // b. Find orphan tags
    const orphanTags = this._findOrphanTags(l2View);

    // c. LLM review (only if there's something to review)
    if (borderline.length > 0 || orphanTags.length > 0) {
      const messages = buildCleanupReviewPrompt(borderline, orphanTags, this.agentName);
      const response = await this._callWithRetry(messages);
      const decisions = parseCleanupReviewResponse(response);

      for (const d of decisions) {
        try {
          if (d.action === 'prune' && d.id) {
            l2View.delete({ id: d.id });
          } else if (d.action === 'delete_tag' && d.tagName) {
            const tag = l2View._db.prepare('SELECT id FROM tags WHERE name = ?').get(d.tagName);
            if (tag) {
              l2View._db.prepare(
                "DELETE FROM edges WHERE (from_type = 'tag' AND from_id = ?) OR (to_type = 'tag' AND to_id = ?)"
              ).run(tag.id, tag.id);
              l2View._db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
            }
          }
        } catch (err) {
          console.warn(`[CerebellumL2:${this.agentName}] Cleanup action ${d.action} failed:`, err.message);
        }
      }
    }

    // d. SQL prune (catches anything below threshold after Steps 2-3 changes)
    l2View.prune({ belowDecayScore: this._pruneThreshold });

    // e. Tag cycle detection
    l2View.detectLoops();
  }

  /**
   * Find memories with borderline decay scores (between PRUNE_THRESHOLD and 0.3).
   * These are candidates for LLM-evaluated pruning.
   * Returns empty array if _db is not available (e.g. lightweight mock views).
   */
  _findBorderlineMemories(l2View) {
    if (!l2View._db) return [];
    const rows = l2View._db.prepare(
      'SELECT id FROM memories WHERE decay_score >= ? AND decay_score < 0.3'
    ).all(this._pruneThreshold);
    if (typeof l2View.read !== 'function') return [];
    return rows.map(r => l2View.read(r.id)).filter(Boolean);
  }

  /**
   * Find tags with zero memory edges (orphan tags).
   * Returns empty array if _db is not available (e.g. lightweight mock views).
   */
  _findOrphanTags(l2View) {
    if (!l2View._db) return [];
    const rows = l2View._db.prepare(`
      SELECT t.name FROM tags t
      WHERE NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.to_type = 'tag' AND e.to_id = t.id AND e.kind = 'tagged_with'
      )
    `).all();
    return rows.map(r => r.name);
  }
}
