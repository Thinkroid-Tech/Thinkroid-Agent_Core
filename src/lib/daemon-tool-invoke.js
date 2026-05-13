// Daemon-side `tool.invoke` kernel handler.
//
// Dispatcher behaviour:
//
//   1. Looks up the tool definition in the daemon's tool registry
//      (populated from the init payload `toolList` plus runtime
//      `tool:added` / `tool:removed` push notifications).
//   2. Discriminates on `tool.executor`:
//        - 'local'  → invoke the daemon-internal handler directly
//                     (recall now, mem:* in future iterations),
//        - 'remote' → delegate to Space via IPC `space.tool.invoke`.
//                     Class A tool-level errors pass through unchanged;
//                     Class B transport errors are wrapped into the
//                     daemon-side tool-result envelope so the LLM
//                     tool-loop sees a uniform `{ content, isToolError? }`
//                     shape regardless of where the failure originated.
//   3. Wraps the local-tool result into the `{ result }` envelope the
//      tool-loop layer expects.
//
// The daemon owns this dispatcher outright for local tools. For remote
// tools the daemon round-trips back through the SpaceIpcAdapter to a
// single Space-side kernel that hosts the `space.tool.invoke` handler.
// The Space-side supervisor still only ships tool *definitions* to the
// daemon at init; the actual executor closures stay in the Space process.

import { internalToolRegistry } from '../brain/internal-tools/index.js';
import { throwJsonRpcError } from '../kernel.js';
import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { IPC_METHOD_TIMEOUTS_MS } from '../adapters/ipc-timeouts.js';

/**
 * Build the `tool.invoke` kernel handler. The factory binds the daemon's
 * tool registry + the runtime context the local tools need (memDb /
 * agentCoreDb handles, the `thinkDeeper` closure, etc.) plus the IPC
 * adapter handle the dispatcher uses to round-trip remote tool calls
 * back to Space's `space.tool.invoke` kernel handler.
 *
 * @param {{
 *   toolRegistry: { getAll: () => Array<object> },
 *   localContext: { thinkDeeper?: (q: string) => Promise<string>, memDb?: any, agentCoreDb?: any },
 *   ipcAdapter?: { request: (method: string, params: any, opts?: any) => Promise<any> } | null,
 *   agentId?: string|null,
 *   agentName?: string|null,
 * }} deps
 * @returns {(params: { name: string, args?: object, ctx?: object }, kernelCtx: object) => Promise<{ result: unknown }>}
 */
export function createToolInvokeHandler({
  toolRegistry,
  localContext,
  ipcAdapter = null,
  agentId = null,
  agentName = null,
}) {
  if (!toolRegistry || typeof toolRegistry.getAll !== 'function') {
    throw new TypeError('createToolInvokeHandler: toolRegistry is required');
  }
  if (!localContext || typeof localContext !== 'object') {
    throw new TypeError('createToolInvokeHandler: localContext is required');
  }

  return async function toolInvokeHandler(params, kernelCtx) {
    const name = params?.name;
    const args = params?.args ?? {};
    const callerCtx = params?.ctx ?? {};

    if (typeof name !== 'string' || name.length === 0) {
      throwJsonRpcError(
        IPC_ERROR_CODES.METHOD_NOT_FOUND,
        'tool.invoke: missing tool name',
        { params },
      );
    }

    // 1. Look up tool def in the daemon's registry. The registry is the
    //    authoritative list — it carries the `executor` discriminator
    //    that drives the local/remote split.
    const tool = toolRegistry
      .getAll()
      .find((t) => t?.function?.name === name);
    if (!tool) {
      throwJsonRpcError(
        IPC_ERROR_CODES.METHOD_NOT_FOUND,
        `Tool not found in daemon registry: ${name}`,
        { name },
      );
    }

    // 2. Discriminate on executor.
    if (tool.executor === 'local') {
      const result = await invokeLocalTool({
        toolName: name,
        args,
        callerCtx,
        kernelCtx,
        localContext,
      });
      return { result };
    }

    if (tool.executor === 'remote') {
      const result = await invokeRemoteTool({
        toolName: name,
        args,
        callerCtx,
        ipcAdapter,
        agentId,
        agentName,
      });
      return { result };
    }

    throwJsonRpcError(
      IPC_ERROR_CODES.INTERNAL_ERROR,
      `Tool ${name} has unknown executor: ${tool.executor}`,
      { name, executor: tool.executor },
    );
  };
}

