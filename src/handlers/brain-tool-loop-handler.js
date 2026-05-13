// Daemon-side `brain.toolLoop` handler — non-streaming multi-round tool
// loop driven by the daemon, dispatching tool calls to local kernel
// handlers or to Space-side remote tools via the bound ipcAdapter.
//
// Wire shape:
//
//   - Per round the handler calls the bound provider's
//     `chat.completions.create({ stream: false, ..., tools })` endpoint,
//     wrapped in `callWithRetry` for transient retry semantics.
//   - Tool calls returned by the provider are dispatched in order. The
//     `tools[i].executor` field decides whether dispatch goes to the
//     daemon-local `tool.invoke` kernel handler or to Space via
//     `space.tool.invoke`.
//   - Tool results are appended to the working message buffer as
//     `{ role: 'tool', tool_call_id, content, isToolError? }` so the next
//     provider round sees the full conversation history.
//   - When the provider returns a message with no `tool_calls`, the loop
//     resolves with `status: 'completed'` and the assistant text.
//   - When `maxToolRounds` is hit, the loop resolves with
//     `status: 'failed'` and a diagnostic text.
//   - When a remote tool returns the approval-pending envelope, the
//     handler persists a durable suspension row and resolves with
//     `status: 'approval_pending'` + the new suspensionId. The caller
//     replays via `brain.toolLoop.resume` once the approval is recorded.
//
// Token usage is accumulated across rounds and emitted as a single
// `token_usage` notification at the end (mirroring brain.chat's flow).

import { randomUUID } from 'node:crypto';

import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import { validateRequestPayload } from '../ipc/agent-core-contract.js';
import { IPC_METHOD_TIMEOUTS_MS } from '../adapters/ipc-timeouts.js';
import { createAIClient } from '../lib/llm-provider/openai-compatible-client.js';
import { callWithRetry as defaultCallWithRetry } from '../lib/llm-provider/retry.js';
import { resolveAiConfig as defaultResolveAiConfig } from '../lib/resolveAiConfig.js';
import { ToolLoopSuspensionsStore } from '../stores/agent-core-db/tool-loop-suspensions-store.js';

const METHOD = 'brain.toolLoop';

const DEFAULT_MAX_TOOL_ROUNDS = 25;
const HARD_CAP_MAX_TOOL_ROUNDS = 50;

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

export function emitTokenUsage({ sendNotification, agentId, usage }) {
  if (typeof sendNotification !== 'function') return;
  if (!usage || typeof usage !== 'object') return;
  try {
    sendNotification('token_usage', { agentId, usage });
  } catch {
    // Notification emission is best-effort; downstream serialization
    // failures must not bring down the tool loop.
  }
}

function parseToolArgs(rawArguments) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) {
    return rawArguments ?? {};
  }
  try {
    return JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
}

function stripExecutorFromTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => {
    // The `executor` field is daemon-only routing metadata; the provider
    // must never see it. Pass the rest through unchanged so the caller's
    // tool definitions (name / description / parameters / etc.) flow into
    // the provider request verbatim.
    const { executor: _executor, ...rest } = tool ?? {};
    return rest;
  });
}

export function accumulateUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens);
  target.prompt_tokens += prompt;
  target.completion_tokens += completion;
  if (Number.isFinite(total) && total > 0) {
    target.total_tokens += total;
  } else {
    target.total_tokens += prompt + completion;
  }
  return target;
}

export function resolveLoopConfig({ agentId, aiConfigResolver, brainConfig, configOverride }) {
  const hasOverride = configOverride !== undefined && configOverride !== null;
  const resolved =
    aiConfigResolver(agentId, hasOverride ? { configOverride } : undefined) ??
    (hasOverride ? configOverride : brainConfig);
  if (!resolved || typeof resolved !== 'object') {
    throw new Error(
      `daemon_ai_config_unavailable: no cached config for agentId='${agentId}' and no configOverride supplied`,
    );
  }
  return resolved;
}

async function runProviderRound({ client, retry, request, signal }) {
  const response = await retry(
    () => {
      if (signal) {
        return client.chat.completions.create(request, { signal });
      }
      return client.chat.completions.create(request);
    },
    {
      label: request?.label ?? 'daemon-brain-tool-loop',
      model: request?.model ?? '',
    },
  );
  return response;
}

