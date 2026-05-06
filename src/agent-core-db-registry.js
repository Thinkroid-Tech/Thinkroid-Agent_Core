/**
 * AgentCoreDbRegistry — lazy per-agent agent-core.db manager.
 *
 * Mirrors MemoryRegistry / RecordRegistry: one DB handle per agent, opened
 * on first access and cached for reuse. Tier B seeded AgentConfigStore;
 * Tier G wires session_meta + session_history into the same per-agent DB so
 * each agent owns its full Agent Core state (config + sessions + history)
 * in a single file.
 *
 * Phase 13 scope-key policy (tightened from Phase 12):
 *   The public API takes `agentId` (the UUID primary key of the Space
 *   `agents` table). Per-agent DB path is `office/agents/<id>/agent-core.db`.
 *
 *   Phase 12 shipped a temporary name→UUID adapter so legacy migration
 *   scripts could stay name-shaped. Phase 13 H3 removed it: every
 *   caller, including migration scripts, MUST resolve to a UUID at the
 *   call site before invoking `getOrCreate`. Non-UUID input now throws,
 *   which makes the scope-key invariant loud instead of silent.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { openAgentCoreDb, closeAgentCoreDb } from './stores/agent-core-db/db.js';
import { AgentConfigStore } from './stores/agent-core-db/agent-config-store.js';
import { SessionMetaStore } from './stores/agent-core-db/session-meta-store.js';
import { SessionHistoryStore } from './stores/agent-core-db/session-history-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Phase 16.M.A: this default is a placeholder. After repo extraction the
// daemon never runs without an explicit officeDir injected via the IPC init
// payload (Q24 standalone mode rejects). The path computed below intentionally
// points outside this repo so any accidental reliance on the default fails
// loudly the first time the registry runs against the FS.
const DEFAULT_OFFICE_DIR = path.join(__dirname, '../office');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentCoreDbRegistry {
  /**
   * @param {string} [officeDir] - Path to the office directory. Defaults to <server-root>/office.
   */
  constructor(officeDir = DEFAULT_OFFICE_DIR) {
    this._officeDir = officeDir;
    /**
     * @type {Map<string, {
     *   db: import('better-sqlite3').Database,
     *   agentConfigStore: AgentConfigStore,
     *   sessionMetaStore: SessionMetaStore,
     *   sessionHistoryStore: SessionHistoryStore,
     * }>}
     */
    this._instances = new Map();
  }

  /**
   * Get or lazily create the per-agent agent-core.db handle and its
   * associated stores (agent_config, session_meta, session_history).
   *
   * @param {string} agentId - agents.id UUID. Phase 13 H3: non-UUID input
   *   throws — the previous name→UUID adapter has been removed.
   * @returns {{
   *   db: import('better-sqlite3').Database,
   *   agentConfigStore: AgentConfigStore,
   *   sessionMetaStore: SessionMetaStore,
   *   sessionHistoryStore: SessionHistoryStore,
   * }}
   */
  getOrCreate(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('AgentCoreDbRegistry.getOrCreate: agentId must be a non-empty string');
    }
    if (!UUID_RE.test(agentId)) {
      throw new Error(
        `AgentCoreDbRegistry.getOrCreate: agentId must be a UUID (got "${agentId}"). ` +
          'Phase 13 removed the Phase 12 name→UUID adapter — resolve to a UUID at the call site.'
      );
    }
    const existing = this._instances.get(agentId);
    if (existing) return existing;

    const dbPath = path.join(this._officeDir, 'agents', agentId, 'agent-core.db');
    const db = openAgentCoreDb(dbPath);
    const agentConfigStore = new AgentConfigStore(db);
    const sessionMetaStore = new SessionMetaStore(db);
    const sessionHistoryStore = new SessionHistoryStore(db);
    const entry = { db, agentConfigStore, sessionMetaStore, sessionHistoryStore };
    this._instances.set(agentId, entry);
    return entry;
  }

  /**
   * Close all open handles. Called on shutdown.
   */
  closeAll() {
    for (const [, entry] of this._instances) {
      closeAgentCoreDb(entry.db);
    }
    this._instances.clear();
  }

  /**
   * Close the agent-core.db handle for `agentId` and remove it from
   * the cache. Phase 16 B.5 + INV-1: the Space process bootstraps the
   * per-agent DB at hire time and the daemon then opens the same file
   * exclusively. Better-sqlite3 holds an OS-level file lock for the
   * lifetime of the handle, so the bootstrap path MUST release its
   * handle before the daemon starts — otherwise the daemon's
   * exclusive open will fail with SQLITE_BUSY.
   *
   * Safe to call when no handle is cached for `agentId` (no-op).
   *
   * @param {string} agentId
   */
  closeAndEvict(agentId) {
    const entry = this._instances.get(agentId);
    if (!entry) return;
    // closeAgentCoreDb is already try/catch-safe.
    closeAgentCoreDb(entry.db);
    this._instances.delete(agentId);
  }

  /** @returns {number} Number of active instances */
  get size() { return this._instances.size; }
}

// Module-level singleton accessors (RecordRegistry / SupervisorRegistry pattern).
let _globalRegistry = null;

export function setAgentCoreDbRegistry(registry) {
  _globalRegistry = registry;
}

export function getAgentCoreDbRegistry() {
  if (!_globalRegistry) throw new Error('AgentCoreDbRegistry not initialized');
  return _globalRegistry;
}
