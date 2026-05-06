/**
 * Session History Store — append-only per-session record of Brain turns.
 * Supports cursor-based reading for Cerebellum, freezing at Dormant.
 *
 * Freeze state is kept in-memory (transient). Phase 3 can persist it to
 * session_meta if needed — it only matters while the process is running.
 *
 * Phase 11 Tier G: writes go to per-agent `office/agents/<name>/agent-core.db`
 * (owned by AgentCoreDbRegistry). The previous global `office/sessions.db` is
 * retired; existing rows are migrated by
 * `scripts/migrate-sessions-to-agent-core-db.js`.
 */

export class SessionHistoryStore {
  constructor(db) {
    this._db = db;
    /** @type {Set<string>} session IDs whose history is frozen */
    this._frozen = new Set();
  }

  /**
   * Append a turn to session history.
   *
   * turn_index is auto-assigned as `MAX(turn_index) + 1` for the session, computed
   * and written inside a single transaction so concurrent / retried appends cannot
   * collide on the UNIQUE(session_id, turn_index) constraint (Tier E fix E-2).
   * Using COUNT(*) (as in the previous implementation) was racy: rows inserted in
   * earlier transactions could be counted while an outer transaction was still in
   * flight, and any prior row gap would silently duplicate an index.
   *
   * Phase 16 B.4 (Design §7.0): every row carries a `status` enum locked
   * to ('in_progress','completed','interrupted','failed'). New rows
   * default to `'in_progress'` because that is the application-layer
   * contract: a turn is in progress until the daemon's tool-loop /
   * lifecycle controller finalizes it. Callers may override with an
   * explicit `status` (Athena's task hand-off, for example, writes the
   * row in its terminal `'completed'` state directly).
   *
   * @param {{ sessionId: string, role: string, content?: string, toolCalls?: object, status?: string }} opts
   * @returns {number} the assigned turn_index
   * @throws {Error} if the session is frozen
   */
  append({ sessionId, role, content, toolCalls, status = 'in_progress' }) {
    if (this._frozen.has(sessionId)) {
      throw new Error(`Session ${sessionId} history is frozen — no further appends allowed.`);
    }

    const selectMax = this._db.prepare(
      'SELECT COALESCE(MAX(turn_index), -1) + 1 AS next FROM session_history WHERE session_id = ?'
    );
    const insert = this._db.prepare(`
      INSERT INTO session_history (session_id, turn_index, role, content, tool_calls, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const runAppend = this._db.transaction((r) => {
      const next = selectMax.get(r.sessionId).next;
      insert.run(
        r.sessionId,
        next,
        r.role,
        r.content ?? null,
        r.toolCalls !== undefined ? JSON.stringify(r.toolCalls) : null,
        Date.now(),
        r.status
      );
      return next;
    });

    return runAppend({ sessionId, role, content, toolCalls, status });
  }

  /**
   * Read turns from startIndex to endIndex (inclusive).
   * @param {{ sessionId: string, startIndex: number, endIndex: number }} opts
   * @returns {{ turnIndex: number, role: string, content: string|null, toolCalls: object|null, createdAt: number }[]}
   */
  readRange({ sessionId, startIndex, endIndex }) {
    if (!this._db) return [];
    const rows = this._db.prepare(`
      SELECT turn_index, role, content, tool_calls, created_at
      FROM session_history
      WHERE session_id = ? AND turn_index BETWEEN ? AND ?
      ORDER BY turn_index ASC
    `).all(sessionId, startIndex, endIndex);

    return rows.map(r => ({
      turnIndex: r.turn_index,
      role: r.role,
      content: r.content,
      toolCalls: r.tool_calls !== null ? JSON.parse(r.tool_calls) : null,
      createdAt: r.created_at,
    }));
  }

  /**
   * Get total number of turns in a session.
   * @param {string} sessionId
   * @returns {number}
   */
  length(sessionId) {
    if (!this._db) return 0;
    const row = this._db.prepare(
      'SELECT COUNT(*) AS cnt FROM session_history WHERE session_id = ?'
    ).get(sessionId);
    return row.cnt;
  }

  /**
   * Freeze session history — no more appends will be accepted.
   * Freeze state is in-memory and resets on process restart.
   * @param {string} sessionId
   */
  freeze(sessionId) {
    this._frozen.add(sessionId);
  }

  /**
   * Check if session history is frozen.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isFrozen(sessionId) {
    return this._frozen.has(sessionId);
  }
}
