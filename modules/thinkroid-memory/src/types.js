/**
 * @typedef {'short'|'long'|'short_skill'|'long_skill'} Layer
 * @typedef {'parent_of'|'related_to'|'synonym_of'|'opposite_of'|'tagged_with'} EdgeKind
 * @typedef {'cerebellum-l1'|'cerebellum-l2'} Writer
 */

/**
 * @typedef {Object} Memory
 * @property {number} id
 * @property {Layer} layer
 * @property {string} content
 * @property {string|null} source_session
 * @property {number} source_timestamp - Epoch ms
 * @property {number} created_at - Epoch ms
 * @property {number} updated_at - Epoch ms
 * @property {number} access_count
 * @property {number|null} last_triggered_at - Epoch ms
 * @property {number} decay_score - 0.0 to 1.0
 * @property {'high'|'medium'|'low'} confidence
 * @property {Writer} writer
 */

/**
 * @typedef {Object} Tag
 * @property {number} id
 * @property {string} name - Unique
 * @property {string} description
 * @property {number} level - 0 = root, max 1000
 * @property {number} created_at - Epoch ms
 * @property {number} updated_at - Epoch ms
 */

/**
 * @typedef {Object} Edge
 * @property {number} id
 * @property {'tag'|'memory'} from_type
 * @property {number} from_id
 * @property {'tag'|'memory'} to_type
 * @property {number} to_id
 * @property {EdgeKind} kind
 * @property {string|null} description
 * @property {number|null} weight - 0.0 to 1.0
 * @property {number} created_at - Epoch ms
 */

/**
 * @typedef {Object} TagNode
 * @property {Tag} tag
 * @property {TagNode[]} children
 */

/**
 * @typedef {Object} LoopReport
 * @property {Array<Array<{id: number, name: string}>>} cycles - Each cycle is a list of tags in the SCC
 */

export {};