/**
 * Build the per-round outcome envelope shapes returned by
 * `runToolLoopRounds`. The function returns one of:
 *
 *   { kind: 'completed', text, conversationMessages, aggregatedUsage, observedAnyUsage }
 *   { kind: 'failed', text, conversationMessages, aggregatedUsage, observedAnyUsage }
 *   { kind: 'approval_pending', toolCallId, toolName, args, envelope,
 *     conversationMessages, roundReached, aggregatedUsage, observedAnyUsage }
 *
 * The caller is responsible for wrapping the outcome into the final IPC
 * response envelope, emitting `token_usage` when `observedAnyUsage`, and
 * (for approval_pending) persisting the suspension row.
 *
 * Shared between the initial `brain.toolLoop` handler and the
 * `brain.toolLoop.resume` handler so the round-driving logic stays in
 * one place.
 *
 * @param {{
 *   client: object,
 *   callWithRetry: Function,
 *   resolvedConfig: { model: string, maxTokens?: number },
 *   workingMessages: Array<object>,
 *   toolsByName: Map<string, object>,
 *   providerTools: Array<object>|undefined,
 *   dispatchLocalTool: Function,
 *   dispatchRemoteTool: Function,
 *   toolCtx: object,
 *   effectiveMaxTokens: number|undefined,
 *   effectiveMaxToolRounds: number,
 *   signal: AbortSignal|null,
 * }} args
 */
export async function runToolLoopRounds({
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
}) {
  const aggregatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let observedAnyUsage = false;

  for (let round = 1; round <= effectiveMaxToolRounds; round += 1) {
    const request = {
      model: resolvedConfig.model,
      messages: workingMessages,
      stream: false,
    };
    if (providerTools && providerTools.length > 0) {
      request.tools = providerTools;
    }
    if (Number.isFinite(effectiveMaxTokens) && effectiveMaxTokens > 0) {
      request.max_tokens = effectiveMaxTokens;
    }

    let response;
    try {
      response = await runProviderRound({
        client,
        retry: callWithRetry,
        request,
        signal,
      });
    } catch (err) {
      return {
        kind: 'provider_error',
        message: `provider error: ${err?.message ?? err}`,
        cause: err?.message ?? String(err),
        aggregatedUsage,
        observedAnyUsage,
      };
    }

    if (response?.usage) {
      observedAnyUsage = true;
      accumulateUsage(aggregatedUsage, response.usage);
    }

    const message = response?.choices?.[0]?.message;
    if (!message || typeof message !== 'object') {
      return {
        kind: 'provider_error',
        message: 'provider returned no assistant message',
        cause: null,
        aggregatedUsage,
        observedAnyUsage,
      };
    }

    // Append the assistant message verbatim so the next round (or the
    // caller's persistence layer) sees the exact tool_calls payload.
    workingMessages.push(message);

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      const finalText = typeof message.content === 'string' ? message.content : '';
      return {
        kind: 'completed',
        text: finalText,
        conversationMessages: workingMessages,
        aggregatedUsage,
        observedAnyUsage,
      };
    }

    // Dispatch each tool call in order.
    for (const call of toolCalls) {
      const toolCallId = call?.id ?? null;
      const fnName = call?.function?.name;
      const rawArgs = call?.function?.arguments;
      const args = parseToolArgs(rawArgs);

      if (typeof fnName !== 'string' || fnName.length === 0 || !toolsByName.has(fnName)) {
        workingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: `Unknown tool: ${fnName ?? ''}`,
          isToolError: true,
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
        workingMessages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: `Tool execution failed: ${err?.message ?? String(err)}`,
          isToolError: true,
        });
        continue;
      }

      // Normalize the local-tool dispatch shape: kernel `tool.invoke`
      // returns `{ result: <envelope> }` per its handler contract,
      // while `space.tool.invoke` returns the envelope directly. The
      // dispatch* seam is allowed to do that unwrap on the way out,
      // but we defensively unwrap a `{ result }` shell here too.
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
        return {
          kind: 'approval_pending',
          toolCallId,
          toolName: fnName,
          args,
          envelope,
          conversationMessages: workingMessages,
          roundReached: round,
          aggregatedUsage,
          observedAnyUsage,
        };
      }

      // Class A success / tool-error envelope: `{ content, isToolError? }`.
      const content = typeof envelope?.content === 'string'
        ? envelope.content
        : typeof envelope === 'string'
          ? envelope
          : JSON.stringify(envelope ?? '');
      const toolMessage = {
        role: 'tool',
        tool_call_id: toolCallId,
        content,
      };
      if (envelope && typeof envelope === 'object' && envelope.isToolError === true) {
        toolMessage.isToolError = true;
      }
      workingMessages.push(toolMessage);
    }
  }

  // Exceeded effectiveMaxToolRounds without the provider terminating.
  return {
    kind: 'failed',
    text: `tool loop exceeded maxToolRounds (${effectiveMaxToolRounds})`,
    conversationMessages: workingMessages,
    aggregatedUsage,
    observedAnyUsage,
  };
}

