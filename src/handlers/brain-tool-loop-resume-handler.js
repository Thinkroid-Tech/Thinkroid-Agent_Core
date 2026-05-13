// Daemon-side `brain.toolLoop.resume` handler — replays a suspended
// multi-round tool loop after the upstream caller records the
// outstanding approval and ships back the tool result.
//
// Idempotency contract:
//
//   - The first resume with `(suspensionId, approvalId)` reconstructs
//     the working message buffer from the persisted row, appends the
//     caller-supplied tool result message, and drives the remaining
//     rounds. The final response envelope is cached on the row.
//   - Subsequent resumes with the same `(suspensionId, approvalId)`
//     return the cached envelope verbatim — no LLM call, no tool
//     re-dispatch.
//   - A resume with a different `approvalId` on an already-resumed row
//     surfaces `BRAIN_TOOL_LOOP_RESUME_CONFLICT` so the caller can
//     detect the cross-talk instead of silently re-running.
//   - Cancelled / expired rows reject with
//     `BRAIN_TOOL_LOOP_RESUME_INVALID_STATE`.
//
// Chained suspensions (the resumed loop itself hits another
// APPROVAL_PENDING) cache the new approval-pending envelope as the
// original row's final response and persist a fresh suspension row for
// the new approval. An idempotent re-resume of the original returns the
// chained `{ status: 'approval_pending', suspensionId: <new> }` shape so
// upstream callers chase the new pointer.

import { randomUUID } from 'node:crypto';

import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import { validateRequestPayload } from '../ipc/agent-core-contract.js';
import { IPC_METHOD_TIMEOUTS_MS } from '../adapters/ipc-timeouts.js';
import { createAIClient } from '../lib/llm-provider/openai-compatible-client.js';
import { callWithRetry as defaultCallWithRetry } from '../lib/llm-provider/retry.js';
import { resolveAiConfig as defaultResolveAiConfig } from '../lib/resolveAiConfig.js';
import { ToolLoopSuspensionsStore } from '../stores/agent-core-db/tool-loop-suspensions-store.js';
import {
  accumulateUsage,
  emitTokenUsage,
  resolveLoopConfig,
  runToolLoopRounds,
} from './brain-tool-loop-handler.js';

const METHOD = 'brain.toolLoop.resume';

function rejectApplication(message, data = {}) {
  throwJsonRpcError(IPC_ERROR_CODES.APPLICATION, message, { method: METHOD, ...data });
}

function validateRequest(params, boundAgentId) {
  const validation = validateRequestPayload(METHOD, params);
  if (!validation.ok) {
    rejectApplication(validation.errors.join('; '), { errors: validation.errors });
  }
  if (params.agentId !== boundAgentId) {
    rejectApplication(`agentId mismatch: expected ${boundAgentId}`, {
      expectedAgentId: boundAgentId,
      actualAgentId: params.agentId,
    });
  }
}

function safeParseJson(text, fallback = null) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stripExecutorFromTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const { executor: _executor, ...rest } = tool ?? {};
    return rest;
  });
}

/**
 * Build the brain.toolLoop.resume handler.
 *
 * @param {{
 *   agentId: string,
 *   suspensionsStore: ToolLoopSuspensionsStore,
 *   brainConfig?: object,
 *   aiConfigResolver?: Function,
 *   clientFactory?: Function,
 *   callWithRetry?: Function,
 *   dispatchLocalTool: Function,
 *   dispatchRemoteTool: Function,
 *   sendNotification?: Function,
 * }} deps
 */
