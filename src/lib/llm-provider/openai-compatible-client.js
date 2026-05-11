import OpenAI from 'openai';

const DEFAULT_HEADERS = {
  'HTTP-Referer': 'https://thinkroid.space',
  'X-Title': 'Thinkroid-Space',
};

export function createAIClient({ baseUrl, apiKey }) {
  return new OpenAI({
    baseURL: baseUrl,
    apiKey,
    maxRetries: 0,
    defaultHeaders: DEFAULT_HEADERS,
  });
}

export async function chat({ client, model, messages, stream = false }) {
  const response = await client.chat.completions.create({
    model,
    messages,
    stream,
  });

  if (stream) {
    return response;
  }

  return response.choices?.[0]?.message?.content || '';
}
