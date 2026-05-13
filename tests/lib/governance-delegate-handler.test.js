import { describe, expect, it } from 'vitest';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import { registerGovernanceDelegateHandler } from '../../src/handlers/governance-delegate-handler.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Build a stub `textChat` callable. `behavior` is either:
 *   - a string  → returned verbatim as the assistant text.
 *   - a function → invoked with the call params and may
 *     return either a string or `{ text, usage }`. May also throw
 *     to exercise the provider-error path.
 *
 * The stub records every call so tests can assert payload shape.
 */
function makeTextChatStub(behavior) {
  const calls = [];
  const fn = async (params = {}) => {
    calls.push(params);
    const result = typeof behavior === 'function' ? await behavior(params) : behavior;
    if (result && typeof result === 'object' && 'text' in result) {
      if (typeof params.onUsage === 'function' && result.usage) {
        params.onUsage(result.usage);
      }
      return result.text;
    }
    return result;
  };
  fn.calls = calls;
  return fn;
}

function makeKernel({
  textChat,
  sendNotification,
  agentId = AGENT_ID,
} = {}) {
  const kernel = new Kernel();
  registerGovernanceDelegateHandler(kernel, {
    agentId,
    agentName: 'Daemon Alice',
    textChat: textChat ?? makeTextChatStub('hello'),
    sendNotification: sendNotification ?? (() => {}),
  });
  return kernel;
}

function validPayload(overrides = {}) {
  return {
    agentId: AGENT_ID,
    capability: 'notification_reader',
    promptKey: 'notification_reader.decide',
    messages: [
      { role: 'system', content: 'You are a governance reviewer.' },
      { role: 'user', content: 'Decide whether to NOTIFY or SKIP.' },
    ],
    source: 'governanceRouter.notification_reader',
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

describe('governance.delegate handler — validation / dispatch', () => {
  it('registers a governance.delegate method on the kernel', () => {
    const kernel = makeKernel();
    expect(kernel.listMethods()).toContain('governance.delegate');
  });

  it('rejects payloads missing the messages field with a validation error', async () => {
    const kernel = makeKernel();
    const payload = validPayload();
    delete payload.messages;
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', payload),
      (err) => {
        expect(err.jsonRpc.message).toContain('messages must be a non-empty array');
      },
    );
  });

  it('rejects responseFormat=decision_word without validDecisions', async () => {
    const kernel = makeKernel();
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload({
        responseFormat: 'decision_word',
      })),
      (err) => {
        expect(err.jsonRpc.message).toContain('validDecisions');
      },
    );
  });

  it('rejects payloads whose agentId mismatches the bound agent', async () => {
    const kernel = makeKernel();
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload({
        agentId: OTHER_AGENT_ID,
      })),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId mismatch');
      },
    );
  });
});

describe('governance.delegate handler — plain-text path', () => {
  it('returns text unchanged and threads payload fields through to textChat', async () => {
    const textChat = makeTextChatStub('hello');
    const kernel = makeKernel({ textChat });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({ maxTokens: 256 }),
    );
    expect(result).toMatchObject({
      ok: true,
      text: 'hello',
      agentId: AGENT_ID,
      capability: 'notification_reader',
    });
    expect(result.parsedOk).toBeUndefined();
    expect(textChat.calls).toHaveLength(1);
    const call = textChat.calls[0];
    expect(call.messages).toEqual([
      { role: 'system', content: 'You are a governance reviewer.' },
      { role: 'user', content: 'Decide whether to NOTIFY or SKIP.' },
    ]);
    expect(call.maxTokens).toBe(256);
    // B.4a tool-text simulation passes tools:[] regardless.
    expect(call.tools).toEqual([]);
  });

  it('passes toolContext through on the tool-text path', async () => {
    const textChat = makeTextChatStub('tool answer');
    const kernel = makeKernel({ textChat });
    const toolContext = { tools: [{ name: 'fake_tool' }], spaceId: 'space-1' };
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({ toolContext, maxToolRounds: 1 }),
    );
    expect(result).toMatchObject({
      ok: true,
      text: 'tool answer',
      agentId: AGENT_ID,
      capability: 'notification_reader',
    });
    expect(textChat.calls).toHaveLength(1);
    const call = textChat.calls[0];
    expect(call.toolContext).toEqual(toolContext);
    expect(call.tools).toEqual([]); // B.4a embeds tools via toolContext only
  });
});

