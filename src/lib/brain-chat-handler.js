// Phase 16.L2'.4 — daemon-side `brain.chat` streaming handler.
//
// The handler signature follows the Kernel contract: `async (params, ctx)`.
// Streaming chunks fly via `ctx.emitChunk(chunk)`; the final return value
// is wrapped by the IPC adapter into the `result.done` envelope (see
// `adapters/ipc.js` `_handleRequest`).
//
// Wire shape (Design §2.6 + §8.2.3):
//
//   Each partial chunk is shipped over IPC as
//     { jsonrpc:'2.0', id:<reqId>, result: { partial:true, chunk } }
//   The chunk payload itself is `{ delta: '<token text>' }` per §8.2.3
//   ("`{ delta: '...partial text...' }`"). The Space-side route relays
//   it verbatim into the SSE stream so the browser receives
//     data: {"delta":"...partial text..."}\n\n
//
// The handler resolves the LLM config via
// `resolveAiConfig(agentId, { configOverride })` so that:
//   - The Athena route's `configOverride: getAthenaAIConfig()` is
//     honoured end-to-end (special-role agent provider routing).
//   - Default agents fall through to the cache primed at daemon init
//     by the supervisor's `brainConfig` field (INV-5).
//
// Production now streams through the daemon-local provider helper. Test
// fixtures may still inject a deterministic `llmFactory` to keep SSE /
// back-pressure / cancel tests reproducible. We provide:
//
//   1. A deterministic stub LLM (`createStubLlm`) — emits a fixed token
//      sequence when explicitly injected.
//   2. A streaming runner (`runBrainChatTurn`) that walks an arbitrary
//      LLM token source, calls `ctx.emitChunk({ delta })` per token, and
//      resolves with `{ done:true, totalCount:N }` when the source is
//      exhausted.
//   3. A back-pressure helper (`emitChunkWithBackpressure`) — when
//      `process.send(...)` returns false (IPC pipe full, ~64 KB on
//      Linux), yields to the event loop with `setImmediate` so the
//      pipe drains before the next token. Per Design §8.2.3.
//
// The handler is wired in two places:
//   - production: `bin/agent-core-daemon.js` S8 (real daemon)
//   - tests:      `tests/fixtures/athena-brain-chat-daemon.js`

import { streamChatCompletion as defaultStreamChatCompletion } from './llm-provider/streaming-chat.js';
import { resolveAiConfig } from './resolveAiConfig.js';

/**
 * Build a deterministic stub LLM that emits a fixed token sequence.
 * Used in tests where reproducibility matters more than realism.
 *
 * @param {string[]} tokens
 * @returns {() => AsyncIterable<string>}
 */
export function createStubLlm(tokens) {
  return async function* stubLlmStream() {
    for (const token of tokens) {
      yield token;
    }
  };
}

/**
 * Emit one chunk with back-pressure awareness.
 *
 * `ctx.emitChunk` itself is synchronous (the IPC adapter wraps the
 * write in `process.send`). The adapter does not surface the boolean
 * return value of `process.send`, so we sniff it via the optional
 * `processRef` hook the caller threads through. When the OS-level pipe
 * is full (~64 KB on Linux), `process.send` returns false; per Design
 * §8.2.3 the handler yields to the event loop via `setImmediate` so
 * the libuv reactor can drain the pipe before the next chunk lands.
 *
 * The yield is `await new Promise(r => setImmediate(r))` (equivalent to
 * `setTimeout(r, 0)` in the Plan but cheaper) so even a synchronous
 * chunk loop becomes cooperative.
 *
 * @param {{ emitChunk: (chunk: any) => void }} ctx
 * @param {any} chunk
 * @param {{ processRef?: NodeJS.Process, onPipeFull?: () => void }} [opts]
 */
