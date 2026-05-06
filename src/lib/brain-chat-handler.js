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
// L3'.A scope (per Plan §L3'.3): the handler now resolves the LLM
// config via `resolveAiConfig(agentId, { configOverride })` so that:
//   - The Athena route's `configOverride: getAthenaAIConfig()` is
//     honoured end-to-end (special-role agent provider routing).
//   - Default agents fall through to the cache primed at daemon init
//     by the supervisor's `brainConfig` field (INV-5).
// Real provider integration (the actual LLM HTTP call) still lands in
// a follow-up sub-phase; until then the resolved config is attached to
// each emitted chunk's `_aiConfig` field (test-only marker) so the
// integration tests can prove the resolver was wired without standing
// up a real model.
//
// L2'.4 / L2'.B legacy: this is a stub that does NOT call a real LLM.
// The actual provider integration lands in L3' / Phase 17+. We provide:
//
//   1. A deterministic stub LLM (`createStubLlm`) — emits a fixed token
//      sequence so the SSE / back-pressure / cancel tests are
//      reproducible without depending on a network.
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
//
// Test fixtures customize the LLM source (e.g. 5 tokens, or many small
// tokens to exercise pipe-full back-pressure). Production uses a TODO
// stub until L3' / Phase 17 wires the provider adapters.

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
  const origSend = processRef.send?.bind(processRef);
  if (origSend) {
    processRef.send = (envelope, ...rest) => {
      const ok = origSend(envelope, ...rest);
      // `process.send` returns false when the channel is full, true
      // otherwise. Older Node versions returned undefined; treat that
      // as ok. A throw still bubbles out of origSend.
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
 * Production wiring threads in a real LLM caller (L3' / Phase 17+).
 * Tests inject a deterministic stub via `llmFactory` so the SSE /
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
 *   - The resolved config is attached to each emitted chunk under the
 *     `_aiConfig` field so the L3'.A integration tests can assert the
 *     resolver wiring without standing up a real LLM. Once a real
 *     provider integration lands the config will drive the actual HTTP
 *     call and the test marker can come off.
 *   - When the resolver returns `undefined` (cache cold + no override)
 *     we throw a structured error so the IPC envelope carries a real
 *     reason instead of a silent stall.
 *
 * @param {{
 *   llmFactory?: (params: any) => AsyncIterable<string>,
 *   processRef?: NodeJS.Process,
 *   onPipeFull?: () => void,
 *   agentId?: string,
 *   aiConfigResolver?: (agentId: string, options?: { configOverride?: object }) => object | undefined,
 * }} [opts]
 * @returns {(params: any, ctx: any) => Promise<{ done: true, totalCount: number }>}
 */
export function createBrainChatHandler(opts = {}) {
  const llmFactory =
    opts.llmFactory ??
    (() => createStubLlm(['Hello', ' ', 'world'])());
  const aiConfigResolver = opts.aiConfigResolver ?? null;
  const boundAgentId = opts.agentId ?? null;

  return async function brainChatHandler(params, ctx) {
    const safeParams = params ?? {};
    const configOverride = safeParams.configOverride ?? null;

    // Resolve only when a resolver was injected — legacy fixtures (the
    // L2' SSE / back-pressure / cancel suites) don't supply one, and
    // we must keep their stub-LLM contract intact (no marker, no
    // throw). New L3'.A code paths always inject the resolver.
    let resolvedConfig = null;
    if (aiConfigResolver) {
      const agentId = boundAgentId ?? ctx?.agentId ?? null;
      resolvedConfig = aiConfigResolver(agentId, configOverride
        ? { configOverride }
        : undefined);
      if (resolvedConfig === undefined) {
        const err = new Error(
          `daemon_ai_config_unavailable: no cached config for agentId='${agentId}' and no configOverride supplied`,
        );
        err.code = 'daemon_ai_config_unavailable';
        throw err;
      }
    }

    const stream = llmFactory(safeParams);
    // Wrap the runner so we can attach the resolved config to the
    // first emitted chunk. We don't want to mutate every chunk because
    // the SSE bridge serialises each one and the marker is only useful
    // for the integration test's first-chunk assertion. Producing it
    // exactly once also keeps the wire bytes the legacy fixtures
    // already exercise unchanged.
    if (aiConfigResolver) {
      let attached = false;
      const wrappedCtx = {
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
      return runBrainChatTurn(stream, wrappedCtx, {
        processRef: opts.processRef,
        onPipeFull: opts.onPipeFull,
      });
    }

    return runBrainChatTurn(stream, ctx, {
      processRef: opts.processRef,
      onPipeFull: opts.onPipeFull,
    });
  };
}
