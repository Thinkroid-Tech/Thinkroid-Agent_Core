-- Per-agent Agent Core database schema.
-- One file per agent: office/agents/{agentId}/agent-core.db
-- Phase 11 Tier B established all three tables at once; Tier G populated
-- session_meta / session_history by migrating the legacy sessions.db.
--
-- Phase 12 scope-key policy: the per-agent directory is keyed by agents.id
-- (UUID) rather than agents.name. session_meta.agent_id stores the same
-- UUID, so renaming an agent is a single UPDATE on agents.name with zero
-- fan-out. The `agentName` parameter name that still appears in some Agent
-- Core registry APIs is a TEMP adapter; T2 migrates the callers to agentId.

CREATE TABLE IF NOT EXISTS agent_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS session_meta (
  session_id           TEXT    PRIMARY KEY,
  parent_session_id    TEXT,
  agent_id             TEXT    NOT NULL,
  summary              TEXT    NOT NULL DEFAULT '',
  tags                 TEXT    NOT NULL DEFAULT '[]',
  status               TEXT    NOT NULL DEFAULT 'awake'
                        CHECK(status IN ('awake','drowsy','dormant','archived')),
  turn_count           INTEGER NOT NULL DEFAULT 0,
  context_size_pct     REAL    NOT NULL DEFAULT 0,
  pending_requests     INTEGER NOT NULL DEFAULT 0,
  keepalive_renewals   INTEGER NOT NULL DEFAULT 0,
  keepalive_start_time INTEGER,
  linger               INTEGER NOT NULL DEFAULT 0,
  linger_count         INTEGER NOT NULL DEFAULT 0,
  cerebellum_l1_cursor INTEGER NOT NULL DEFAULT 0,
  cerebellum_l2_cursor INTEGER NOT NULL DEFAULT 0,
  last_l2_at           INTEGER,
  created_at           INTEGER NOT NULL,
  last_active_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  turn_index  INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  content     TEXT,
  tool_calls  TEXT,
  created_at  INTEGER NOT NULL,
  -- Phase 16 B.4 (Design §7.0): the daemon writes turns in
  -- `'in_progress'` and finalizes them as `'completed'` / `'interrupted'`
  -- / `'failed'` later. There is no column-level DEFAULT — the
  -- application contract requires every caller to write the status
  -- explicitly, and the BEFORE-INSERT/UPDATE triggers installed by
  -- `applySessionHistoryStatusMigration` (in db.js) reject NULL or
  -- out-of-enum values. Legacy rows that pre-date Phase 16 are
  -- back-filled as `'completed'` by that same migration. The column is
  -- repeated by the ALTER path in db.js for databases minted before
  -- this declaration landed.
  --
  -- NOTE: enum enforcement uses BEFORE INSERT/UPDATE triggers (see
  -- `applySessionHistoryStatusMigration` in
  -- services/agent-core/stores/agent-core-db/db.js) instead of a
  -- column-level CHECK constraint. SQLite cannot ALTER an existing
  -- column to add a CHECK after the fact, and the migration must
  -- support both fresh databases and legacy ones minted before Phase
  -- 16. Triggers give us idempotent ALTER-friendly enforcement plus
  -- retroactive coverage of rows that existed before the rule landed,
  -- which a column-level CHECK would not provide.
  status      TEXT,
  UNIQUE(session_id, turn_index)
);

CREATE TABLE IF NOT EXISTS token_usage (
  id                          TEXT PRIMARY KEY,
  agent_id                    TEXT NOT NULL,
  task_id                     TEXT,
  prompt_tokens               INTEGER NOT NULL DEFAULT 0,
  completion_tokens           INTEGER NOT NULL DEFAULT 0,
  total_tokens                INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  model                       TEXT,
  provider_id                 TEXT,
  source                      TEXT NOT NULL DEFAULT 'brain.chat',
  created_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_session ON session_history(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_meta_status ON session_meta(status);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage(created_at);
