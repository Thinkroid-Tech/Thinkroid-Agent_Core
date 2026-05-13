import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import {
  clearAiConfig,
  setAiConfig,
} from '../../src/lib/resolveAiConfig.js';
import {
  createBrainChatToolStreamHandler,
  registerBrainChatToolStreamHandler,
} from '../../src/handlers/brain-chat-tool-stream-handler.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

function validPayload(overrides = {}) {
  return {
    agentId: AGENT_ID,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ],
    source: 'tests.brain-chat-tool-stream',
    stream: true,
    ...overrides,
  };
}

/**
 * Build a fake streaming chat completion. Each script entry describes a
 * single round and is consumed left-to-right across loop iterations:
 *
 *   { textDeltas?: string[], usage?: object, toolCalls?: ToolCall[], throws?: (deltas:string[]) => Error }
 *
 * The fake returns an async generator that yields textDeltas in order;
 * after the last delta (or before any when `throws` fires) it invokes
 * `onToolCall` once per tool call, then resolves. `onUsage` is invoked
 * once with `usage` if provided.
 */
function makeFakeStream(script) {
  const fn = vi.fn(({ onUsage, onToolCall }) => {
    if (script.length === 0) {
      throw new Error('makeFakeStream: no more rounds queued');
    }
    const next = script.shift();
    async function* gen() {
      const deltas = next.textDeltas ?? [];
      let emittedCount = 0;
      for (const delta of deltas) {
        if (next.throwAfter !== undefined && emittedCount === next.throwAfter) {
          throw next.throwAfter.kind === 'abort'
            ? makeAbortError()
            : new Error(next.throwError ?? 'provider exploded');
        }
        yield delta;
        emittedCount += 1;
      }
      if (next.throwAtEnd) {
        if (next.throwAtEnd === 'abort') throw makeAbortError();
        throw new Error(next.throwError ?? 'provider exploded');
      }
      if (next.usage && typeof onUsage === 'function') {
        onUsage(next.usage);
      }
      if (Array.isArray(next.toolCalls)) {
        for (const call of next.toolCalls) {
          // The real streamChatCompletion already parses args; emulate
          // the parsed shape here.
          await onToolCall({
            type: 'tool_call',
            toolCallId: call.toolCallId,
            name: call.name,
            args: call.args,
            finishReason: call.finishReason ?? 'tool_calls',
          });
        }
      }
    }
    return gen();
  });
  return fn;
}

function makeAbortError() {
  const err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

function makeBaseDeps(overrides = {}) {
  return {
    agentId: AGENT_ID,
    brainConfig: { baseUrl: 'http://localhost', apiKey: 'k', model: 'm' },
    aiConfigResolver: () => ({ baseUrl: 'http://localhost', apiKey: 'k', model: 'm' }),
    dispatchLocalTool: vi.fn(async () => ({ content: 'local ok' })),
    dispatchRemoteTool: vi.fn(async () => ({ content: 'remote ok' })),
    sendNotification: vi.fn(),
    ...overrides,
  };
}

function makeCtx() {
  return { emitChunk: vi.fn() };
}

function expectJsonRpcApplicationError(promise, predicate) {
  return promise.then(
    () => {
      throw new Error('expected promise to reject but it resolved');
    },
    (err) => {
      expect(err.jsonRpc).toMatchObject({ code: IPC_ERROR_CODES.APPLICATION });
      predicate(err);
    },
  );
}

beforeEach(() => {
  clearAiConfig();
});

afterEach(() => {
  clearAiConfig();
});

describe('brain.chatToolStream handler — registration + validation', () => {
  it('registers on the kernel', () => {
    const kernel = new Kernel();
    registerBrainChatToolStreamHandler(kernel, makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    expect(kernel.listMethods()).toContain('brain.chatToolStream');
  });

  it('rejects missing agentId', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    const payload = validPayload();
    delete payload.agentId;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId must be a UUID string');
      },
    );
  });

  it('rejects missing messages', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    const payload = validPayload();
    delete payload.messages;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('messages must be a non-empty array');
      },
    );
  });

  it('rejects missing source', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    const payload = validPayload();
    delete payload.source;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('source must be a non-empty string');
      },
    );
  });

  it('rejects when stream is not true', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ stream: false }), makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('stream must be true');
      },
    );
  });

  it('rejects when stream is omitted', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    const payload = validPayload();
    delete payload.stream;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('stream must be true');
      },
    );
  });

  it('rejects non-object configOverride', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ configOverride: 'not-object' }), makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('configOverride must be an object when provided');
      },
    );
  });

  it('rejects non-object backupConfigOverride', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ backupConfigOverride: 'nope' }), makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('backupConfigOverride must be an object when provided');
      },
    );
  });

  it('rejects tools[i] with invalid executor', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({
        tools: [{ name: 'x', executor: 'space' }],
      }), makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('tools[0].executor must be');
      },
    );
  });

  it('rejects agentId that mismatches the bound agent', async () => {
    const handler = createBrainChatToolStreamHandler(makeBaseDeps({
      streamChatCompletion: makeFakeStream([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ agentId: OTHER_AGENT_ID }), makeCtx())),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId mismatch');
      },
    );
  });
});

