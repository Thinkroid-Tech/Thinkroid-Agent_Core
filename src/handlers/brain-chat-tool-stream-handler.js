// Daemon-side `brain.chatToolStream` handler — streaming multi-round tool
// loop driven by the daemon. Provider text deltas surface to the caller as
// `text_chunk` partials; tool dispatches surface as `tool_use` /
// `tool_result` partials; an approval-pending dispatch yields an
// `approval_required` partial AND persists a durable suspension row.
//
// The request always resolves with one final JSON-RPC `result` envelope
// (the IPC adapter wraps it into `result.done`). Per-round wire shape:
//
//   - Provider text deltas:        ctx.emitChunk({ type: 'text_chunk', delta })
//   - Tool dispatched (each):      ctx.emitChunk({ type: 'tool_use', id, name, args, round })
//   - Tool result (each):          ctx.emitChunk({ type: 'tool_result', id, name, result, isToolError?, round })
//   - Approval-pending suspension: ctx.emitChunk({ type: 'approval_required', suspensionId, toolCallId, name, args })
//
// Configuration resolution supports a dual-path: when the primary
// `configOverride` fails (no agent cache and no override supplied), the
// handler retries the resolution with `backupConfigOverride`. This is the
// special-role chat dual-path — the primary attempts the per-agent
// provider, falling back to the backup when the primary is misconfigured.

import { randomUUID } from 'node:crypto';

import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import { validateRequestPayload } from '../ipc/agent-core-contract.js';
import { IPC_METHOD_TIMEOUTS_MS } from '../adapters/ipc-timeouts.js';
import { streamChatCompletion as defaultStreamChatCompletion } from '../lib/llm-provider/streaming-chat.js';
import { resolveAiConfig as defaultResolveAiConfig } from '../lib/resolveAiConfig.js';
import { ToolLoopSuspensionsStore } from '../stores/agent-core-db/tool-loop-suspensions-store.js';
import {
  accumulateUsage,
  emitTokenUsage,
  resolveLoopConfig,
} from './brain-tool-loop-handler.js';

const METHOD = 'brain.chatToolStream';

const DEFAULT_MAX_TOOL_ROUNDS = 25;
const HARD_CAP_MAX_TOOL_ROUNDS = 50;
const CONFIG_UNAVAILABLE_TOKEN = 'daemon_ai_config_unavailable';

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

function extractToolName(tool) {
  if (!tool || typeof tool !== 'object') return null;
  if (
    tool.function &&
    typeof tool.function === 'object' &&
    typeof tool.function.name === 'string'
  ) {
    return tool.function.name;
  }
  if (typeof tool.name === 'string') return tool.name;
  return null;
}

function stripExecutorFromTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    const { executor: _executor, ...rest } = tool ?? {};
    return rest;
  });
}

function safeEmit(ctx, chunk) {
  try {
    if (ctx && typeof ctx.emitChunk === 'function') {
      ctx.emitChunk(chunk);
    }
  } catch {
    // Best-effort: a downstream serialization failure must not bring
    // down the tool loop. The adapter logs its own failures.
  }
}

function serializeToolCallForAssistantMessage(call) {
  // Re-serialize the parsed args back to a JSON string so the assistant
  // message we feed back to the provider in the next round matches the
  // OpenAI-style `{ id, type:'function', function:{ name, arguments } }`
  // shape (arguments is a string, not an object).
  let argsString;
  if (typeof call.args === 'string') {
    argsString = call.args;
  } else {
    try {
      argsString = JSON.stringify(call.args ?? {});
    } catch {
      argsString = '';
    }
  }
  return {
    id: call.toolCallId ?? null,
    type: 'function',
    function: {
      name: call.name ?? '',
      arguments: argsString,
    },
  };
}

async function resolveConfigWithFallback({
  agentId,
  aiConfigResolver,
  brainConfig,
  configOverride,
  backupConfigOverride,
}) {
  // Try the primary path first. `resolveLoopConfig` throws an Error with
  // a `daemon_ai_config_unavailable` prefix when both the cache miss and
  // override-missing case apply.
  try {
    return resolveLoopConfig({
      agentId,
      aiConfigResolver,
      brainConfig,
      configOverride,
    });
  } catch (primaryErr) {
    const message = primaryErr?.message ?? String(primaryErr ?? '');
    const isUnavailable = message.startsWith(CONFIG_UNAVAILABLE_TOKEN);
    if (!isUnavailable || backupConfigOverride === undefined || backupConfigOverride === null) {
      // No backup wired — surface the primary failure.
      throw primaryErr;
    }
    // Fall through to backup.
    return resolveLoopConfig({
      agentId,
      aiConfigResolver,
      brainConfig,
      configOverride: backupConfigOverride,
    });
  }
}

