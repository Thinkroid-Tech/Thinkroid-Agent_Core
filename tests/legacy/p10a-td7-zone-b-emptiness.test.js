/**
 * P10-A: Zone B emptiness string check — TD-7.
 *
 * Verifies that assemblePayloadForEvent() in context-engine.js uses a
 * `.length > 0` check (not `&&` string truthiness) when deciding whether to
 * append the Zone B system message.
 *
 * Test 1 — empty Zone B: buildZoneBContent returns '', Zone B message must
 *   NOT be appended to the messages array.
 * Test 2 — non-empty Zone B: buildZoneBContent returns 'some memory content',
 *   Zone B message MUST be appended at messages[1] with role: 'system'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

// Control what buildZoneBContent returns per test.
const mockBuildZoneBContent = vi.fn();

vi.mock('../ce/zone-b-builder.js', () => ({
  buildZoneBContent: (...args) => mockBuildZoneBContent(...args),
}));

// Import ContextEngine AFTER mocks are registered.
import { ContextEngine } from '../ce/context-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal session meta object.
 * turn_count=0 ensures Stage 2 does not trigger during these tests.
 */
function makeMeta() {
  return {
    status: 'awake',
    turn_count: 0,
    cerebellum_l1_cursor: 0,
    tags: [],
    summary: '',
  };
}

/**
 * Build a ContextEngine with fully mocked dependencies.
 * metaStore.get always returns a valid session meta so assemblePayloadForEvent
 * does not throw the "Session not found" error.
 */
function makeCE() {
  return new ContextEngine({
    agentId: 'agent-1',
    agentName: 'TestAgent',
    ceAccessView: {
      findByTag: vi.fn().mockReturnValue([]),
      search: vi.fn().mockReturnValue([]),
      touchAccess: vi.fn(),
    },
    metaStore: {
      get: vi.fn().mockReturnValue(makeMeta()),
      list: vi.fn().mockReturnValue([]),
      update: vi.fn(),
      create: vi.fn(),
    },
    historyStore: {
      length: vi.fn().mockReturnValue(0),
      readRange: vi.fn().mockReturnValue([]),
    },
    ceChannel: vi.fn(),
    buildSystemPrompt: vi.fn().mockResolvedValue({ system: 'Zone A system prompt', user: '' }),
    getToolsForAgent: vi.fn().mockReturnValue([]),
    // Fix B-4: agentManager required — stub with empty personality.
    agentManager: { getPersonality: async () => '' },
  });
}

/** Build a minimal agent event with a plain string payload. */
function makeEvent(text = 'test message') {
  return {
    id: 'evt-1',
    type: 'user_message',
    agent_id: 'agent-1',
    payload: text,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// beforeEach — reset all mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P10-A (TD-7): Zone B emptiness check in assemblePayloadForEvent', () => {

  it('test-1: Zone B message is NOT appended when buildZoneBContent returns empty string', async () => {
    // Arrange: buildZoneBContent returns empty string (no memories found)
    mockBuildZoneBContent.mockReturnValue({ content: '', blockCount: 0 });

    const ce = makeCE();
    const payload = await ce.assemblePayloadForEvent('session-1', makeEvent(), { sceneId: 'chat_employee' });

    // messages[0] is Zone A (system prompt)
    // With empty Zone B, no additional system message should follow before the user message
    const systemMessages = payload.messages.filter(m => m.role === 'system');
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0].content).toBe('Zone A system prompt');

    // Total messages: Zone A + user message = 2
    expect(payload.messages).toHaveLength(2);
    expect(payload.messages[1].role).toBe('user');
  });

  it('test-2: Zone B message IS appended at messages[1] when buildZoneBContent returns non-empty string', async () => {
    // Arrange: buildZoneBContent returns a non-empty content string
    mockBuildZoneBContent.mockReturnValue({ content: 'some memory content', blockCount: 1 });

    const ce = makeCE();
    const payload = await ce.assemblePayloadForEvent('session-1', makeEvent(), { sceneId: 'chat_employee' });

    // messages[0] = Zone A, messages[1] = Zone B
    expect(payload.messages.length).toBeGreaterThanOrEqual(2);
    expect(payload.messages[1].role).toBe('system');
    expect(payload.messages[1].content).toBe('some memory content');

    // Zone B breakpoint (bp2) must be set to 1 (index of Zone B message)
    const bp2 = payload.breakpoints.find(bp => bp.id === 'bp2');
    expect(bp2).toBeDefined();
    expect(bp2.position).toBe(1);
  });

});
