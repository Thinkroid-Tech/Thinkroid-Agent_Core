import { afterEach, describe, expect, it, vi } from 'vitest';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import { openAgentCoreDb } from '../../src/stores/agent-core-db/db.js';
import { ToolLoopSuspensionsStore } from '../../src/stores/agent-core-db/tool-loop-suspensions-store.js';
import {
  createBrainToolLoopResumeHandler,
  registerBrainToolLoopResumeHandler,
} from '../../src/handlers/brain-tool-loop-resume-handler.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

let db = null;

afterEach(() => {
  try { db?.close(); } catch { /* noop */ }
  db = null;
});

function makeClientFactory(responses) {
  const create = vi.fn(async () => {
    if (responses.length === 0) {
      throw new Error('makeClientFactory: no more responses queued');
    }
    const next = responses.shift();
    if (typeof next === 'function') return next();
    return next;
  });
  const client = { chat: { completions: { create } } };
  const factory = vi.fn(() => client);
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

function freshDbWithStore() {
  db = openAgentCoreDb(':memory:');
  const store = new ToolLoopSuspensionsStore(db);
  return { db, store };
}

function seedPendingRow(store, overrides = {}) {
  const entry = {
    id: 'susp-1',
    agentId: AGENT_ID,
    taskId: null,
    sessionId: null,
    toolCallId: 'call_1',
    toolName: 'risky',
    toolArgsJson: JSON.stringify({ x: 1 }),
    toolContextJson: JSON.stringify({ agentId: AGENT_ID }),
    conversationMessagesJson: JSON.stringify([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'risky', arguments: '{}' } }],
      },
    ]),
    maxTokens: null,
    maxToolRoundsRemaining: 3,
    approvalId: 'a1',
    idempotencyKey: 'susp-1:a1',
    configOverrideJson: null,
    ...overrides,
  };
  store.insertPending(entry);
  return entry;
}

function makeBaseDeps({ store, ...overrides } = {}) {
  return {
    agentId: AGENT_ID,
    suspensionsStore: store,
    brainConfig: { baseUrl: 'http://localhost', apiKey: 'k', model: 'm' },
    aiConfigResolver: () => ({ baseUrl: 'http://localhost', apiKey: 'k', model: 'm' }),
    callWithRetry: passthroughRetry,
    dispatchLocalTool: vi.fn(async () => ({ content: 'local ok' })),
    dispatchRemoteTool: vi.fn(async () => ({ content: 'remote ok' })),
    sendNotification: vi.fn(),
    ...overrides,
  };
}

function validRequest(overrides = {}) {
  return {
    agentId: AGENT_ID,
    suspensionId: 'susp-1',
    approvalId: 'a1',
    toolResult: { content: 'approved!' },
    ...overrides,
  };
}

function expectJsonRpcApplicationError(promise, predicate) {
  return promise.then(
    () => { throw new Error('expected promise to reject but it resolved'); },
    (err) => {
      expect(err.jsonRpc).toMatchObject({ code: IPC_ERROR_CODES.APPLICATION });
      predicate(err);
    },
  );
}

describe('brain.toolLoop.resume handler — kernel registration', () => {
  it('registers on the kernel', () => {
    const kernel = new Kernel();
    const { store } = freshDbWithStore();
    registerBrainToolLoopResumeHandler(kernel, {
      agentId: AGENT_ID,
      suspensionsStore: store,
      clientFactory: makeClientFactory([]),
    });
    expect(kernel.listMethods()).toContain('brain.toolLoop.resume');
  });
});

describe('brain.toolLoop.resume handler — request validation', () => {
  it('rejects when suspensionId is missing', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    const payload = validRequest();
    delete payload.suspensionId;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, {})),
      (err) => expect(err.jsonRpc.message).toContain('suspensionId must be a non-empty string'),
    );
  });

  it('rejects when approvalId is missing', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    const payload = validRequest();
    delete payload.approvalId;
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(payload, {})),
      (err) => expect(err.jsonRpc.message).toContain('approvalId must be a non-empty string'),
    );
  });

  it('rejects when agentId is not a UUID', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ agentId: 'nope' }), {})),
      (err) => expect(err.jsonRpc.message).toContain('agentId must be a UUID string'),
    );
  });

  it('rejects when toolResult is not an object', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ toolResult: 'not-an-object' }), {})),
      (err) => expect(err.jsonRpc.message).toContain('toolResult must be an object'),
    );
  });

  it('rejects empty toolResult that supplies neither content nor isToolError', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ toolResult: {} }), {})),
      (err) => expect(err.jsonRpc.message).toContain(
        'toolResult must include content (string) or isToolError: true',
      ),
    );
  });

  it('rejects request.agentId that mismatches the bound daemon agent', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ agentId: OTHER_AGENT_ID }), {})),
      (err) => expect(err.jsonRpc.message).toContain('agentId mismatch'),
    );
  });
});

