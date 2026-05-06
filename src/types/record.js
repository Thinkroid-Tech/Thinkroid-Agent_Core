// Record types for agent long-term memory entries.
// Records are stored in the Cerebellum and are accessible based on the access level.

/**
 * @typedef {Object} Record
 * @property {string} id - Unique record identifier
 * @property {string} agent_id - Owning agent
 * @property {string} title - Record title
 * @property {string} content - Record content (markdown)
 * @property {string[]} tags - Searchable tags
 * @property {Object[]} links - Links to other entities
 * @property {string} links[].type - 'space'|'room'|'org'|'agent'|'project'
 * @property {string} links[].id - Linked entity ID
 * @property {'hidden'|'readonly'|'readwrite'} access - Access level (Boss overrides all)
 * @property {number} created_at - Epoch ms
 * @property {number} updated_at - Epoch ms
 */

export {};
