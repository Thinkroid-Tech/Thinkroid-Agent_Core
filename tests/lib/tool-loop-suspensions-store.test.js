import { afterEach, describe, expect, it } from 'vitest';

import { openAgentCoreDb } from '../../src/stores/agent-core-db/db.js';
import { ToolLoopSuspensionsStore } from '../../src/stores/agent-core-db/tool-loop-suspensions-store.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

let db = null;

afterEach(() => {
  try { db?.close(); } catch { /* noop */ }
  db = null;
});

function makeEntry(overrides = {}) {
  return {
    id: 'susp-1',
    agentId: AGENT_ID,
    taskId: 'task-1',
    sessionId: null,
    toolCallId: 'call_1',
    toolName: 'risky',
    toolArgsJson: JSON.stringify({ x: 1 }),
    toolContextJson: JSON.stringify({ agentId: AGENT_ID }),
    conversationMessagesJson: JSON.stringify([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [] },
    ]),
    maxTokens: 1024,
    maxToolRoundsRemaining: 4,
    approvalId: 'a1',
    idempotencyKey: 'susp-1:a1',
    configOverrideJson: JSON.stringify({ model: 'gpt-test' }),
    ...overrides,
  };
}

describe('ToolLoopSuspensionsStore', () => {
  it('inserts a pending row and reads it back via getById', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);

    expect(store.insertPending(makeEntry())).toBe(true);

    const row = store.getById('susp-1');
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      id: 'susp-1',
      agent_id: AGENT_ID,
      task_id: 'task-1',
      session_id: null,
      status: 'pending',
      tool_call_id: 'call_1',
      tool_name: 'risky',
      max_tokens: 1024,
      max_tool_rounds_remaining: 4,
      approval_id: 'a1',
      idempotency_key: 'susp-1:a1',
      final_response_json: null,
      resumed_at: null,
    });
    expect(typeof row.created_at).toBe('string');
    expect(typeof row.updated_at).toBe('string');
    expect(JSON.parse(row.tool_args_json)).toEqual({ x: 1 });
    expect(JSON.parse(row.config_override_json)).toEqual({ model: 'gpt-test' });
  });

  it('returns null for unknown id', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    expect(store.getById('does-not-exist')).toBeNull();
    expect(store.getById('')).toBeNull();
  });

  it('markResumed updates status, approval_id, final_response_json, resumed_at atomically', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    store.insertPending(makeEntry());

    const finalEnvelope = {
      ok: true,
      status: 'completed',
      text: 'done',
      agentId: AGENT_ID,
    };

    const updated = store.markResumed({
      id: 'susp-1',
      approvalId: 'a1',
      finalResponseJson: JSON.stringify(finalEnvelope),
    });

    expect(updated).not.toBeNull();
    expect(updated).toMatchObject({
      id: 'susp-1',
      status: 'resumed',
      approval_id: 'a1',
    });
    expect(updated.resumed_at).toEqual(expect.any(String));
    expect(JSON.parse(updated.final_response_json)).toEqual(finalEnvelope);

    // Round-trip a fresh getById to confirm the durable state matches.
    const reread = store.getById('susp-1');
    expect(reread).toMatchObject({
      status: 'resumed',
      approval_id: 'a1',
    });
    expect(JSON.parse(reread.final_response_json)).toEqual(finalEnvelope);
  });

  it('markResumed returns null when id is not found', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    const result = store.markResumed({
      id: 'missing',
      approvalId: 'a1',
      finalResponseJson: '{}',
    });
    expect(result).toBeNull();
  });

  it('markCancelled updates status and updated_at', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    store.insertPending(makeEntry());
    expect(store.markCancelled('susp-1')).toBe(true);
    expect(store.getById('susp-1')).toMatchObject({ status: 'cancelled' });
  });

  it('markExpired updates status and updated_at', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    store.insertPending(makeEntry());
    expect(store.markExpired('susp-1')).toBe(true);
    expect(store.getById('susp-1')).toMatchObject({ status: 'expired' });
  });

  it('rejects malformed inserts', () => {
    db = openAgentCoreDb(':memory:');
    const store = new ToolLoopSuspensionsStore(db);
    expect(() => store.insertPending(null)).toThrow(/entry must be an object/);
    expect(() => store.insertPending(makeEntry({ id: '' }))).toThrow(/id must be a non-empty/);
    expect(() => store.insertPending(makeEntry({ agentId: '' }))).toThrow(
      /agentId must be a non-empty/,
    );
    expect(() => store.insertPending(makeEntry({ maxToolRoundsRemaining: -1 }))).toThrow(
      /maxToolRoundsRemaining/,
    );
  });
});
