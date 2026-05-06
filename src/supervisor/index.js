/**
 * Supervisor — per-Agent pure rule engine.
 *
 * Responsibilities:
 * - Session lifecycle state machine (Awake/Drowsy/Dormant/Archived)
 * - Dual TTL management
 * - Event reception → CE handoff
 * - Keep-alive / Linger triggering (Phase 4)
 * - Archived trigger via Cerebellum cursor check
 *
 * Hard constraints:
 * - NO LLM calls
 * - Only writes session_meta.status field
 * - Does NOT judge which session an event belongs to (CE does)
 */

import { SessionStateMachine } from './session-state-machine.js';
import { TtlManager } from './ttl-manager.js';
import { buildCacheControlMarkers, applyCacheMarkers } from '../ce/context-payload-builder.js';

/** @typedef {import('../types/supervisor-runtime.js').SupervisorConfig} SupervisorConfig */
/** @typedef {import('../types/event.js').AgentEvent} AgentEvent */

/** Default config values */
const DEFAULT_CONFIG = {
  cache_ttl: 300,          // seconds
  safety_buffer: 30,       // seconds
  max_linger_count: 3,
  linger_enabled: false,
  system_linger_master_switch: false,
};

export class Supervisor {
  /**
   * @param {Object} options
   * @param {string} options.agentId
   * @param {Partial<SupervisorConfig>} [options.config]
   * @param {import('../ce/context-engine.js').ContextEngine} options.ce - CE instance for event handoff
   * @param {import('../stores/agent-core-db/session-meta-store.js').SessionMetaStore} options.sessionMetaStore
   * @param {import('../stores/agent-core-db/session-history-store.js').SessionHistoryStore} options.sessionHistoryStore
   * @param {Object} [options.clock] - Mockable clock for testing
   */
  constructor({ agentId, config = {}, ce, brain = null, sessionMetaStore, sessionHistoryStore, clock = null }) {
    this.agentId = agentId;
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._ce = ce;
    this._brain = brain;
    this._sessionMetaStore = sessionMetaStore;
    this._sessionHistoryStore = sessionHistoryStore;

    this._clock = clock;
    this._stateMachine = new SessionStateMachine();
    this._ttlManager = new TtlManager({
      cacheTtlMs: this._config.cache_ttl * 1000,
      safetyBufferMs: this._config.safety_buffer * 1000,
      clock,
    });

    // Wake condition CONFIG — which conditions are enabled (design doc §2.10)
    this._wakeConditionDefaults = {
      unfinishedTasks: this._config.wake_unfinishedTasks ?? true,
      thinkingResidual: this._config.wake_thinkingResidual ?? true,
      thinkingWarmth: this._config.wake_thinkingWarmth ?? false,
      asyncCollaboration: this._config.wake_asyncCollaboration ?? true,
    };

    // Wake condition runtime VALUES per session
    /** @type {Map<string, { unfinishedTasks: boolean, thinkingResidual: boolean, thinkingWarmth: boolean, asyncCollaboration: boolean }>} */
    this._wakeConditions = new Map();
  }

  /** Get the state machine (for testing/inspection) */
  get stateMachine() { return this._stateMachine; }

  /** Get the TTL manager (for testing/inspection) */
  get ttlManager() { return this._ttlManager; }

  /** Get current config */
  get config() { return { ...this._config }; }

