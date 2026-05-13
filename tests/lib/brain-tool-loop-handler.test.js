import { describe, expect, it, vi } from 'vitest';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import {
  createBrainToolLoopHandler,
  registerBrainToolLoopHandler,
} from '../../src/handlers/brain-tool-loop-handler.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

function validPayload(overrides = {}) {
  return {
    agentId: AGENT_ID,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ],
    source: 'tests.brain-tool-loop',
    ...overrides,
  };
}

/**
 * Build a fake OpenAI-compatible client whose `chat.completions.create`
 * pops the next response off `responses` in order. Each entry is either
 * the response object itself or a function that returns it (so tests
 * can throw to exercise the provider-error path).
 */
function makeClientFactory(responses) {
  const create = vi.fn(async () => {
    if (responses.length === 0) {
      throw new Error('makeClientFactory: no more responses queued');
    }
    const next = responses.shift();
    if (typeof next === 'function') {
      return next();
    }
    return next;
  });
  const client = {
    chat: {
      completions: { create },
    },
  };
  const factory = vi.fn(() => client);
  factory.client = client;
  factory.create = create;
  return factory;
}

function makeAssistantMessage({ content = '', tool_calls } = {}) {
  const msg = { role: 'assistant', content };
  if (tool_calls) msg.tool_calls = tool_calls;
  return msg;
}

function makeResponse({ message, usage } = {}) {
  return {
    choices: [{ message }],
    ...(usage ? { usage } : {}),
  };
}

function makeToolCall({ id = 'call_1', name, args = {} }) {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

function passthroughRetry(fn) {
  return fn();
}

function makeBaseDeps(overrides = {}) {
  return {
    agentId: AGENT_ID,
    brainConfig: { baseUrl: 'http://localhost', apiKey: 'k', model: 'm' },
    aiConfigResolver: () => ({ baseUrl: 'http://localhost', apiKey: 'k', model: 'm' }),
    callWithRetry: passthroughRetry,
    dispatchLocalTool: vi.fn(async () => ({ content: 'local ok' })),
    dispatchRemoteTool: vi.fn(async () => ({ content: 'remote ok' })),
    sendNotification: vi.fn(),
    ...overrides,
  };
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

describe('brain.toolLoop handler — request validation', () => {
  it('registers on the kernel', () => {
    const kernel = new Kernel();
    registerBrainToolLoopHandler(kernel, makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    expect(kernel.listMethods()).toContain('brain.toolLoop');
  });

  it('rejects payloads missing messages with a validation error', async () => {
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    const payload = validPayload();
    delete payload.messages;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, {})),
      (err) => {
        expect(err.jsonRpc.message).toContain('messages must be a non-empty array');
      },
    );
  });

  it('rejects non-UUID agentId via contract validation', async () => {
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ agentId: 'nope' }), {})),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId must be a UUID string');
      },
    );
  });

  it('rejects tools with invalid executor', async () => {
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({
        tools: [{ name: 'x', executor: 'space' }],
      }), {})),
      (err) => {
        expect(err.jsonRpc.message).toContain('tools[0].executor must be');
      },
    );
  });

  it('rejects maxToolRounds greater than 50', async () => {
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ maxToolRounds: 51 }), {})),
      (err) => {
        expect(err.jsonRpc.message).toContain('maxToolRounds must not exceed 50');
      },
    );
  });

  it('rejects agentId that mismatches the bound agent', async () => {
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({ agentId: OTHER_AGENT_ID }), {})),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId mismatch');
      },
    );
  });
});

describe('brain.toolLoop handler — plain text completion', () => {
  it('returns status=completed when the provider emits no tool calls', async () => {
    const factory = makeClientFactory([
      makeResponse({ message: makeAssistantMessage({ content: 'hi' }) }),
    ]);
    const deps = makeBaseDeps({ clientFactory: factory });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload(), {});
    expect(result.ok).toBe(true);
    expect(result.text).toBe('hi');
    expect(result.status).toBe('completed');
    expect(result.agentId).toBe(AGENT_ID);
    expect(deps.dispatchLocalTool).not.toHaveBeenCalled();
    expect(deps.dispatchRemoteTool).not.toHaveBeenCalled();
    expect(result.conversationMessages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'hi',
    });
  });
});

