/**
 * Context Engine (CE) — Phase 2 implementation.
 *
 * Responsibilities:
 *   - Route incoming Supervisor events to the correct session (Awake vs. new)
 *   - Stage 1: create a new session with assembled Brain Context Payload
 *   - Search Memory (CeAccessView) and apply touchAccess on every context build
 *   - Maintain Session Meta lifecycle fields (CE writes all fields except status)
 *
 * Stages (full design):
 *   1. Create session       ← implemented here
 *   2. Organize / compact   ← Phase 3
 *   3. Extreme compress     ← Phase 4
 *   4. Think deeper         ← Phase 7 (DL-46)
 *   5. Keep-alive           ← Phase 5
 *   6. Linger               ← Phase 5
 */

import crypto from 'crypto';
import { buildInitialPayload, assertBpInvariant } from './context-payload-builder.js';
import { buildZoneBContent } from './zone-b-builder.js';
import { buildCompactionPrompt, parseCompactionVerdict } from './compaction-prompt.js';
import { stage3ExtremeCompress } from './stage3-compress.js';
import { listInternalTools } from '../brain/internal-tools/index.js';
import { ValidationError } from '../../modules/thinkroid-memory/src/errors.js';
// Imported for the views layer — constants drive touchAccess increment logic (Phase 3)
import { ACCESS_COUNT_SELECTED, ACCESS_COUNT_SEEN } from '../stores/constants.js';

const STAGE2_COMPACT_INTERVAL = 4;
const DEFAULT_CONTEXT_WINDOW_SIZE = 200000; // Phase 2 default; production reads from agent config

export class ContextEngine {
  /**
   * @param {Object} deps
   * @param {string} deps.agentId
   * @param {string} [deps.agentName]
   * @param {import('../../modules/thinkroid-memory/src/views.js').CeAccessView} deps.ceAccessView
   * @param {import('../stores/agent-core-db/session-meta-store.js').SessionMetaStore} deps.metaStore
   * @param {import('../stores/agent-core-db/session-history-store.js').SessionHistoryStore} deps.historyStore
   */
  constructor({ agentId, agentName, ceAccessView, metaStore, historyStore, ceChannel, buildSystemPrompt, getToolsForAgent, agentManager }) {
    this.agentId = agentId;
    this.agentName = agentName || agentId;
    this.ceAccessView = ceAccessView;
    this.metaStore = metaStore;
    this.historyStore = historyStore;

    // DL-12: ceChannel is required, not optional
    if (!ceChannel || typeof ceChannel !== 'function') {
      throw new ValidationError('ContextEngine requires ceChannel (callContextEngine function)');
    }
    this.ceChannel = ceChannel;

    // DL-31: buildSystemPrompt is required
    if (!buildSystemPrompt || typeof buildSystemPrompt !== 'function') {
      throw new ValidationError('ContextEngine requires buildSystemPrompt function');
    }
    this.buildSystemPrompt = buildSystemPrompt;

    // DL-31: getToolsForAgent is required
    if (!getToolsForAgent || typeof getToolsForAgent !== 'function') {
      throw new ValidationError('ContextEngine requires getToolsForAgent function');
    }
    this.getToolsForAgent = getToolsForAgent;

    // Phase 11 Tier B §B-7 + Fix B-4: agentManager is the authority for L1
    // personality and is a REQUIRED constructor dependency. No silent fallback
    // — production must inject the real AgentManager; tests must inject a
    // stub that exposes getPersonality(). Missing DI is a programmer error
    // and should fail loudly before any session work begins.
    if (!agentManager || typeof agentManager.getPersonality !== 'function') {
      throw new ValidationError(
        'ContextEngine requires agentManager with a getPersonality(agentName) method'
      );
    }
    this.agentManager = agentManager;

    // DL-13: Global failure counter with probe mode
    this._compactionFailureCount = 0;
    this._compactionPaused = false;
  }

  /**
   * Handle an incoming event routed by Supervisor.
   *
   * Phase 2 routing heuristic (no LLM-based CE decisions yet):
   *   - If an Awake session exists → append to it
   *   - Otherwise → Stage 1: create new session
   *
   * Scene semantics (the set of valid sceneId strings, Zone A rendering, etc.)
   * are a Space-side concern — agent-core only requires a non-empty string.
   *
   * @param {import('../types/event.js').AgentEvent} event
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {{ action: string, session_id: string|null, payload?: Object }}
   */
  async handleEvent(event, { sceneId, dynamicData, contextParams } = {}) {
    if (!sceneId || typeof sceneId !== 'string') {
      throw new ValidationError(
        `handleEvent requires a non-empty sceneId. Got: ${JSON.stringify(sceneId)}`,
      );
    }

    const sessions = this.metaStore.list({ agentId: this.agentId });
    const awake = sessions.find(s => s.status === 'awake');

    // Step 1: Awake session exists → append event to it
    if (awake) {
      // TODO(Phase-9+): topic-relevance check before blindly appending to Awake
      const payload = await this.assemblePayloadForEvent(
        awake.session_id, event, { sceneId, dynamicData, contextParams },
      );
      return { action: 'append_to_session', session_id: awake.session_id, payload };
    }

    // Step 2: No Awake — search Drowsy sessions by tag overlap (DL-43)
    const eventTags = this._extractTags(event);
    const drowsySessions = sessions.filter(s => s.status === 'drowsy');
    const bestDrowsy = this._findBestSessionByTags(drowsySessions, eventTags);
    if (bestDrowsy) {
      const payload = await this.assemblePayloadForEvent(
        bestDrowsy.session_id, event, { sceneId, dynamicData, contextParams },
      );
      return { action: 'switch_session', session_id: bestDrowsy.session_id, payload };
    }

    // Step 3: No Drowsy match — search Dormant sessions by tag overlap (DL-43, §2.7)
    const dormantSessions = sessions.filter(s => s.status === 'dormant');
    const bestDormant = this._findBestSessionByTags(dormantSessions, eventTags);
    if (bestDormant) {
      return this._compressReuseAndCreateSession(bestDormant, event, { sceneId, dynamicData, contextParams });
    }

    // Step 4: No match at all → Stage 1 fresh session
    return this.stage1CreateSession(event, { sceneId, dynamicData, contextParams });
  }

