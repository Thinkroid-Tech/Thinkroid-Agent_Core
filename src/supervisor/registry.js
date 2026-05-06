/**
 * SupervisorRegistry — lazy Supervisor instance manager (DL-34).
 * One Supervisor + CE + Brain per agent, created on first event.
 * Mirrors MemoryRegistry pattern from Phase 3.
 */

export class SupervisorRegistry {
  /**
   * @param {Object} deps
   * @param {Function} deps.createSupervisor - Factory: (agentId, agentName) => Supervisor
   */
  constructor({ createSupervisor }) {
    if (!createSupervisor || typeof createSupervisor !== 'function') {
      throw new Error('SupervisorRegistry requires createSupervisor factory function');
    }
    this._createSupervisor = createSupervisor;
    /** @type {Map<string, import('./index.js').Supervisor>} */
    this._instances = new Map();
  }

  /**
   * Get or lazily create a Supervisor for an agent.
   * @param {string} agentId
   * @param {string} [agentName] - Display name (defaults to agentId)
   * @returns {import('./index.js').Supervisor}
   */
  get(agentId, agentName) {
    if (this._instances.has(agentId)) return this._instances.get(agentId);
    const supervisor = this._createSupervisor(agentId, agentName || agentId);
    this._instances.set(agentId, supervisor);
    return supervisor;
  }

  /**
   * Remove and shutdown a Supervisor instance (agent deletion).
   * @param {string} agentId
   */
  remove(agentId) {
    const supervisor = this._instances.get(agentId);
    if (supervisor) {
      supervisor.shutdown();
      this._instances.delete(agentId);
    }
  }

  /**
   * Shutdown all instances. Called on SIGTERM.
   */
  shutdownAll() {
    for (const [, supervisor] of this._instances) {
      try { supervisor.shutdown(); } catch { /* ignore shutdown errors */ }
    }
    this._instances.clear();
  }

  /** @returns {number} Number of active instances */
  get size() { return this._instances.size; }
}

// ---------------------------------------------------------------------------
// Module-level global accessor (avoids circular deps for callers)
// ---------------------------------------------------------------------------

/** @type {SupervisorRegistry|null} */
let _globalRegistry = null;

/**
 * Set the global SupervisorRegistry instance. Called once at startup.
 * @param {SupervisorRegistry} registry
 */
export function setSupervisorRegistry(registry) {
  _globalRegistry = registry;
}

/**
 * Get the global SupervisorRegistry instance.
 * @returns {SupervisorRegistry}
 * @throws {Error} if not initialized
 */
export function getSupervisorRegistry() {
  if (!_globalRegistry) {
    throw new Error('SupervisorRegistry not initialized. Call setSupervisorRegistry() at startup.');
  }
  return _globalRegistry;
}