  /**
   * Receive an external event and hand off to CE.
   * This is the main entry point for all events.
   * @param {AgentEvent} event
   * @param {{ sceneId?: string, dynamicData?: Object, contextParams?: Object|null }} [options]
   * @returns {{ action: string, session_id: string|null }}
   */
  async receiveEvent(event, { sceneId = 'task', dynamicData = {}, contextParams = null, toolContext = null, callerOptions = {} } = {}) {
    // Step 1: Hand to CE for routing judgment
    const ceResult = await this._ce.handleEvent(event, { sceneId, dynamicData, contextParams });

    // Step 2: If CE says create new session, do so
    if (ceResult.action === 'create_session' && ceResult.session_id) {
      this.createSession(ceResult.session_id);
    }

    // Step 2b: If appending to existing Awake session, reset TTL (cache refresh)
    if (ceResult.action === 'append_to_session' && ceResult.session_id) {
      this._resetTtl(ceResult.session_id);
    }

    // Reset linger_count on normal event arrival (§4.1 line 652)
    if (ceResult.session_id) {
      const meta = this._sessionMetaStore.get(ceResult.session_id);
      if (meta && meta.linger_count > 0) {
        this._sessionMetaStore.update(ceResult.session_id, { linger_count: 0 }, 'supervisor');
      }
    }

    // Step 3: If CE says switch to a specific session
    // TODO(Phase-7+): cold-start recovery — if state machine was restarted,
    //   Drowsy sessions from persistent DB won't be registered, silently skipping switch.
    //   Needs state machine hydration from SessionMetaStore on startup.
    if (ceResult.action === 'switch_session' && ceResult.session_id) {
      const status = this._stateMachine.getStatus(ceResult.session_id);
      if (status === 'drowsy') {
        this._switchContext(ceResult.session_id);
      }
    }

    // Step 4: Handle Stage 3 new-session result (old session → Drowsy)
    if (ceResult.oldSessionId) {
      const oldStatus = this._stateMachine.getStatus(ceResult.oldSessionId);
      if (oldStatus === 'awake') {
        this._demoteToDrowsy(ceResult.oldSessionId);
      }
    }

    // Step 5: If CE produced a payload and Brain is available, call Brain
    let brainResponse = null;
    if (ceResult.payload && this._brain) {
      // DL-39: per-call onOverflow for Supervisor pipeline (session-aware compress).
      // `msgs` param is intentionally unused — new session builds fresh context from store,
      // not from the overflowed messages that the tool-loop passes in.
      // TODO(Phase-7+): remove unused `msgs` param — refactor tool-loop onOverflow signature
      //   to not require it, or use it as fallback seed when store read fails.
      const supervisorOnOverflow = async (msgs) => {
        const result = await this._ce.stage3CreateNewSession(
          ceResult.session_id, { sceneId, dynamicData, contextParams },
        );
        if (result.oldSessionId) {
          const oldSt = this._stateMachine.getStatus(result.oldSessionId);
          if (oldSt === 'awake') this._demoteToDrowsy(result.oldSessionId);
        }
        this.createSession(result.session_id);
        // Re-apply cache markers to new session's messages (P8-A3)
        const markers = buildCacheControlMarkers(result.payload.breakpoints);
        const cachedMessages = applyCacheMarkers(result.payload.messages, markers, this._config.providerType);
        return { messages: cachedMessages, truncated: false };
      };

      // Inject CE Stage 4 accessor for the recall internal tool (DL-46).
      // Phase 11 Tier D renamed the Brain-facing tool from `deep_think` to
      // `think_deeper`; Phase 16 (ADR §11 / Design §10) then merged the
      // Space-side `recall` into the same internal tool and renamed it to
      // `recall`. The closure name on toolContext is still `thinkDeeper`
      // because the CE Stage 4 accessor signature is unchanged. The
      // handler in brain/internal-tools/recall.js reads ctx.thinkDeeper.
      const enrichedToolContext = {
        ...toolContext,
        thinkDeeper: (query) => this._ce.stage4ThinkDeeper(query),
      };

      brainResponse = await this._brain.think({
        payload: ceResult.payload,
        toolContext: enrichedToolContext,
        callerOptions: { ...callerOptions, onOverflow: supervisorOnOverflow },
      });

      // Tier E: hand the completed Brain turn back to CE for history append
      // and turn_count bump. All writes for non-supervisor fields live in CE
      // (SessionMetaStore guards turn_count behind the supervisor whitelist).
      if (ceResult.session_id && typeof this._ce.recordTurnAfterBrain === 'function') {
        try {
          this._ce.recordTurnAfterBrain(ceResult.session_id, event, brainResponse);
        } catch (err) {
          console.warn(`[Supervisor:${this.agentId}] recordTurnAfterBrain failed for ${ceResult.session_id}:`, err.message);
        }
      }
    }

    return { ...ceResult, brainResponse };
  }

