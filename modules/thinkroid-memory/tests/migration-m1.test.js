import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ThinkroidMemory } from '../src/api.js';

// =================== Helpers ===================

/**
 * Create an isolated ThinkroidMemory instance backed by a temp DB.
 * @returns {{ mem: ThinkroidMemory, dbPath: string, tmpDir: string }}
 */
function createTempMemory() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-m1-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const mem = new ThinkroidMemory(dbPath, 'test-agent');
  return { mem, dbPath, tmpDir };
}

/**
 * Insert a minimal memory row so that memory_audit rows have a valid memory_id FK.
 * @param {import('better-sqlite3').Database} db
 * @returns {number} new memory row id
 */
function seedMemoryRow(db) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, decay_score, confidence, writer)
     VALUES ('short', 'seed content', 'test', ?, ?, ?, 0, 1.0, 'medium', 'cerebellum-l1')`
  ).run(now, now, now);
  return Number(info.lastInsertRowid);
}

// =================== Tests ===================

describe('M1 — changed_by CHECK constraint removal (TD-1)', () => {
  let mem;
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    ({ mem, dbPath, tmpDir } = createTempMemory());
    mem.open();
  });

  afterEach(() => {
    mem.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('insert with changed_by = cerebellum-l1 succeeds (regression)', () => {
    const db = new Database(dbPath);
    try {
      const memId = seedMemoryRow(db);
      expect(() => {
        db.prepare(
          `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
           VALUES (?, 'create', NULL, 'hello', 'cerebellum-l1', ?)`
        ).run(memId, Date.now());
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('insert with changed_by = cerebellum-l2 succeeds (regression)', () => {
    const db = new Database(dbPath);
    try {
      const memId = seedMemoryRow(db);
      expect(() => {
        db.prepare(
          `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
           VALUES (?, 'update', 'old', 'new', 'cerebellum-l2', ?)`
        ).run(memId, Date.now());
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('insert with changed_by = migration succeeds (was blocked by CHECK)', () => {
    const db = new Database(dbPath);
    try {
      const memId = seedMemoryRow(db);
      expect(() => {
        db.prepare(
          `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
           VALUES (?, 'create', NULL, 'migrated content', 'migration', ?)`
        ).run(memId, Date.now());
      }).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('M1 migration removes CHECK constraint from pre-existing DB at user_version=3', () => {
    // Build a v3 DB with the old CHECK constraint manually, then re-open via ThinkroidMemory
    // to trigger the v3→v4 migration.
    const v3TmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-m1-v3-'));
    const v3DbPath = join(v3TmpDir, 'v3.db');
    try {
      // Create a DB that looks like user_version=3 with the old CHECK constraint.
      const rawDb = new Database(v3DbPath);
      rawDb.pragma('journal_mode = WAL');
      rawDb.pragma('foreign_keys = ON');
      rawDb.exec(`
        CREATE TABLE memories (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          layer             TEXT    NOT NULL CHECK (layer IN ('short', 'long', 'short_skill', 'long_skill')),
          content           TEXT    NOT NULL,
          source_session    TEXT,
          source_timestamp  INTEGER NOT NULL,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          access_count      INTEGER NOT NULL DEFAULT 0,
          last_triggered_at INTEGER,
          decay_score       REAL    NOT NULL DEFAULT 1.0 CHECK (decay_score >= 0.0 AND decay_score <= 1.0),
          confidence        TEXT    NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
          writer            TEXT    NOT NULL CHECK (writer IN ('cerebellum-l1', 'cerebellum-l2'))
        )
      `);
      rawDb.exec(`
        CREATE TABLE memory_audit (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id   INTEGER REFERENCES memories (id) ON DELETE SET NULL,
          operation   TEXT    NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'promote', 'prune', 'merge', 'rename_tag', 'unrelate_tags', 'detect_loop')),
          old_content TEXT,
          new_content TEXT,
          changed_by  TEXT    NOT NULL CHECK (changed_by IN ('cerebellum-l1', 'cerebellum-l2')),
          changed_at  INTEGER NOT NULL
        )
      `);
      rawDb.exec(`
        CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id  ON memory_audit (memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_changed_at ON memory_audit (changed_at);
        CREATE TABLE IF NOT EXISTS summaries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          level        TEXT    NOT NULL CHECK(level IN ('daily','weekly','monthly','quarterly','yearly')),
          period_start INTEGER NOT NULL,
          period_end   INTEGER NOT NULL,
          content      TEXT    NOT NULL DEFAULT '',
          source_ids   TEXT    NOT NULL DEFAULT '[]',
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_level_period ON summaries(level, period_start)
      `);
      rawDb.pragma('user_version = 3');
      rawDb.close();

      // Now open with ThinkroidMemory — should run M1 migration automatically.
      const migratedMem = new ThinkroidMemory(v3DbPath, 'migrator-agent');
      migratedMem.open();

      // Verify: inserting a non-standard changed_by value should now succeed.
      const db2 = new Database(v3DbPath);
      try {
        const now = Date.now();
        const info = db2.prepare(
          `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, decay_score, confidence, writer)
           VALUES ('short', 'test', 'test', ?, ?, ?, 0, 1.0, 'medium', 'cerebellum-l1')`
        ).run(now, now, now);
        const memId = Number(info.lastInsertRowid);

        expect(() => {
          db2.prepare(
            `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
             VALUES (?, 'create', NULL, 'v3-migrated', 'migration', ?)`
          ).run(memId, now);
        }).not.toThrow();
      } finally {
        db2.close();
        migratedMem.close();
      }
    } finally {
      rmSync(v3TmpDir, { recursive: true, force: true });
    }
  });
});