  /**
   * Record a completed Brain turn into session_history + bump turn_count.
   *
   * Called by Supervisor after Brain.think() returns. Keeps all write-path
   * for non-supervisor fields inside CE, matching the store's writer guard
   * (supervisor cannot write turn_count / context_size_pct / last_active_at).
   *
   * Turn granularity (v3 plan §3.5 E-1.3):
   *   One Brain inference cycle = one logical turn, written as TWO rows:
   *     - role='user'      (event content fed into the model)
   *     - role='assistant' (final Brain text; mid-round tool calls are
   *                         consumed by tool-loop and never surface here,
   *                         so we never emit role='tool' rows from this path)
   *   Each row carries its own linear turn_index (no sharing), matching
   *   the UNIQUE(session_id, turn_index) SQL constraint.
   *
   * turn_count is incremented exactly once per Brain inference (not per row),
   * so it stays a reliable signal for Stage 2 cadence (W=4).
   *
   * @param {string} sessionId
   * @param {import('../types/event.js').AgentEvent} event - Same event given to handleEvent
   * @param {string|Object|null} brainResponse - Raw Brain.think() return value
   * @returns {{ turnCount: number, appendedRows: number }}
   */
  recordTurnAfterBrain(sessionId, event, brainResponse) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) return { turnCount: 0, appendedRows: 0 };

    // Brain output normalization (Tier E fix E-1, Tinybear decision "skip"):
    //   - non-empty string (normal case)                  → assistant row + bump turn_count
    //   - { __interrupted | __taskRejected | __taskCompleted, ... }
    //     → user row only, NO assistant row, NO turn_count bump
    //       (only successful inferences count toward Stage 2 cadence)
    //   - null / undefined / empty string                 → same as interrupt (no bump)
    //     (empty '' must go through skip branch too — otherwise the assistant
    //     row is omitted but turn_count would still advance, contradicting the
    //     "only successful Brain inferences count" invariant. Tier E re-audit.)
    const isPlainText = typeof brainResponse === 'string' && brainResponse.length > 0;
    const isInterrupt =
      brainResponse === null ||
      brainResponse === undefined ||
      brainResponse === '' ||
      (typeof brainResponse === 'object' && (
        brainResponse.__interrupted ||
        brainResponse.__taskRejected ||
        brainResponse.__taskCompleted
      ));

    const userMessage = this._extractUserMessage(event);

    let appendedRows = 0;

    // Append user row (only if event carries content).
    // We still record the user row on interrupt so the event shows up in history,
    // but we do not count it as a completed Brain turn.
    if (userMessage && userMessage.length > 0) {
      try {
        this.historyStore.append({
          sessionId,
          role: 'user',
          content: userMessage,
        });
        appendedRows++;
      } catch (err) {
        // Frozen sessions cannot be written — log and continue so meta still bumps
        console.warn(`[CE:${this.agentId}] history.append(user) skipped for ${sessionId}:`, err.message);
      }
    }

    // Append assistant row (only if we got plain text back; tool-call mid-rounds
    // are already absorbed by the tool-loop before Brain returns)
    if (isPlainText) {
      try {
        this.historyStore.append({
          sessionId,
          role: 'assistant',
          content: brainResponse,
        });
        appendedRows++;
      } catch (err) {
        console.warn(`[CE:${this.agentId}] history.append(assistant) skipped for ${sessionId}:`, err.message);
      }
    }

    // Skip bump on interrupt: keep turn_count unchanged, do not refresh
    // context_size_pct (still safe — Stage 2 cadence should only reflect
    // successfully-completed Brain inferences).
    if (isInterrupt) {
      return { turnCount: meta.turn_count || 0, appendedRows };
    }

    // Bump turn_count (+1 per successful Brain inference) and refresh context_size_pct.
    // last_active_at is auto-bumped by SessionMetaStore.update().
    const newTurnCount = (meta.turn_count || 0) + 1;

    // Recompute context_size_pct from current session footprint.
    // Rough proxy: char total of assembled history rows; real token math lives
    // in Stage 2 where full payload is available.
    const historyLength = this.historyStore.length(sessionId);
    const historyRows = historyLength > 0
      ? this.historyStore.readRange({ sessionId, startIndex: 0, endIndex: historyLength - 1 })
      : [];
    const historyChars = historyRows.reduce(
      (sum, t) => sum + (t.content ? t.content.length : 0),
      0,
    );
    const estimatedTokens = Math.ceil(historyChars / 3);
    const contextSizePct = DEFAULT_CONTEXT_WINDOW_SIZE > 0
      ? Math.round((estimatedTokens / DEFAULT_CONTEXT_WINDOW_SIZE) * 100)
      : 0;

    this.metaStore.update(sessionId, {
      turn_count: newTurnCount,
      context_size_pct: contextSizePct,
    }, 'ce');

    return { turnCount: newTurnCount, appendedRows };
  }

  /**
   * CE Stage 1: create a fresh session.
   *
   * Steps:
   *   1. Search Memory (CeAccessView) — Phase 2 always returns []
   *   2. Collect Dormant session summaries for Zone B
   *   3. Build Zone A system prompt
   *   4. Get tool definitions
   *   5. Extract user message from event
   *   6. Assemble Context Payload (Zone A/B/C + 4 BPs)
   *   7. Persist Session Meta
   *   8. Log BP positions for cache observability
   *
   * @param {import('../types/event.js').AgentEvent} event
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {Promise<{ action: 'create_session', session_id: string, payload: import('../types/context-payload.js').ContextPayload }>}
   */
  async stage1CreateSession(event, { sceneId, dynamicData, contextParams } = {}) {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    // Step 1: Search Memory and apply touchAccess
    const { selected: selectedMemories, cooperationMemoryIds } = this._searchAndTouchMemory(event);

    // Step 2: Collect dormant session summaries for Zone B
    const dormantSessions = this.metaStore.list({ agentId: this.agentId, status: 'dormant' });
    const dormantSummaries = dormantSessions
      .filter(s => s.summary)
      .map(s => s.summary);

    // Step 3: Build Zone B content (P5-C)
    const { content: zoneBContentStr } = buildZoneBContent(selectedMemories, dormantSummaries, cooperationMemoryIds);

    // Step 4: Build system prompt (Zone A) and user prompt via injected buildSystemPrompt
    const { system: systemPrompt, user: userPrompt } = await this._buildSystemPrompt(sceneId, dynamicData, contextParams);

    // Step 5: Get tool definitions via injected getToolsForAgent
    const toolDefinitions = this._getToolDefinitions();

    // Step 6: Extract user message — prefer buildSystemPrompt().user (DL-35), fall back to event payload
    const userMessage = userPrompt || this._extractUserMessage(event);

    // Step 6b: Extract chat history from event payload (DL-36)
    const chatHistory = Array.isArray(event?.payload?.chatHistory)
      ? event.payload.chatHistory
      : [];

    // Step 7: Assemble Context Payload
    const payload = buildInitialPayload({
      sessionId,
      systemPrompt,
      toolDefinitions,
      zoneBContent: zoneBContentStr,
      chatHistory,
      userMessage,
    });

    // Step 8: Persist Session Meta
    const initialTags = this._extractTags(event);
    const initialSummary = userMessage.slice(0, 100);

    this.metaStore.create({
      session_id: sessionId,
      parent_session_id: null,
      agent_id: this.agentId,
      summary: initialSummary,
      tags: initialTags,
      status: 'awake',
      turn_count: 0,
      context_size_pct: 0,
      pending_requests: 0,
      keepalive_renewals: 0,
      keepalive_start_time: null,
      linger: false,
      linger_count: 0,
      cerebellum_l1_cursor: 0,
      cerebellum_l2_cursor: 0,
      created_at: now,
      last_active_at: now,
    });

    // Log BP positions for cache observability
    const bpLog = payload.breakpoints.map(bp => `${bp.id}=${bp.position}`).join(', ');
    console.log(`[CE:${this.agentId}] Stage 1 created session ${sessionId}, BPs: ${bpLog}`);

    return { action: 'create_session', session_id: sessionId, payload };
  }

  /**
   * Find the session with the best tag overlap against the given event tags.
   * Non-LLM string set intersection (DL-43).
   * @param {Array<import('../types/session-meta.js').SessionMeta>} sessions
   * @param {string[]} eventTags
   * @returns {import('../types/session-meta.js').SessionMeta|null}
   */
  _findBestSessionByTags(sessions, eventTags) {
    if (!eventTags.length || !sessions.length) return null;
    const eventTagSet = new Set(eventTags);
    let best = null;
    let bestScore = 0;
    for (const session of sessions) {
      const sessionTags = session.tags || [];
      const overlap = sessionTags.filter(t => eventTagSet.has(t)).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = session;
      }
    }
    return best;
  }

  /**
   * Compress-reuse a Dormant session's history and create a new session (§2.7).
   * One-time read + compress, not persisted.
   * @param {import('../types/session-meta.js').SessionMeta} dormantSession
   * @param {import('../types/event.js').AgentEvent} event
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {Promise<{ action: 'create_session', session_id: string, payload: Object }>}
   */
  async _compressReuseAndCreateSession(dormantSession, event, { sceneId, dynamicData, contextParams } = {}) {
    // Read dormant session history in full (§2.7: one-time read allowed)
    const historyLength = this.historyStore.length(dormantSession.session_id);
    let compressedSummary = dormantSession.summary || '';

    if (historyLength > 0) {
      const history = this.historyStore.readRange({
        sessionId: dormantSession.session_id,
        startIndex: 0,
        endIndex: historyLength - 1,
      });
      // Compress history to summary via ceChannel
      const historyText = history.map(t => `${t.role}: ${t.content || ''}`).join('\n');
      try {
        compressedSummary = await this.ceChannel({
          agentId: this.agentId,
          agentName: this.agentName,
          messages: [
            { role: 'system', content: 'Compress the following conversation history into a concise summary (max 500 chars). Preserve key facts, decisions, and context.' },
            { role: 'user', content: historyText },
          ],
          maxTokens: 256,
        });
      } catch (err) {
        console.warn(`[CE:${this.agentId}] Dormant compress-reuse failed, using session summary:`, err.message);
      }
    }

    // Create new session with compressed content as Zone B seed
    return this._createSessionWithSeed(compressedSummary, dormantSession.session_id, event, { sceneId, dynamicData, contextParams });
  }

  /**
   * CE Stage 3: create a new session from compressed content of an old session.
   * Old session transitions to Drowsy (not Dormant — §1.9 line 280).
   * @param {string} oldSessionId
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {Promise<{ action: 'create_session', session_id: string, payload: Object, oldSessionId: string }>}
   */
  async stage3CreateNewSession(oldSessionId, { sceneId, dynamicData, contextParams } = {}) {
    const oldMeta = this.metaStore.get(oldSessionId);
    if (!oldMeta) throw new Error(`Session ${oldSessionId} not found`);

    // Read old session history
    const historyLength = this.historyStore.length(oldSessionId);
    const history = historyLength > 0
      ? this.historyStore.readRange({ sessionId: oldSessionId, startIndex: 0, endIndex: historyLength - 1 })
      : [];

    // Compress history to summary
    let compressedSummary = oldMeta.summary || '';
    if (history.length > 0) {
      const historyMessages = history.map(t => ({ role: t.role, content: t.content || '' }));
      try {
        // Reuse stage3ExtremeCompress for aggressive compression
        const { messages: compressed } = await stage3ExtremeCompress(
          [{ role: 'system', content: 'session context' }, ...historyMessages],
          this.ceChannel, this.agentName, DEFAULT_CONTEXT_WINDOW_SIZE,
        );
        // Extract compressed text (skip system prompt marker)
        compressedSummary = compressed
          .filter(m => m.role !== 'system' || m.content !== 'session context')
          .map(m => m.content)
          .join('\n');
      } catch (err) {
        console.warn(`[CE:${this.agentId}] Stage 3 compress failed, using summary:`, err.message);
      }
    }

    // Create synthetic event for the new session (carry forward the original context)
    const result = await this._createSessionWithSeed(
      compressedSummary, oldSessionId, null, { sceneId, dynamicData, contextParams },
    );

    return { ...result, oldSessionId };
  }

  /**
   * Internal: create a new session with compressed seed content in Zone B.
   * @param {string} compressedSeed - Compressed content from old/dormant session
   * @param {string} parentSessionId - Source session ID for traceability
   * @param {import('../types/event.js').AgentEvent|null} event - Original event (null for Stage 3)
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {Promise<{ action: 'create_session', session_id: string, payload: Object }>}
   */
  async _createSessionWithSeed(compressedSeed, parentSessionId, event, { sceneId, dynamicData, contextParams } = {}) {
    const sessionId = crypto.randomUUID();
    const now = Date.now();

    // Search Memory
    const { selected: selectedMemories, cooperationMemoryIds } = event
      ? this._searchAndTouchMemory(event)
      : { selected: [], cooperationMemoryIds: new Set() };
    const dormantSessions = this.metaStore.list({ agentId: this.agentId })
      .filter(s => s.status === 'dormant');
    const dormantSummaries = dormantSessions
      .filter(s => s.summary && s.summary.length > 0)
      .map(s => s.summary);

    // Build Zone B with compressed seed (M2: place in Zone B, not userMessage)
    const { content: memoryZoneB } = buildZoneBContent(selectedMemories, dormantSummaries, cooperationMemoryIds);
    let zoneBContentStr = memoryZoneB || '';
    if (compressedSeed && compressedSeed.length > 0) {
      const seedSection = `\n[Previous Session Context]\n${compressedSeed}`;
      zoneBContentStr = zoneBContentStr ? zoneBContentStr + seedSection : seedSection.trim();
    }

    // Build Zone A
    const { system: systemPrompt, user: userPrompt } = await this._buildSystemPrompt(sceneId, dynamicData, contextParams);
    const toolDefinitions = this._getToolDefinitions();

    // Extract user message
    const userMessage = event
      ? (userPrompt || this._extractUserMessage(event))
      : (userPrompt || 'Continue from previous context.');
    const chatHistory = event && Array.isArray(event.payload?.chatHistory) ? event.payload.chatHistory : [];

    // Assemble payload
    const payload = buildInitialPayload({
      sessionId,
      systemPrompt,
      toolDefinitions,
      zoneBContent: zoneBContentStr,
      chatHistory,
      userMessage,
    });

    // Inherit tags from parent session
    const parentMeta = this.metaStore.get(parentSessionId);
    const parentTags = parentMeta?.tags || [];
    const eventTags = event ? this._extractTags(event) : [];
    const mergedTags = [...new Set([...parentTags, ...eventTags])];

    // Persist SessionMeta
    this.metaStore.create({
      session_id: sessionId,
      parent_session_id: parentSessionId,
      agent_id: this.agentId,
      summary: `Continuation of: ${(parentMeta?.summary || '').slice(0, 60)}`,
      tags: mergedTags,
      status: 'awake',
      turn_count: 0,
      context_size_pct: 0,
      pending_requests: 0,
      keepalive_renewals: 0,
      keepalive_start_time: null,
      linger: false,
      linger_count: 0,
      cerebellum_l1_cursor: 0,
      cerebellum_l2_cursor: 0,
      created_at: now,
      last_active_at: now,
    });

    const bpLog = payload.breakpoints.map(bp => `${bp.id}=${bp.position}`).join(', ');
    console.log(`[CE:${this.agentId}] Created session ${sessionId} (parent: ${parentSessionId}), BPs: ${bpLog}`);

    return { action: 'create_session', session_id: sessionId, payload };
  }

  // ---------------------------------------------------------------------------
  // CE Stage 4: recall — deep Memory search (§1.9 Stage 4, DL-46)
  // ---------------------------------------------------------------------------

  /**
   * CE Stage 4: deep Memory search triggered by Brain's `recall` tool call.
   * Phase 11 Tier D renamed the Brain-facing tool from `deep_think` to
   * `think_deeper`; Phase 16 (ADR §11 / Design §10) merged it with the
   * Space-side `recall` into a single internal tool named `recall`. The
   * accessor on toolContext keeps its `thinkDeeper` name for backwards
   * compatibility — see brain/internal-tools/recall.js.
   * Returns formatted text results (not a ContextPayload).
   * "Independent prompt" — does not reorganize context (§1.9 line 284-288).
   *
   * @param {string} query - Brain's search query
   * @returns {Promise<string>} Formatted memory results
   */
  async stage4ThinkDeeper(query) {
    if (!query || query.trim().length === 0) return '';

    // Step 1: Extract keywords for tag-based search
    const keywords = query.split(/\s+/).filter(w => w.length > 2).slice(0, 10);

    // Step 2: Tag-based search (broader than normal — all keywords as tags)
    const tagResults = [];
    for (const kw of keywords) {
      const found = this.ceAccessView.findByTag({ tagName: kw, includeDescendants: true });
      tagResults.push(...found);
    }

    // Step 3: Keyword search (higher limit than Stage 1)
    const kwResults = this.ceAccessView.search({ kw: query.slice(0, 200), limit: 20 });

    // Step 4: Deduplicate by ID
    const seen = new Map();
    for (const m of [...tagResults, ...kwResults]) {
      if (!seen.has(m.id)) seen.set(m.id, m);
    }
    const allResults = [...seen.values()];

    if (allResults.length === 0) return '';

    // Step 5: touchAccess for ALL found memories
    for (const m of allResults) {
      this.ceAccessView.touchAccess({ id: m.id, usedInBrainContext: true });
    }

    // Step 6: Format results grouped by layer
    const groups = { long: [], long_skill: [], short: [], short_skill: [] };
    for (const m of allResults) {
      const layer = m.layer || 'short';
      if (groups[layer]) groups[layer].push(m);
      else groups.short.push(m);
    }

    const sections = [];
    if (groups.long.length > 0) {
      sections.push(`[Long-term Memory]\n${groups.long.map(m => `- ${m.content}`).join('\n')}`);
    }
    if (groups.long_skill.length > 0) {
      sections.push(`[Learned Skills]\n${groups.long_skill.map(m => `- ${m.content}`).join('\n')}`);
    }
    if (groups.short.length > 0) {
      sections.push(`[Recent Context]\n${groups.short.map(m => `- ${m.content}`).join('\n')}`);
    }
    if (groups.short_skill.length > 0) {
      sections.push(`[Working Patterns]\n${groups.short_skill.map(m => `- ${m.content}`).join('\n')}`);
    }

    return sections.join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // CE Stage 5: Keep-alive cache renewal (§1.9 Stage 5, line 290-300)
  // ---------------------------------------------------------------------------

  /**
   * CE Stage 5: refresh context with pending status + optional Memory content.
   * Called by Supervisor._triggerKeepAlive (DL-41 pattern: direct call).
   *
   * @param {string} sessionId
   * @returns {Promise<import('../types/context-payload.js').ContextPayload>}
   */
  async stage5KeepAlive(sessionId) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) throw new Error(`Session ${sessionId} not found`);

    // Step 1: Propose search tags from session's existing tags (non-LLM, §1.9 line 296)
    const searchTags = meta.tags || [];

    // Step 2: Tag-match Memory for new related content
    let relatedContent = '';
    for (const tag of searchTags) {
      const found = this.ceAccessView.findByTag({ tagName: tag, includeDescendants: true });
      if (found.length > 0) {
        const snippets = found.slice(0, 3).map(m => m.content).join('\n');
        relatedContent += snippets + '\n';
        for (const m of found.slice(0, 3)) {
          this.ceAccessView.touchAccess({ id: m.id, usedInBrainContext: true });
        }
      }
    }

    // Step 3: Build Zone A
    const { system: systemPrompt } = await this._buildSystemPrompt('idle', {}, null);
    const toolDefinitions = this._getToolDefinitions();

    // Step 4: Read session history
    const K = 20;
    const historyLength = this.historyStore.length(sessionId);
    const cerebellusCursor = meta.cerebellum_l1_cursor ?? 0;
    const readStart = Math.min(Math.max(0, historyLength - K), cerebellusCursor);
    const history = historyLength > 0
      ? this.historyStore.readRange({ sessionId, startIndex: readStart, endIndex: historyLength - 1 })
      : [];

    // Step 5: Build keep-alive message (pending status + optional new content)
    const pendingCount = meta.pending_requests || 0;
    let keepAliveMessage = `You have ${pendingCount} pending external request${pendingCount !== 1 ? 's' : ''} awaiting responses. Cache is being refreshed to maintain session continuity.`;
    if (relatedContent.trim().length > 0) {
      keepAliveMessage += `\n\nNew related context from memory:\n${relatedContent.trim()}`;
    }

    // Step 6: Assemble messages
    const messages = [];
    messages.push({ role: 'system', content: systemPrompt });

    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content || '' });
    }
    messages.push({ role: 'user', content: keepAliveMessage });

    // Step 7: Build payload
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 3);

    return {
      session_id: sessionId,
      messages,
      tools: toolDefinitions,
      zones: { zone_a_end: 0, zone_b_end: 0, zone_c_front_end: 0, zone_c_mid_end: 0 },
      breakpoints: [
        { id: 'bp1', position: 0 },
        { id: 'bp2', position: null },
        { id: 'bp3', position: null },
        { id: 'bp4', position: null },
      ],
      estimated_tokens: estimatedTokens,
    };
  }

  // ---------------------------------------------------------------------------
  // CE Stage 6: Linger prompt enhancement (§1.9 Stage 6, line 301-312)
  // ---------------------------------------------------------------------------

  /** Default linger prompt (§4.1 line 646). */
  static LINGER_PROMPT = 'Your reasoning is complete and TTL is about to expire. Do you have any thoughts to record (write_record) or report to the boss (send_chat)?';

  /**
   * CE Stage 6: enhance context with linger prompt + optional Memory content.
   * Called by Supervisor._triggerLingerTick (DL-41: direct call, not via receiveEvent).
   *
   * @param {string} sessionId
   * @returns {Promise<import('../types/context-payload.js').ContextPayload>}
   */
  async stage6LingerEnhance(sessionId) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) throw new Error(`Session ${sessionId} not found`);

    // Step 1: Propose search tags from session's existing tags (non-LLM, §1.9 line 307)
    const searchTags = meta.tags || [];

    // Step 2: Tag-match Memory for related content
    let relatedContent = '';
    for (const tag of searchTags) {
      const found = this.ceAccessView.findByTag({ tagName: tag, includeDescendants: true });
      if (found.length > 0) {
        const snippets = found.slice(0, 3).map(m => m.content).join('\n');
        relatedContent += snippets + '\n';
        // touchAccess for found memories (seen but context-dependent)
        for (const m of found.slice(0, 3)) {
          this.ceAccessView.touchAccess({ id: m.id, usedInBrainContext: true });
        }
      }
    }

    // Step 3: Build Zone A (system prompt + tools)
    // Use 'idle' scene for linger — it's the closest match to passive thinking
    const { system: systemPrompt } = await this._buildSystemPrompt('idle', {}, null);
    const toolDefinitions = this._getToolDefinitions();

    // Step 4: Read session history
    const K = 20;
    const historyLength = this.historyStore.length(sessionId);
    const cerebellusCursor = meta.cerebellum_l1_cursor ?? 0;
    const readStart = Math.min(Math.max(0, historyLength - K), cerebellusCursor);
    const history = historyLength > 0
      ? this.historyStore.readRange({ sessionId, startIndex: readStart, endIndex: historyLength - 1 })
      : [];

    // Step 5: Assemble messages with linger prompt at tail
    const messages = [];
    messages.push({ role: 'system', content: systemPrompt });

    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content || '' });
    }

    // Linger prompt: related content (if any) + default hint
    let lingerMessage = ContextEngine.LINGER_PROMPT;
    if (relatedContent.trim().length > 0) {
      lingerMessage = `Related context from memory:\n${relatedContent.trim()}\n\n${lingerMessage}`;
    }
    messages.push({ role: 'user', content: lingerMessage });

    // Step 6: Build payload
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 3);

    return {
      session_id: sessionId,
      messages,
      tools: toolDefinitions,
      zones: { zone_a_end: 0, zone_b_end: 0, zone_c_front_end: 0, zone_c_mid_end: 0 },
      breakpoints: [
        { id: 'bp1', position: 0 },
        { id: 'bp2', position: null },
        { id: 'bp3', position: null },
        { id: 'bp4', position: null },
      ],
      estimated_tokens: estimatedTokens,
    };
  }

  /**
   * Search Memory and apply touchAccess for all results.
   *
   * touchAccess MUST be called every time CE assembles context — it is the
   * data feed for Short→Long promotion scoring (Phase 3/5).
   *
   * usedInBrainContext=true  → access_count += ACCESS_COUNT_SELECTED (2)
   * usedInBrainContext=false → access_count += ACCESS_COUNT_SEEN     (1)
   *
   * Phase 2: Memory shell returns [] for all queries, so both selected and
   * notSelected are always empty. The full call path still runs.
   *
   * @param {import('../types/event.js').AgentEvent} event
   * @returns {{ selected: Array, notSelected: Array, cooperationMemoryIds: Set<string> }}
   */
  _searchAndTouchMemory(event) {
    const tags = this._extractTags(event);

    // Tag-based search
    let allMemories = [];
    for (const tag of tags) {
      const found = this.ceAccessView.findByTag({ tagName: tag, includeDescendants: true });
      allMemories.push(...found);
    }

    // Keyword search using the first 50 chars of the user message
    const userMsg = this._extractUserMessage(event);
    if (userMsg) {
      const kwResults = this.ceAccessView.search({ kw: userMsg.slice(0, 50), limit: 10 });
      allMemories.push(...kwResults);
    }

    // P9-A: Always fetch cooperation memories for Agent Card (DL-57)
    // Uses canonical 'collaboration' tag with descendants (M2)
    const cooperationResults = this.ceAccessView.findByTag({ tagName: 'collaboration', includeDescendants: true });
    // M1: Limit to 20 entries at CE level; zone-b-builder does final top-10 selection
    const limitedCooperation = cooperationResults.slice(0, 20);
    allMemories.push(...limitedCooperation);

    // Track cooperation memory IDs for zone-b-builder block separation
    const cooperationMemoryIds = new Set(limitedCooperation.map(m => m.id));

    // Deduplicate by ID — O(n) via Map; Phase 3 SQLite化时用 Set/索引重写
    const seen = new Map();
    for (const m of allMemories) {
      if (!seen.has(m.id)) seen.set(m.id, m);
    }
    allMemories = [...seen.values()];

    // Phase 2: no LLM-based selection — include all (empty set anyway)
    const selected = allMemories;
    const selectedIds = new Set(selected.map(m => m.id));
    const notSelected = allMemories.filter(m => !selectedIds.has(m.id));

    // touchAccess: selected memories used in Brain context
    for (const m of selected) {
      this.ceAccessView.touchAccess({ id: m.id, usedInBrainContext: true });
    }
    // touchAccess: seen but not included in Brain context
    for (const m of notSelected) {
      this.ceAccessView.touchAccess({ id: m.id, usedInBrainContext: false });
    }

    return { selected, notSelected, cooperationMemoryIds };
  }

  /**
   * Build the system prompt for Zone A by delegating to the injected buildSystemPrompt fn.
   *
   * The injected function (from sceneTemplates.js) is async and returns { system, user }.
   * This method extracts the .system string for inclusion in Zone A.
   *
   * @param {string} sceneId
   * @param {Object} [dynamicData]
   * @param {Object|null} [contextParams]
   * @returns {Promise<string>}
   */
  async _buildSystemPrompt(sceneId, dynamicData, contextParams) {
    // Phase 11 Tier B §B-7: personality is Agent Core authority.
    // Order: Agent Core personality (L1) + Space systemPrompt (scene + skills + dynamicData)
    //   + Agent Core internal instructions. The Space-side buildSystemPrompt is responsible
    //   for no longer injecting personality into its own output (see sceneTemplates.js).
    // Phase 12: AgentManager is keyed by agents.id UUID; fall back to agentName
    // so stubs (tests) that ignore the key continue to work.
    const personality = (await this.agentManager.getPersonality(this.agentId || this.agentName)) || '';

    const rendered = await this.buildSystemPrompt({
      agentId: this.agentId,
      agentName: this.agentName,
      sceneId,
      contextParams: contextParams || null,
      dynamicData: dynamicData || {},
    });

    const parts = [];
    if (personality.trim().length > 0) {
      parts.push(`[Personality]\n${personality.trim()}`);
    }
    if (rendered.system && rendered.system.length > 0) {
      parts.push(rendered.system);
    }
    const combinedSystem = parts.join('\n\n');
    return { system: combinedSystem, user: rendered.user || '' };
  }

  /**
   * Get tool definitions for the agent by delegating to the injected getToolsForAgent fn.
   *
   * Merges Agent Core's internal tools (Map insertion order) ahead of Space
   * tools. The Space side must keep its own ordering stable so that the
   * BP1 cache prefix does not shift between sessions.
   *
   * Called at Stage 1 only. Stage 2 preserves tools from the existing payload (DL-32).
   *
   * @returns {Object[]}
   */
  _getToolDefinitions() {
    // Phase 13 I5.2: Space tool registry is keyed by agents.id UUID.
    const internalTools = listInternalTools();
    const spaceTools = this.getToolsForAgent(this.agentId, 'brain') || [];
    return [...internalTools, ...spaceTools];
  }

  /**
   * Extract the user message text from an event payload.
   *
   * Handles string payload, { content }, { message }, or falls back to JSON.
   *
   * @param {import('../types/event.js').AgentEvent} event
   * @returns {string}
   */
  _extractUserMessage(event) {
    if (!event?.payload) return '';
    if (typeof event.payload === 'string') return event.payload;
    if (typeof event.payload.content === 'string') return event.payload.content;
    if (typeof event.payload.message === 'string') return event.payload.message;
    return JSON.stringify(event.payload);
  }

  /**
   * Extract topic tags from an event for Memory / SessionMeta search.
   *
   * Phase 2: simple word-frequency heuristic.
   * Production: CE LLM will extract semantic tags.
   *
   * @param {import('../types/event.js').AgentEvent} event
   * @returns {string[]}
   */
  _extractTags(event) {
    const text = this._extractUserMessage(event);
    if (!text) return [];
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    return [...new Set(words)].slice(0, 5);
  }

  // ---------------------------------------------------------------------------
  // CE Stage 2
  // ---------------------------------------------------------------------------

  /**
   * Check if Stage 2 should trigger for this session.
   *
   * Triggers when turn_count > 0 and divisible by W=4.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  shouldTriggerStage2(sessionId) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) return false;
    return meta.turn_count > 0 && meta.turn_count % STAGE2_COMPACT_INTERVAL === 0;
  }

  /**
   * Assemble a ContextPayload for an existing session + new event.
   * Optionally runs Stage 2 compaction if turn_count interval met.
   * @param {string} sessionId
   * @param {import('../types/event.js').AgentEvent} event
   * @param {{ sceneId: string, dynamicData?: Object, contextParams?: Object|null }} options
   * @returns {Promise<import('../types/context-payload.js').ContextPayload>}
   */
  async assemblePayloadForEvent(sessionId, event, { sceneId, dynamicData, contextParams } = {}) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) throw new Error(`Session ${sessionId} not found`);

    // Search Memory for Zone B content
    const { selected: selectedMemories, cooperationMemoryIds } = this._searchAndTouchMemory(event);
    const dormantSessions = this.metaStore.list({ agentId: this.agentId })
      .filter(s => s.status === 'dormant');
    const dormantSummaries = dormantSessions
      .filter(s => s.summary && s.summary.length > 0)
      .map(s => s.summary);
    const { content: zoneBContentStr } = buildZoneBContent(selectedMemories, dormantSummaries, cooperationMemoryIds);

    // Build Zone A (system prompt + tools)
    const { system: systemPrompt, user: userPrompt } = await this._buildSystemPrompt(
      sceneId, dynamicData, contextParams,
    );
    const toolDefinitions = this._getToolDefinitions();

    // Read session history (read_range: max K=20 turns, cerebellum cursor)
    const K = 20;
    const historyLength = this.historyStore.length(sessionId);
    const cerebellusCursor = meta.cerebellum_l1_cursor ?? 0;
    const readStart = Math.min(Math.max(0, historyLength - K), cerebellusCursor);
    const history = historyLength > 0
      ? this.historyStore.readRange({ sessionId, startIndex: readStart, endIndex: historyLength - 1 })
      : [];

    // Extract event content (DL-35: prefer buildSystemPrompt().user, DL-36: chatHistory)
    const userMessage = userPrompt || this._extractUserMessage(event);
    const chatHistory = Array.isArray(event.payload?.chatHistory) ? event.payload.chatHistory : [];

    // Assemble messages: Zone A + Zone B + history + chatHistory + user message
    const messages = [];
    messages.push({ role: 'system', content: systemPrompt });
    const zoneAEnd = 0;

    let zoneBEnd = zoneAEnd;
    if (zoneBContentStr.length > 0) {
      messages.push({ role: 'system', content: zoneBContentStr });
      zoneBEnd = messages.length - 1;
    }

    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content || '' });
    }
    for (const entry of chatHistory) {
      if (entry && entry.role && entry.content) {
        messages.push({ role: entry.role, content: entry.content });
      }
    }
    messages.push({ role: 'user', content: userMessage });

    // Breakpoints (Stage 2 will refine bp3/bp4 if it runs)
    const bp2 = (zoneBEnd > zoneAEnd) ? zoneBEnd : null;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 3);

    let payload = {
      session_id: sessionId,
      messages,
      tools: toolDefinitions,
      zones: {
        zone_a_end: zoneAEnd,
        zone_b_end: zoneBEnd,
        zone_c_front_end: zoneBEnd,
        zone_c_mid_end: zoneBEnd,
      },
      breakpoints: [
        { id: 'bp1', position: zoneAEnd },
        { id: 'bp2', position: bp2 },
        { id: 'bp3', position: null },
        { id: 'bp4', position: null },
      ],
      estimated_tokens: estimatedTokens,
    };

    // Run Stage 2 if compaction interval reached
    if (this.shouldTriggerStage2(sessionId)) {
      payload = await this.stage2OrganizeContext(sessionId, payload);
    }

    // Update SessionMeta
    const hasUnresolved = userMessage.includes('?') || userMessage.toLowerCase().includes('todo');
    const newTags = this._extractTags(event);
    const mergedTags = [...new Set([...(meta.tags || []), ...newTags])];
    const contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE;
    const contextSizePct = (payload.estimated_tokens / contextWindowSize) * 100;

    this.metaStore.update(sessionId, {
      summary: userMessage.slice(0, 100),
      tags: mergedTags,
      linger: hasUnresolved,
      context_size_pct: contextSizePct,
    }, 'ce');

    return payload;
  }

  /**
   * CE Stage 2: periodic context organization (every W=4 turns).
   *
   * Trigger: called when turn_count % W === 0 (W=4 configurable).
   *
   * Design doc refs:
   *   - 改造指引 P2-4
   *   - 顶层设计 1.9 Stage 2
   *   - 顶层设计 4.9 "Zone 与 CE Stage 的关系"
   *
   * Flow:
   *   1. Read last X=5 turns from session history as search context
   *   2. Search Memory + Session Meta by tags (same touchAccess as Stage 1)
   *   3. Analyze Zone C from tail backward in Y=5 turn blocks for compaction
   *   4. Update Zone B with new memory summary
   *   5. Advance BP3 to compact boundary
   *   6. Update Session Meta (summary, tags, linger, context_size_pct)
   *
   * Constraints:
   *   - CE compact range: Zone C-mid ONLY (not A, B, C-front, C-tail)
   *   - read_range: max(last K=20 turns, Cerebellum cursor to tail)
   *   - BP3 advances from BP4 toward BP2 monotonically
   *   - Invariant: bp1 <= bp2 <= bp3 <= bp4 enforced on every exit
   *
   * @param {string} sessionId
   * @param {import('../types/context-payload.js').ContextPayload} currentPayload
   * @returns {import('../types/context-payload.js').ContextPayload}
   */
  async stage2OrganizeContext(sessionId, currentPayload) {
    const meta = this.metaStore.get(sessionId);
    if (!meta) return currentPayload;

    const turnCount = meta.turn_count;
    const historyLength = this.historyStore.length(sessionId);

    // Step 1: Read last X=5 turns for search context
    const X = 5;
    const searchStart = Math.max(0, historyLength - X);
    const recentTurns = historyLength > 0
      ? this.historyStore.readRange({
          sessionId,
          startIndex: searchStart,
          endIndex: historyLength - 1,
        })
      : [];

    // Step 2: Search Memory and apply touchAccess using recent turn content
    // Synthetic event lets _searchAndTouchMemory/_extractTags/_extractUserMessage run unchanged.
    const searchText = recentTurns.map(t => t.content || '').join(' ');
    const syntheticEvent = { payload: searchText };
    const { selected: selectedMemories, cooperationMemoryIds } = this._searchAndTouchMemory(syntheticEvent);

    // Step 3: Search dormant sessions for Zone B reuse
    const dormantSessions = this.metaStore.list({ agentId: this.agentId, status: 'dormant' });
    const dormantSummaries = dormantSessions
      .filter(s => s.summary)
      .map(s => s.summary);

    // Step 4: Build Zone B content (P5-C)
    const { content: stage2ZoneBContent } = buildZoneBContent(selectedMemories, dormantSummaries, cooperationMemoryIds);

    // Step 5: Read full session history for zone layout
    // read_range: max(last K=20 turns, cerebellum_l1_cursor to tail)
    const K = 20;
    const cerebellusCursor = meta.cerebellum_l1_cursor ?? 0;
    const readStart = Math.min(
      Math.max(0, historyLength - K),
      cerebellusCursor,
    );

    const fullHistory = historyLength > 0
      ? this.historyStore.readRange({
          sessionId,
          startIndex: readStart,
          endIndex: historyLength - 1,
        })
      : [];

    const totalTurns = fullHistory.length;

    // Step 6: Determine Zone C compaction boundary
    // C-tail: last X turns — never compacted
    // C-mid: turns between C-front and C-tail — Stage 2 compact target
    // C-front: turns compacted by Stage 3 only — left untouched here
    // Y-block heuristic: how many Y=5 blocks to analyze scales with turn_count
    const Y = 5;
    const tailKeep = X;
    const blocksToAnalyze = turnCount <= 8 ? 1
      : turnCount <= 16 ? 2
      : Math.min(5, Math.floor(Math.max(0, totalTurns - tailKeep) / Y));

    // compact boundary = where BP3 lands (advances toward front on each Stage 2)
    // Ensure boundary never exceeds (totalTurns - tailKeep) so C-tail stays intact
    const compactBoundaryTurn = Math.max(
      0,
      totalTurns - tailKeep - (blocksToAnalyze * Y),
    );

    // Step 7: Reassemble message array with updated Zone layout
    // DL-32: Zone A is preserved from the incoming payload — do NOT re-render.
    // Stage 2 never calls _buildSystemPrompt() or _getToolDefinitions().
    const systemPrompt = currentPayload.messages[0].content;
    const toolDefinitions = currentPayload.tools;
    const messages = [];

    // Zone A: system prompt (index 0)
    messages.push({ role: 'system', content: systemPrompt });
    const zoneAEnd = 0;

    // Zone B: structured memory + dormant session summaries (P5-C)
    const zoneBContent = stage2ZoneBContent;

    let zoneBEnd;
    if (zoneBContent.length > 0) {
      messages.push({ role: 'system', content: zoneBContent });
      zoneBEnd = messages.length - 1;
    } else {
      zoneBEnd = zoneAEnd;
    }

    // Zone C-front: turns [0, compactBoundaryTurn) — not touched by Stage 2
    for (let i = 0; i < compactBoundaryTurn && i < totalTurns; i++) {
      const turn = fullHistory[i];
      messages.push({ role: turn.role, content: turn.content || '' });
    }
    const zoneCFrontEnd = compactBoundaryTurn > 0
      ? messages.length - 1
      : zoneBEnd;

    // Zone C-mid: turns [compactBoundaryTurn, totalTurns - tailKeep)
    // Real LLM compaction via Haiku — replaces DEV-3 pass-through
    const midStart = compactBoundaryTurn;
    const midEnd = Math.max(compactBoundaryTurn, totalTurns - tailKeep);
    if (midEnd > midStart) {
      const midTurns = fullHistory.slice(midStart, midEnd);
      const compactedMessages = await this._compactZoneCMid(midTurns);
      messages.push(...compactedMessages);
    }
    const zoneCMidEnd = midEnd > compactBoundaryTurn
      ? messages.length - 1
      : zoneCFrontEnd;

    // Zone C-tail: last X turns — always preserved verbatim
    for (let i = Math.max(0, totalTurns - tailKeep); i < totalTurns; i++) {
      const turn = fullHistory[i];
      messages.push({ role: turn.role, content: turn.content || '' });
    }

    // Step 8: Build breakpoints with updated positions
    // BP2: null if Zone B has no content (D-5: length-based check)
    const bp2Position = zoneBContent.length > 0 ? zoneBEnd : null;

    // BP3: null if Zone C-front has no turns OR if BP2 is null.
    // BP3 must never be non-null when BP2 is null — that would create a mid-gap
    // (null tail invariant: once a BP is null, all subsequent must be null).
    const bp3Position = (bp2Position !== null && compactBoundaryTurn > 0) ? zoneCFrontEnd : null;

    // BP4: null if Zone C-mid has no turns OR if BP3 is null.
    // BP4 must never be non-null when BP3 is null — that would create a mid-gap
    // (null tail invariant: once a BP is null, all subsequent must be null).
    // IMPORTANT: First Stage 2 often has bp4=null because C-front is empty
    // (compactBoundaryTurn=0 → bp3=null → bp4 forced null too).
    // Do NOT set bp4 = bp3 when mid is empty — that wastes a marker slot.
    const hasMidContent = midEnd > compactBoundaryTurn;
    const bp4Position = (bp3Position !== null && hasMidContent) ? zoneCMidEnd : null;

    const breakpoints = [
      { id: 'bp1', position: zoneAEnd },
      { id: 'bp2', position: bp2Position },
      { id: 'bp3', position: bp3Position },
      { id: 'bp4', position: bp4Position },
    ];

    // Enforce bp1 <= bp2 <= bp3 <= bp4 invariant
    assertBpInvariant(breakpoints);

    // Step 9: Estimate token count (~1 token per 3 chars)
    const estimatedTokens = messages.reduce((sum, m) => {
      return sum + Math.ceil((m.content || '').length / 3);
    }, 0);

    const contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE; // Phase 2 default; production reads from agent config
    const contextSizePct = contextWindowSize > 0
      ? Math.round((estimatedTokens / contextWindowSize) * 100)
      : 0;

    // Step 10: Update Session Meta
    const updatedTags = this._extractTags(syntheticEvent);
    const existingTags = meta.tags || [];
    const mergedTags = [...new Set([...existingTags, ...updatedTags])];

    // Linger heuristic: unresolved questions or explicit TODOs in recent turns
    const hasUnresolved = recentTurns.some(t =>
      t.content && (t.content.includes('?') || t.content.includes('TODO')),
    );

    // Summary: first 100 chars of the most recent turn content
    const lastTurnContent = recentTurns[recentTurns.length - 1]?.content || '';
    const updatedSummary = lastTurnContent.slice(0, 100) || meta.summary;

    this.metaStore.update(sessionId, {
      summary: updatedSummary,
      tags: mergedTags,
      linger: hasUnresolved,
      turn_count: turnCount,
      context_size_pct: contextSizePct,
    }, 'ce');

    // Log BP positions and token estimate for cache observability
    const bpLog = breakpoints.map(bp => `${bp.id}=${bp.position}`).join(', ');
    console.log(
      `[CE:${this.agentId}] Stage 2 organized session ${sessionId}` +
      ` (turn ${turnCount}), BPs: ${bpLog}, tokens: ~${estimatedTokens}`,
    );

    return {
      session_id: sessionId,
      messages,
      tools: toolDefinitions,
      zones: {
        zone_a_end: zoneAEnd,
        zone_b_end: zoneBEnd,
        zone_c_front_end: zoneCFrontEnd,
        zone_c_mid_end: zoneCMidEnd,
      },
      breakpoints,
      estimated_tokens: estimatedTokens,
    };
  }

  /**
   * Compact Zone C-mid turns using Haiku LLM.
   * Splits into Y-blocks, gets verdict per block, handles failure state machine.
   *
   * @param {Array<{role: string, content: string}>} midTurns
   * @returns {Promise<Array<{role: string, content: string}>>}
   */
  async _compactZoneCMid(midTurns) {
    const Y = 5;
    const results = [];

    // Split into Y-blocks
    const blocks = [];
    for (let i = 0; i < midTurns.length; i += Y) {
      blocks.push(midTurns.slice(i, i + Y));
    }

    for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
      const block = blocks[blockIdx];

      // DL-13: If paused, enter probe mode on first block only
      if (this._compactionPaused) {
        if (blockIdx === 0) {
          // Probe: try exactly one block
          const probeResult = await this._compactOneBlock(block);
          if (probeResult.succeeded) {
            // Probe success: clear flags, continue normal loop
            this._compactionPaused = false;
            this._compactionFailureCount = 0;
            results.push(...probeResult.messages);
            continue;
          } else {
            // Probe failed: stay paused, keep all remaining blocks
            for (const b of blocks) {
              for (const turn of b) {
                results.push({ role: turn.role, content: turn.content || '' });
              }
            }
            return results;
          }
        }
        // blockIdx > 0 shouldn't happen if probe failed (we returned above)
        // but safety: keep the block
        for (const turn of block) {
          results.push({ role: turn.role, content: turn.content || '' });
        }
        continue;
      }

      // Normal mode: compact this block
      const compactionResult = await this._compactOneBlock(block);

      if (compactionResult.succeeded) {
        this._compactionFailureCount = 0; // success resets counter
        results.push(...compactionResult.messages);
      } else {
        this._compactionFailureCount++;
        // Conservative fallback: keep original messages
        for (const turn of block) {
          results.push({ role: turn.role, content: turn.content || '' });
        }

        if (this._compactionFailureCount >= 3) {
          // Enter paused state, keep all remaining blocks
          this._compactionPaused = true;
          console.error(
            `[CE:${this.agentId}] Compaction paused after ${this._compactionFailureCount} consecutive failures`,
          );
          for (let remaining = blockIdx + 1; remaining < blocks.length; remaining++) {
            for (const turn of blocks[remaining]) {
              results.push({ role: turn.role, content: turn.content || '' });
            }
          }
          break;
        }
      }
    }

    return results;
  }

  /**
   * Attempt to compact a single Y-block via Haiku LLM.
   * Implements Q3 degradation: retry once on error, then fall back to keep.
   *
   * @param {Array<{role: string, content: string}>} block
   * @returns {Promise<{ succeeded: boolean, messages: Array<{role: string, content: string}> }>}
   */
  async _compactOneBlock(block) {
    const promptMessages = buildCompactionPrompt(block, `Agent: ${this.agentName}`);

    // Try up to 2 times (Q3: retry once on error)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const responseText = await this.ceChannel({
          agentId: this.agentId,
          agentName: this.agentName,
          messages: promptMessages,
          maxTokens: 1024,
        });

        const verdict = parseCompactionVerdict(responseText);

        switch (verdict.verdict) {
          case 'keep':
            return {
              succeeded: true,
              messages: block.map(t => ({ role: t.role, content: t.content || '' })),
            };
          case 'delete':
            return { succeeded: true, messages: [] };
          case 'compact':
            return {
              succeeded: true,
              messages: [{ role: 'system', content: `[Compacted] ${verdict.compactedText}` }],
            };
          default:
            // Should not happen after parseCompactionVerdict, but safety
            return {
              succeeded: true,
              messages: block.map(t => ({ role: t.role, content: t.content || '' })),
            };
        }
      } catch (err) {
        if (attempt === 0) {
          console.warn(
            `[CE:${this.agentName}] Compaction attempt ${attempt + 1} failed, retrying:`, err.message,
          );
          continue; // retry once
        }
        console.warn(
          `[CE:${this.agentName}] Compaction failed after retry, falling back to keep:`, err.message,
        );
        return {
          succeeded: false,
          messages: block.map(t => ({ role: t.role, content: t.content || '' })),
        };
      }
    }

    // Should not reach here, but safety fallback
    return {
      succeeded: false,
      messages: block.map(t => ({ role: t.role, content: t.content || '' })),
    };
  }
}