/**
 * Build the brain.chatToolStream handler.
 *
 * @param {{
 *   agentId: string,
 *   brainConfig?: object,
 *   aiConfigResolver?: (agentId: string, opts?: { configOverride?: object }) => object|undefined,
 *   streamChatCompletion?: Function,
 *   dispatchLocalTool: ({ name, args, ctx }) => Promise<unknown>,
 *   dispatchRemoteTool: ({ name, args, ctx }) => Promise<unknown>,
 *   sendNotification?: (method: string, payload: object) => void,
 *   suspensionsStore?: ToolLoopSuspensionsStore,
 * }} deps
 */
export function createBrainChatToolStreamHandler({
  agentId,
  brainConfig = null,
  aiConfigResolver = defaultResolveAiConfig,
  streamChatCompletion = defaultStreamChatCompletion,
  dispatchLocalTool,
  dispatchRemoteTool,
  sendNotification,
  suspensionsStore = null,
}) {
  if (!agentId) {
    throw new TypeError('createBrainChatToolStreamHandler requires agentId');
  }
  if (typeof dispatchLocalTool !== 'function') {
    throw new TypeError('createBrainChatToolStreamHandler requires dispatchLocalTool');
  }
  if (typeof dispatchRemoteTool !== 'function') {
    throw new TypeError('createBrainChatToolStreamHandler requires dispatchRemoteTool');
  }

  return async (params, kernelCtx) => {
    validateRequest(params, agentId);

    let resolvedConfig;
    try {
      resolvedConfig = await resolveConfigWithFallback({
        agentId,
        aiConfigResolver,
        brainConfig,
        configOverride: params.configOverride,
        backupConfigOverride: params.backupConfigOverride,
      });
    } catch (err) {
      rejectApplication(err?.message ?? String(err), {
        code: 'BRAIN_CHAT_TOOL_STREAM_CONFIG_UNAVAILABLE',
        retryable: false,
      });
    }

    const requestedRounds = params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const effectiveMaxToolRounds = Math.min(requestedRounds, HARD_CAP_MAX_TOOL_ROUNDS);

    const workingMessages = params.messages.map((m) => ({ ...m }));
    // Tool entries arrive in the OpenAI function-calling shape
    // (`{type, function:{name,...}, executor}`). See the matching
    // comment in brain-tool-loop-handler.js for the full rationale.
    const toolsByName = new Map();
    if (Array.isArray(params.tools)) {
      for (const t of params.tools) {
        const name = extractToolName(t);
        if (typeof name === 'string' && name.length > 0) {
          toolsByName.set(name, t);
        }
      }
    }
    const providerTools = stripExecutorFromTools(params.tools);

    const toolCtx = {
      agentId,
      ...(params.toolContext && typeof params.toolContext === 'object' ? params.toolContext : {}),
      ...(typeof params.taskId === 'string' && params.taskId.length > 0 ? { taskId: params.taskId } : {}),
    };

    const effectiveMaxTokens = params.maxTokens ?? resolvedConfig.maxTokens;
    const signal = kernelCtx?.signal ?? null;

    const aggregatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let observedAnyUsage = false;

    for (let round = 1; round <= effectiveMaxToolRounds; round += 1) {
      const queuedToolCalls = [];
      let roundText = '';

      const onUsage = (usage) => {
        if (usage && typeof usage === 'object') {
          observedAnyUsage = true;
          accumulateUsage(aggregatedUsage, usage);
        }
      };
      const onToolCall = (call) => {
        // Collect first, dispatch after the stream completes for the
        // round. Pausing inside the callback would require coordinating
        // back-pressure with the provider stream, which the helper does
        // not expose; the queue keeps the loop body simple.
        queuedToolCalls.push(call);
      };

      const stream = streamChatCompletion({
        config: resolvedConfig,
        messages: workingMessages,
        tools: providerTools,
        maxTokens: effectiveMaxTokens,
        onUsage,
        onToolCall,
        signal,
      });

      try {
        for await (const delta of stream) {
          if (typeof delta === 'string' && delta.length > 0) {
            roundText += delta;
            safeEmit(kernelCtx, { type: 'text_chunk', delta });
          }
        }
      } catch (err) {
        const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
        if (observedAnyUsage) {
          emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
        }
        rejectApplication(
          `provider error: ${err?.message ?? err}`,
          {
            code: isAbort
              ? 'BRAIN_CHAT_TOOL_STREAM_INTERRUPTED'
              : 'BRAIN_CHAT_TOOL_STREAM_PROVIDER_ERROR',
            retryable: !isAbort,
            ...(err?.message ? { cause: err.message } : {}),
          },
        );
      }

      // Append the assistant message verbatim so the next round (or the
      // caller's persistence layer) sees the exact tool_calls payload in
      // the canonical OpenAI shape.
      const assistantMessage = { role: 'assistant', content: roundText };
      if (queuedToolCalls.length > 0) {
        assistantMessage.tool_calls = queuedToolCalls.map(serializeToolCallForAssistantMessage);
      }
      workingMessages.push(assistantMessage);

      if (queuedToolCalls.length === 0) {
        if (observedAnyUsage) {
          emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
        }
        const envelope = {
          ok: true,
          text: roundText,
          agentId,
          status: 'completed',
          conversationMessages: workingMessages,
        };
        if (observedAnyUsage) envelope.usage = aggregatedUsage;
        return envelope;
      }

      // Dispatch each queued tool call in order.
      for (const call of queuedToolCalls) {
        const toolCallId = call.toolCallId ?? null;
        const fnName = typeof call.name === 'string' ? call.name : '';
        const args = call.args;

        safeEmit(kernelCtx, {
          type: 'tool_use',
          id: toolCallId,
          name: fnName,
          args,
          round,
        });

        if (fnName.length === 0 || !toolsByName.has(fnName)) {
          const content = `Unknown tool: ${fnName}`;
          workingMessages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content,
            isToolError: true,
          });
          safeEmit(kernelCtx, {
            type: 'tool_result',
            id: toolCallId,
            name: fnName,
            result: content,
            isToolError: true,
            round,
          });
          continue;
        }

        const toolDef = toolsByName.get(fnName);
        const dispatch = toolDef.executor === 'local' ? dispatchLocalTool : dispatchRemoteTool;

        let envelope;
        try {
          envelope = await dispatch({ name: fnName, args, ctx: toolCtx });
        } catch (err) {
          // Class B kernel-level throw: wrap into a Class A tool-error
          // message and continue the loop so the LLM can recover.
          const content = `Tool execution failed: ${err?.message ?? String(err)}`;
          workingMessages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content,
            isToolError: true,
          });
          safeEmit(kernelCtx, {
            type: 'tool_result',
            id: toolCallId,
            name: fnName,
            result: content,
            isToolError: true,
            round,
          });
          continue;
        }

        // Defensive unwrap of the `{ result: <envelope> }` shell, mirroring
        // the non-streaming tool-loop handler. Local kernel `tool.invoke`
        // returns that shape; remote `space.tool.invoke` returns the
        // envelope directly.
        if (
          envelope &&
          typeof envelope === 'object' &&
          !Array.isArray(envelope) &&
          'result' in envelope &&
          Object.keys(envelope).length === 1
        ) {
          envelope = envelope.result;
        }

        if (
          envelope &&
          typeof envelope === 'object' &&
          envelope.ok === false &&
          envelope.code === 'APPROVAL_PENDING'
        ) {
          // Persist a durable suspension row and emit the
          // approval_required partial; then return the final envelope.
          if (!suspensionsStore) {
            if (observedAnyUsage) {
              emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
            }
            rejectApplication(
              `tool ${fnName} returned APPROVAL_PENDING but daemon suspensions store is not wired`,
              {
                code: 'BRAIN_CHAT_TOOL_STREAM_SUSPENSIONS_UNAVAILABLE',
                retryable: false,
                approvalId: envelope.approvalId ?? null,
                toolName: fnName,
                toolCallId,
              },
            );
          }

          const suspensionId = randomUUID();
          const maxToolRoundsRemaining = effectiveMaxToolRounds - round;
          const approvalId = envelope.approvalId ?? null;

          try {
            suspensionsStore.insertPending({
              id: suspensionId,
              agentId,
              taskId: typeof params.taskId === 'string' && params.taskId.length > 0 ? params.taskId : null,
              sessionId: null,
              toolCallId,
              toolName: fnName,
              toolArgsJson: JSON.stringify(args ?? null),
              toolContextJson: JSON.stringify(toolCtx ?? null),
              conversationMessagesJson: JSON.stringify(workingMessages),
              maxTokens: Number.isFinite(effectiveMaxTokens) ? effectiveMaxTokens : null,
              maxToolRoundsRemaining,
              approvalId,
              idempotencyKey: `${suspensionId}:${approvalId ?? 'none'}`,
              configOverrideJson: params.configOverride ? JSON.stringify(params.configOverride) : null,
            });
          } catch (err) {
            if (observedAnyUsage) {
              emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
            }
            rejectApplication(
              `failed to persist tool loop suspension: ${err?.message ?? err}`,
              {
                code: 'BRAIN_CHAT_TOOL_STREAM_SUSPENSION_PERSIST_FAILED',
                retryable: false,
                toolName: fnName,
                toolCallId,
              },
            );
          }

          safeEmit(kernelCtx, {
            type: 'approval_required',
            suspensionId,
            toolCallId,
            name: fnName,
            args,
          });

          if (observedAnyUsage) {
            emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
          }

          const finalEnvelope = {
            ok: true,
            text: '',
            agentId,
            status: 'approval_pending',
            suspensionId,
            toolCallId,
            conversationMessages: workingMessages,
          };
          if (observedAnyUsage) finalEnvelope.usage = aggregatedUsage;
          return finalEnvelope;
        }

        // Class A success / tool-error envelope: `{ content, isToolError? }`.
        const content = typeof envelope?.content === 'string'
          ? envelope.content
          : typeof envelope === 'string'
            ? envelope
            : JSON.stringify(envelope ?? '');
        const isToolError = envelope && typeof envelope === 'object' && envelope.isToolError === true;
        const toolMessage = {
          role: 'tool',
          tool_call_id: toolCallId,
          content,
        };
        if (isToolError) toolMessage.isToolError = true;
        workingMessages.push(toolMessage);

        const resultChunk = {
          type: 'tool_result',
          id: toolCallId,
          name: fnName,
          result: content,
          round,
        };
        if (isToolError) resultChunk.isToolError = true;
        safeEmit(kernelCtx, resultChunk);
      }
    }

    // Exceeded effectiveMaxToolRounds without the provider terminating.
    if (observedAnyUsage) {
      emitTokenUsage({ sendNotification, agentId, usage: aggregatedUsage });
    }
    const envelope = {
      ok: true,
      text: `tool loop exceeded maxToolRounds (${effectiveMaxToolRounds})`,
      agentId,
      status: 'failed',
      conversationMessages: workingMessages,
    };
    if (observedAnyUsage) envelope.usage = aggregatedUsage;
    return envelope;
  };
}