describe('brain.toolLoop.resume handler — suspension lookup errors', () => {
  it('rejects when the suspension row is not found', async () => {
    const { store } = freshDbWithStore();
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ suspensionId: 'missing' }), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_RESUME_NOT_FOUND',
          retryable: false,
          suspensionId: 'missing',
        });
      },
    );
  });

  it('rejects when the row is owned by a different agent', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store, { agentId: OTHER_AGENT_ID });
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest(), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_RESUME_AGENT_MISMATCH',
          retryable: false,
        });
      },
    );
  });
});

describe('brain.toolLoop.resume handler — terminal-state idempotency', () => {
  it('rejects cancelled rows with INVALID_STATE and currentStatus', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);
    store.markCancelled('susp-1');
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest(), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_RESUME_INVALID_STATE',
          retryable: false,
          currentStatus: 'cancelled',
        });
      },
    );
  });

  it('rejects expired rows with INVALID_STATE and currentStatus', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);
    store.markExpired('susp-1');
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest(), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_RESUME_INVALID_STATE',
          retryable: false,
          currentStatus: 'expired',
        });
      },
    );
  });

  it('returns the cached envelope verbatim on idempotent re-resume', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);
    const cached = {
      ok: true,
      status: 'completed',
      agentId: AGENT_ID,
      text: 'cached!',
    };
    store.markResumed({
      id: 'susp-1',
      approvalId: 'a1',
      finalResponseJson: JSON.stringify(cached),
    });

    const factory = makeClientFactory([]);
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory,
    }));
    const result = await handler(validRequest(), {});
    expect(result).toEqual(cached);
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('rejects with CONFLICT when approvalId does not match a resumed row', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);
    store.markResumed({
      id: 'susp-1',
      approvalId: 'different-approval',
      finalResponseJson: JSON.stringify({ ok: true, status: 'completed', text: 'x', agentId: AGENT_ID }),
    });
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: makeClientFactory([]),
    }));
    await expectJsonRpcApplicationError(
      Promise.resolve().then(() => handler(validRequest({ approvalId: 'a1' }), {})),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'BRAIN_TOOL_LOOP_RESUME_CONFLICT',
          retryable: false,
          expectedApprovalId: 'different-approval',
        });
      },
    );
  });
});

describe('brain.toolLoop.resume handler — pending row replay', () => {
  it('appends tool result, runs the loop, caches the final response', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);

    const factory = makeClientFactory([
      makeResponse({ message: makeAssistantMessage({ content: 'all clear' }) }),
    ]);
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory,
    }));

    const result = await handler(validRequest({
      toolResult: { content: 'approved!' },
    }), {});
    expect(result.status).toBe('completed');
    expect(result.text).toBe('all clear');
    expect(result.agentId).toBe(AGENT_ID);
    expect(Array.isArray(result.conversationMessages)).toBe(true);
    const lastToolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(lastToolMsg).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'approved!',
    });

    // The provider saw exactly one round.
    expect(factory.create).toHaveBeenCalledTimes(1);

    // Cache assertion: a fresh getById on the same store shows resumed.
    const reread = store.getById('susp-1');
    expect(reread).toMatchObject({
      status: 'resumed',
      approval_id: 'a1',
    });
    expect(JSON.parse(reread.final_response_json)).toEqual(result);
  });

  it('returns status:failed when persisted remaining-rounds budget is 0', async () => {
    // Suspension that fired on the very last allowed round: the remaining
    // budget is 0, so the resume must NOT silently grant an extra LLM
    // call. The handler should fall straight through to the failed
    // branch instead of running one more provider round.
    const { store } = freshDbWithStore();
    seedPendingRow(store, { maxToolRoundsRemaining: 0 });

    const factory = makeClientFactory([]);  // no provider response should be consumed
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory,
    }));

    const result = await handler(validRequest({
      toolResult: { content: 'approved!' },
    }), {});
    expect(result.status).toBe('failed');
    expect(result.text).toMatch(/exceeded maxToolRounds/);
    expect(factory.create).toHaveBeenCalledTimes(0);

    // The tool result is still appended to the conversation history so
    // the caller can inspect what was approved before the budget cap
    // bit.
    const lastToolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(lastToolMsg).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'approved!',
    });
  });

  it('propagates isToolError flag from the resume request into the tool message', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);

    const factory = makeClientFactory([
      makeResponse({ message: makeAssistantMessage({ content: 'recovered' }) }),
    ]);
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory,
    }));

    const result = await handler(validRequest({
      toolResult: { content: 'rejected', isToolError: true },
    }), {});
    expect(result.status).toBe('completed');
    const toolMsg = result.conversationMessages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      content: 'rejected',
      isToolError: true,
    });
  });
});

