import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const openAiConstructorCalls = [];

vi.mock('openai', () => ({
  default: vi.fn(function MockOpenAI(options) {
    openAiConstructorCalls.push(options);
    return {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    };
  }),
}));

const providerDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/lib/llm-provider',
);

async function collectStream(asyncIterable) {
  const chunks = [];
  for await (const chunk of asyncIterable) {
    chunks.push(chunk);
  }
  return chunks;
}

async function* providerStream(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeRetryableError(status) {
  const err = new Error(`status ${status}`);
  err.status = status;
  return err;
}

describe('llm-provider primitives', () => {
  it('createAIClient passes baseURL, apiKey, and default headers to OpenAI', async () => {
    const { createAIClient } = await import('../../src/lib/llm-provider/openai-compatible-client.js');

    const client = createAIClient({
      baseUrl: 'http://provider.test/v1',
      apiKey: 'sk-test',
    });

    expect(client).toBeTruthy();
    expect(openAiConstructorCalls.at(-1)).toEqual({
      baseURL: 'http://provider.test/v1',
      apiKey: 'sk-test',
      maxRetries: 0,
      defaultHeaders: {
        'HTTP-Referer': 'https://thinkroid.space',
        'X-Title': 'Thinkroid-Space',
      },
    });
  });

  it('callWithRetry retries 429 and 5xx errors before succeeding', async () => {
    const { callWithRetry } = await import('../../src/lib/llm-provider/retry.js');
    const attempts = [];

    const result = await callWithRetry(async () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw makeRetryableError(429);
      if (attempts.length === 2) throw makeRetryableError(503);
      return 'ok';
    }, {
      baseDelay: 0,
      maxRetries: 3,
      onRetry: vi.fn(),
    });

    expect(result).toBe('ok');
    expect(attempts).toHaveLength(3);
  });

  it('callWithRetry checks rate limits before each provider attempt', async () => {
    const { callWithRetry, modelCallTimestamps } = await import('../../src/lib/llm-provider/retry.js');
    modelCallTimestamps.clear();

    const result = await callWithRetry(async () => {
      const timestamps = modelCallTimestamps.get('gpt-test') ?? [];
      if (timestamps.length < 3) throw makeRetryableError(429);
      return 'ok';
    }, {
      baseDelay: 0,
      maxRetries: 3,
      model: 'gpt-test',
      getRateLimit: () => 100,
    });

    expect(result).toBe('ok');
    expect(modelCallTimestamps.get('gpt-test')).toHaveLength(3);
  });

  it('callWithRetry honors retry-after-ms before exponential backoff', async () => {
    const { callWithRetry } = await import('../../src/lib/llm-provider/retry.js');
    const onRetry = vi.fn();
    let attempts = 0;

    const result = await callWithRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = makeRetryableError(429);
        err.headers = { 'retry-after-ms': '0' };
        throw err;
      }
      return 'ok';
    }, {
      baseDelay: 7,
      maxRetries: 1,
      onRetry,
    });

    expect(result).toBe('ok');
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delay: 0 }));
  });

  it('callWithRetry does not retry non-retryable 400 errors', async () => {
    const { callWithRetry } = await import('../../src/lib/llm-provider/retry.js');
    let attempts = 0;

    await expect(callWithRetry(async () => {
      attempts += 1;
      throw makeRetryableError(400);
    }, {
      baseDelay: 0,
      maxRetries: 3,
    })).rejects.toMatchObject({ status: 400 });

    expect(attempts).toBe(1);
  });

  it('streamChatCompletion yields text tokens in order and exposes usage to for-await consumers', async () => {
    const { streamChatCompletion } = await import('../../src/lib/llm-provider/streaming-chat.js');
    const create = vi.fn(async () => providerStream([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, choices: [{ delta: {} }] },
    ]));
    const clientFactory = vi.fn(() => ({
      chat: { completions: { create } },
    }));
    const usageEvents = [];
    const signal = AbortSignal.timeout(1000);

    const chunks = await collectStream(streamChatCompletion({
      config: {
        baseUrl: 'http://provider.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      },
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 128,
      clientFactory,
      onUsage: (usage) => usageEvents.push(usage),
      retry: (fn) => fn(),
      signal,
    }));

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(usageEvents).toEqual([
      { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    ]);
    expect(create).toHaveBeenCalledWith(
      {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 128,
      },
      { signal },
    );
  });

  it('streamChatCompletion rejects tool-call chunks with a structured B2 error code', async () => {
    const { streamChatCompletion } = await import('../../src/lib/llm-provider/streaming-chat.js');
    const clientFactory = vi.fn(() => ({
      chat: {
        completions: {
          create: vi.fn(async () => providerStream([
            { choices: [{ delta: { tool_calls: [{ id: 'call-1' }] } }] },
          ])),
        },
      },
    }));

    await expect(collectStream(streamChatCompletion({
      config: {
        baseUrl: 'http://provider.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      },
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      clientFactory,
      retry: (fn) => fn(),
    }))).rejects.toMatchObject({
      code: 'daemon_tool_calls_not_supported_in_b2',
    });
  });

  it('streamChatCompletion rejects legacy function_call finish reasons', async () => {
    const { streamChatCompletion } = await import('../../src/lib/llm-provider/streaming-chat.js');
    const clientFactory = vi.fn(() => ({
      chat: {
        completions: {
          create: vi.fn(async () => providerStream([
            { choices: [{ finish_reason: 'function_call', delta: {} }] },
          ])),
        },
      },
    }));

    await expect(collectStream(streamChatCompletion({
      config: {
        baseUrl: 'http://provider.test/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      },
      messages: [{ role: 'user', content: 'use a legacy tool' }],
      clientFactory,
      retry: (fn) => fn(),
    }))).rejects.toMatchObject({
      code: 'daemon_tool_calls_not_supported_in_b2',
    });
  });

  it('llm-provider modules do not import Space paths', () => {
    const forbidden = [
      'thinkroid-space-server',
      'src/db.js',
      'hookManager',
      'routes/events',
      'Thinkroid_Space',
    ];

    const files = [
      'openai-compatible-client.js',
      'retry.js',
      'streaming-chat.js',
      'index.js',
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(providerDir, file), 'utf8');
      for (const pattern of forbidden) {
        expect(source, `${file} must not include ${pattern}`).not.toContain(pattern);
      }
    }
  });
});
