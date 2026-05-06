import { buildCacheControlMarkers, applyCacheMarkers } from '../ce/context-payload-builder.js';

/**
 * Brain — the sole business LLM channel.
 * Wraps callAIWithTools via constructor DI.
 * Brain never directly reads Memory or Session History.
 */

export class Brain {
  /**
   * @param {Object} options
   * @param {string} options.agentId - agents.id UUID. Phase 13 I5.6: this
   *   is the canonical identity key. Every downstream `callAIWithTools`
   *   invocation looks up AI config / tool registry / interrupt state /
   *   token usage / debug logs by this UUID.
   * @param {string} [options.agentName] - Human-readable display name.
   *   Travels alongside agentId as metadata for hook payloads and log
   *   labels only — never participates in DB lookups.
   * @param {Function} options.callAIWithTools - Injected from brain-channel.js
   */
  constructor({ agentId, agentName, callAIWithTools, providerType }) {
    this.agentId = agentId;
    this.agentName = agentName ?? agentId;
    if (!callAIWithTools || typeof callAIWithTools !== 'function') {
      throw new Error('Brain requires callAIWithTools function');
    }
    this._callAIWithTools = callAIWithTools;
    this._providerType = providerType || 'anthropic';
  }

  /**
   * Execute an LLM call using the assembled context payload.
   * Returns raw callAIWithTools result (DL-33 passthrough).
   *
   * @param {Object} params
   * @param {import('../types/context-payload.js').ContextPayload} params.payload - From CE
   * @param {Object} [params.toolContext] - { agentId, agentName, spaceId, ... }
   * @param {Object} [params.callerOptions] - Passthrough options from the original caller
   * @returns {Promise<string|Object>} Raw callAIWithTools return value
   */
  async think({ payload, toolContext, callerOptions = {} }) {
    const {
      maxTokens, maxToolRounds, onToolUse, onBeforeToolExec,
      skipInterruptCheck, taskId, configOverride, onOverflow,
      isLingerTick,
    } = callerOptions;

    // Linger-tick: soft single-round constraint (maxToolRounds=1) is kept below;
    // tool-allowlist is now a Space-side concern — agent-core stays neutral.
    const effectiveTools = payload.tools;

    // Inject runtime metadata into toolContext under the reserved `_core` key.
    // Space-side tool executors read `toolContext._core.mode` to apply the
    // runtime policy (see services/tools/runtime-policy.js) without the
    // caller having to know about the envelope — other toolContext fields
    // stay untouched. `_core` never enters the API cache key: it travels with
    // the handler invocation only.
    const enrichedToolContext = {
      ...(toolContext || {}),
      _core: {
        mode: isLingerTick ? 'linger' : 'normal',
        agentName: this.agentName,
        sessionId: payload?.session_id ?? null,
      },
    };

    // Apply cache_control markers to messages at breakpoint indices (P8-A2).
    // Content-block format persists across tool-loop rounds since BP-indexed
    // messages (system prompt, memory block, etc.) are never modified by the loop.
    const markers = buildCacheControlMarkers(payload.breakpoints);
    const cachedMessages = applyCacheMarkers(payload.messages, markers, this._providerType);

    return this._callAIWithTools({
      agentId: this.agentId,
      agentName: this.agentName,
      messages: cachedMessages,
      toolContext: enrichedToolContext,
      tools: effectiveTools,
      maxTokens,
      maxToolRounds: isLingerTick ? 1 : maxToolRounds,
      onToolUse,
      onBeforeToolExec,
      skipInterruptCheck,
      taskId,
      configOverride,
      onOverflow,
    });
  }
}
