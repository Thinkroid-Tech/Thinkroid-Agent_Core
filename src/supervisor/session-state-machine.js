/**
 * Session State Machine — manages Awake/Drowsy/Dormant/Archived transitions.
 *
 * Constraints:
 * - Max 1 Awake session at any time
 * - Only valid transitions allowed (invalid ones throw)
 * - Only Supervisor can call these methods
 */

/** @typedef {'awake'|'drowsy'|'dormant'|'archived'} SessionStatus */

/** Valid state transitions */
const VALID_TRANSITIONS = {
  awake: ['drowsy'],            // Awake → Drowsy (TTL or context switch)
  drowsy: ['awake', 'dormant'], // Drowsy → Awake (event) or Dormant (TTL expired)
  dormant: ['archived'],        // Dormant → Archived (cursors past end)
  archived: [],                 // Terminal state
};

export class SessionStateMachine {
  constructor() {
    /** @type {Map<string, SessionStatus>} sessionId → status */
    this._states = new Map();
    /** @type {string|null} */
    this._currentAwake = null;
  }

  /**
   * Register a new session (always starts as Awake).
   * If another session is Awake, it must be demoted to Drowsy first.
   * @param {string} sessionId
   * @throws {Error} if session already exists or another session is Awake
   */
  create(sessionId) {
    if (this._states.has(sessionId)) {
      throw new Error(`Session ${sessionId} already exists`);
    }
    if (this._currentAwake !== null) {
      throw new Error(`Cannot create Awake session: ${this._currentAwake} is already Awake. Demote it first.`);
    }
    this._states.set(sessionId, 'awake');
    this._currentAwake = sessionId;
  }

  /**
   * Get the current status of a session.
   * @param {string} sessionId
   * @returns {SessionStatus|undefined}
   */
  getStatus(sessionId) {
    return this._states.get(sessionId);
  }

  /**
   * Get the current Awake session ID, or null.
   * @returns {string|null}
   */
  getCurrentAwake() {
    return this._currentAwake;
  }

  /**
   * Transition a session to a new status.
   * @param {string} sessionId
   * @param {SessionStatus} newStatus
   * @throws {Error} on invalid transition or constraint violation
   */
  transition(sessionId, newStatus) {
    const currentStatus = this._states.get(sessionId);
    if (currentStatus === undefined) {
      throw new Error(`Session ${sessionId} does not exist`);
    }

    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${currentStatus} → ${newStatus} for session ${sessionId}. ` +
        `Allowed: ${allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)'}`
      );
    }

    // Enforce max 1 Awake
    if (newStatus === 'awake') {
      if (this._currentAwake !== null && this._currentAwake !== sessionId) {
        throw new Error(
          `Cannot promote ${sessionId} to Awake: ${this._currentAwake} is already Awake. Demote it first.`
        );
      }
      this._currentAwake = sessionId;
    }

    // Clear Awake tracking when leaving Awake
    if (currentStatus === 'awake' && this._currentAwake === sessionId) {
      this._currentAwake = null;
    }

    this._states.set(sessionId, newStatus);
  }

  /**
   * Convenience: switch context from current Awake to a Drowsy session.
   * Demotes current Awake → Drowsy, then promotes target → Awake.
   * @param {string} targetSessionId - Must be in Drowsy state
   * @throws {Error} if target is not Drowsy or no current Awake
   */
  switchContext(targetSessionId) {
    const targetStatus = this._states.get(targetSessionId);
    if (targetStatus !== 'drowsy') {
      throw new Error(`Cannot switch to ${targetSessionId}: status is ${targetStatus}, expected drowsy`);
    }

    if (this._currentAwake) {
      this.transition(this._currentAwake, 'drowsy');
    }
    this.transition(targetSessionId, 'awake');
  }

  /**
   * Get all sessions with a given status.
   * @param {SessionStatus} status
   * @returns {string[]}
   */
  getSessionsByStatus(status) {
    return [...this._states.entries()]
      .filter(([, s]) => s === status)
      .map(([id]) => id);
  }

  /**
   * Get all sessions.
   * @returns {Map<string, SessionStatus>}
   */
  getAllSessions() {
    return new Map(this._states);
  }

  /**
   * Remove a session from tracking (cleanup).
   * @param {string} sessionId
   */
  remove(sessionId) {
    if (this._currentAwake === sessionId) {
      this._currentAwake = null;
    }
    this._states.delete(sessionId);
  }
}
