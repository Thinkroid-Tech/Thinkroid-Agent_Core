// Durable store for in-flight tool-loop suspensions.
//
// The daemon's non-streaming tool loop persists a row here whenever a
// remote tool dispatch returns an approval-pending envelope. The row
// captures the full state needed to resume the loop after the upstream
// approval is recorded:
//
//   - conversation_messages_json — the working message buffer up to and
//     including the assistant turn that requested the suspended tool
//     call (the tool result message is NOT appended; the resume request
//     supplies it).
//   - tool_call_id / tool_name / tool_args_json — identify the exact
//     tool call that stalled.
//   - max_tool_rounds_remaining — the loop budget remaining AFTER the
//     suspending round, so the resume handler can keep the original
//     bound intact across restarts.
//   - config_override_json — the caller's per-request provider/config
//     pin, if any. Restored verbatim so a resume hits the same model.
//
// Resume completion is captured in a single transactional update so an
// idempotent retry sees either both `status='resumed'` and the cached
// `final_response_json`, or neither — never a half-written row.

export class ToolLoopSuspensionsStore {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    if (!db) throw new Error('ToolLoopSuspensionsStore requires an opened Database handle');
    this._db = db;

    this._insertStmt = db.prepare(`
      INSERT INTO tool_loop_suspensions (
        id, agent_id, task_id, session_id, status,
        tool_call_id, tool_name, tool_args_json, tool_context_json,
        conversation_messages_json, max_tokens, max_tool_rounds_remaining,
        approval_id, idempotency_key, config_override_json,
        final_response_json, created_at, updated_at, resumed_at
      ) VALUES (
        @id, @agent_id, @task_id, @session_id, 'pending',
        @tool_call_id, @tool_name, @tool_args_json, @tool_context_json,
        @conversation_messages_json, @max_tokens, @max_tool_rounds_remaining,
        @approval_id, @idempotency_key, @config_override_json,
        NULL, @created_at, @updated_at, NULL
      )
    `);

    this._getByIdStmt = db.prepare(`
      SELECT * FROM tool_loop_suspensions WHERE id = ?
    `);

    this._markResumedStmt = db.prepare(`
      UPDATE tool_loop_suspensions
         SET status = 'resumed',
             approval_id = @approval_id,
             final_response_json = @final_response_json,
             resumed_at = @resumed_at,
             updated_at = @updated_at
       WHERE id = @id
    `);

    this._markCancelledStmt = db.prepare(`
      UPDATE tool_loop_suspensions
         SET status = 'cancelled',
             updated_at = @updated_at
       WHERE id = @id
    `);

    this._markExpiredStmt = db.prepare(`
      UPDATE tool_loop_suspensions
         SET status = 'expired',
             updated_at = @updated_at
       WHERE id = @id
    `);

    // Wrap the resume-completion write in a transaction so the four
    // columns (status, approval_id, final_response_json, resumed_at,
    // updated_at) update atomically. In-process sqlite means the txn is
    // synchronous; we still get the all-or-nothing guarantee that
    // protects an idempotent re-read mid-update.
    this._markResumedTxn = db.transaction((bindings) => {
      const info = this._markResumedStmt.run(bindings);
      if (info.changes === 0) return null;
      return this._getByIdStmt.get(bindings.id) ?? null;
    });
  }

  /**
   * Insert a fresh `status='pending'` suspension row. All `*Json` fields
   * are expected to already be JSON.stringify()'d by the caller; the
   * store treats them as opaque text columns.
   *
   * @param {{
   *   id: string,
   *   agentId: string,
   *   taskId?: string|null,
   *   sessionId?: string|null,
   *   toolCallId: string,
   *   toolName: string,
   *   toolArgsJson?: string|null,
   *   toolContextJson?: string|null,
   *   conversationMessagesJson: string,
   *   maxTokens?: number|null,
   *   maxToolRoundsRemaining: number,
   *   approvalId?: string|null,
   *   idempotencyKey?: string|null,
   *   configOverrideJson?: string|null,
   * }} entry
   * @returns {boolean} true when a row was inserted
   */
  insertPending(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('ToolLoopSuspensionsStore.insertPending: entry must be an object');
    }
    requireNonEmptyString(entry.id, 'id');
    requireNonEmptyString(entry.agentId, 'agentId');
    requireNonEmptyString(entry.toolCallId, 'toolCallId');
    requireNonEmptyString(entry.toolName, 'toolName');
    requireNonEmptyString(entry.conversationMessagesJson, 'conversationMessagesJson');
    if (!Number.isInteger(entry.maxToolRoundsRemaining) || entry.maxToolRoundsRemaining < 0) {
      throw new Error(
        'ToolLoopSuspensionsStore.insertPending: maxToolRoundsRemaining must be a non-negative integer',
      );
    }

    const nowIso = new Date().toISOString();
    const info = this._insertStmt.run({
      id: entry.id,
      agent_id: entry.agentId,
      task_id: entry.taskId ?? null,
      session_id: entry.sessionId ?? null,
      tool_call_id: entry.toolCallId,
      tool_name: entry.toolName,
      tool_args_json: entry.toolArgsJson ?? null,
      tool_context_json: entry.toolContextJson ?? null,
      conversation_messages_json: entry.conversationMessagesJson,
      max_tokens: Number.isFinite(entry.maxTokens) ? entry.maxTokens : null,
      max_tool_rounds_remaining: entry.maxToolRoundsRemaining,
      approval_id: entry.approvalId ?? null,
      idempotency_key: entry.idempotencyKey ?? null,
      config_override_json: entry.configOverrideJson ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return info.changes > 0;
  }

  /**
   * @param {string} id
   * @returns {object|null}
   */
  getById(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    return this._getByIdStmt.get(id) ?? null;
  }

  /**
   * Atomically mark the row as resumed and cache the final response so
   * future retries with the same approvalId return the cached envelope
   * without re-driving the loop.
   *
   * @param {{ id: string, approvalId: string, finalResponseJson: string }} args
   * @returns {object|null} the updated row, or null when the id was not found
   */
  markResumed({ id, approvalId, finalResponseJson }) {
    requireNonEmptyString(id, 'id');
    requireNonEmptyString(approvalId, 'approvalId');
    requireNonEmptyString(finalResponseJson, 'finalResponseJson');
    const nowIso = new Date().toISOString();
    return this._markResumedTxn({
      id,
      approval_id: approvalId,
      final_response_json: finalResponseJson,
      resumed_at: nowIso,
      updated_at: nowIso,
    });
  }

  /**
   * @param {string} id
   * @returns {boolean} true when a row was updated
   */
  markCancelled(id) {
    requireNonEmptyString(id, 'id');
    const nowIso = new Date().toISOString();
    const info = this._markCancelledStmt.run({ id, updated_at: nowIso });
    return info.changes > 0;
  }

  /**
   * @param {string} id
   * @returns {boolean} true when a row was updated
   */
  markExpired(id) {
    requireNonEmptyString(id, 'id');
    const nowIso = new Date().toISOString();
    const info = this._markExpiredStmt.run({ id, updated_at: nowIso });
    return info.changes > 0;
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`ToolLoopSuspensionsStore: ${field} must be a non-empty string`);
  }
}
