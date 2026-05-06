/**
 * Event factory for the Supervisor event system.
 * All events flow: External → Supervisor → CE for routing judgment.
 *
 * Event-type strings are a Space-side convention — agent-core treats `type`
 * as an opaque string. The legacy EVENT_TYPES enum was removed in Phase 11
 * (Tier A) to keep agent-core free of Space-specific constants.
 */

/** @typedef {import('../types/event.js').AgentEvent} AgentEvent */

let _eventCounter = 0;

/**
 * Create an AgentEvent.
 * @param {Object} params
 * @param {string} params.type - Opaque event-type string (Space-side convention)
 * @param {string} params.agentId
 * @param {*} params.payload
 * @param {string} [params.sourceAgentId]
 * @returns {AgentEvent}
 */
export function createEvent({ type, agentId, payload, sourceAgentId = null }) {
  return {
    id: `evt-${++_eventCounter}-${Date.now()}`,
    type,
    agent_id: agentId,
    source_agent_id: sourceAgentId,
    payload,
    timestamp: Date.now(),
  };
}

/** Reset counter (for testing) */
export function _resetEventCounter() { _eventCounter = 0; }
