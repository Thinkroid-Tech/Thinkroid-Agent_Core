/**
 * AgentManager — authoritative accessor for per-agent configuration
 * stored in agent-core.db (`agent_config` table).
 *
 * Phase 11 Tier B scope:
 *   - personality (the anchor use case — single authority, replaces persona.md)
 *
 * Later tiers may add more config keys (e.g. model overrides, hotkeys).
 * All callers that previously read/wrote office/agents/{name}/persona.md
 * MUST go through this class instead. See Tier B plan §B-6 / §B-7.
 *
 * Phase 12 scope-key policy:
 *   The public API takes `agentId` (the UUID primary key of the Space
 *   `agents` table). Inputs that are not UUID-shaped are handled by the
 *   AgentCoreDbRegistry TEMP adapter (Phase 12 shim) which resolves legacy
 *   name-based callers to their UUID before opening the per-agent DB. T2
 *   migrates the remaining callers off name-based identity.
 */

const PERSONALITY_KEY = 'personality';

/**
 * Persona normalization contract (Phase 11 Tier B §B-4).
 *
 * Five rules, applied in order:
 *   1. Strip leading BOM
 *   2. CRLF -> LF line endings
 *   3. Unicode NFC normalization (combining-mark canonicalization)
 *   4. Global trim() of leading/trailing whitespace
 *   5. Append a trailing newline when the body is non-empty
 *
 * Empty strings stay empty (no trailing newline).
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizePersona(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') {
    throw new Error('normalizePersona: input must be a string');
  }

  // 1. BOM strip
  let out = raw.replace(/^\uFEFF/, '');
  // 2. CRLF -> LF
  out = out.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // 3. Unicode NFC
  out = out.normalize('NFC');
  // 4. Trim
  out = out.trim();
  // 5. Trailing newline on non-empty body
  if (out.length > 0) out += '\n';
  return out;
}

export class AgentManager {
  /**
   * @param {{ agentCoreDbRegistry: import('./agent-core-db-registry.js').AgentCoreDbRegistry }} deps
   */
  constructor({ agentCoreDbRegistry }) {
    if (!agentCoreDbRegistry || typeof agentCoreDbRegistry.getOrCreate !== 'function') {
      throw new Error('AgentManager requires an AgentCoreDbRegistry with getOrCreate()');
    }
    this._registry = agentCoreDbRegistry;
  }

  /**
   * Resolve the AgentConfigStore for an agent (lazy-open on first access).
   * @param {string} agentId - agents.id UUID (legacy name accepted via registry adapter).
   * @returns {import('./stores/agent-core-db/agent-config-store.js').AgentConfigStore}
   */
  _store(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('AgentManager: agentId must be a non-empty string');
    }
    const { agentConfigStore } = this._registry.getOrCreate(agentId);
    return agentConfigStore;
  }

  /**
   * Read the authoritative personality string for an agent.
   * Returns '' when no value is stored (fallback — callers should still
   * treat persona as optional). Never throws on missing keys.
   *
   * @param {string} agentId
   * @returns {Promise<string>}
   */
  async getPersonality(agentId) {
    const store = this._store(agentId);
    const value = store.get(PERSONALITY_KEY);
    return value == null ? '' : value;
  }

  /**
   * Write the personality string for an agent. Runs the normalization
   * contract before persisting. The `updatedBy` audit field defaults to
   * 'system' but should be overridden by callers that know their origin
   * (e.g. 'template-apply', 'update_self_profile', 'migration-2026-04-21').
   *
   * @param {string} agentId
   * @param {string} text
   * @param {{ updatedBy?: string, now?: number }} [opts]
   * @returns {Promise<void>}
   */
  async setPersonality(agentId, text, { updatedBy = 'system', now } = {}) {
    const store = this._store(agentId);
    const normalized = normalizePersona(text);
    store.set(PERSONALITY_KEY, normalized, { updatedBy, now });
  }
}

// Module-level singleton accessors — match RecordRegistry/SupervisorRegistry pattern.
let _globalAgentManager = null;

export function setAgentManager(manager) {
  _globalAgentManager = manager;
}

export function getAgentManager() {
  if (!_globalAgentManager) throw new Error('AgentManager not initialized');
  return _globalAgentManager;
}
