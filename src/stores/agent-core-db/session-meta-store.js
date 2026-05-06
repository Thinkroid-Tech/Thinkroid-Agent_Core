/**
 * Session Meta Store — CE-managed session metadata.
 * CRITICAL: Supervisor can ONLY write the 'status' field.
 * All other fields are CE's responsibility.
 *
 * Phase 11 Tier G: writes go to per-agent `office/agents/<name>/agent-core.db`
 * (owned by AgentCoreDbRegistry). The previous global `office/sessions.db` is
 * retired; existing rows are migrated by
 * `scripts/migrate-sessions-to-agent-core-db.js`.
 */

/** Fields that the Supervisor role is permitted to write.
 *  status: session lifecycle transitions (Awake/Drowsy/Dormant/Archived)
 *  linger, linger_count: linger lifecycle management (P6-C)
 *  pending_requests, keepalive_renewals, keepalive_start_time: keep-alive lifecycle (P6-B)
 */
const SUPERVISOR_ALLOWED_FIELDS = [
  'status', 'linger', 'linger_count',
  'pending_requests', 'keepalive_renewals', 'keepalive_start_time',
];

/** Fields that the Cerebellum role is permitted to write.
 *  cerebellum_l1_cursor, cerebellum_l2_cursor: cursor advancement
 *  last_l2_at: L2 tick timestamp
 *  summary: session summary from L2 Phase 1 (P7-B1)
 */
const CEREBELLUM_ALLOWED_FIELDS = [
  'cerebellum_l1_cursor', 'cerebellum_l2_cursor', 'last_l2_at', 'summary',
];

/**
 * Deserialize a raw SQLite row into a SessionMeta JS object.
 * - tags: TEXT JSON array → string[]
 * - linger: INTEGER 0/1 → boolean
 */
function rowToMeta(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags),
    linger: row.linger !== 0,
  };
}

export class SessionMetaStore {
  constructor(db) { this._db = db; }

  /**
   * Create a new session meta entry.
   * @param {import('../../types/session-meta.js').SessionMeta} sessionMeta
   */
  create(sessionMeta) {
    if (!this._db) return;
    const stmt = this._db.prepare(`
      INSERT INTO session_meta (
        session_id, parent_session_id, agent_id, summary, tags, status,
        turn_count, context_size_pct, pending_requests, keepalive_renewals,
        keepalive_start_time, linger, linger_count,
        cerebellum_l1_cursor, cerebellum_l2_cursor,
        created_at, last_active_at
      ) VALUES (
        @session_id, @parent_session_id, @agent_id, @summary, @tags, @status,
        @turn_count, @context_size_pct, @pending_requests, @keepalive_renewals,
        @keepalive_start_time, @linger, @linger_count,
        @cerebellum_l1_cursor, @cerebellum_l2_cursor,
        @created_at, @last_active_at
      )
    `);
    stmt.run({
      ...sessionMeta,
      tags: JSON.stringify(sessionMeta.tags ?? []),
      linger: sessionMeta.linger ? 1 : 0,
      parent_session_id: sessionMeta.parent_session_id ?? null,
      keepalive_start_time: sessionMeta.keepalive_start_time ?? null,
    });
  }

  /**
   * Read session meta by session_id.
   * @param {string} sessionId
   * @returns {import('../../types/session-meta.js').SessionMeta|null}
   */
  get(sessionId) {
    if (!this._db) return null;
    const row = this._db.prepare(
      'SELECT * FROM session_meta WHERE session_id = ?'
    ).get(sessionId);
    return rowToMeta(row);
  }

  /**
   * List all sessions for an agent, optionally filtered by status.
   * @param {{ agentId: string, status?: string }} opts
   * @returns {import('../../types/session-meta.js').SessionMeta[]}
   */
  list({ agentId, status }) {
    if (!this._db) return [];
    if (status !== undefined) {
      const rows = this._db.prepare(
        'SELECT * FROM session_meta WHERE agent_id = ? AND status = ?'
      ).all(agentId, status);
      return rows.map(rowToMeta);
    }
    const rows = this._db.prepare(
      'SELECT * FROM session_meta WHERE agent_id = ?'
    ).all(agentId);
    return rows.map(rowToMeta);
  }

  /**
   * Update session meta fields.
   * @param {string} sessionId
   * @param {Partial<import('../../types/session-meta.js').SessionMeta>} patch
   * @param {'ce'|'supervisor'} caller - Determines which fields can be written
   * @throws {Error} if supervisor tries to write non-status fields
   */
  update(sessionId, patch, caller) {
    // Supervisor write guard
    if (caller === 'supervisor') {
      const keys = Object.keys(patch);
      const forbidden = keys.filter(k => !SUPERVISOR_ALLOWED_FIELDS.includes(k));
      if (forbidden.length > 0) {
        throw new Error(
          `Supervisor cannot write fields: ${forbidden.join(', ')}. Only 'status' is allowed.`
        );
      }
    }

    // Cerebellum write guard
    if (caller === 'cerebellum') {
      const keys = Object.keys(patch);
      const forbidden = keys.filter(k => !CEREBELLUM_ALLOWED_FIELDS.includes(k));
      if (forbidden.length > 0) {
        throw new Error(
          `Cerebellum cannot write fields: ${forbidden.join(', ')}. Allowed: ${CEREBELLUM_ALLOWED_FIELDS.join(', ')}.`
        );
      }
    }

    // No-op when db is null (e.g. guard-only unit tests)
    if (!this._db) return;

    // Build SET clause dynamically from patch keys
    const normalized = { ...patch };
    if ('tags' in normalized) {
      normalized.tags = JSON.stringify(normalized.tags);
    }
    if ('linger' in normalized) {
      normalized.linger = normalized.linger ? 1 : 0;
    }

    // Always bump last_active_at
    normalized.last_active_at = Date.now();

    const setClauses = Object.keys(normalized).map(k => `${k} = @${k}`).join(', ');
    const stmt = this._db.prepare(
      `UPDATE session_meta SET ${setClauses} WHERE session_id = @_session_id`
    );
    stmt.run({ ...normalized, _session_id: sessionId });
  }

  /**
   * Delete session meta (for cleanup).
   * @param {string} sessionId
   */
  delete(sessionId) {
    if (!this._db) return;
    this._db.prepare('DELETE FROM session_meta WHERE session_id = ?').run(sessionId);
  }
}