  /**
   * Create a new Awake session.
   * If another session is Awake, demote it first.
   * @param {string} sessionId
   */
  createSession(sessionId) {
    const currentAwake = this._stateMachine.getCurrentAwake();
    if (currentAwake) {
      this._demoteToDrowsy(currentAwake);
    }

    this._stateMachine.create(sessionId);
    this._updateStatus(sessionId, 'awake');
    this._startTtl(sessionId);
    this._wakeConditions.set(sessionId, {
      unfinishedTasks: false,
      thinkingResidual: false,
      thinkingWarmth: false,
      asyncCollaboration: false,
    });
  }

  /**
   * Check if Cerebellum cursors have passed session history end → trigger Archived.
   * Called periodically or after Cerebellum reports cursor advancement.
   * @param {string} sessionId
   * @returns {boolean} true if session was archived
   */
  checkArchivedTrigger(sessionId) {
    const status = this._stateMachine.getStatus(sessionId);
    if (status !== 'dormant') return false;

    const meta = this._sessionMetaStore.get(sessionId);
    if (!meta) return false;

    const historyLength = this._sessionHistoryStore.length(sessionId);

    const l1Done = meta.cerebellum_l1_cursor >= historyLength;
    const l2Done = meta.cerebellum_l2_cursor >= historyLength;

    if (l1Done && l2Done) {
      this._stateMachine.transition(sessionId, 'archived');
      this._updateStatus(sessionId, 'archived');
      return true;
    }

    return false;
  }

  /**
   * Get the status of a session.
   * @param {string} sessionId
   * @returns {'awake'|'drowsy'|'dormant'|'archived'|undefined}
   */
  getSessionStatus(sessionId) {
    return this._stateMachine.getStatus(sessionId);
  }

  /**
   * Get the current Awake session.
   * @returns {string|null}
   */
  getCurrentAwakeSession() {
    return this._stateMachine.getCurrentAwake();
  }

  /** Get wake condition defaults (config). */
  get wakeConditionDefaults() {
    return { ...this._wakeConditionDefaults };
  }

  /** Get wake condition runtime values for a session. */
  getWakeConditions(sessionId) {
    return this._wakeConditions.get(sessionId) || null;
  }

  /** Update wake condition runtime values for a session. */
  updateWakeConditions(sessionId, updates) {
    const current = this._wakeConditions.get(sessionId);
    if (current) {
      Object.assign(current, updates);
    }
  }

  /** Get supervisor runtime state for monitoring/debugging. */
  getRuntime() {
    return {
      current_awake_session: this._stateMachine.getCurrentAwake(),
      session_timers: this._ttlManager.getAllTimerInfo(),
    };
  }

  /**
   * Cleanup: clear all timers.
   */
  shutdown() {
    this._ttlManager.clearAll();
    this._wakeConditions.clear();
  }

  // ========== Private methods ==========

  /** @private */
  _demoteToDrowsy(sessionId) {
    this._stateMachine.transition(sessionId, 'drowsy');
    this._updateStatus(sessionId, 'drowsy');
    // Keep TTL running (Drowsy TTL will fire eventually)
  }

  /** @private */
  _switchContext(targetSessionId) {
    this._stateMachine.switchContext(targetSessionId);

    // Update both sessions' status in the store
    // switchContext already changed the state machine, so read from it
    const allSessions = this._stateMachine.getAllSessions();
    for (const [id, status] of allSessions) {
      if (id === targetSessionId || status === 'drowsy') {
        this._updateStatus(id, status);
      }
    }

    // Refresh TTL for newly Awake session
    this._startTtl(targetSessionId);
  }

  /** @private */
  _resetTtl(sessionId) {
    const status = this._stateMachine.getStatus(sessionId);
    if (status === 'awake') {
      this._startTtl(sessionId);
    }
  }

  /** @private */
  _startTtl(sessionId) {
    this._ttlManager.startAwake(sessionId, {
      onAwakeTtlExpired: (sid) => this._handleAwakeTtlExpired(sid),
      onDrowsyTtlExpired: (sid) => this._handleDrowsyTtlExpired(sid),
    });
  }