describe('brain.chatToolStream handler — text-only streaming', () => {
  it('emits text_chunk partials and resolves with status=completed', async () => {
    const stream = makeFakeStream([
      { textDeltas: ['Hel', 'lo'] },
    ]);
    const deps = makeBaseDeps({ streamChatCompletion: stream });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload(), ctx);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Hello');
    expect(result.agentId).toBe(AGENT_ID);
    expect(deps.dispatchLocalTool).not.toHaveBeenCalled();
    expect(deps.dispatchRemoteTool).not.toHaveBeenCalled();

    const textChunks = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .filter((c) => c.type === 'text_chunk');
    expect(textChunks).toHaveLength(2);
    expect(textChunks[0]).toEqual({ type: 'text_chunk', delta: 'Hel' });
    expect(textChunks[1]).toEqual({ type: 'text_chunk', delta: 'lo' });

    expect(result.conversationMessages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Hello',
    });
    expect(result.conversationMessages.at(-1)).not.toHaveProperty('tool_calls');
  });
});

describe('brain.chatToolStream handler — single-tool streaming', () => {
  it('emits text_chunks, tool_use, tool_result, then completes', async () => {
    const stream = makeFakeStream([
      {
        textDeltas: ['working...'],
        toolCalls: [
          { toolCallId: 'c1', name: 'lookup', args: { q: 'x' } },
        ],
      },
      { textDeltas: ['final answer'] },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async () => ({ content: 'tool said hi' })),
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'lookup', executor: 'local' }],
    }), ctx);

    expect(result.status).toBe('completed');
    expect(result.text).toBe('final answer');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(1);
    expect(deps.dispatchLocalTool).toHaveBeenCalledWith({
      name: 'lookup',
      args: { q: 'x' },
      ctx: expect.objectContaining({ agentId: AGENT_ID }),
    });

    const types = ctx.emitChunk.mock.calls.map((c) => c[0].type);
    expect(types).toEqual([
      'text_chunk',
      'tool_use',
      'tool_result',
      'text_chunk',
    ]);
    const toolUse = ctx.emitChunk.mock.calls[1][0];
    expect(toolUse).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      name: 'lookup',
      args: { q: 'x' },
      round: 1,
    });
    const toolResult = ctx.emitChunk.mock.calls[2][0];
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      id: 'c1',
      name: 'lookup',
      result: 'tool said hi',
      round: 1,
    });

    // Assistant message in conversation should retain the original
    // tool_calls payload in OpenAI shape so the next provider round
    // sees it correctly.
    const assistantWithCalls = result.conversationMessages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    );
    expect(assistantWithCalls).toBeDefined();
    expect(assistantWithCalls.tool_calls[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: {
        name: 'lookup',
        arguments: JSON.stringify({ q: 'x' }),
      },
    });
  });
});

describe('brain.chatToolStream handler — multi-tool streaming within a round', () => {
  it('emits tool_use + tool_result for each call in order', async () => {
    const stream = makeFakeStream([
      {
        toolCalls: [
          { toolCallId: 'c1', name: 'a', args: { v: 1 } },
          { toolCallId: 'c2', name: 'b', args: { v: 2 } },
        ],
      },
      { textDeltas: ['done'] },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async ({ name }) => ({ content: `r:${name}` })),
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [
        { name: 'a', executor: 'local' },
        { name: 'b', executor: 'local' },
      ],
    }), ctx);

    expect(result.status).toBe('completed');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(2);

    const orderedTypes = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .filter((c) => c.type === 'tool_use' || c.type === 'tool_result')
      .map((c) => `${c.type}:${c.id}`);
    expect(orderedTypes).toEqual([
      'tool_use:c1',
      'tool_result:c1',
      'tool_use:c2',
      'tool_result:c2',
    ]);
  });
});