export function createBrainToolLoopResumeHandler({
  agentId,
  suspensionsStore,
  brainConfig = null,
  aiConfigResolver = defaultResolveAiConfig,
  clientFactory = createAIClient,
  callWithRetry = defaultCallWithRetry,
  dispatchLocalTool,
  dispatchRemoteTool,
  sendNotification,
}) {
  if (!agentId) {
    throw new TypeError('createBrainToolLoopResumeHandler requires agentId');
  }
  if (!suspensionsStore) {
    throw new TypeError('createBrainToolLoopResumeHandler requires suspensionsStore');
  }
  if (typeof dispatchLocalTool !== 'function') {
    throw new TypeError('createBrainToolLoopResumeHandler requires dispatchLocalTool');
  }
  if (typeof dispatchRemoteTool !== 'function') {
    throw new TypeError('createBrainToolLoopResumeHandler requires dispatchRemoteTool');
  }

  return async (params, kernelCtx) => {
    validateRequest(params, agentId);

    const row = suspensionsStore.getById(params.suspensionId);
    if (!row) {
      rejectApplication(`suspension not found: ${params.suspensionId}`, {
        code: 'BRAIN_TOOL_LOOP_RESUME_NOT_FOUND',
        retryable: false,
        suspensionId: params.suspensionId,
      });
    }

    if (row.agent_id !== params.agentId) {
      rejectApplication(
        `suspension agent mismatch: expected ${params.agentId}, row owned by ${row.agent_id}`,
        {
          code: 'BRAIN_TOOL_LOOP_RESUME_AGENT_MISMATCH',
          retryable: false,
          suspensionId: params.suspensionId,
        },
      );
    }

    if (row.status === 'cancelled' || row.status === 'expired') {
      rejectApplication(`suspension is in terminal state '${row.status}'`, {
        code: 'BRAIN_TOOL_LOOP_RESUME_INVALID_STATE',
        retryable: false,
        currentStatus: row.status,
        suspensionId: params.suspensionId,
      });
    }

    if (row.status === 'resumed') {
      if (row.approval_id === params.approvalId && row.final_response_json) {
        // Idempotent return: replay the cached final response.
        const cached = safeParseJson(row.final_response_json, null);
        if (cached && typeof cached === 'object') {
          return cached;
        }
        // Cache exists but is unparseable; surface as conflict so the
        // caller stops retrying.
        rejectApplication(
          'cached final response is unreadable',
          {
            code: 'BRAIN_TOOL_LOOP_RESUME_CONFLICT',
            retryable: false,
            expectedApprovalId: row.approval_id,
            suspensionId: params.suspensionId,
          },
        );
      }
      rejectApplication(
        `suspension already resumed with a different approvalId`,
        {
          code: 'BRAIN_TOOL_LOOP_RESUME_CONFLICT',
          retryable: false,
          expectedApprovalId: row.approval_id,
          suspensionId: params.suspensionId,
        },
      );
    }

    // status === 'pending' — replay the loop.
    const persistedConversation = safeParseJson(row.conversation_messages_json, null);
    if (!Array.isArray(persistedConversation)) {
      rejectApplication(
        'suspension conversation buffer is corrupted',
        {
          code: 'BRAIN_TOOL_LOOP_RESUME_CORRUPT',
          retryable: false,
          suspensionId: params.suspensionId,
        },
      );
    }

    const workingMessages = persistedConversation.map((m) => ({ ...m }));
    const toolResultMessage = {
      role: 'tool',
      tool_call_id: row.tool_call_id,
      content: typeof params.toolResult?.content === 'string' ? params.toolResult.content : '',
    };
    if (params.toolResult?.isToolError === true) {
      toolResultMessage.isToolError = true;
    }
    workingMessages.push(toolResultMessage);

    const persistedConfigOverride = safeParseJson(row.config_override_json, null);
    // configOverride precedence (per dep wiring):
    //   1. caller-supplied params.configOverride (when wired in v2; not
    //      part of the resume request contract today)
    //   2. row.config_override_json (restored verbatim)
    //   3. brainConfig / aiConfigResolver default chain
    const configOverride = params.configOverride ?? persistedConfigOverride ?? undefined;

    let resolvedConfig;
    try {
      resolvedConfig = resolveLoopConfig({
        agentId,
        aiConfigResolver,
        brainConfig,
        configOverride,
      });
    } catch (err) {
      rejectApplication(err?.message ?? String(err), {
        code: 'BRAIN_TOOL_LOOP_RESUME_CONFIG_UNAVAILABLE',
        retryable: false,
      });
    }

    const client = clientFactory({
      baseUrl: resolvedConfig.baseUrl ?? resolvedConfig.baseURL,
      apiKey: resolvedConfig.apiKey,
    });

    // Reconstruct the tool registry from the persisted tool context if
    // the caller supplied a tools snapshot there, OR fall back to a
    // singleton entry for the suspended tool only — the caller's
    // upstream code is expected to supply the original tool definitions
    // through the same `params.tools` channel on the resume call when
    // chained suspensions are possible. For v1 the resume request body
    // does not carry tools; the loop will treat any new provider tool
    // call against an unknown name as a Class A tool-error and recover.
    const persistedToolContext = safeParseJson(row.tool_context_json, null);
    const toolsByName = new Map();
    if (Array.isArray(params.tools)) {
      for (const t of params.tools) {
        if (t && typeof t.name === 'string') {
          toolsByName.set(t.name, t);
        }
      }
    }
    const providerTools = stripExecutorFromTools(params.tools);
    const toolCtx = persistedToolContext && typeof persistedToolContext === 'object'
      ? persistedToolContext
      : { agentId };

    const effectiveMaxTokens = Number.isFinite(row.max_tokens) ? row.max_tokens : undefined;
    // Use the persisted remaining-rounds budget literally. When the
    // suspending round was the very last allowed round the persisted
    // remaining is 0 — the resume should NOT silently grant an extra
    // round, since that would extend the loop past the caller's original
    // maxToolRounds. With remaining=0 the loop body runs zero times and
    // the helper falls through to the `failed` branch immediately.
    const persistedRemaining = Number(row.max_tool_rounds_remaining);
    const effectiveMaxToolRounds = Number.isFinite(persistedRemaining) && persistedRemaining >= 0
      ? persistedRemaining
      : 0;
    const signal = kernelCtx?.signal ?? null;

    const outcome = await runToolLoopRounds({
      client,
      callWithRetry,
      resolvedConfig,
      workingMessages,
      toolsByName,
      providerTools,
      dispatchLocalTool,
      dispatchRemoteTool,
      toolCtx,
      effectiveMaxTokens,
      effectiveMaxToolRounds,
      signal,
    });

    if (outcome.kind === 'provider_error') {
      if (outcome.observedAnyUsage) {
        emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
      }
      rejectApplication(outcome.message, {
        code: 'BRAIN_TOOL_LOOP_RESUME_PROVIDER_ERROR',
        retryable: true,
        ...(outcome.cause ? { cause: outcome.cause } : {}),
      });
    }

    let finalEnvelope;
    if (outcome.kind === 'completed') {
      finalEnvelope = {
        ok: true,
        text: outcome.text,
        agentId,
        status: 'completed',
        conversationMessages: outcome.conversationMessages,
      };
      if (outcome.observedAnyUsage) finalEnvelope.usage = outcome.aggregatedUsage;
    } else if (outcome.kind === 'failed') {
      finalEnvelope = {
        ok: true,
        text: outcome.text,
        agentId,
        status: 'failed',
        conversationMessages: outcome.conversationMessages,
      };
      if (outcome.observedAnyUsage) finalEnvelope.usage = outcome.aggregatedUsage;
    } else if (outcome.kind === 'approval_pending') {
      // Chained suspension. Persist a fresh row with the carry-forward
      // state, then cache the new approval-pending envelope as the
      // ORIGINAL row's final response so an idempotent re-resume of the
      // original returns the chained pointer.
      const newSuspensionId = randomUUID();
      const remainingAfterChain = effectiveMaxToolRounds - outcome.roundReached;
      const chainedApprovalId = outcome.envelope.approvalId ?? null;
      try {
        suspensionsStore.insertPending({
          id: newSuspensionId,
          agentId,
          taskId: row.task_id ?? null,
          sessionId: row.session_id ?? null,
          toolCallId: outcome.toolCallId,
          toolName: outcome.toolName,
          toolArgsJson: JSON.stringify(outcome.args ?? null),
          toolContextJson: JSON.stringify(toolCtx ?? null),
          conversationMessagesJson: JSON.stringify(outcome.conversationMessages),
          maxTokens: Number.isFinite(effectiveMaxTokens) ? effectiveMaxTokens : null,
          maxToolRoundsRemaining: remainingAfterChain,
          approvalId: chainedApprovalId,
          idempotencyKey: `${newSuspensionId}:${chainedApprovalId ?? 'none'}`,
          configOverrideJson: row.config_override_json ?? null,
        });
      } catch (err) {
        if (outcome.observedAnyUsage) {
          emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
        }
        rejectApplication(
          `failed to persist chained tool loop suspension: ${err?.message ?? err}`,
          {
            code: 'BRAIN_TOOL_LOOP_SUSPENSION_PERSIST_FAILED',
            retryable: false,
            toolName: outcome.toolName,
            toolCallId: outcome.toolCallId,
          },
        );
      }

      finalEnvelope = {
        ok: true,
        text: '',
        agentId,
        status: 'approval_pending',
        suspensionId: newSuspensionId,
        toolCallId: outcome.toolCallId,
        conversationMessages: outcome.conversationMessages,
      };
      if (outcome.observedAnyUsage) finalEnvelope.usage = outcome.aggregatedUsage;
    }

    // Cache the final envelope on the original row so idempotent
    // re-issues of the same `(suspensionId, approvalId)` return verbatim
    // without re-driving the loop. We always cache — even chained
    // approval_pending envelopes — so the original suspension's identity
    // is closed out cleanly.
    try {
      suspensionsStore.markResumed({
        id: params.suspensionId,
        approvalId: params.approvalId,
        finalResponseJson: JSON.stringify(finalEnvelope),
      });
    } catch (err) {
      if (outcome.observedAnyUsage) {
        emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
      }
      rejectApplication(
        `failed to mark suspension resumed: ${err?.message ?? err}`,
        {
          code: 'BRAIN_TOOL_LOOP_RESUME_PERSIST_FAILED',
          retryable: false,
          suspensionId: params.suspensionId,
        },
      );
    }

    if (outcome.observedAnyUsage) {
      emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
    }

    // Touch accumulateUsage to keep the symbol live across the resume
    // path even when token_usage emission is short-circuited; this is
    // documentation more than runtime — the helper aggregates per-round
    // usage inside runToolLoopRounds and we just emit it here.
    void accumulateUsage;

    return finalEnvelope;
  };
}