  /** @private */
  _handleAwakeTtlExpired(sessionId) {
    const status = this._stateMachine.getStatus(sessionId);
    if (status === 'awake') {
      this._demoteToDrowsy(sessionId);
    }
  }

  /** @private */
  async _handleDrowsyTtlExpired(sessionId) {
    const status = this._stateMachine.getStatus(sessionId);
    if (status !== 'drowsy') return;

    // §4.7 line 1072: linger checked BEFORE keep-alive (design invariant)
    // Phase 5: skeleton only — both stubs return false

    // Check 1: Linger — extends Drowsy if agent has unresolved thinking (清醒条件 #3)
    // _checkLingerConditions is always called first (design invariant §4.7 line 1072)
    const lingerConditionMet = this._checkLingerConditions(sessionId);
    const lingerEligible = this._config.linger_enabled
      && this._config.system_linger_master_switch
      && lingerConditionMet;
    if (lingerEligible) {
      await this._triggerLingerTick(sessionId);
      return;
    }

    // Check 2: Keep-alive — extends Drowsy if 清醒条件 #1/#2/#4 are met
    const keepAliveEligible = this._checkKeepAliveConditions(sessionId);
    if (keepAliveEligible) {
      await this._triggerKeepAlive(sessionId);
      return;
    }

    // Default: transition to Dormant
    this._stateMachine.transition(sessionId, 'dormant');
    this._updateStatus(sessionId, 'dormant');
    this._ttlManager.clear(sessionId);
    this._wakeConditions.delete(sessionId);
  }

  /**
   * Check linger conditions for a session (§4.1 line 632-633).
   * Outer _handleDrowsyTtlExpired already checks linger_enabled + system master switch.
   * This method checks session-level: meta.linger=true AND count < max.
   * @param {string} sessionId
   * @returns {boolean}
   */
  _checkLingerConditions(sessionId) {
    const meta = this._sessionMetaStore.get(sessionId);
    if (!meta) return false;
    if (!meta.linger) return false;
    // Count exhausted → reset linger flag, fall through (§4.1 line 652-653)
    if (meta.linger_count >= this._config.max_linger_count) {
      this._sessionMetaStore.update(sessionId, { linger: false }, 'supervisor');
      return false;
    }
    return true;
  }

  /**
   * Trigger a linger-tick: CE Stage 6 → Brain (restricted tools) → append to history.
   * DL-41: direct method calls, NOT through receiveEvent.
   * @param {string} sessionId
   */
  async _triggerLingerTick(sessionId) {
    // Step 1: CE enhances context with linger prompt
    const payload = await this._ce.stage6LingerEnhance(sessionId);

    // Step 2: Brain thinks with restricted tools (isLingerTick=true)
    let brainResponse = null;
    if (payload && this._brain) {
      brainResponse = await this._brain.think({
        payload,
        callerOptions: { isLingerTick: true },
      });
    }

    // Step 3: Append Brain output to session history (Cerebellum L1 can read, §4.1 line 643)
    if (brainResponse && typeof brainResponse === 'string' && brainResponse.length > 0) {
      this._sessionHistoryStore.append({
        sessionId,
        role: 'assistant',
        content: brainResponse,
      });
    }

    // Step 4: Increment linger_count
    const meta = this._sessionMetaStore.get(sessionId);
    const newCount = (meta?.linger_count || 0) + 1;
    this._sessionMetaStore.update(sessionId, { linger_count: newCount }, 'supervisor');

    // Step 5: Refresh TTL → new Drowsy cycle
    this._startTtl(sessionId);

    console.log(`[Supervisor:${this.agentId}] Linger-tick #${newCount} for session ${sessionId}`);
  }