/**
 * Build the brain.toolLoop handler.
 *
 * @param {{
 *   agentId: string,
 *   brainConfig?: object,
 *   aiConfigResolver?: (agentId: string, opts?: { configOverride?: object }) => object|undefined,
 *   clientFactory?: (cfg: { baseUrl: string, apiKey: string }) => object,
 *   callWithRetry?: Function,
 *   dispatchLocalTool: ({ name, args, ctx }) => Promise<unknown>,
 *   dispatchRemoteTool: ({ name, args, ctx }) => Promise<unknown>,
 *   sendNotification?: (method: string, payload: object) => void,
 *   suspensionsStore?: ToolLoopSuspensionsStore,
 * }} deps
 */
export function createBrainToolLoopHandler({
  agentId,
  brainConfig = null,
  aiConfigResolver = defaultResolveAiConfig,
  clientFactory = createAIClient,
  callWithRetry = defaultCallWithRetry,
  dispatchLocalTool,
  dispatchRemoteTool,
  sendNotification,
  suspensionsStore = null,
}) {
  if (!agentId) {
    throw new TypeError('createBrainToolLoopHandler requires agentId');
  }
  if (typeof dispatchLocalTool !== 'function') {
    throw new TypeError('createBrainToolLoopHandler requires dispatchLocalTool');
  }
  if (typeof dispatchRemoteTool !== 'function') {
    throw new TypeError('createBrainToolLoopHandler requires dispatchRemoteTool');
  }

  return async (params, kernelCtx) => {
    validateRequest(params, agentId);

    let resolvedConfig;
    try {
      resolvedConfig = resolveLoopConfig({
        agentId,
        aiConfigResolver,
        brainConfig,
        configOverride: params.configOverride,
      });
    } catch (err) {
      rejectApplication(err?.message ?? String(err), {
        code: 'BRAIN_TOOL_LOOP_CONFIG_UNAVAILABLE',
        retryable: false,
      });
    }

    const client = clientFactory({
      baseUrl: resolvedConfig.baseUrl ?? resolvedConfig.baseURL,
      apiKey: resolvedConfig.apiKey,
    });

    const requestedRounds = params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const effectiveMaxToolRounds = Math.min(requestedRounds, HARD_CAP_MAX_TOOL_ROUNDS);

    // Work on a copy so we never mutate the caller's array.
    const workingMessages = params.messages.map((m) => ({ ...m }));
    const toolsByName = new Map();
    if (Array.isArray(params.tools)) {
      for (const t of params.tools) {
        if (t && typeof t.name === 'string') {
          toolsByName.set(t.name, t);
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
        code: 'BRAIN_TOOL_LOOP_PROVIDER_ERROR',
        retryable: true,
        ...(outcome.cause ? { cause: outcome.cause } : {}),
      });
    }

    if (outcome.kind === 'completed') {
      if (outcome.observedAnyUsage) {
        emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
      }
      const envelope = {
        ok: true,
        text: outcome.text,
        agentId,
        status: 'completed',
        conversationMessages: outcome.conversationMessages,
      };
      if (outcome.observedAnyUsage) envelope.usage = outcome.aggregatedUsage;
      return envelope;
    }

    if (outcome.kind === 'approval_pending') {
      if (!suspensionsStore) {
        if (outcome.observedAnyUsage) {
          emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
        }
        rejectApplication(
          `tool ${outcome.toolName} returned APPROVAL_PENDING but daemon suspensions store is not wired`,
          {
            code: 'BRAIN_TOOL_LOOP_SUSPENSIONS_UNAVAILABLE',
            retryable: false,
            approvalId: outcome.envelope.approvalId ?? null,
            toolName: outcome.toolName,
            toolCallId: outcome.toolCallId,
          },
        );
      }

      const suspensionId = randomUUID();
      const maxToolRoundsRemaining = effectiveMaxToolRounds - outcome.roundReached;
      const approvalId = outcome.envelope.approvalId ?? null;

      try {
        suspensionsStore.insertPending({
          id: suspensionId,
          agentId,
          taskId: typeof params.taskId === 'string' && params.taskId.length > 0 ? params.taskId : null,
          sessionId: null,
          toolCallId: outcome.toolCallId,
          toolName: outcome.toolName,
          toolArgsJson: JSON.stringify(outcome.args ?? null),
          toolContextJson: JSON.stringify(toolCtx ?? null),
          conversationMessagesJson: JSON.stringify(outcome.conversationMessages),
          maxTokens: Number.isFinite(effectiveMaxTokens) ? effectiveMaxTokens : null,
          maxToolRoundsRemaining,
          approvalId,
          idempotencyKey: `${suspensionId}:${approvalId ?? 'none'}`,
          configOverrideJson: params.configOverride ? JSON.stringify(params.configOverride) : null,
        });
      } catch (err) {
        if (outcome.observedAnyUsage) {
          emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
        }
        rejectApplication(
          `failed to persist tool loop suspension: ${err?.message ?? err}`,
          {
            code: 'BRAIN_TOOL_LOOP_SUSPENSION_PERSIST_FAILED',
            retryable: false,
            toolName: outcome.toolName,
            toolCallId: outcome.toolCallId,
          },
        );
      }

      if (outcome.observedAnyUsage) {
        emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
      }

      const envelope = {
        ok: true,
        text: '',
        agentId,
        status: 'approval_pending',
        suspensionId,
        toolCallId: outcome.toolCallId,
        conversationMessages: outcome.conversationMessages,
      };
      if (outcome.observedAnyUsage) envelope.usage = outcome.aggregatedUsage;
      return envelope;
    }

    // outcome.kind === 'failed'
    if (outcome.observedAnyUsage) {
      emitTokenUsage({ sendNotification, agentId, usage: outcome.aggregatedUsage });
    }
    const envelope = {
      ok: true,
      text: outcome.text,
      agentId,
      status: 'failed',
      conversationMessages: outcome.conversationMessages,
    };
    if (outcome.observedAnyUsage) envelope.usage = outcome.aggregatedUsage;
    return envelope;
  };
}