/**
 * Register the brain.toolLoop.resume handler against `kernel`.
 *
 * @param {object} kernel
 * @param {{
 *   agentId: string,
 *   brainConfig?: object,
 *   aiConfigResolver?: Function,
 *   clientFactory?: Function,
 *   callWithRetry?: Function,
 *   sendNotification?: Function,
 *   dispatchLocalTool?: Function,
 *   dispatchRemoteTool?: Function,
 *   ipcAdapter?: object,
 *   agentCoreDb?: import('better-sqlite3').Database,
 *   suspensionsStore?: ToolLoopSuspensionsStore,
 * }} deps
 */
export function registerBrainToolLoopResumeHandler(kernel, deps) {
  if (!kernel) {
    throw new TypeError('registerBrainToolLoopResumeHandler requires kernel');
  }
  const {
    agentId,
    brainConfig,
    aiConfigResolver,
    clientFactory,
    callWithRetry,
    sendNotification,
    dispatchLocalTool,
    dispatchRemoteTool,
    ipcAdapter,
    agentCoreDb,
    suspensionsStore: suppliedStore,
  } = deps ?? {};
  if (!agentId) {
    throw new TypeError('registerBrainToolLoopResumeHandler requires agentId');
  }

  const suspensionsStore = suppliedStore
    ?? (agentCoreDb ? new ToolLoopSuspensionsStore(agentCoreDb) : null);
  if (!suspensionsStore) {
    throw new TypeError(
      'registerBrainToolLoopResumeHandler requires agentCoreDb or suspensionsStore',
    );
  }

  const effectiveDispatchLocal = typeof dispatchLocalTool === 'function'
    ? dispatchLocalTool
    : async ({ name, args, ctx }) => kernel.dispatch('tool.invoke', { name, args, ctx });

  const effectiveDispatchRemote = typeof dispatchRemoteTool === 'function'
    ? dispatchRemoteTool
    : async ({ name, args, ctx }) => {
      if (!ipcAdapter || typeof ipcAdapter.request !== 'function') {
        return {
          content: `Tool execution failed: remote dispatch unavailable (no IPC adapter)`,
          isToolError: true,
        };
      }
      return ipcAdapter.request(
        'space.tool.invoke',
        { name, args, ctx },
        { timeoutMs: IPC_METHOD_TIMEOUTS_MS['space.tool.invoke'] },
      );
    };

  kernel.registerHandler(
    METHOD,
    createBrainToolLoopResumeHandler({
      agentId,
      suspensionsStore,
      brainConfig,
      aiConfigResolver,
      clientFactory,
      callWithRetry,
      dispatchLocalTool: effectiveDispatchLocal,
      dispatchRemoteTool: effectiveDispatchRemote,
      sendNotification,
    }),
  );
}