/**
 * Register the brain.chatToolStream handler against `kernel`. Mirrors
 * `registerBrainToolLoopHandler` — builds default local/remote dispatch
 * callables when the caller does not supply explicit overrides, and
 * threads the suspensions store from `agentCoreDb`.
 *
 * @param {object} kernel
 * @param {{
 *   agentId: string,
 *   brainConfig?: object,
 *   aiConfigResolver?: Function,
 *   streamChatCompletion?: Function,
 *   sendNotification?: Function,
 *   dispatchLocalTool?: Function,
 *   dispatchRemoteTool?: Function,
 *   ipcAdapter?: object,
 *   agentCoreDb?: import('better-sqlite3').Database,
 *   suspensionsStore?: ToolLoopSuspensionsStore,
 * }} deps
 */
export function registerBrainChatToolStreamHandler(kernel, deps) {
  if (!kernel) {
    throw new TypeError('registerBrainChatToolStreamHandler requires kernel');
  }
  const {
    agentId,
    brainConfig,
    aiConfigResolver,
    streamChatCompletion,
    sendNotification,
    dispatchLocalTool,
    dispatchRemoteTool,
    ipcAdapter,
    agentCoreDb,
    suspensionsStore: suppliedStore,
  } = deps ?? {};
  if (!agentId) {
    throw new TypeError('registerBrainChatToolStreamHandler requires agentId');
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

  const suspensionsStore = suppliedStore
    ?? (agentCoreDb ? new ToolLoopSuspensionsStore(agentCoreDb) : null);

  kernel.registerHandler(
    METHOD,
    createBrainChatToolStreamHandler({
      agentId,
      brainConfig,
      aiConfigResolver,
      streamChatCompletion,
      dispatchLocalTool: effectiveDispatchLocal,
      dispatchRemoteTool: effectiveDispatchRemote,
      sendNotification,
      suspensionsStore,
    }),
  );
}
