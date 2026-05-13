import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createBrainChatHandler,
  createStubLlm,
} from '../../src/lib/brain-chat-handler.js';
import {
  clearAiConfig,
  setAiConfig,
} from '../../src/lib/resolveAiConfig.js';

async function runHandler(handler, params = {}, ctxOverrides = {}) {
  const chunks = [];
  const ctx = {
    emitChunk: (chunk) => chunks.push(chunk),
    ...ctxOverrides,
  };
  const result = await handler(params, ctx);
  return { chunks, result };
}

async function* tokenStream(tokens) {
  for (const token of tokens) {
    yield token;
  }
}

async function* throwingProviderStream(err) {
  yield 'before-error';
  throw err;
}

afterEach(() => {
  clearAiConfig();
});

describe('brain-chat handler', () => {
  it('uses provider-backed streaming by default instead of deterministic Hello world', async () => {
    const streamChatCompletion = vi.fn(() => tokenStream(['provider', ' text']));
    const aiConfigResolver = vi.fn(() => ({
      baseUrl: 'http://provider.test/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
    }));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver,
      streamChatCompletion,
    });

    const { chunks, result } = await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      max_tokens: 42,
    });

    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ model: 'gpt-test' }),
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      maxTokens: 42,
    }));
    expect(chunks).toEqual([{ delta: 'provider' }, { delta: ' text' }]);
    expect(chunks.map((chunk) => chunk.delta).join('')).not.toBe('Hello world');
    expect(result).toEqual({ done: true, totalCount: 2 });
  });

  it('uses the default resolveAiConfig cache when no resolver override is supplied', async () => {
    const cachedConfig = {
      baseUrl: 'http://cached.test/v1',
      apiKey: 'sk-cached',
      model: 'gpt-cached',
    };
    const streamChatCompletion = vi.fn(() => tokenStream(['cached']));
    setAiConfig('agent-cached', cachedConfig);
    const handler = createBrainChatHandler({
      agentId: 'agent-cached',
      streamChatCompletion,
    });

    await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      config: cachedConfig,
    }));
  });

  it('passes camelCase maxTokens params through to provider streaming', async () => {
    const streamChatCompletion = vi.fn(() => tokenStream(['ok']));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => ({
        model: 'gpt-test',
        maxTokens: 123,
      })),
      streamChatCompletion,
    });

    await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 42,
    });

    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 42,
    }));
  });

  it('preserves explicit stub injection and back-pressure handling', async () => {
    const processRef = {
      send: vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
    };
    const onPipeFull = vi.fn();
    const handler = createBrainChatHandler({
      llmFactory: () => createStubLlm(['A', 'B'])(),
      processRef,
      onPipeFull,
    });

    const chunks = [];
    const result = await handler({}, {
      emitChunk: (chunk) => {
        chunks.push(chunk);
        processRef.send({ chunk });
      },
    });

    expect(chunks).toEqual([{ delta: 'A' }, { delta: 'B' }]);
    expect(result).toEqual({ done: true, totalCount: 2 });
    expect(processRef.send).toHaveBeenCalledTimes(2);
    expect(onPipeFull).toHaveBeenCalledTimes(1);
  });

  it('resolves configOverride before the cached/default resolver path', async () => {
    const overrideConfig = {
      baseUrl: 'http://override.test/v1',
      apiKey: 'sk-override',
      model: 'gpt-override',
    };
    const streamChatCompletion = vi.fn(() => tokenStream(['ok']));
    const cachedConfig = {
      baseUrl: 'http://cached.test/v1',
      apiKey: 'sk-cached',
      model: 'gpt-cached',
    };
    const aiConfigResolver = vi.fn((agentId, options) => (
      options?.configOverride ?? cachedConfig
    ));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver,
      streamChatCompletion,
    });

    await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
      configOverride: overrideConfig,
    });

    expect(aiConfigResolver).toHaveBeenCalledWith('agent-1', {
      configOverride: overrideConfig,
    });
    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      config: overrideConfig,
    }));
  });

  it('falls back to resolved config maxTokens when params maxTokens is zero', async () => {
    const streamChatCompletion = vi.fn(() => tokenStream(['ok']));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => ({
        model: 'gpt-test',
        maxTokens: 123,
      })),
      streamChatCompletion,
    });

    await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 0,
    });

    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 123,
    }));
  });

  it('throws daemon_ai_config_unavailable when no config can be resolved', async () => {
    const handler = createBrainChatHandler({
      agentId: 'agent-missing',
      aiConfigResolver: vi.fn(() => undefined),
      streamChatCompletion: vi.fn(() => tokenStream(['should-not-run'])),
    });

    await expect(runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
    })).rejects.toMatchObject({
      code: 'daemon_ai_config_unavailable',
    });
  });

  it('emits provider text tokens as delta chunks and returns final usage', async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    const streamChatCompletion = vi.fn(({ onUsage }) => {
      onUsage(usage);
      return tokenStream(['Hel', 'lo']);
    });
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => ({ model: 'gpt-test' })),
      streamChatCompletion,
    });

    const { chunks, result } = await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(chunks).toEqual([{ delta: 'Hel' }, { delta: 'lo' }]);
    expect(result).toEqual({ done: true, totalCount: 2, usage });
  });

  it('propagates provider tool-call rejection without catching it', async () => {
    const err = new Error('daemon streaming tool calls require an onToolCall callback');
    err.code = 'daemon_tool_calls_require_callback';
    const streamChatCompletion = vi.fn(() => throwingProviderStream(err));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => ({ model: 'gpt-test' })),
      streamChatCompletion,
    });

    await expect(runHandler(handler, {
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    })).rejects.toBe(err);
  });

  it('only includes resolved config marker when explicitly requested', async () => {
    const config = { model: 'gpt-test' };
    const makeHandler = (includeResolvedConfigMarker) => createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => config),
      streamChatCompletion: vi.fn(() => tokenStream(['ok'])),
      includeResolvedConfigMarker,
    });

    const defaultRun = await runHandler(makeHandler(false), {
      messages: [{ role: 'user', content: 'hello' }],
    });
    const markerRun = await runHandler(makeHandler(true), {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(defaultRun.chunks).toEqual([{ delta: 'ok' }]);
    expect(markerRun.chunks).toEqual([{ delta: 'ok', _aiConfig: config }]);
  });

  it('threads ctx.signal into provider streaming', async () => {
    const signal = AbortSignal.timeout(1000);
    const streamChatCompletion = vi.fn(() => tokenStream(['ok']));
    const handler = createBrainChatHandler({
      agentId: 'agent-1',
      aiConfigResolver: vi.fn(() => ({ model: 'gpt-test' })),
      streamChatCompletion,
    });

    await runHandler(handler, {
      messages: [{ role: 'user', content: 'hello' }],
    }, { signal });

    expect(streamChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      signal,
    }));
  });

  it('fires usage, hook, and debug callbacks without blocking the request result', async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    const streamChatCompletion = vi.fn(({ onUsage }) => {
      onUsage(usage);
      return tokenStream(['ok']);
    });
    const onTokenUsage = vi.fn(() => {
      throw new Error('duplicate subscriber failed');
    });
    const onHookEvent = vi.fn();
    const onDebugLog = vi.fn();
    const onCallbackError = vi.fn();
    const handler = createBrainChatHandler({
      agentId: '11111111-1111-4111-8111-111111111111',
      aiConfigResolver: vi.fn(() => ({
        providerId: 'provider-test',
        model: 'gpt-test',
      })),
      streamChatCompletion,
      createUsageId: () => 'usage-1',
      onTokenUsage,
      onHookEvent,
      onDebugLog,
      onCallbackError,
    });

    const { result } = await runHandler(handler, {
      taskId: 'task-1',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toEqual({ done: true, totalCount: 1, usage });
    expect(onTokenUsage).toHaveBeenCalledWith({
      agentId: '11111111-1111-4111-8111-111111111111',
      usage: expect.objectContaining({
        id: 'usage-1',
        taskId: 'task-1',
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        model: 'gpt-test',
        providerId: 'provider-test',
        source: 'brain.chat',
      }),
    });
    expect(onHookEvent).toHaveBeenCalledWith({
      agentId: '11111111-1111-4111-8111-111111111111',
      event: expect.objectContaining({
        type: 'brain.chat.completed',
        usageId: 'usage-1',
      }),
    });
    expect(onDebugLog).toHaveBeenCalledWith({
      agentId: '11111111-1111-4111-8111-111111111111',
      level: 'debug',
      message: 'brain.chat completed',
      context: expect.objectContaining({ usageId: 'usage-1' }),
    });
    expect(onCallbackError).toHaveBeenCalledWith(
      'token_usage',
      expect.objectContaining({ message: 'duplicate subscriber failed' }),
    );
  });
});
