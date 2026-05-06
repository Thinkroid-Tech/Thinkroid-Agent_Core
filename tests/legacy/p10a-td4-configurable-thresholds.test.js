/**
 * P10-A TD-4: Configurable PRUNE_THRESHOLD and PROMOTION_THRESHOLDS.
 *
 * Verifies that CerebellumL2 accepts pruneThreshold / promotionThresholds
 * via constructor options and passes them through to the appropriate call sites.
 */

import { describe, it, expect, vi } from 'vitest';
import { CerebellumL2 } from '../cerebellum/layer2.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock set required by CerebellumL2 constructor. */
function makeMocks(overrides = {}) {
  return {
    agentId: 'test-agent',
    agentName: 'test-agent',
    memory: {
      lock: { withLock: (fn) => fn() },
      viewForCerebellumL2: vi.fn().mockReturnValue(overrides.l2View || {}),
    },
    metaStore: { listByAgent: vi.fn().mockReturnValue([]) },
    historyStore: { length: vi.fn().mockReturnValue(0) },
    cerebellumChannel: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P10-A TD-4: Configurable thresholds', () => {
  it('test-1: default thresholds used when no options provided', () => {
    const l2 = new CerebellumL2(makeMocks());
    expect(l2._pruneThreshold).toBe(0.1);
    expect(l2._promotionThresholds).toBe(null);
  });

  it('test-2: custom pruneThreshold stored on instance', () => {
    const l2 = new CerebellumL2(makeMocks({ pruneThreshold: 0.05 }));
    expect(l2._pruneThreshold).toBe(0.05);
  });

  it('test-3: custom promotionThresholds passed to findPromotable', async () => {
    const mockFindPromotable = vi.fn().mockReturnValue([]);
    const mockL2View = {
      recomputeDecayScores: vi.fn().mockReturnValue({ updatedCount: 0 }),
      findPromotable: mockFindPromotable,
      recent: vi.fn().mockReturnValue([]),
      prune: vi.fn(),
      detectLoops: vi.fn(),
    };

    const l2 = new CerebellumL2(makeMocks({
      promotionThresholds: { short: 5, short_skill: 25 },
    }));

    // Call _step2MemoryOrganization directly with the mock view
    await l2._step2MemoryOrganization(mockL2View);

    // findPromotable is called once per layer: 'short' and 'short_skill'
    expect(mockFindPromotable).toHaveBeenCalledWith({ layer: 'short', threshold: 5 });
    expect(mockFindPromotable).toHaveBeenCalledWith({ layer: 'short_skill', threshold: 25 });
  });

  it('test-4: findPromotable with explicit threshold override in CerebellumL2View', async () => {
    // Use real in-memory DB to test views.js findPromotable
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');

    // Minimal memories table schema
    db.exec(`
      CREATE TABLE memories (
        id   INTEGER PRIMARY KEY,
        layer TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Insert a row with access_count = 3
    db.prepare('INSERT INTO memories (id, layer, access_count) VALUES (?, ?, ?)').run(1, 'short', 3);

    // Import CerebellumL2View
    const { CerebellumL2View } = await import(
      '../../../../../modules/thinkroid-memory/src/views.js'
    );
    const view = new CerebellumL2View(db);

    // With threshold=3, should find the row (access_count >= 3)
    const found = view.findPromotable({ layer: 'short', threshold: 3 });
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ id: 1, newLayer: 'long' });

    // Without threshold override, uses default (10) — should NOT find it
    const notFound = view.findPromotable({ layer: 'short' });
    expect(notFound).toHaveLength(0);

    db.close();
  });
});