describe('brain.toolLoop handler — single local tool round', () => {
  it('dispatches the tool locally and completes on the next round', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ name: 'lookup', args: { q: 'x' } })],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'final' }) }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async () => ({ content: 'tool result' })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'lookup', executor: 'local' }],
    }), {});
    expect(result.status).toBe('completed');
    expect(result.text).toBe('final');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(1);
    expect(deps.dispatchLocalTool).toHaveBeenCalledWith({
      name: 'lookup',
      args: { q: 'x' },
      ctx: expect.objectContaining({ agentId: AGENT_ID }),
    });
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ content: 'tool result' });
    expect(result.conversationMessages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'final',
    });
  });
});

describe('brain.toolLoop handler — single remote tool round', () => {
  it('dispatches to the remote executor and forwards the result', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ name: 'fetch', args: { url: 'u' } })],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'done' }) }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchRemoteTool: vi.fn(async () => ({ content: 'remote-text' })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'fetch', executor: 'remote' }],
    }), {});
    expect(result.status).toBe('completed');
    expect(deps.dispatchRemoteTool).toHaveBeenCalledTimes(1);
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ content: 'remote-text' });
  });
});

describe('brain.toolLoop handler — multi-round branching', () => {
  it('handles multiple tool calls in a single round before completing', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [
            makeToolCall({ id: 'c1', name: 'a', args: { v: 1 } }),
            makeToolCall({ id: 'c2', name: 'b', args: { v: 2 } }),
          ],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'all done' }) }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async ({ name }) => ({ content: `r:${name}` })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [
        { name: 'a', executor: 'local' },
        { name: 'b', executor: 'local' },
      ],
    }), {});
    expect(result.status).toBe('completed');
    expect(result.text).toBe('all done');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(2);
    const toolMessages = result.conversationMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: 'c1', content: 'r:a' });
    expect(toolMessages[1]).toMatchObject({ tool_call_id: 'c2', content: 'r:b' });
  });
});

describe('brain.toolLoop handler — maxToolRounds clamp', () => {
  it('caps at the caller-supplied limit and returns status=failed', async () => {
    const neverEnding = () => makeResponse({
      message: makeAssistantMessage({
        tool_calls: [makeToolCall({ name: 'a' })],
      }),
    });
    const factory = makeClientFactory([neverEnding(), neverEnding()]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
      maxToolRounds: 2,
    }), {});
    expect(result.status).toBe('failed');
    expect(result.text).toContain('maxToolRounds');
    expect(result.text).toContain('2');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(2);
  });

  it('defaults to 25 rounds when not provided', async () => {
    const responses = [];
    for (let i = 0; i < 25; i += 1) {
      responses.push(makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: `c${i}`, name: 'a' })],
        }),
      }));
    }
    const factory = makeClientFactory(responses);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), {});
    expect(result.status).toBe('failed');
    expect(deps.dispatchLocalTool).toHaveBeenCalledTimes(25);
  });
});

describe('brain.toolLoop handler — provider error wrapping', () => {
  it('wraps provider throws as BRAIN_TOOL_LOOP_PROVIDER_ERROR', async () => {
    const factory = makeClientFactory([
      () => { throw new Error('upstream 502'); },
    ]);
    const handler = createBrainToolLoopHandler(makeBaseDeps({
      clientFactory: factory,
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload(), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_PROVIDER_ERROR',
          retryable: true,
        });
        expect(err.jsonRpc.message).toContain('upstream 502');
      },
    );
  });
});