  /**
   * Check keep-alive conditions for a session (§2.12 line 521-538).
   * Returns true if pending_requests > 0 and forced Dormant conditions NOT met.
   * @param {string} sessionId
   * @returns {boolean}
   */
  _checkKeepAliveConditions(sessionId) {
    const meta = this._sessionMetaStore.get(sessionId);
    if (!meta) return false;
    if (meta.pending_requests <= 0) return false;

    // Forced Dormant check (§2.12 line 537): renewals≥5 AND elapsed≥30min
    const renewals = meta.keepalive_renewals || 0;
    const startTime = meta.keepalive_start_time;
    const now = this._clock ? this._clock.now() : Date.now();
    const elapsed = startTime ? (now - startTime) : 0;
    const FORCED_RENEWAL_LIMIT = 5;
    const FORCED_TIME_LIMIT_MS = 30 * 60 * 1000;

    if (renewals >= FORCED_RENEWAL_LIMIT && elapsed >= FORCED_TIME_LIMIT_MS) {
      // Forced: clear all keepalive + pending state → next TTL expiry → Dormant
      this._sessionMetaStore.update(sessionId, {
        pending_requests: 0,
        keepalive_renewals: 0,
        keepalive_start_time: null,
      }, 'supervisor');
      return false;
    }

    return true;
  }

  /**
   * Trigger a keep-alive renewal: CE Stage 5 → optional Brain → refresh TTL.
   * Mirrors _triggerLingerTick pattern (DL-41 direct calls).
   * @param {string} sessionId
   */
  async _triggerKeepAlive(sessionId) {
    // Step 1: CE Stage 5 — refresh context with pending status
    const payload = await this._ce.stage5KeepAlive(sessionId);

    // Step 2: Brain optional processing (no tool calls — cache renewal only)
    let brainResponse = null;
    if (payload && this._brain) {
      brainResponse = await this._brain.think({
        payload,
        callerOptions: { maxToolRounds: 0 },
      });
    }

    // Step 3: Append Brain response to history if present
    if (brainResponse && typeof brainResponse === 'string' && brainResponse.length > 0) {
      this._sessionHistoryStore.append({
        sessionId,
        role: 'assistant',
        content: brainResponse,
      });
    }

    // Step 4: Increment keepalive_renewals
    const meta = this._sessionMetaStore.get(sessionId);
    const newRenewals = (meta?.keepalive_renewals || 0) + 1;
    this._sessionMetaStore.update(sessionId, {
      keepalive_renewals: newRenewals,
    }, 'supervisor');

    // Step 5: Refresh TTL
    this._startTtl(sessionId);

    console.log(`[Supervisor:${this.agentId}] Keep-alive renewal #${newRenewals} for session ${sessionId}`);
  }

  /**
   * Increment pending_requests for a session (§2.12 line 532-534).
   * Each new request resets keepalive_start_time + keepalive_renewals (active Agent signal).
   * @param {string} [sessionId] - Defaults to current Awake session
   */
  incrementPendingRequests(sessionId = null) {
    const sid = sessionId || this._stateMachine.getCurrentAwake();
    if (!sid) return;
    const meta = this._sessionMetaStore.get(sid);
    if (!meta) return;

    this._sessionMetaStore.update(sid, {
      pending_requests: (meta.pending_requests || 0) + 1,
      keepalive_start_time: this._clock ? this._clock.now() : Date.now(),
      keepalive_renewals: 0,
    }, 'supervisor');
  }

  /**
   * Decrement pending_requests for a session (§2.12 line 536).
   * When back to 0, clears all keepalive state — resume normal TTL flow.
   * @param {string} [sessionId] - Defaults to current Awake session
   */
  decrementPendingRequests(sessionId = null) {
    const sid = sessionId || this._stateMachine.getCurrentAwake();
    if (!sid) return;
    const meta = this._sessionMetaStore.get(sid);
    if (!meta || meta.pending_requests <= 0) return;

    const newCount = meta.pending_requests - 1;
    const patch = { pending_requests: newCount };

    if (newCount === 0) {
      patch.keepalive_renewals = 0;
      patch.keepalive_start_time = null;
    }

    this._sessionMetaStore.update(sid, patch, 'supervisor');
  }

  /**
   * Write ONLY lifecycle fields to session_meta.
   * @private
   */
  _updateStatus(sessionId, newStatus) {
    this._sessionMetaStore.update(sessionId, { status: newStatus }, 'supervisor');
  }
}
