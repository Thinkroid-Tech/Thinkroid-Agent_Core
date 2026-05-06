/**
 * P10-A TD-3: exp_decay registration guard in recomputeDecayScores().
 *
 * Test 1: recomputeDecayScores() with a properly opened ThinkroidMemory client
 *   succeeds (exp_decay is registered via ThinkroidMemory.open()).
 *
 * Test 2: recomputeDecayScores() on a raw better-sqlite3 connection that has
 *   the full schema but no exp_decay function registered throws a descriptive
 *   error containing "exp_decay SQL function not registered".
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ThinkroidMemory } from '../src/api.js';
import { CerebellumL2View } from '../src/views.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an isolated ThinkroidMemory instance backed by a temp file.
 * @returns {{ mem: ThinkroidMemory, tmpDir: string }}
 */
function createTempMemory() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-sg4-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const mem = new ThinkroidMemory(dbPath, 'test-agent');
  return { mem, tmpDir };
}

/**
 * Build a raw better-sqlite3 DB with the minimal memories table
 * but WITHOUT registering exp_decay. Used to simulate a caller that
 * bypassed ThinkroidMemory.open().
 * @returns {{ db: import('better-sqlite3').Database, tmpDir: string }}
 */
function createRawDbWithSchema() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-raw-sg4-test-'));
  const dbPath = join(tmpDir, 'raw.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Create memories table without registering exp_decay function
  const createMemoriesTable = [
    'CREATE TABLE IF NOT EXISTS memories (',
    '  id                INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  layer             TEXT    NOT NULL,',
    '  content           TEXT    NOT NULL,',
    '  source_session    TEXT,',
    '  source_timestamp  INTEGER NOT NULL,',
    '  created_at        INTEGER NOT NULL,',
    '  updated_at        INTEGER NOT NULL,',
    '  access_count      INTEGER NOT NULL DEFAULT 0,',
    '  last_triggered_at INTEGER,',
    '  decay_score       REAL    NOT NULL DEFAULT 1.0,',
    '  confidence        TEXT    NOT NULL DEFAULT \'medium\',',
    '  writer            TEXT    NOT NULL',
    ')',
  ].join('\n');
  db.prepare(createMemoriesTable).run();
  return { db, tmpDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SG-4 TD-3: exp_decay registration guard', () => {

  it('test-1: recomputeDecayScores() with ThinkroidMemory.open() succeeds', () => {
    const { mem, tmpDir } = createTempMemory();
    try {
      mem.open();
      const view = mem.viewForCerebellumL2();

      // Should not throw — exp_decay is registered by ThinkroidMemory.open()
      let result;
      expect(() => {
        result = view.recomputeDecayScores();
      }).not.toThrow();

      // Empty DB returns zero updated count
      expect(result).toEqual({ updatedCount: 0 });
    } finally {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('test-2: recomputeDecayScores() on raw DB without exp_decay throws descriptive error', () => {
    const { db, tmpDir } = createRawDbWithSchema();
    try {
      const view = new CerebellumL2View(db);

      expect(() => {
        view.recomputeDecayScores();
      }).toThrow('exp_decay SQL function not registered');
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true });
    }
  });

});
