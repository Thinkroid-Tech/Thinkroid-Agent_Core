// Session metadata — persisted state for each agent conversation session.
// Managed by CE (Context Engine) and Supervisor. Only Supervisor writes the status field.

/**
 * @typedef {Object} SessionMeta
 * @property {string} session_id - Unique session identifier
 * @property {string|null} parent_session_id - Source session when created via Stage 3 compression
 * @property {string} agent_id - Owning agent
 * @property {string} summary - 1-3 sentences, max 100 chars. Updated by CE
 * @property {string[]} tags - Topic tags for routing. Updated by CE
 * @property {'awake'|'drowsy'|'dormant'|'archived'} status - Session lifecycle state. Only Supervisor writes this
 * @property {number} turn_count - Incremented by CE after each Brain inference completes
 * @property {number} context_size_pct - Updated after each CE context organization (0-100)
 * @property {number} pending_requests - Count of pending external tool call responses
 * @property {number} keepalive_renewals - Times cache has been renewed for keep-alive
 * @property {number|null} keepalive_start_time - Epoch ms when latest pending_request batch started
 * @property {boolean} linger - Whether CE flagged unresolved matters
 * @property {number} linger_count - Times linger-tick has fired for this session
 * @property {number} cerebellum_l1_cursor - L1 cursor position in session history
 * @property {number} cerebellum_l2_cursor - L2 cursor position in session history
 * @property {number} created_at - Epoch ms
 * @property {number} last_active_at - Epoch ms
 */

export {};