/**
 * Delegate a remote tool call back to Space via IPC.
 *
 * Wire contract:
 *
 *   - On success the Space-side handler returns a tool-result envelope:
 *
 *       { content: '<text>' }                                  // Class A success
 *       { content: '<error message>', isToolError: true }      // Class A tool error
 *
 *     Both shapes carry an OK transport, so they pass through to the
 *     daemon-side LLM tool-loop verbatim. The LLM sees the same
 *     `{ content, isToolError? }` shape it expects from local tools.
 *
 *   - Approval-pending envelope (new, daemon→Space tool callback bridge):
 *
 *       { ok: false, code: 'APPROVAL_PENDING', approvalId, name, args }
 *
 *     Returned verbatim. A future tool-loop handler consumes this
 *     directly to persist suspension state; existing `tool.invoke`
 *     callers (text-only paths) do not invoke approval-bearing tools
 *     and therefore never observe this shape in practice.
 *
 *   - Class B transport errors (no live daemon ↔ space, missing
 *     handler, internal Space crash) surface as a JsonRpcError throw
 *     from `ipcAdapter.request`. The dispatcher catches the throw and
 *     re-wraps it as a Class A tool-result so the LLM sees a uniform
 *     failure envelope; without this wrap, an IPC-layer hiccup would
 *     bubble up through the daemon kernel and crash the tool-loop turn.
 *
 * @param {{
 *   toolName: string,
 *   args: object,
 *   callerCtx: object,
 *   ipcAdapter: { request: Function }|null,
 *   agentId: string|null,
 *   agentName: string|null,
 * }} deps
 * @returns {Promise<
 *   { content: string, isToolError?: boolean }
 *   | { ok: false, code: string, approvalId?: string, name?: string, args?: object }
 * >}
 */
async function invokeRemoteTool({
  toolName,
  args,
  callerCtx,
  ipcAdapter,
  agentId,
  agentName,
}) {
  if (!ipcAdapter || typeof ipcAdapter.request !== 'function') {
    // No IPC adapter wired (e.g. unit-test daemon harness without a
    // SpaceIpcAdapter). Surface as a Class A tool-result so the LLM
    // tool-loop can move on instead of hanging on an unresolved
    // promise.
    return {
      content: `Tool execution failed: remote dispatch unavailable (no IPC adapter)`,
      isToolError: true,
    };
  }

  // Round-trip context: thread the daemon's identity + caller-supplied
  // session/turn ids back to Space so `buildToolContext` can populate
  // the per-agent fields (projectId, orgIds, agentName lookup, etc.).
  const ctx = {
    agentId,
    agentName,
    ...callerCtx,
  };

  try {
    const result = await ipcAdapter.request(
      'space.tool.invoke',
      { name: toolName, args, ctx },
      { timeoutMs: IPC_METHOD_TIMEOUTS_MS['space.tool.invoke'] },
    );
    // Pass the Class A tool-result envelope through unchanged. Defensive
    // null-guard so an unexpected `undefined` from the wire doesn't
    // explode the LLM tool-loop.
    if (!result || typeof result !== 'object') {
      return {
        content: `Tool execution failed: empty response from Space for ${toolName}`,
        isToolError: true,
      };
    }
    // Recognise the daemon→Space tool callback approval bridge envelope
    // (`{ ok: false, code: 'APPROVAL_PENDING', approvalId, name, args }`)
    // and surface it as-is to the caller. The future tool-loop handler
    // consumes this directly to persist suspension state; current
    // `tool.invoke` callers do not invoke approval-bearing tools, so
    // they never see this shape in practice. Note that to a legacy
    // caller expecting `{ content, isToolError? }` this envelope reads
    // as "unrecognised" — intentional: the legacy callers can't act on
    // a pending approval anyway, and shape-matching it here is the
    // contract pivot the new tool-loop relies on.
    if (
      result.ok === false &&
      typeof result.code === 'string' &&
      result.code === 'APPROVAL_PENDING'
    ) {
      return result;
    }
    // Defensive shape-guard: any other `{ ok: false }` payload (with or
    // without a `code` field) is returned verbatim too — never coerced
    // into a phoney `{ content }` envelope. This keeps room for future
    // structured-error codes without forcing them through a
    // tool-result re-wrap.
    if (result.ok === false) {
      return result;
    }
    return result;
  } catch (err) {
    // Class B transport-level error — wrap into Class A so the LLM
    // tool-loop sees a uniform failure shape. The original message is
    // preserved verbatim for debugging.
    return {
      content: `Tool execution failed: ${err?.message ?? String(err)}`,
      isToolError: true,
    };
  }
}

/**
 * Dispatch a local tool by name. v1 only wires `recall` — additional
 * `mem:*` tools will be appended here as later sub-phases land.
 *
 * @param {{
 *   toolName: string,
 *   args: object,
 *   callerCtx: object,
 *   kernelCtx: object,
 *   localContext: object,
 * }} args
 * @returns {Promise<unknown>}
 */
async function invokeLocalTool({ toolName, args, callerCtx, kernelCtx, localContext }) {
  const entry = internalToolRegistry.get(toolName);
  if (!entry) {
    // The registry says executor='local' but the internal-tool registry
    // doesn't have this name registered. That's a daemon-config bug —
    // surface as INTERNAL_ERROR so the supervisor records the right
    // failure mode (vs METHOD_NOT_FOUND, which would suggest the IPC
    // method itself was wrong).
    throwJsonRpcError(
      IPC_ERROR_CODES.INTERNAL_ERROR,
      `Local tool '${toolName}' is registered but has no internal handler`,
      { toolName },
    );
  }

  // Build the toolContext the internal-tool handler closure expects.
  // recall.js reads `ctx.thinkDeeper`; future mem:* tools read
  // `ctx.memDb` / `ctx.agentCoreDb`. Caller-supplied ctx fields
  // override daemon defaults so a Space-side caller can pass
  // session-scoped context (sessionId, turnId, etc.) through unchanged.
  const toolCtx = {
    ...localContext,
    ...callerCtx,
    kernel: kernelCtx,
  };

  const handler = entry.createHandler(toolCtx);
  return handler(args);
}
