/**
 * MemoryRegistry — lazy ThinkroidMemory instance manager.
 * One memory DB per agent, created on first access, cached for reuse.
 *
 * Phase 13 scope-key policy (tightened from Phase 12):
 *   The public API takes `agentId` — the UUID primary key of the Space
 *   `agents` table. The per-agent directory layout is `office/agents/<id>/`
 *   (UUID, not the display name). Renaming an agent is a single UPDATE on
 *   `agents.name`; the memory DB does not move.
 *
 *   Phase 12 shipped a temporary name→UUID adapter so legacy callers
 *   could stay name-shaped during the migration. Phase 13 H3 deleted
 *   that adapter entirely: every runtime and migration-script caller
 *   MUST resolve to a UUID before calling `getOrCreate`. Passing a
 *   non-UUID now throws instead of warning-and-falling-back, so the
 *   scope key can no longer diverge between call sites.
 */

import { ThinkroidMemory } from '../modules/thinkroid-memory/src/api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Phase 16.M.A: this default is a placeholder. After repo extraction the
// daemon never runs without an explicit officeDir injected via the IPC init
// payload (Q24 standalone mode rejects). The path computed below intentionally
// points outside this repo so any accidental reliance on the default fails
// loudly the first time MemoryRegistry.getOrCreate runs against the FS.
const DEFAULT_OFFICE_DIR = path.join(__dirname, '../../office');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MemoryRegistry {
  /**
   * @param {string} [officeDir] - Path to the office directory. Defaults to <server-root>/office.
   */
  constructor(officeDir = DEFAULT_OFFICE_DIR) {
    this._officeDir = officeDir;
    /** @type {Map<string, ThinkroidMemory>} */
    this._instances = new Map();
  }

  /**
   * Get or lazily create a ThinkroidMemory instance for an agent.
   * Opens the DB on first access.
   *
   * @param {string} agentId - agents.id UUID. Phase 13 H3: non-UUID input
   *   throws — the previous name→UUID adapter has been removed.
   * @returns {ThinkroidMemory}
   */
  getOrCreate(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('MemoryRegistry.getOrCreate: agentId must be a non-empty string');
    }
    if (!UUID_RE.test(agentId)) {
      throw new Error(
        `MemoryRegistry.getOrCreate: agentId must be a UUID (got "${agentId}"). ` +
          'Phase 13 removed the Phase 12 name→UUID adapter — resolve to a UUID at the call site.'
      );
    }
    if (this._instances.has(agentId)) return this._instances.get(agentId);
    const agentDir = path.join(this._officeDir, 'agents', agentId);
    // better-sqlite3 cannot create intermediate directories; ensure the
    // per-agent directory exists so a fresh UUID bootstraps without hitting
    // ENOENT. Existing dirs no-op (`recursive: true`).
    fs.mkdirSync(agentDir, { recursive: true });
    const dbPath = path.join(agentDir, 'memory.db');
    const memory = new ThinkroidMemory(dbPath, agentId);
    memory.open();
    this._instances.set(agentId, memory);
    return memory;
  }

  /**
   * Close all open instances. Called on shutdown.
   */
  closeAll() {
    for (const [, memory] of this._instances) {
      try { memory.close(); } catch { /* ignore close errors on shutdown */ }
    }
    this._instances.clear();
  }

  /**
   * Close the memory.db handle for `agentId` and remove it from the
   * cache. Phase 16 B.5 + INV-1: the Space process bootstraps the
   * per-agent DB at hire time, then the daemon spawns and opens the
   * same file exclusively. Better-sqlite3 holds an OS-level file lock
   * for the lifetime of the handle, so the bootstrap path MUST release
   * its handle before the daemon starts — otherwise the daemon's
   * exclusive open will fail with SQLITE_BUSY.
   *
   * Safe to call when no handle is cached for `agentId` (no-op).
   *
   * @param {string} agentId
   */
  closeAndEvict(agentId) {
    const memory = this._instances.get(agentId);
    if (!memory) return;
    try {
      memory.close();
    } catch {
      // Swallow close errors — re-opening the file later will surface
      // any real corruption loudly. We intentionally do NOT leave the
      // entry in the cache: a half-closed handle is worse than none.
    }
    this._instances.delete(agentId);
  }

  /** @returns {number} Number of active instances */
  get size() { return this._instances.size; }
}

// Module-level singleton accessors — Phase 16 B.5 needs the runtime
// MemoryRegistry from the hire_agent route's `bootstrapAgentDbs` helper.
// Mirrors the AgentCoreDbRegistry pattern: src/index.js calls
// `setMemoryRegistry(_memoryRegistry)` after construction so the rest
// of the codebase resolves the same handle.
let _globalMemoryRegistry = null;

export function setMemoryRegistry(registry) {
  _globalMemoryRegistry = registry;
}

export function getMemoryRegistry() {
  if (!_globalMemoryRegistry) throw new Error('MemoryRegistry not initialized');
  return _globalMemoryRegistry;
}