describe('brain.toolLoop handler — Class A tool-error envelope', () => {
  it('preserves isToolError on the tool message and continues the loop', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'c1', name: 'fetch' })],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'recovered' }) }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchRemoteTool: vi.fn(async () => ({
        content: 'remote failed',
        isToolError: true,
      })),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'fetch', executor: 'remote' }],
    }), {});
    expect(result.status).toBe('completed');
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      content: 'remote failed',
      isToolError: true,
    });
  });
});

describe('brain.toolLoop handler — kernel throw wrapping', () => {
  it('catches dispatch throws and appends a Class A tool-error message', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'c1', name: 'a' })],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'ok after' }) }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async () => { throw new Error('kernel exploded'); }),
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), {});
    expect(result.status).toBe('completed');
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      isToolError: true,
    });
    expect(toolMsg.content).toContain('kernel exploded');
  });
});

describe('brain.toolLoop handler — APPROVAL_PENDING surfaces NOT_READY', () => {
  it('throws BRAIN_TOOL_LOOP_APPROVAL_NOT_READY when remote returns approval-pending', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'c1', name: 'risky' })],
        }),
      }),
    ]);
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchRemoteTool: vi.fn(async () => ({
        ok: false,
        code: 'APPROVAL_PENDING',
        approvalId: 'a1',
        name: 'risky',
        args: {},
      })),
    });
    const handler = createBrainToolLoopHandler(deps);
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validPayload({
        tools: [{ name: 'risky', executor: 'remote' }],
      }), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_APPROVAL_NOT_READY',
          retryable: false,
          approvalId: 'a1',
          toolName: 'risky',
        });
      },
    );
  });
});

describe('brain.toolLoop handler — unknown tool reference', () => {
  it('appends a Class A tool-error and continues the loop', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'c1', name: 'nope' })],
        }),
      }),
      makeResponse({ message: makeAssistantMessage({ content: 'recovered' }) }),
    ]);
    const deps = makeBaseDeps({ clientFactory: factory });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'real', executor: 'local' }],
    }), {});
    expect(result.status).toBe('completed');
    expect(deps.dispatchLocalTool).not.toHaveBeenCalled();
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      tool_call_id: 'c1',
      isToolError: true,
    });
    expect(toolMsg.content).toContain('Unknown tool:');
    expect(toolMsg.content).toContain('nope');
  });
});

describe('brain.toolLoop handler — token usage aggregation', () => {
  it('aggregates usage across rounds and emits a single notification', async () => {
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'c1', name: 'a' })],
        }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      makeResponse({
        message: makeAssistantMessage({ content: 'done' }),
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    ]);
    const sendNotification = vi.fn();
    const deps = makeBaseDeps({
      clientFactory: factory,
      dispatchLocalTool: vi.fn(async () => ({ content: 'r' })),
      sendNotification,
    });
    const handler = createBrainToolLoopHandler(deps);
    const result = await handler(validPayload({
      tools: [{ name: 'a', executor: 'local' }],
    }), {});
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

describe('brain.toolLoop handler — provider tools shape', () => {
  it('strips the executor field before passing tools to the provider', async () => {
    const factory = makeClientFactory([
      makeResponse({ message: makeAssistantMessage({ content: 'hi' }) }),
    ]);
    const deps = makeBaseDeps({ clientFactory: factory });
    const handler = createBrainToolLoopHandler(deps);
    await handler(validPayload({
      tools: [
        {
          name: 'lookup',
          executor: 'remote',
          description: 'look stuff up',
          parameters: { type: 'object', properties: {} },
        },
      ],
    }), {});
    expect(factory.create).toHaveBeenCalledTimes(1);
    const sentRequest = factory.create.mock.calls[0][0];
    expect(sentRequest.stream).toBe(false);
    expect(Array.isArray(sentRequest.tools)).toBe(true);
    expect(sentRequest.tools[0]).toEqual({
      name: 'lookup',
      description: 'look stuff up',
      parameters: { type: 'object', properties: {} },
    });
    expect(sentRequest.tools[0]).not.toHaveProperty('executor');
  });
});