describe('brain.chatToolStream handler — multi-round streaming', () => {
  it('emits chunks in order across rounds', async () => {
    const stream = makeFakeStream([
      {
        textDeltas: ['thinking '],
        toolCalls: [{ toolCallId: 'c1', name: 'a', args: {} }],
      },
      { textDeltas: ['done'] },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), ctx);

    expect(result.status).toBe('completed');
    const types = ctx.emitChunk.mock.calls.map((c) => c[0].type);
    expect(types).toEqual([
      'text_chunk',
      'tool_use',
      'tool_result',
      'text_chunk',
    ]);

    // Verify the round-1 tool_use carries round:1 and the round-2
    // text_chunk arrives after the round-1 tool_result.
    expect(ctx.emitChunk.mock.calls[1][0].round).toBe(1);
    expect(ctx.emitChunk.mock.calls[2][0].round).toBe(1);
  });
});

describe('brain.chatToolStream handler — approval-required mid-stream', () => {
  function makeStubSuspensionsStore() {
    return {
      insertPending: vi.fn(),
      getById: vi.fn(),
      markResumed: vi.fn(),
      markCancelled: vi.fn(),
      markExpired: vi.fn(),
    };
  }

  it('persists a suspension, emits approval_required, and resolves approval_pending', async () => {
    const stream = makeFakeStream([
      {
        toolCalls: [{ toolCallId: 'c1', name: 'risky', args: { ammo: 'live' } }],
      },
    ]);
    const suspensionsStore = makeStubSuspensionsStore();
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchRemoteTool: vi.fn(async () => ({
        ok: false,
        code: 'APPROVAL_PENDING',
        approvalId: 'a1',
        name: 'risky',
        args: { ammo: 'live' },
      })),
      suspensionsStore,
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'risky', executor: 'remote' }],
    }), ctx);

    expect(result).toMatchObject({
      ok: true,
      status: 'approval_pending',
      agentId: AGENT_ID,
      toolCallId: 'c1',
    });
    expect(typeof result.suspensionId).toBe('string');
    expect(result.suspensionId.length).toBeGreaterThan(0);

    expect(suspensionsStore.insertPending).toHaveBeenCalledTimes(1);
    const inserted = suspensionsStore.insertPending.mock.calls[0][0];
    expect(inserted).toMatchObject({
      id: result.suspensionId,
      agentId: AGENT_ID,
      toolCallId: 'c1',
      toolName: 'risky',
      approvalId: 'a1',
    });
    expect(JSON.parse(inserted.toolArgsJson)).toEqual({ ammo: 'live' });

    const approvalChunk = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .find((c) => c.type === 'approval_required');
    expect(approvalChunk).toMatchObject({
      type: 'approval_required',
      suspensionId: result.suspensionId,
      toolCallId: 'c1',
      name: 'risky',
      args: { ammo: 'live' },
    });
  });
});

describe('brain.chatToolStream handler — provider error mid-stream', () => {
  it('emits chunks already streamed, then throws BRAIN_CHAT_TOOL_STREAM_PROVIDER_ERROR', async () => {
    const stream = makeFakeStream([
      {
        textDeltas: ['hi'],
        throwAtEnd: 'error',
        throwError: 'upstream 502',
      },
    ]);
    const deps = makeBaseDeps({ streamChatCompletion: stream });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload(), ctx)),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_CHAT_TOOL_STREAM_PROVIDER_ERROR',
          retryable: true,
        });
        expect(err.jsonRpc.message).toContain('upstream 502');
      },
    );
    const textChunks = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .filter((c) => c.type === 'text_chunk');
    expect(textChunks).toHaveLength(1);
    expect(textChunks[0]).toEqual({ type: 'text_chunk', delta: 'hi' });
  });

  it('wraps AbortError as BRAIN_CHAT_TOOL_STREAM_INTERRUPTED', async () => {
    const stream = makeFakeStream([
      {
        textDeltas: ['hi'],
        throwAtEnd: 'abort',
      },
    ]);
    const deps = makeBaseDeps({ streamChatCompletion: stream });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload(), ctx)),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_CHAT_TOOL_STREAM_INTERRUPTED',
          retryable: false,
        });
      },
    );
  });
});

describe('brain.chatToolStream handler — configuration fallback', () => {
  it('falls back to backupConfigOverride when primary resolution is unavailable', async () => {
    const stream = makeFakeStream([
      { textDeltas: ['hi'] },
    ]);
    // aiConfigResolver returns undefined for the primary path (no
    // cache + no override), then returns the backup when retried with
    // configOverride pointing at the backup.
    const aiConfigResolver = vi.fn((agentId, options) => {
      if (options?.configOverride) return options.configOverride;
      return undefined;
    });
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      brainConfig: null,
      aiConfigResolver,
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const backupConfigOverride = { baseUrl: 'http://backup', apiKey: 'b', model: 'm2' };
    const result = await handler(validPayload({
      backupConfigOverride,
    }), ctx);

    expect(result.status).toBe('completed');
    expect(result.text).toBe('hi');
    // The resolver was called twice (primary undefined, then backup).
    expect(aiConfigResolver).toHaveBeenCalledTimes(2);
  });

  it('raises BRAIN_CHAT_TOOL_STREAM_CONFIG_UNAVAILABLE when both primary and backup are missing', async () => {
    const stream = makeFakeStream([]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      brainConfig: null,
      aiConfigResolver: () => undefined,
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload(), ctx)),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_CHAT_TOOL_STREAM_CONFIG_UNAVAILABLE',
          retryable: false,
        });
      },
    );
  });
});

