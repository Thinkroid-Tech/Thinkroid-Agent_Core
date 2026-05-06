-- ThinkroidMemory schema
-- All timestamps are epoch milliseconds (INTEGER)
-- decay_score and weight are stored as REAL (0.0 to 1.0)

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- memories
-- ============================================================
CREATE TABLE IF NOT EXISTS memories (
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
);

CREATE INDEX IF NOT EXISTS idx_memories_layer         ON memories (layer);
CREATE INDEX IF NOT EXISTS idx_memories_decay_score   ON memories (decay_score);
CREATE INDEX IF NOT EXISTS idx_memories_source_session ON memories (source_session);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at    ON memories (updated_at);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL DEFAULT '',
  level       INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0 AND level <= 1000),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tags_name  ON tags (name);
CREATE INDEX IF NOT EXISTS idx_tags_level ON tags (level);

-- ============================================================
-- edges
-- Supports tag→tag, tag→memory, memory→memory relationships
-- ============================================================
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type   TEXT    NOT NULL CHECK (from_type IN ('tag', 'memory')),
  from_id     INTEGER NOT NULL,
  to_type     TEXT    NOT NULL CHECK (to_type IN ('tag', 'memory')),
  to_id       INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('parent_of', 'related_to', 'synonym_of', 'opposite_of', 'tagged_with')),
  description TEXT,
  weight      REAL             CHECK (weight IS NULL OR (weight >= 0.0 AND weight <= 1.0)),
  created_at  INTEGER NOT NULL,
  UNIQUE (from_type, from_id, to_type, to_id, kind),
  CHECK ((kind = 'tagged_with') OR (description IS NOT NULL AND weight IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges (from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges (to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges (kind);

-- ============================================================
-- memory_audit
-- Immutable log of every write operation on memories and tags.
-- memory_id is nullable: tag operations (rename_tag, unrelate_tags, detect_loop)
-- have no associated memory and write NULL. For delete/prune operations, the
-- row is inserted before the memory is removed; ON DELETE SET NULL preserves
-- the audit row with memory_id=NULL after the memory is deleted.
-- ============================================================
CREATE TABLE IF NOT EXISTS memory_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   INTEGER REFERENCES memories (id) ON DELETE SET NULL,
  operation   TEXT    NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'promote', 'prune', 'merge', 'rename_tag', 'unrelate_tags', 'detect_loop')),
  old_content TEXT,
  new_content TEXT,
  changed_by  TEXT    NOT NULL,
  changed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_memory_id  ON memory_audit (memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_audit_changed_at ON memory_audit (changed_at);

-- ============================================================
-- summaries (P7-B1, DL-48)
-- Stores multi-level periodic summaries: daily, weekly, monthly, quarterly, yearly.
-- source_ids is a JSON array of IDs from the source level used to generate the summary.
-- ============================================================
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
