/**
 * P9-A: Cooperation Zone B tests.
 *
 * Part 1 — zone-b-builder.js: verifies cooperation block assembly, ordering,
 *   capping, and backward-compat behavior of buildZoneBContent.
 *
 * Part 2 — context-engine.js: verifies _searchAndTouchMemory's cooperation
 *   fetch path — findByTag('collaboration'), 20-entry limit, deduplication,
 *   touchAccess calls, and the cooperationMemoryIds Set returned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildZoneBContent, MAX_COOPERATION_ENTRIES } from '../ce/zone-b-builder.js';
import { ContextEngine } from '../ce/context-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a memory object in the shape accepted by buildZoneBContent.
 * @param {number} id
 * @param {string} content
 * @param {string} layer
 * @param {string[]} tags
 */
function makeMemory(id, content, layer = 'short', tags = []) {
  return { id, content, layer, tags };
}

/**
 * Build a ContextEngine with fully mocked dependencies.
 *
 * @param {object} opts
 * @param {Function} [opts.findByTag] - ceAccessView.findByTag implementation
 * @param {Function} [opts.search]    - ceAccessView.search implementation
 */
function makeCE({ findByTag = () => [], search = () => [] } = {}) {
  return new ContextEngine({
    agentId: 'agent-1',
    agentName: 'TestAgent',
    ceAccessView: {
      findByTag,
      search,
      touchAccess: vi.fn(),
    },
    metaStore: {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    historyStore: { length: () => 0, readRange: () => [] },
    ceChannel: vi.fn(),
    buildSystemPrompt: vi.fn().mockResolvedValue({ system: 'sys', user: 'usr' }),
    getToolsForAgent: vi.fn().mockReturnValue([]),
    // Fix B-4: agentManager required — stub with empty personality.
    agentManager: { getPersonality: async () => '' },
  });
}

/** Build a minimal event whose payload is a plain string. */
function makeEvent(text = 'hello') {
  return { id: 'e1', type: 'user_message', agent_id: 'agent-1', payload: text, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Part 1: buildZoneBContent — cooperation block behavior
// ---------------------------------------------------------------------------

describe('P9-A: buildZoneBContent — cooperation block', () => {
  it('test-1: cooperation block appears when IDs provided', () => {
    const memories = [
      makeMemory(1, 'Cooperated on refactor with agent-2', 'short'),
      makeMemory(2, 'User prefers dark mode', 'long'),
    ];
    const cooperationMemoryIds = new Set([1]);

    const { content } = buildZoneBContent(memories, [], cooperationMemoryIds);

    expect(content).toContain('[Cooperation History]');
    expect(content).toContain('- Cooperated on refactor with agent-2');
  });

  it('test-2: cooperation block absent when no IDs provided', () => {
    const memories = [
      makeMemory(1, 'Regular short memory', 'short'),
    ];

    const { content } = buildZoneBContent(memories, []);

    expect(content).not.toContain('[Cooperation History]');
  });

  it('test-3: cooperation memories excluded from Related Context block', () => {
    const memories = [
      makeMemory(10, 'Shared task context', 'short'),
      makeMemory(11, 'Normal short memory', 'short'),
    ];
    // Memory 10 is tagged as cooperation — should NOT appear in [Related Context]
    const cooperationMemoryIds = new Set([10]);

    const { content } = buildZoneBContent(memories, [], cooperationMemoryIds);

    expect(content).toContain('[Cooperation History]');
    expect(content).toContain('- Shared task context');

    // The Related Context block must exist for the non-cooperation memory
    expect(content).toContain('[Related Context]');
    expect(content).toContain('- Normal short memory');

    // Ensure the cooperation memory does not also appear under Related Context
    const relatedIdx = content.indexOf('[Related Context]');
    const relatedSection = relatedIdx !== -1 ? content.slice(relatedIdx) : '';
    expect(relatedSection).not.toContain('- Shared task context');
  });

  it('test-4: cooperation memory with layer=long excluded from Long-term Memory block', () => {
    const memories = [
      makeMemory(5, 'Long-term collab note', 'long'),
      makeMemory(6, 'Regular long-term pref', 'long'),
    ];
    // Memory 5 is cooperation despite being layer=long
    const cooperationMemoryIds = new Set([5]);

    const { content } = buildZoneBContent(memories, [], cooperationMemoryIds);

    // Memory 5 should appear in Cooperation History
    expect(content).toContain('[Cooperation History]');
    expect(content).toContain('- Long-term collab note');

    // Memory 5 should NOT appear in Long-term Memory
    const ltmIdx = content.indexOf('[Long-term Memory]');
    const ltmSection = ltmIdx !== -1 ? content.slice(ltmIdx).split('\n\n')[0] : '';
    expect(ltmSection).not.toContain('- Long-term collab note');

    // Memory 6 should still appear in Long-term Memory
    expect(content).toContain('[Long-term Memory]');
    expect(content).toContain('- Regular long-term pref');
  });

  it('test-5: cooperation block capped at MAX_COOPERATION_ENTRIES (10)', () => {
    // Create 15 cooperation memories
    const memories = Array.from({ length: 15 }, (_, i) =>
      makeMemory(i + 1, `Coop memory ${i + 1}`, 'short')
    );
    const cooperationMemoryIds = new Set(memories.map(m => m.id));

    const { content } = buildZoneBContent(memories, [], cooperationMemoryIds);

    // Count how many "- Coop memory" lines appear
    const matches = content.match(/^- Coop memory \d+/gm);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeLessThanOrEqual(MAX_COOPERATION_ENTRIES);
    expect(matches.length).toBe(10);
  });

  it('test-6: block order is Long-term → Cooperation → Skills → Related → Dormant', () => {
    const memories = [
      makeMemory(1, 'Skill entry', 'short_skill'),
      makeMemory(2, 'Long-term pref', 'long'),
      makeMemory(3, 'Coop history entry', 'short'),
      makeMemory(4, 'Regular context', 'short'),
    ];
    const cooperationMemoryIds = new Set([3]);
    const dormantSummaries = ['Dormant summary'];

    const { content } = buildZoneBContent(memories, dormantSummaries, cooperationMemoryIds);

    const idxLongTerm = content.indexOf('[Long-term Memory]');
    const idxCooperation = content.indexOf('[Cooperation History]');
    const idxSkills = content.indexOf('[Learned Skills]');
    const idxRelated = content.indexOf('[Related Context]');
    const idxDormant = content.indexOf('[Dormant Session Context]');

    expect(idxLongTerm).toBeGreaterThanOrEqual(0);
    expect(idxCooperation).toBeGreaterThan(idxLongTerm);
    expect(idxSkills).toBeGreaterThan(idxCooperation);
    expect(idxRelated).toBeGreaterThan(idxSkills);
    expect(idxDormant).toBeGreaterThan(idxRelated);
  });

  it('test-7: blockCount is incremented when cooperation block is present', () => {
    const memories = [
      makeMemory(1, 'Coop entry', 'short'),
      makeMemory(2, 'Regular entry', 'short'),
    ];

    const withoutCoop = buildZoneBContent(memories, []);
    const withCoop = buildZoneBContent(memories, [], new Set([1]));

    // Adding cooperation block should increase blockCount by 1
    expect(withCoop.blockCount).toBe(withoutCoop.blockCount + 1);
  });

  it('test-8: empty cooperationMemoryIds Set is backward-compatible (no cooperation block)', () => {
    const memories = [
      makeMemory(1, 'Some context', 'short'),
    ];

    const withEmptySet = buildZoneBContent(memories, [], new Set());
    const withNoArg = buildZoneBContent(memories, []);

    expect(withEmptySet.content).toBe(withNoArg.content);
    expect(withEmptySet.blockCount).toBe(withNoArg.blockCount);
  });

  it('test-9: cooperation ID not matching any memory is silently ignored', () => {
    const memories = [
      makeMemory(1, 'Normal memory', 'short'),
    ];
    // ID 999 does not exist in memories array
    const cooperationMemoryIds = new Set([999]);

    let result;
    expect(() => {
      result = buildZoneBContent(memories, [], cooperationMemoryIds);
    }).not.toThrow();

    // No cooperation block since no matching memory was found
    expect(result.content).not.toContain('[Cooperation History]');
    // Normal memory still appears
    expect(result.content).toContain('[Related Context]');
    expect(result.content).toContain('- Normal memory');
  });

  it('test-10: MAX_COOPERATION_ENTRIES is exported and equals 10', () => {
    expect(MAX_COOPERATION_ENTRIES).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Part 2: _searchAndTouchMemory — cooperation fetch integration
// ---------------------------------------------------------------------------

describe('P9-A: _searchAndTouchMemory — cooperation fetch', () => {
  it('test-11: calls findByTag with collaboration tag and includeDescendants=true', () => {
    const findByTagMock = vi.fn().mockReturnValue([]);
    const ce = makeCE({ findByTag: findByTagMock });

    ce._searchAndTouchMemory(makeEvent('hello'));

    // Verify at least one call used the 'collaboration' tag with includeDescendants
    const collaborationCall = findByTagMock.mock.calls.find(
      ([args]) => args.tagName === 'collaboration' && args.includeDescendants === true
    );
    expect(collaborationCall).toBeDefined();
  });

  it('test-12: cooperation results are limited to 20 entries', () => {
    const thirtyMemories = Array.from({ length: 30 }, (_, i) =>
      makeMemory(i + 100, `Coop memory ${i + 100}`, 'short', ['collaboration'])
    );

    // findByTag returns 30 items when asked for 'collaboration'
    const findByTagMock = vi.fn(({ tagName }) => {
      if (tagName === 'collaboration') return thirtyMemories;
      return [];
    });
    const ce = makeCE({ findByTag: findByTagMock });

    const { cooperationMemoryIds } = ce._searchAndTouchMemory(makeEvent('hello'));

    expect(cooperationMemoryIds.size).toBeLessThanOrEqual(20);
    expect(cooperationMemoryIds.size).toBe(20);
  });

  it('test-13: cooperation memories are deduplicated with event-based results', () => {
    const sharedMemory = makeMemory(42, 'Shared coop+event memory', 'short', ['collaboration']);

    // findByTag returns the shared memory for both an event tag and the collaboration tag
    const findByTagMock = vi.fn().mockReturnValue([sharedMemory]);
    const ce = makeCE({ findByTag: findByTagMock, search: () => [] });

    const { selected } = ce._searchAndTouchMemory(makeEvent('short text'));

    // Count occurrences of ID 42 in selected — must be exactly 1
    const occurrences = selected.filter(m => m.id === 42).length;
    expect(occurrences).toBe(1);
  });

  it('test-14: return value includes cooperationMemoryIds as a Set', () => {
    const coopMemory = makeMemory(7, 'Collab note', 'short', ['collaboration']);

    const findByTagMock = vi.fn(({ tagName }) => {
      if (tagName === 'collaboration') return [coopMemory];
      return [];
    });
    const ce = makeCE({ findByTag: findByTagMock });

    const result = ce._searchAndTouchMemory(makeEvent('hello'));

    expect(result).toHaveProperty('cooperationMemoryIds');
    expect(result.cooperationMemoryIds).toBeInstanceOf(Set);
    expect(result.cooperationMemoryIds.has(7)).toBe(true);
  });

  it('test-15: cooperation fetch returns empty Set when no collaboration memories exist', () => {
    const findByTagMock = vi.fn().mockReturnValue([]);
    const ce = makeCE({ findByTag: findByTagMock, search: () => [] });

    const { cooperationMemoryIds } = ce._searchAndTouchMemory(makeEvent('hello'));

    expect(cooperationMemoryIds).toBeInstanceOf(Set);
    expect(cooperationMemoryIds.size).toBe(0);
  });

  it('test-16: touchAccess is called for cooperation memories', () => {
    const touchAccessMock = vi.fn();
    const coopMemory = makeMemory(55, 'Agent collab entry', 'short', ['collaboration']);

    const ce = new ContextEngine({
      agentId: 'agent-1',
      agentName: 'TestAgent',
      ceAccessView: {
        findByTag: vi.fn(({ tagName }) => {
          if (tagName === 'collaboration') return [coopMemory];
          return [];
        }),
        search: vi.fn().mockReturnValue([]),
        touchAccess: touchAccessMock,
      },
      metaStore: {
        list: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
        create: vi.fn(),
        update: vi.fn(),
      },
      historyStore: { length: () => 0, readRange: () => [] },
      ceChannel: vi.fn(),
      buildSystemPrompt: vi.fn().mockResolvedValue({ system: 'sys', user: 'usr' }),
      getToolsForAgent: vi.fn().mockReturnValue([]),
      // Fix B-4: agentManager required — stub with empty personality.
      agentManager: { getPersonality: async () => '' },
    });

    ce._searchAndTouchMemory(makeEvent('hello'));

    // touchAccess must have been called at least once with the cooperation memory's ID
    const touchedIds = touchAccessMock.mock.calls.map(([args]) => args.id);
    expect(touchedIds).toContain(55);
  });
});
