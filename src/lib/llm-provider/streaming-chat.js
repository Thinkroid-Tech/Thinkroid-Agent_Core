import { createAIClient } from './openai-compatible-client.js';
import { callWithRetry } from './retry.js';

export function createUnsupportedToolCallError() {
  const err = new Error('daemon_tool_calls_not_supported_in_b2');
  err.code = 'daemon_tool_calls_not_supported_in_b2';
  return err;
}

function hasToolCallSignal(choice) {
  return Boolean(
    choice?.delta?.tool_calls?.length ||
    choice?.delta?.function_call ||
    choice?.message?.tool_calls?.length ||
    choice?.finish_reason === 'tool_calls' ||
    choice?.finish_reason === 'function_call',
  );
}

export async function* streamChatCompletion({
  config,
  messages,
  tools,
  maxTokens,
  onUsage,
  signal,
  clientFactory = createAIClient,
  retry = callWithRetry,
} = {}) {
  const client = clientFactory({
    baseUrl: config?.baseUrl ?? config?.baseURL,
    apiKey: config?.apiKey,
  });
  const effectiveMaxTokens = maxTokens ?? config?.maxTokens;
  const request = {
    model: config?.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (tools !== undefined) {
    request.tools = tools;
  }
  if (effectiveMaxTokens > 0) {
    request.max_tokens = effectiveMaxTokens;
  }

  const providerStream = await retry(
    () => {
      if (signal) {
        return client.chat.completions.create(request, { signal });
      }
      return client.chat.completions.create(request);
    },
    {
      label: config?.label ?? 'daemon-brain',
      model: config?.model ?? '',
    },
  );

  let usage;
  for await (const chunk of providerStream) {
    if (chunk?.usage) {
      usage = chunk.usage;
      if (typeof onUsage === 'function') {
        onUsage(usage);
      }
    }

    for (const choice of chunk?.choices ?? []) {
      if (hasToolCallSignal(choice)) {
        throw createUnsupportedToolCallError();
      }

      const content = choice?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield content;
      }
    }
  }

  return undefined;
}