describe('brain.chatToolStream handler — maxToolRounds clamp', () => {
  it('caps at the caller-supplied limit and returns status=failed', async () => {
    const stream = makeFakeStream([
      {
        toolCalls: [{ toolCallId: 'c1', name: 'a', args: {} }],
      },
      {
        toolCalls: [{ toolCallId: 'c2', name: 'a', args: {} }],
      },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
      maxToolRounds: 2,
    }), ctx);

    expect(result.status).toBe('failed');
    expect(result.text).toContain('maxToolRounds');
    expect(result.text).toContain('2');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(2);
  });
});

describe('brain.chatToolStream handler — token usage aggregation', () => {
  it('aggregates usage across rounds and emits a single notification', async () => {
    const stream = makeFakeStream([
      {
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        toolCalls: [{ toolCallId: 'c1', name: 'a', args: {} }],
      },
      {
        usage: { prompt_tokens: 12, completion_tokens: 8 },
        textDeltas: ['done'],
      },
    ]);
    const sendNotification = vi.fn();
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
      sendNotification,
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), ctx);

    expect(result.status).toBe('completed');
    expect(result.usage).toEqual({
      prompt_tokens: 22,
      completion_tokens: 13,
      total_tokens: 35,
    });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith('token_usage', {
      agentId: AGENT_ID,
      usage: {
        prompt_tokens: 22,
        completion_tokens: 13,
        total_tokens: 35,
      },
    });
  });
});

describe('brain.chatToolStream handler — unknown tool reference', () => {
  it('emits tool_use + tool_result with isToolError:true and continues the loop', async () => {
    const stream = makeFakeStream([
      {
        toolCalls: [{ toolCallId: 'c1', name: 'nope', args: {} }],
      },
      { textDeltas: ['recovered'] },
    ]);
    const deps = makeBaseDeps({ streamChatCompletion: stream });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'real', executor: 'local' }],
    }), ctx);

    expect(result.status).toBe('completed');
    expect(deps.dispatchLocalTool).not.toHaveBeenCalled();
    const toolResult = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .find((c) => c.type === 'tool_result');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      id: 'c1',
      isToolError: true,
    });
    expect(toolResult.result).toContain('Unknown tool:');
    expect(toolResult.result).toContain('nope');

    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      tool_call_id: 'c1',
      isToolError: true,
    });
  });
});

describe('brain.chatToolStream handler — kernel-throw on dispatch', () => {
  it('wraps as Class A tool-error and continues the loop', async () => {
    const stream = makeFakeStream([
      {
        toolCalls: [{ toolCallId: 'c1', name: 'a', args: {} }],
      },
      { textDeltas: ['ok after'] },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      dispatchLocalTool: vi.fn(async () => { throw new Error('kernel exploded'); }),
    });
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), ctx);

    expect(result.status).toBe('completed');
    const toolResult = ctx.emitChunk.mock.calls
      .map((c) => c[0])
      .find((c) => c.type === 'tool_result');
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      id: 'c1',
      isToolError: true,
    });
    expect(toolResult.result).toContain('kernel exploded');

    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      tool_call_id: 'c1',
      isToolError: true,
    });
    expect(toolMsg.content).toContain('kernel exploded');
  });
});

describe('brain.chatToolStream handler — registry seam', () => {
  it('reads from the AI config cache when no override is supplied', async () => {
    setAiConfig(AGENT_ID, { baseUrl: 'http://cached', apiKey: 'c', model: 'cached-m' });
    const stream = makeFakeStream([
      { textDeltas: ['ok'] },
    ]);
    const deps = makeBaseDeps({
      streamChatCompletion: stream,
      brainConfig: null,
      aiConfigResolver: undefined, // use real resolver
    });
    // Re-create deps using the real resolver:
    delete deps.aiConfigResolver;
    const handler = createBrainChatToolStreamHandler(deps);
    const ctx = makeCtx();
    const result = await handler(validPayload(), ctx);
    expect(result.status).toBe('completed');
    expect(result.text).toBe('ok');
  });
});
