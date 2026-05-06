// Event types for the Supervisor event system.
// All agent interactions are modeled as typed events dispatched to the Supervisor.
//
// Post-P11 Tier A: agent-core treats `type` as an opaque string — concrete
// event-type vocabulary is a Space-side convention, not enforced here.

/**
 * @typedef {Object} AgentEvent
 * @property {string} id - Unique event identifier
 * @property {string} type - Event category (opaque string, Space-side convention)
 * @property {string} agent_id - Target agent
 * @property {string|null} source_agent_id - Originating agent (for agent_message/task_assignment)
 * @property {*} payload - Event-specific data
 * @property {number} timestamp - Epoch ms
 */

export {};