export async function emitChunkWithBackpressure(ctx, chunk, opts = {}) {
  const processRef = opts.processRef ?? process;

  // Capture the return value of the underlying process.send by wrapping
  // it for the duration of this single emit. The adapter calls
  // `processRef.send(envelope)` synchronously inside `_send`; we replace
  // it with a thin probe that records the boolean and forwards.
  let pipeFull = false;
  const origSend = processRef.send;
  if (origSend) {
    processRef.send = (envelope, ...rest) => {
      const ok = origSend.call(processRef, envelope, ...rest);
      // `process.send` returns false when the channel is full, true
      // otherwise. Treat undefined as ok for older Node variants.
      if (ok === false) pipeFull = true;
      return ok;
    };
  }

  try {
    ctx.emitChunk(chunk);
  } finally {
    if (origSend) processRef.send = origSend;
  }

  if (pipeFull) {
    if (typeof opts.onPipeFull === 'function') {
      try { opts.onPipeFull(); } catch { /* test hook only */ }
    }
    // Yield to the event loop so libuv can drain the IPC pipe before
    // the next chunk goes out. Plan §L2'.5 specifies `setTimeout(r, 0)`;
    // `setImmediate` accomplishes the same but skips the 1ms minimum
    // timer floor on Linux.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function withResolvedConfigMarker(ctx, resolvedConfig) {
  let attached = false;
  return {
    ...ctx,
    emitChunk: (chunk) => {
      if (!attached && chunk && typeof chunk === 'object') {
        // eslint-disable-next-line no-param-reassign
        chunk._aiConfig = resolvedConfig;
        attached = true;
      }
      ctx.emitChunk(chunk);
    },
  };
}

function createConfigUnavailableError(agentId) {
  const err = new Error(
    `daemon_ai_config_unavailable: no cached config for agentId='${agentId}' and no configOverride supplied`,
  );
  err.code = 'daemon_ai_config_unavailable';
  return err;
}

/**
 * Walk an LLM token source and emit one streaming chunk per token.
 *
 * @param {AsyncIterable<string>} llmStream
 * @param {{ emitChunk: (chunk: any) => void }} ctx
 * @param {{ processRef?: NodeJS.Process, onPipeFull?: () => void }} [opts]
 * @returns {Promise<{ done: true, totalCount: number }>}
 */
export async function runBrainChatTurn(llmStream, ctx, opts = {}) {
  let totalCount = 0;
  for await (const token of llmStream) {
    await emitChunkWithBackpressure(ctx, { delta: token }, opts);
    totalCount += 1;
  }
  return { done: true, totalCount };
}

/**
 * Build the daemon-side `brain.chat` handler.
 *
 * Production wiring uses the daemon-local provider helper. Tests may
 * inject a deterministic stub via `llmFactory` so the SSE /
 * back-pressure / cancel suites are reproducible.
 *
 * Handler params shape (matches the Plan §L2'.4 + §L3'.3 contract):
 *   { messages, tools, stream:true, configOverride?, ...override fields per Design §8.3.3 }
 *
 * L3'.A wiring (Plan §L3'.3 + Design §8.3.3):
 *   - The handler reads `params.configOverride` and the daemon's bound
 *     `agentId` (via the factory closure — the daemon process is one
 *     agent per Design §3.1, so the agentId is fixed at register time)
 *     and threads them through `aiConfigResolver(...)` to obtain the
 *     resolved provider/model triple.
 *   - The resolved config drives the provider call. It is only attached
 *     to emitted chunks when `includeResolvedConfigMarker` is explicitly
 *     enabled for tests.
 *   - When the resolver returns `undefined` (cache cold + no override)
 *     we throw a structured error so the IPC envelope carries a real
 *     reason instead of a silent stall.
 *
 * @param {{
 *   llmFactory?: (params: any) => AsyncIterable<string>,
 *   streamChatCompletion?: (params: any) => AsyncIterable<string>,
 *   processRef?: NodeJS.Process,
 *   onPipeFull?: () => void,
 *   agentId?: string,
 *   aiConfigResolver?: (agentId: string, options?: { configOverride?: object }) => object | undefined,
 *   includeResolvedConfigMarker?: boolean,
 * }} [opts]
 * @returns {(params: any, ctx: any) => Promise<{ done: true, totalCount: number, usage?: object }>}
 */
export function createBrainChatHandler(opts = {}) {
  const llmFactory = opts.llmFactory ?? null;
  const streamChatCompletion = opts.streamChatCompletion ?? defaultStreamChatCompletion;
  const hasExplicitAiConfigResolver = typeof opts.aiConfigResolver === 'function';
  const aiConfigResolver = opts.aiConfigResolver ?? resolveAiConfig;
  const boundAgentId = opts.agentId ?? null;

  return async function brainChatHandler(params, ctx) {
    const safeParams = params ?? {};
    const hasConfigOverride =
      safeParams.configOverride !== null &&
      safeParams.configOverride !== undefined;
    const configOverride = hasConfigOverride ? safeParams.configOverride : null;

    let resolvedConfig = null;
    const shouldResolveConfig =
      !llmFactory ||
      hasExplicitAiConfigResolver ||
      opts.includeResolvedConfigMarker;
    if (shouldResolveConfig) {
      const agentId = boundAgentId ?? ctx?.agentId ?? null;
      resolvedConfig = aiConfigResolver(
        agentId,
        hasConfigOverride ? { configOverride } : undefined,
      );
      if (resolvedConfig === undefined) {
        throw createConfigUnavailableError(agentId);
      }
    }

    const outputCtx = opts.includeResolvedConfigMarker && resolvedConfig
      ? withResolvedConfigMarker(ctx, resolvedConfig)
      : ctx;

    if (llmFactory) {
      const stream = llmFactory(safeParams);
      return runBrainChatTurn(stream, outputCtx, {
        processRef: opts.processRef,
        onPipeFull: opts.onPipeFull,
      });
    }

    let usage;
    const effectiveMaxTokens =
      safeParams.maxTokens ||
      safeParams.max_tokens ||
      resolvedConfig?.maxTokens;
    const stream = streamChatCompletion({
      config: resolvedConfig,
      messages: safeParams.messages,
      tools: safeParams.tools,
      maxTokens: effectiveMaxTokens,
      onUsage: (nextUsage) => {
        usage = nextUsage;
      },
      signal: ctx?.signal,
    });
    const result = await runBrainChatTurn(stream, outputCtx, {
      processRef: opts.processRef,
      onPipeFull: opts.onPipeFull,
    });
    if (usage !== undefined) {
      return { ...result, usage };
    }
    return result;
  };
}
