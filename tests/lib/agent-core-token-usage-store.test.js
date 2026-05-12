import { afterEach, describe, expect, it } from 'vitest';

import { openAgentCoreDb } from '../../src/stores/agent-core-db/db.js';
import { TokenUsageStore } from '../../src/stores/agent-core-db/token-usage-store.js';

let db = null;

afterEach(() => {
  try { db?.close(); } catch { /* noop */ }
  db = null;
});

describe('Agent Core token usage store', () => {
  it('records usage envelopes idempotently and returns durable totals', () => {
    db = openAgentCoreDb(':memory:');
    const store = new TokenUsageStore(db);

    const event = {
      id: 'usage-1',
      agentId: '11111111-1111-4111-8111-111111111111',
      taskId: 'task-1',
      usage: {
        prompt_tokens: 7,
        completion_tokens: 11,
        total_tokens: 18,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 5,
      },
      model: 'gpt-test',
      providerId: 'provider-test',
      source: 'brain.chat',
      createdAt: 1710000000000,
    };

    expect(store.record(event)).toBe(true);
    expect(store.record({
      ...event,
      usage: { ...event.usage, prompt_tokens: 999 },
    })).toBe(false);

    expect(store.totals()).toEqual({
      count: 1,
      prompt_tokens: 7,
      completion_tokens: 11,
      total_tokens: 18,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
    });
  });

  it('accepts missing ids and still returns totals', () => {
    db = openAgentCoreDb(':memory:');
    const store = new TokenUsageStore(db);

    expect(store.record({
      agentId: '11111111-1111-4111-8111-111111111111',
      usage: { input_tokens: 2, output_tokens: 4 },
    })).toBe(true);

    expect(store.totals().total_tokens).toBe(6);
  });
});