describe('brain.toolLoop.resume handler — chained suspension', () => {
  it('inserts a fresh suspension row and caches the chained envelope on the original', async () => {
    const { store } = freshDbWithStore();
    seedPendingRow(store);

    // Resume payload also supplies tools so the chained tool call has a
    // registered executor (otherwise the loop would treat it as unknown
    // and surface a tool-error instead of APPROVAL_PENDING).
    const factory = makeClientFactory([
      makeResponse({
        message: makeAssistantMessage({
          tool_calls: [makeToolCall({ id: 'call_2', name: 'second_risky' })],
        }),
      }),
    ]);
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory,
      dispatchRemoteTool: vi.fn(async () => ({
        ok: false,
        code: 'APPROVAL_PENDING',
        approvalId: 'a2',
        name: 'second_risky',
        args: {},
      })),
    }));

    const result = await handler({
      ...validRequest(),
      tools: [{ name: 'second_risky', executor: 'remote' }],
    }, {});

    expect(result.status).toBe('approval_pending');
    expect(typeof result.suspensionId).toBe('string');
    expect(result.suspensionId).not.toBe('susp-1');
    expect(result.toolCallId).toBe('call_2');

    // The original row is marked resumed with the chained envelope cached.
    const original = store.getById('susp-1');
    expect(original).toMatchObject({
      status: 'resumed',
      approval_id: 'a1',
    });
    expect(JSON.parse(original.final_response_json)).toEqual(result);

    // The new row is pending with its own approvalId.
    const chained = store.getById(result.suspensionId);
    expect(chained).toMatchObject({
      status: 'pending',
      approval_id: 'a2',
      tool_call_id: 'call_2',
      tool_name: 'second_risky',
    });

    // Re-resuming the ORIGINAL with the same approvalId returns the
    // cached chained envelope verbatim (idempotent return).
    const factory2 = makeClientFactory([]);
    const handler2 = createBrainToolLoopResumeHandler(makeBaseDeps({
      store,
      clientFactory: factory2,
      dispatchRemoteTool: vi.fn(),
    }));
    const replay = await handler2(validRequest(), {});
    expect(replay).toEqual(result);
    expect(factory2.create).not.toHaveBeenCalled();
  });
});

describe('brain.toolLoop.resume handler — durable suspension survives a reload', () => {
  it('reads back the persisted row via a freshly constructed store handle', async () => {
    const { store, db: openDb } = freshDbWithStore();
    seedPendingRow(store);

    // Simulate a daemon restart by constructing a second store against
    // the same DB handle (in-process equivalent of reopening the file).
    const reloadedStore = new ToolLoopSuspensionsStore(openDb);
    const row = reloadedStore.getById('susp-1');
    expect(row).toMatchObject({
      id: 'susp-1',
      status: 'pending',
      agent_id: AGENT_ID,
      tool_name: 'risky',
    });

    const factory = makeClientFactory([
      makeResponse({ message: makeAssistantMessage({ content: 'done' }) }),
    ]);
    const handler = createBrainToolLoopResumeHandler(makeBaseDeps({
      store: reloadedStore,
      clientFactory: factory,
    }));
    const result = await handler(validRequest(), {});
    expect(result.status).toBe('completed');
  });
});