/**
 * Register the brain.toolLoop handler against `kernel`. Builds default
 * `dispatchLocalTool` / `dispatchRemoteTool` callables wired into the
 * daemon-local `tool.invoke` kernel handler and the `space.tool.invoke`
 * IPC method respectively. Either may be overridden via deps for tests.
 *
 * When `agentCoreDb` is supplied, a `ToolLoopSuspensionsStore` is built
 * from it and forwarded so APPROVAL_PENDING dispatches persist durable
 * suspension rows.
 */
export function registerBrainToolLoopHandler(kernel, deps) {
  if (!kernel) {
    throw new TypeError('registerBrainToolLoopHandler requires kernel');
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
    throw new TypeError('registerBrainToolLoopHandler requires agentId');
  }

  const effectiveDispatchLocal = typeof dispatchLocalTool === 'function'
    ? dispatchLocalTool
    : async ({ name, args, ctx }) => kernel.dispatch('tool.invoke', { name, args, ctx });

  const effectiveDispatchRemote = typeof dispatchRemoteTool === 'function'
    ? dispatchRemoteTool
    : async ({ name, args, ctx }) => {
      if (!ipcAdapter || typeof ipcAdapter.request !== 'function') {
        // Surface the missing-adapter case as a Class A tool-error so
        // the loop can move on; mirrors the local tool-invoke fallback
        // shape in src/lib/daemon-tool-invoke.js.
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
    createBrainToolLoopHandler({
      agentId,
      brainConfig,
      aiConfigResolver,
      clientFactory,
      callWithRetry,
      dispatchLocalTool: effectiveDispatchLocal,
      dispatchRemoteTool: effectiveDispatchRemote,
      sendNotification,
      suspensionsStore,
    }),
  );
}
