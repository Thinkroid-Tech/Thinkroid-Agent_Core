/**
 * Per-agent Agent Core database connection.
 *
 * Each agent gets its own office/agents/{name}/agent-core.db file that
 * holds the authoritative agent_config (personality etc.), plus the
 * session_meta / session_history tables that were historically kept in a
 * global sessions.db (migrated in Phase 11 Tier G).
 *
 * Phase 16 B.4 (Design §7.0): `session_history.status` is now an enum
 * locked to ('in_progress','completed','interrupted','failed'). The
 * migration is a SQLite-friendly three-step pattern (see
 * `applySessionHistoryStatusMigration` below) — ALTER + UPDATE + two
 * BEFORE-INSERT/UPDATE triggers — because SQLite cannot ALTER a column
 * to add a CHECK constraint or change its default after the fact. The
 * application contract is: the daemon must explicitly write
 * `status='in_progress'` when creating new rows; legacy rows minted
 * before Phase 16 migrate to `'completed'`. There is intentionally NO
 * column-level default — relying on a SQLite default would let a buggy
 * caller silently produce in_progress rows that look like fresh
 * sessions, and would hide the contract violation.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const SESSION_HISTORY_STATUSES = ['in_progress', 'completed', 'interrupted', 'failed'];
const SESSION_HISTORY_STATUS_LIST_SQL = SESSION_HISTORY_STATUSES
  .map((s) => `'${s}'`)
  .join(',');

/**
 * Apply the Phase 16 B.4 `session_history.status` enum migration. The
 * migration is wrapped in a single transaction so a partial failure
 * rolls back cleanly (otherwise an ALTER could land without the
 * matching trigger and the next insert would silently bypass enum
 * validation).
 *
 * Step 3a: `ALTER TABLE … ADD COLUMN status TEXT` — SQLite will accept
 *          this even when the column already exists if we drive it
 *          through a try/catch, which is the idempotent escape hatch
 *          for "schema already migrated" boots.
 * Step 3b: backfill legacy rows (`status IS NULL`) with `'completed'`.
 *          Pre-Phase-16 rows are by definition finished sessions; this
 *          is the conservative default the Plan locks in.
 * Step 3c: install BEFORE-INSERT and BEFORE-UPDATE triggers that
 *          RAISE(ABORT, …) when `status` is NULL or outside the enum.
 *          The WHEN clauses include an explicit `IS NULL OR …` because
 *          SQLite evaluates `NULL NOT IN (…)` as NULL (which the
 *          trigger treats as falsy), and would otherwise silently
 *          bypass the check (M47 v4 fix).
 *
 * @param {import('better-sqlite3').Database} db
 */
function applySessionHistoryStatusMigration(db) {
  db.exec('BEGIN');
  try {
    // 3a — ALTER ADD COLUMN. The try/catch is the idempotency lever:
    // re-running on a database that already has `status` raises
    // "duplicate column name" and we treat that as a no-op.
    try {
      db.exec('ALTER TABLE session_history ADD COLUMN status TEXT');
    } catch (alterErr) {
      if (!/duplicate column name/i.test(String(alterErr.message))) {
        throw alterErr;
      }
    }

    // 3b — fill in pre-Phase-16 rows that came through before the
    // column existed. WHERE status IS NULL keeps this idempotent: a
    // second run finds zero NULL rows because every row now has a
    // value. New daemon-minted rows (which carry `'in_progress'`
    // explicitly) are not touched because their status is non-NULL.
    db.exec("UPDATE session_history SET status = 'completed' WHERE status IS NULL");

    // 3c — enum guards. CREATE TRIGGER IF NOT EXISTS keeps this
    // idempotent across boots. The WHEN clause includes the explicit
    // NULL check (M47 v4) so an INSERT/UPDATE writing NULL is rejected
    // alongside any non-enum value. The error message lists the legal
    // values so the daemon can surface a useful message at the
    // application boundary.
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS session_history_status_insert_check ' +
      'BEFORE INSERT ON session_history ' +
      `WHEN NEW.status IS NULL OR NEW.status NOT IN (${SESSION_HISTORY_STATUS_LIST_SQL}) ` +
      'BEGIN ' +
      `  SELECT RAISE(ABORT, 'session_history.status must be one of: ${SESSION_HISTORY_STATUSES.join(', ')}'); ` +
      'END;'
    );
    db.exec(
      'CREATE TRIGGER IF NOT EXISTS session_history_status_update_check ' +
      'BEFORE UPDATE OF status ON session_history ' +
      `WHEN NEW.status IS NULL OR NEW.status NOT IN (${SESSION_HISTORY_STATUS_LIST_SQL}) ` +
      'BEGIN ' +
      `  SELECT RAISE(ABORT, 'session_history.status must be one of: ${SESSION_HISTORY_STATUSES.join(', ')} (cannot UPDATE to NULL)'); ` +
      'END;'
    );

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Open (or create) the per-agent agent-core.db file.
 * Enables WAL, applies the schema idempotently, and returns the Database handle.
 *
 * @param {string} dbPath - Full path to agent-core.db (use ':memory:' in tests)
 * @returns {import('better-sqlite3').Database}
 */
export function openAgentCoreDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(ddl);

  // Phase 16 B.4 — must run after the base schema so the table exists.
  applySessionHistoryStatusMigration(db);

  return db;
}

/**
 * Close an agent-core.db connection. Safe to call on null.
 * @param {import('better-sqlite3').Database|null} db
 */
export function closeAgentCoreDb(db) {
  if (db) {
    try { db.close(); } catch { /* ignore close errors on shutdown */ }
  }
}

// Exported for unit-testing the migration in isolation (Phase 16 B.4).
export { applySessionHistoryStatusMigration };
