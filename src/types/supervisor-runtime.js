// Supervisor runtime state and configuration types.
// SupervisorRuntime is held in memory only; SupervisorConfig comes from agent/space settings.

/**
 * @typedef {Object} SessionTimer
 * @property {number} cache_created_at - Epoch ms when cache was created/refreshed
 * @property {number} awake_ttl_deadline - Epoch ms = cache_created_at + Drowsy TTL - SAFETY_BUFFER
 * @property {number} drowsy_ttl_deadline - Epoch ms = cache_created_at + cache_ttl - SAFETY_BUFFER
 * @property {number} cache_expire_deadline - Epoch ms = cache_created_at + cache_ttl
 */

/**
 * @typedef {Object} SupervisorRuntime
 * @property {Object<string, SessionTimer>} session_timers - Keyed by session_id
 * @property {string|null} current_awake_session - Session ID of current Awake session, or null
 */

/**
 * @typedef {Object} SupervisorConfig
 * @property {number} cache_ttl - Seconds, per model (e.g., 300)
 * @property {number} safety_buffer - Seconds (default 30)
 * @property {number} max_linger_count - Per session (default 3)
 * @property {boolean} linger_enabled - Agent-level switch (default false)
 * @property {boolean} system_linger_master_switch - Space-level master switch
 */

export {};