describe('governance.delegate handler — json_text path', () => {
  it('returns parsedOk=true on valid JSON', async () => {
    const textChat = makeTextChatStub('{"action":"ok"}');
    const kernel = makeKernel({ textChat });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({ responseFormat: 'json_text' }),
    );
    expect(result).toMatchObject({
      ok: true,
      text: '{"action":"ok"}',
      parsedOk: true,
      agentId: AGENT_ID,
      capability: 'notification_reader',
    });
  });

  it('strips ```json fences before parsing and returns parsedOk=true', async () => {
    const fenced = '```json\n{"a":1}\n```';
    const textChat = makeTextChatStub(fenced);
    const kernel = makeKernel({ textChat });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({ responseFormat: 'json_text' }),
    );
    expect(result.text).toBe(fenced); // text returned unchanged per spec
    expect(result.parsedOk).toBe(true);
  });

  it('returns parsedOk=false on unparseable JSON without raising', async () => {
    const textChat = makeTextChatStub('not json');
    const kernel = makeKernel({ textChat });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({ responseFormat: 'json_text' }),
    );
    expect(result).toMatchObject({
      ok: true,
      text: 'not json',
      parsedOk: false,
    });
  });
});

describe('governance.delegate handler — decision_word path', () => {
  it('accepts a response whose first uppercase token is in validDecisions', async () => {
    const textChat = makeTextChatStub('NOTIFY please');
    const kernel = makeKernel({ textChat });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload({
        responseFormat: 'decision_word',
        validDecisions: ['NOTIFY', 'SKIP'],
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      text: 'NOTIFY please',
      agentId: AGENT_ID,
      capability: 'notification_reader',
    });
  });

  it('rejects a mismatching first uppercase token with INVALID_RESPONSE', async () => {
    const textChat = makeTextChatStub('Maybe');
    const kernel = makeKernel({ textChat });
    await expectJsonRpcApplicationError(
      kernel.dispatch(
        'governance.delegate',
        validPayload({
          responseFormat: 'decision_word',
          validDecisions: ['NOTIFY', 'SKIP'],
        }),
      ),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'GOVERNANCE_DELEGATE_INVALID_RESPONSE',
          retryable: false,
        });
      },
    );
  });

  it('rejects "NOTIFIED" because the token NOTIFIED is not in validDecisions', async () => {
    const textChat = makeTextChatStub('NOTIFIED');
    const kernel = makeKernel({ textChat });
    await expectJsonRpcApplicationError(
      kernel.dispatch(
        'governance.delegate',
        validPayload({
          responseFormat: 'decision_word',
          validDecisions: ['NOTIFY', 'SKIP'],
        }),
      ),
      (err) => {
        expect(err.jsonRpc.data?.code).toBe('GOVERNANCE_DELEGATE_INVALID_RESPONSE');
      },
    );
  });

  it('rejects lowercase responses with INVALID_RESPONSE', async () => {
    const textChat = makeTextChatStub('notify');
    const kernel = makeKernel({ textChat });
    await expectJsonRpcApplicationError(
      kernel.dispatch(
        'governance.delegate',
        validPayload({
          responseFormat: 'decision_word',
          validDecisions: ['NOTIFY', 'SKIP'],
        }),
      ),
      (err) => {
        expect(err.jsonRpc.data?.code).toBe('GOVERNANCE_DELEGATE_INVALID_RESPONSE');
      },
    );
  });
});

describe('governance.delegate handler — provider error mapping', () => {
  it('wraps upstream textChat throws as PROVIDER_ERROR (retryable)', async () => {
    const textChat = makeTextChatStub(() => {
      throw new Error('upstream 502');
    });
    const kernel = makeKernel({ textChat });
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload()),
      (err) => {
        expect(err.jsonRpc.data).toMatchObject({
          code: 'GOVERNANCE_DELEGATE_PROVIDER_ERROR',
          retryable: true,
        });
        expect(err.jsonRpc.message).toContain('upstream 502');
      },
    );
  });
});

describe('governance.delegate handler — token usage notification', () => {
  it('emits a token_usage notification when the provider reports usage', async () => {
    const textChat = makeTextChatStub({
      text: 'ok',
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const notifications = [];
    const kernel = makeKernel({
      textChat,
      sendNotification: (method, payload) => {
        notifications.push({ method, payload });
      },
    });
    const result = await kernel.dispatch(
      'governance.delegate',
      validPayload(),
    );
    expect(result.ok).toBe(true);
    expect(result.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 });
    const usageNotification = notifications.find((n) => n.method === 'token_usage');
    expect(usageNotification).toBeDefined();
    expect(usageNotification.payload).toMatchObject({ agentId: AGENT_ID });
    // The notification payload nests provider usage under `usage` for parity
    // with the brain.chat token_usage flow consumed by Space.
    expect(usageNotification.payload.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 3,
    });
  });

  it('omits the token_usage notification when no usage is reported', async () => {
    const textChat = makeTextChatStub('ok'); // no usage payload
    const notifications = [];
    const kernel = makeKernel({
      textChat,
      sendNotification: (method, payload) => {
        notifications.push({ method, payload });
      },
    });
    await kernel.dispatch('governance.delegate', validPayload());
    expect(notifications.find((n) => n.method === 'token_usage')).toBeUndefined();
  });
});
