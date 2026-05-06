import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ReadOnlyView, CeAccessView, CerebellumL1View, CerebellumL2View } from './views.js';
import { Lock } from './lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, 'schema.sql');
const CURRENT_USER_VERSION = 4;

export class ThinkroidMemory {
  /**
   * @param {string} dbPath - Path to the SQLite database file
   * @param {string} agentId - Unique identifier for the agent using this memory instance
   */
  constructor(dbPath, agentId) {
    this._dbPath = dbPath;
    this._agentId = agentId;
    this._db = null;
    /** @type {Lock} Per-instance mutex for L1/L2 serialization (DL-8). */
    this.lock = new Lock();
  }

  /**
   * Synchronous. Idempotent — creates DB + schema if not exists.
   * Opens better-sqlite3 connection, sets PRAGMAs, applies schema.sql if needed.
   */
  open() {
    if (this._db !== null) return;

    this._db = new Database(this._dbPath);

    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');

    // Register exp_decay(lambda, lastTriggeredMs, nowMs) → e^(-lambda * daysDiff)
    // Used by recomputeDecayScores() via pure SQL UPDATE (DL requirement).
    this._db.function('exp_decay', (lambda, lastTriggeredMs, nowMs) =>
      Math.exp(-lambda * (nowMs - lastTriggeredMs) / 86400000)
    );

    const userVersion = this._db.pragma('user_version', { simple: true });
    if (userVersion < 1) {
      // First-time setup: create all tables from schema.sql (includes summaries table).
      const sql = readFileSync(SCHEMA_PATH, 'utf8');
      this._db.exec(sql);
      this._db.pragma(`user_version = ${CURRENT_USER_VERSION}`);
    } else if (userVersion < 2) {
      // Migration v1 → v2: memory_audit.memory_id becomes nullable with ON DELETE SET NULL.
      // SQLite does not support ALTER TABLE to change FK constraints, so the table is recreated.
      this._db.exec(`
        CREATE TABLE memory_audit_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id   INTEGER REFERENCES memories (id) ON DELETE SET NULL,
          operation   TEXT    NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'promote', 'prune', 'merge', 'rename_tag', 'unrelate_tags', 'detect_loop')),
          old_content TEXT,
          new_content TEXT,
          changed_by  TEXT    NOT NULL,
          changed_at  INTEGER NOT NULL
        );
        INSERT INTO memory_audit_new SELECT * FROM memory_audit;
        DROP TABLE memory_audit;
        ALTER TABLE memory_audit_new RENAME TO memory_audit;
        CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id  ON memory_audit (memory_id);
        CREATE INDEX IF NOT EXISTS idx_memory_audit_changed_at ON memory_audit (changed_at);
      `);
      this._db.pragma(`user_version = 2`);
    }

    // Re-read version: v1→v2 migration above sets it to 2, so check again for v3.
    const versionAfterV2 = this._db.pragma('user_version', { simple: true });
    if (versionAfterV2 < 3) {
      // Migration v2 → v3: Add summaries table (P7-B1, DL-48).
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS summaries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          level        TEXT    NOT NULL CHECK(level IN ('daily','weekly','monthly','quarterly','yearly')),
          period_start INTEGER NOT NULL,
          period_end   INTEGER NOT NULL,
          content      TEXT    NOT NULL DEFAULT '',
          source_ids   TEXT    NOT NULL DEFAULT '[]',
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_summaries_level_period ON summaries(level, period_start);
      `);
      this._db.pragma(`user_version = 3`);
    }

    // Re-read version: v2→v3 migration above sets it to 3, so check again for v4.
    const versionAfterV3 = this._db.pragma('user_version', { simple: true });
    if (versionAfterV3 < 4) {
      // M1: Migration v3 → v4: Remove changed_by CHECK constraint from memory_audit.
      // SQLite does not support ALTER TABLE to drop constraints, so the table is recreated.
      // Wrapped in try/catch: migration failure is non-fatal (old schema still functional).
      try {
        this._db.exec(`
          CREATE TABLE memory_audit_new (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id   INTEGER REFERENCES memories (id) ON DELETE SET NULL,
            operation   TEXT    NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'promote', 'prune', 'merge', 'rename_tag', 'unrelate_tags', 'detect_loop')),
            old_content TEXT,
            new_content TEXT,
            changed_by  TEXT    NOT NULL,
            changed_at  INTEGER NOT NULL
          );
          INSERT INTO memory_audit_new SELECT * FROM memory_audit;
          DROP TABLE memory_audit;
          ALTER TABLE memory_audit_new RENAME TO memory_audit;
          CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id  ON memory_audit (memory_id);
          CREATE INDEX IF NOT EXISTS idx_memory_audit_changed_at ON memory_audit (changed_at);
        `);
        this._db.pragma(`user_version = 4`);
        console.log('[thinkroid-memory] M1: migrated memory_audit — removed changed_by CHECK constraint');
      } catch (e) {
        console.warn('[thinkroid-memory] M1 migration failed (non-fatal):', e.message);
      }
    }
  }

  close() {
    if (this._db !== null) {
      this._db.close();
      this._db = null;
    }
  }

  /** @returns {string} */
  get agentId() { return this._agentId; }

  /** @returns {boolean} */
  get isOpen() { return this._db !== null; }

  /** @returns {ReadOnlyView} */
  viewForReadOnly() { return new ReadOnlyView(this._db); }

  /**
   * @param {{ selectedIncrement: number, seenIncrement: number }} incrementConfig
   * @returns {CeAccessView}
   */
  viewForCeAccess(incrementConfig) { return new CeAccessView(this._db, incrementConfig); }

  /** @returns {CerebellumL1View} */
  viewForCerebellumL1() { return new CerebellumL1View(this._db); }

  /** @returns {CerebellumL2View} */
  viewForCerebellumL2() { return new CerebellumL2View(this._db); }
}
