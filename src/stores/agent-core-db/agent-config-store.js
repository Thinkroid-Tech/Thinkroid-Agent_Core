/**
 * AgentConfigStore — CRUD wrapper over the `agent_config` table of
 * per-agent agent-core.db.
 *
 * Values are stored as TEXT. Callers can serialize JSON/text as they
 * see fit. The `personality` key is the anchor use case for Phase 11
 * Tier B and is stored as plain text (no JSON wrapping).
 */

export class AgentConfigStore {
  /**
   * @param {import('better-sqlite3').Database} db - An already-opened agent-core.db handle
   */
  constructor(db) {
    if (!db) throw new Error('AgentConfigStore requires an opened Database handle');
    this._db = db;
  }

  /**
   * Read a config value.
   * @param {string} key
   * @returns {string|null}
   */
  get(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('AgentConfigStore.get: key must be a non-empty string');
    }
    const row = this._db.prepare('SELECT value FROM agent_config WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /**
   * Read the full row (value + audit metadata) for a key.
   * @param {string} key
   * @returns {{ key: string, value: string, updated_at: number, updated_by: string }|null}
   */
  getRow(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('AgentConfigStore.getRow: key must be a non-empty string');
    }
    const row = this._db.prepare(
      'SELECT key, value, updated_at, updated_by FROM agent_config WHERE key = ?',
    ).get(key);
    return row || null;
  }

  /**
   * Insert or update a config value. Upserts on primary key.
   * @param {string} key
   * @param {string} value
   * @param {{ updatedBy?: string, now?: number }} [opts]
   */
  set(key, value, { updatedBy = 'system', now = Date.now() } = {}) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('AgentConfigStore.set: key must be a non-empty string');
    }
    if (typeof value !== 'string') {
      throw new Error('AgentConfigStore.set: value must be a string');
    }
    this._db.prepare(`
      INSERT INTO agent_config (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(key, value, now, updatedBy);
  }

  /**
   * Delete a config key.
   * @param {string} key
   * @returns {boolean} true if a row was removed
   */
  delete(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('AgentConfigStore.delete: key must be a non-empty string');
    }
    const info = this._db.prepare('DELETE FROM agent_config WHERE key = ?').run(key);
    return info.changes > 0;
  }

  /**
   * List all config rows (admin / introspection use).
   * @returns {Array<{ key: string, value: string, updated_at: number, updated_by: string }>}
   */
  list() {
    return this._db.prepare(
      'SELECT key, value, updated_at, updated_by FROM agent_config ORDER BY key ASC',
    ).all();
  }
}
