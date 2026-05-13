import { createAIClient } from './openai-compatible-client.js';
import { callWithRetry } from './retry.js';

export function createUnsupportedToolCallError() {
  const err = new Error('daemon streaming tool calls require an onToolCall callback');
  err.code = 'daemon_tool_calls_require_callback';
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

function parseToolArgs(buffer) {
  if (typeof buffer !== 'string' || buffer.length === 0) {
    return buffer ?? '';
  }
  try {
    return JSON.parse(buffer);
  } catch {
    return buffer;
  }
}

function applyToolCallDeltas(accumulator, deltaToolCalls) {
  for (const entry of deltaToolCalls) {
    if (!entry || typeof entry !== 'object') continue;
    const index = typeof entry.index === 'number' ? entry.index : 0;
    const existing = accumulator.get(index) ?? {
      id: null,
      name: null,
      argumentsBuffer: '',
    };
    if (entry.id != null && existing.id == null) {
      existing.id = entry.id;
    }
    const fn = entry.function;
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string' && fn.name.length > 0 && existing.name == null) {
        existing.name = fn.name;
      }
      if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
        existing.argumentsBuffer += fn.arguments;
      }
    }
    accumulator.set(index, existing);
  }
}

// Legacy `function_call` deltas have no index, so they merge into the
// index-0 accumulator entry. If a modern `tool_calls[0]` and a legacy
// `function_call` arrive in the same stream (rare; providers usually emit
// one shape per response) they fold into the same entry — `id` / `name`
// retain the first non-null observation, `argumentsBuffer` concatenates.
function applyLegacyFunctionCallDelta(accumulator, functionCall) {
  if (!functionCall || typeof functionCall !== 'object') return;
  const existing = accumulator.get(0) ?? {
    id: null,
    name: null,
    argumentsBuffer: '',
  };
  if (typeof functionCall.name === 'string' && functionCall.name.length > 0 && existing.name == null) {
    existing.name = functionCall.name;
  }
  if (typeof functionCall.arguments === 'string' && functionCall.arguments.length > 0) {
    existing.argumentsBuffer += functionCall.arguments;
  }
  accumulator.set(0, existing);
}

async function flushToolCalls(accumulator, onToolCall, finishReason) {
  if (accumulator.size === 0) return;
  const indices = [...accumulator.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const entry = accumulator.get(index);
    const args = parseToolArgs(entry.argumentsBuffer);
    await onToolCall({
      type: 'tool_call',
      toolCallId: entry.id,
      name: entry.name,
      args,
      finishReason,
    });
  }
  accumulator.clear();
}

export async function* streamChatCompletion({
  config,
  messages,
  tools,
  maxTokens,
  onUsage,
  onToolCall,
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

  const toolCallsEnabled = typeof onToolCall === 'function';
  const toolAccumulator = new Map();

  let usage;
  for await (const chunk of providerStream) {
    if (chunk?.usage) {
      usage = chunk.usage;
      if (typeof onUsage === 'function') {
        onUsage(usage);
      }
    }

    for (const choice of chunk?.choices ?? []) {
      if (!toolCallsEnabled) {
        if (hasToolCallSignal(choice)) {
          throw createUnsupportedToolCallError();
        }
      } else {
        const deltaToolCalls = choice?.delta?.tool_calls;
        if (Array.isArray(deltaToolCalls) && deltaToolCalls.length > 0) {
          applyToolCallDeltas(toolAccumulator, deltaToolCalls);
        }
        const legacyFunctionCall = choice?.delta?.function_call;
        if (legacyFunctionCall) {
          applyLegacyFunctionCallDelta(toolAccumulator, legacyFunctionCall);
        }
        const finishReason = choice?.finish_reason;
        if (finishReason === 'tool_calls' || finishReason === 'function_call') {
          await flushToolCalls(toolAccumulator, onToolCall, finishReason);
        }
      }

      const content = choice?.delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        yield content;
      }
    }
  }

  if (toolCallsEnabled) {
    await flushToolCalls(toolAccumulator, onToolCall, null);
  }

  return undefined;
}
