/**
 * TTL Manager — manages Awake TTL and Drowsy TTL timers for sessions.
 *
 * TTL Hierarchy:
 *   Awake TTL = cache_ttl - 2 * SAFETY_BUFFER  (i.e., Drowsy TTL - SAFETY_BUFFER)
 *   Drowsy TTL = cache_ttl - SAFETY_BUFFER
 *   Cache expires at: cache_ttl
 *
 * When Awake TTL fires → session goes Drowsy
 * When Drowsy TTL fires → check linger/keep-alive, then possibly Dormant
 */

export class TtlManager {
  /**
   * @param {Object} config
   * @param {number} config.cacheTtlMs - Cache TTL in milliseconds
   * @param {number} config.safetyBufferMs - Safety buffer in milliseconds (default 30000)
   * @param {Object} [config.clock] - Mockable clock { now(), setTimeout(), clearTimeout() }
   */
  constructor({ cacheTtlMs, safetyBufferMs = 30000, clock = null }) {
    this._cacheTtlMs = cacheTtlMs;
    this._safetyBufferMs = safetyBufferMs;
    this._clock = clock || {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };

    /** @type {Map<string, { awakeTtlTimer: *, drowsyTtlTimer: *, cacheCreatedAt: number }>} */
    this._timers = new Map();
  }

  /** Awake TTL duration in ms = Drowsy TTL - safety_buffer */
  get awakeTtlMs() {
    return this._cacheTtlMs - 2 * this._safetyBufferMs;
  }

  /** Drowsy TTL duration in ms = cache_ttl - safety_buffer */
  get drowsyTtlMs() {
    return this._cacheTtlMs - this._safetyBufferMs;
  }

  /**
   * Start TTL tracking for a session becoming Awake.
   * @param {string} sessionId
   * @param {Object} callbacks
   * @param {function} callbacks.onAwakeTtlExpired - Called when Awake TTL fires
   * @param {function} callbacks.onDrowsyTtlExpired - Called when Drowsy TTL fires
   */
  startAwake(sessionId, { onAwakeTtlExpired, onDrowsyTtlExpired }) {
    this.clear(sessionId);

    const now = this._clock.now();
    const entry = {
      cacheCreatedAt: now,
      awakeTtlTimer: this._clock.setTimeout(() => {
        onAwakeTtlExpired(sessionId);
      }, this.awakeTtlMs),
      drowsyTtlTimer: this._clock.setTimeout(() => {
        onDrowsyTtlExpired(sessionId);
      }, this.drowsyTtlMs),
    };

    this._timers.set(sessionId, entry);
  }

  /**
   * Refresh TTL for a session (e.g., after linger-tick or keep-alive renewal).
   * Clears old timers and starts fresh.
   * @param {string} sessionId
   * @param {Object} callbacks - same as startAwake
   */
  refresh(sessionId, callbacks) {
    this.startAwake(sessionId, callbacks);
  }

  /**
   * Clear all timers for a session (e.g., when going Dormant).
   * @param {string} sessionId
   */
  clear(sessionId) {
    const entry = this._timers.get(sessionId);
    if (entry) {
      this._clock.clearTimeout(entry.awakeTtlTimer);
      this._clock.clearTimeout(entry.drowsyTtlTimer);
      this._timers.delete(sessionId);
    }
  }

  /**
   * Clear ALL timers (cleanup).
   */
  clearAll() {
    for (const [sessionId] of this._timers) {
      this.clear(sessionId);
    }
  }

  /**
   * Get timer info for a session.
   * @param {string} sessionId
   * @returns {{ cacheCreatedAt: number, awakeTtlDeadline: number, drowsyTtlDeadline: number, cacheExpireDeadline: number }|null}
   */
  getTimerInfo(sessionId) {
    const entry = this._timers.get(sessionId);
    if (!entry) return null;
    return {
      cacheCreatedAt: entry.cacheCreatedAt,
      awakeTtlDeadline: entry.cacheCreatedAt + this.awakeTtlMs,
      drowsyTtlDeadline: entry.cacheCreatedAt + this.drowsyTtlMs,
      cacheExpireDeadline: entry.cacheCreatedAt + this._cacheTtlMs,
    };
  }

  /**
   * Get timer info for all sessions.
   * @returns {Object.<string, { cacheCreatedAt: number, awakeTtlDeadline: number, drowsyTtlDeadline: number, cacheExpireDeadline: number }>}
   */
  getAllTimerInfo() {
    const result = {};
    for (const [sessionId, entry] of this._timers) {
      result[sessionId] = {
        cacheCreatedAt: entry.cacheCreatedAt,
        awakeTtlDeadline: entry.cacheCreatedAt + this.awakeTtlMs,
        drowsyTtlDeadline: entry.cacheCreatedAt + this.drowsyTtlMs,
        cacheExpireDeadline: entry.cacheCreatedAt + this._cacheTtlMs,
      };
    }
    return result;
  }

  /**
   * Check if a session has active timers.
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasTimers(sessionId) {
    return this._timers.has(sessionId);
  }
}
