import { ValidationError, UnknownTagError, MemoryNotFoundError } from './errors.js';
import { tarjanSCC } from './graph-utils.js';

const MAX_TRAVERSAL_NODES = 10000;

// =================== ReadOnlyView ===================

export class ReadOnlyView {
  /** @param {import('better-sqlite3').Database} _db */
  constructor(_db) {
    if (!_db) throw new ValidationError('ReadOnlyView requires a non-null database handle');
    this._db = _db;
  }

  /**
   * Resolve tag name strings for a memory by its ID.
   * @param {number} memoryId
   * @returns {string[]}
   */
  _resolveMemoryTags(memoryId) {
    const rows = this._db.prepare(
      `SELECT t.name FROM tags t
       INNER JOIN edges e ON e.to_type = 'tag' AND e.to_id = t.id
       WHERE e.from_type = 'memory' AND e.from_id = ? AND e.kind = 'tagged_with'`
    ).all(memoryId);
    return rows.map(r => r.name);
  }

  /**
   * Convert a SQLite memories row to a Memory object with resolved tags.
   * @param {Object} row
   * @returns {import('./types.js').Memory}
   */
  _rowToMemory(row) {
    return {
      id: row.id,
      layer: row.layer,
      content: row.content,
      source_session: row.source_session,
      source_timestamp: row.source_timestamp,
      created_at: row.created_at,
      updated_at: row.updated_at,
      access_count: row.access_count,
      last_triggered_at: row.last_triggered_at,
      decay_score: row.decay_score,
      confidence: row.confidence,
      writer: row.writer,
      tags: this._resolveMemoryTags(row.id),
    };
  }

  /**
   * @param {number} id
   * @returns {import('./types.js').Memory|null}
   */
  read(id) {
    const row = this._db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) return null;
    return this._rowToMemory(row);
  }

  /**
   * @param {{ tagName: string, includeDescendants?: boolean }} opts
   * @returns {import('./types.js').Memory[]}
   */
  findByTag({ tagName, includeDescendants = false }) {
    const rootTag = this._db.prepare('SELECT * FROM tags WHERE name = ?').get(tagName);
    if (!rootTag) return [];

    let tagIds;

    if (!includeDescendants) {
      tagIds = [rootTag.id];
    } else {
      // Iterative DFS collecting all descendant tag IDs via parent_of edges
      const visited = new Set();
      const stack = [rootTag.id];
      visited.add(rootTag.id);

      while (stack.length > 0) {
        if (visited.size >= MAX_TRAVERSAL_NODES) {
          throw new ValidationError(`Tag traversal exceeded ${MAX_TRAVERSAL_NODES} node limit`);
        }
        const current = stack.pop();
        const children = this._db.prepare(
          `SELECT to_id FROM edges
           WHERE from_type = 'tag' AND from_id = ? AND to_type = 'tag' AND kind = 'parent_of'`
        ).all(current);
        for (const { to_id } of children) {
          if (!visited.has(to_id)) {
            visited.add(to_id);
            stack.push(to_id);
          }
        }
      }
      tagIds = Array.from(visited);
    }

    // Find memories tagged with any of these tag IDs
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = this._db.prepare(
      `SELECT DISTINCT m.* FROM memories m
       INNER JOIN edges e ON e.from_type = 'memory' AND e.from_id = m.id
       WHERE e.to_type = 'tag' AND e.kind = 'tagged_with' AND e.to_id IN (${placeholders})`
    ).all(...tagIds);

    return rows.map(r => this._rowToMemory(r));
  }

  /**
   * @param {{ tagNames: string[], mode?: 'any'|'all' }} opts
   * @returns {import('./types.js').Memory[]}
   */
  findByTags({ tagNames, mode = 'any' }) {
    if (!tagNames || tagNames.length === 0) return [];

    // Build a Set of memory IDs for each tag
    const memoryIdSets = tagNames.map(name => {
      const tag = this._db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      if (!tag) return new Set();
      const rows = this._db.prepare(
        `SELECT from_id FROM edges
         WHERE from_type = 'memory' AND to_type = 'tag' AND kind = 'tagged_with' AND to_id = ?`
      ).all(tag.id);
      return new Set(rows.map(r => r.from_id));
    });

    let resultIds;
    if (mode === 'any') {
      resultIds = new Set();
      for (const s of memoryIdSets) {
        for (const id of s) resultIds.add(id);
      }
    } else {
      // mode === 'all': intersection
      if (memoryIdSets.length === 0) return [];
      resultIds = memoryIdSets[0];
      for (let i = 1; i < memoryIdSets.length; i++) {
        resultIds = new Set([...resultIds].filter(id => memoryIdSets[i].has(id)));
      }
    }

    if (resultIds.size === 0) return [];
    const ids = Array.from(resultIds);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this._db.prepare(
      `SELECT * FROM memories WHERE id IN (${placeholders})`
    ).all(...ids);
    return rows.map(r => this._rowToMemory(r));
  }

  /**
   * @param {{ tagName: string, depth?: number }} opts
   * @returns {import('./types.js').Memory[]}
   */
  findRelated({ tagName, depth = 1 }) {
    const rootTag = this._db.prepare('SELECT * FROM tags WHERE name = ?').get(tagName);
    if (!rootTag) return [];

    // BFS following ALL edge kinds, up to depth hops, collecting tag IDs
    const visited = new Set();
    visited.add(rootTag.id);
    let frontier = [rootTag.id];

    for (let hop = 0; hop < depth; hop++) {
      if (frontier.length === 0) break;
      const nextFrontier = [];
      for (const tagId of frontier) {
        if (visited.size >= MAX_TRAVERSAL_NODES) {
          throw new ValidationError(`Tag traversal exceeded ${MAX_TRAVERSAL_NODES} node limit`);
        }
        // All edges where this tag is from_id or to_id
        const outbound = this._db.prepare(
          `SELECT to_id FROM edges WHERE from_type = 'tag' AND from_id = ? AND to_type = 'tag'`
        ).all(tagId);
        const inbound = this._db.prepare(
          `SELECT from_id as to_id FROM edges WHERE to_type = 'tag' AND to_id = ? AND from_type = 'tag'`
        ).all(tagId);
        for (const { to_id } of [...outbound, ...inbound]) {
          if (!visited.has(to_id)) {
            visited.add(to_id);
            nextFrontier.push(to_id);
          }
        }
      }
      frontier = nextFrontier;
    }

    if (visited.size === 0) return [];
    const tagIds = Array.from(visited);
    const placeholders = tagIds.map(() => '?').join(', ');
    const rows = this._db.prepare(
      `SELECT DISTINCT m.* FROM memories m
       INNER JOIN edges e ON e.from_type = 'memory' AND e.from_id = m.id
       WHERE e.to_type = 'tag' AND e.kind = 'tagged_with' AND e.to_id IN (${placeholders})`
    ).all(...tagIds);
    return rows.map(r => this._rowToMemory(r));
  }

  /**
   * @param {{ layer: import('./types.js').Layer, limit?: number }} opts
   * @returns {import('./types.js').Memory[]}
   */
  recent({ layer, limit = 10 }) {
    const rows = this._db.prepare(
      'SELECT * FROM memories WHERE layer = ? ORDER BY updated_at DESC LIMIT ?'
    ).all(layer, limit);
    return rows.map(r => this._rowToMemory(r));
  }

  /**
   * @param {{ kw: string, limit?: number }} opts
   * @returns {import('./types.js').Memory[]}
   */
  search({ kw, limit = 10 }) {
    // Search by content
    const contentRows = this._db.prepare(
      `SELECT * FROM memories WHERE content LIKE '%' || ? || '%'`
    ).all(kw);

    // Search by tag name — find tags whose name contains kw, then memories tagged with them
    const matchingTags = this._db.prepare(
      `SELECT id FROM tags WHERE name LIKE '%' || ? || '%'`
    ).all(kw);

    const tagMemoryIds = new Set();
    for (const tag of matchingTags) {
      const rows = this._db.prepare(
        `SELECT from_id FROM edges
         WHERE from_type = 'memory' AND to_type = 'tag' AND kind = 'tagged_with' AND to_id = ?`
      ).all(tag.id);
      for (const r of rows) tagMemoryIds.add(r.from_id);
    }

    // Union and deduplicate
    const seen = new Set();
    const results = [];
    for (const row of contentRows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
      }
    }
    if (tagMemoryIds.size > 0) {
      const tagIds = Array.from(tagMemoryIds).filter(id => !seen.has(id));
      if (tagIds.length > 0) {
        const placeholders = tagIds.map(() => '?').join(', ');
        const tagRows = this._db.prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders})`
        ).all(...tagIds);
        for (const row of tagRows) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            results.push(row);
          }
        }
      }
    }

    return results.slice(0, limit).map(r => this._rowToMemory(r));
  }

  /**
   * @param {string} name
   * @returns {import('./types.js').Tag|null}
   */
  getTag(name) {
    const row = this._db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    return row || null;
  }

  /**
   * @param {{ root: string, maxDepth?: number }} opts
   * @returns {import('./types.js').TagNode}
   */
  getTagTree({ root, maxDepth = 10 }) {
    const rootTag = this._db.prepare('SELECT * FROM tags WHERE name = ?').get(root);
    if (!rootTag) return { tag: null, children: [] };

    // Iterative DFS building TagNode tree, respecting maxDepth and cycle guard
    const visited = new Set();
    visited.add(rootTag.id);

    /**
     * Build a TagNode for the given tag at the given depth.
     * @param {Object} tag
     * @param {number} currentDepth
     * @returns {import('./types.js').TagNode}
     */
    const buildNode = (tag, currentDepth) => {
      const node = { tag, children: [] };
      if (currentDepth >= maxDepth) return node;

      const childEdges = this._db.prepare(
        `SELECT to_id FROM edges
         WHERE from_type = 'tag' AND from_id = ? AND to_type = 'tag' AND kind = 'parent_of'`
      ).all(tag.id);

      for (const { to_id } of childEdges) {
        if (visited.size >= MAX_TRAVERSAL_NODES) {
          throw new ValidationError(`Tag traversal exceeded ${MAX_TRAVERSAL_NODES} node limit`);
        }
        if (visited.has(to_id)) continue; // skip cycles
        visited.add(to_id);
        const childTag = this._db.prepare('SELECT * FROM tags WHERE id = ?').get(to_id);
        if (childTag) {
          node.children.push(buildNode(childTag, currentDepth + 1));
        }
      }
      return node;
    };

    return buildNode(rootTag, 0);
  }

  /**
   * @param {string} name
   * @returns {import('./types.js').Edge[]}
   */
  getTagEdges(name) {
    const tag = this._db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
    if (!tag) return [];
    return this._db.prepare(
      `SELECT * FROM edges
       WHERE (from_type = 'tag' AND from_id = ?) OR (to_type = 'tag' AND to_id = ?)`
    ).all(tag.id, tag.id);
  }
}

// =================== CeAccessView ===================

export class CeAccessView extends ReadOnlyView {
  /**
   * @param {import('better-sqlite3').Database|null} _db
   * @param {Object} incrementConfig - Required. Access count increment values.
   * @param {number} incrementConfig.selectedIncrement - Increment when memory is used in Brain context (design: +2)
   * @param {number} incrementConfig.seenIncrement - Increment when memory is seen but not used (design: +1)
   */
  constructor(_db, { selectedIncrement, seenIncrement } = {}) {
    super(_db);
    if (selectedIncrement == null || seenIncrement == null) {
      throw new ValidationError('CeAccessView requires selectedIncrement and seenIncrement');
    }
    this._selectedIncrement = selectedIncrement;
    this._seenIncrement = seenIncrement;
  }

  /**
   * Update access tracking fields for a memory entry.
   *
   * usedInBrainContext=true:  access_count += selectedIncrement, last_triggered_at = now, decay_score = 1.0
   * usedInBrainContext=false: access_count += seenIncrement (no other field changes)
   *
   * All updates are atomic (single UPDATE statement).
   * Does NOT write memory_audit (DL-1: frequency too high).
   *
   * @param {{ id: number, usedInBrainContext: boolean }} opts
   */
  touchAccess({ id, usedInBrainContext }) {
    const now = Date.now();
    if (usedInBrainContext) {
      this._db.prepare(`
        UPDATE memories SET
          access_count = access_count + ?,
          last_triggered_at = ?,
          decay_score = 1.0,
          updated_at = ?
        WHERE id = ?
      `).run(this._selectedIncrement, now, now, id);
    } else {
      this._db.prepare(`
        UPDATE memories SET
          access_count = access_count + ?,
          updated_at = ?
        WHERE id = ?
      `).run(this._seenIncrement, now, id);
    }
  }

  /**
   * Batch update: mark multiple memories as used in Brain context.
   * Equivalent to calling touchAccess({ id, usedInBrainContext: true }) for each id.
   *
   * @param {number[]} ids
   */
  noteBrainInclusion(ids) {
    if (!ids || ids.length === 0) return;

    const now = Date.now();
    const placeholders = ids.map(() => '?').join(', ');
    this._db.prepare(`
      UPDATE memories SET
        access_count = access_count + ?,
        last_triggered_at = ?,
        decay_score = 1.0,
        updated_at = ?
      WHERE id IN (${placeholders})
    `).run(this._selectedIncrement, now, now, ...ids);
  }
}

// =================== CerebellumL1View ===================

export class CerebellumL1View extends ReadOnlyView {
  /**
   * @param {import('better-sqlite3').Database|null} _db
   * @param {Object} [opts]
   * @param {string} [opts.writer='cerebellum-l1'] - Audit identity for memory.writer and memory_audit.changed_by
   */
  constructor(_db, { writer = 'cerebellum-l1' } = {}) {
    super(_db);
    this._writer = writer;
  }

  /**
   * Insert a memory with tags in a single transaction. Writer identity comes from this._writer.
   * Auto-creates tags that do not exist (INSERT OR IGNORE). Inserts memory_audit row.
   *
   * @param {{ content: string, layer: import('./types.js').Layer, tags: string[], source_session: string, source_timestamp: number, confidence: 'high'|'medium'|'low' }} opts
   * @returns {{ id: number }}
   */
  write({ content, layer, tags, source_session, source_timestamp, confidence }) {
    const db = this._db;
    const insertMemory = db.prepare(`
      INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, last_triggered_at, decay_score, confidence, writer)
      VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 1.0, ?, ?)
    `);
    const insertTagIgnore = db.prepare(`
      INSERT OR IGNORE INTO tags (name, description, level, created_at, updated_at)
      VALUES (?, '', 0, ?, ?)
    `);
    const selectTag = db.prepare('SELECT id FROM tags WHERE name = ?');
    const insertEdge = db.prepare(`
      INSERT INTO edges (from_type, from_id, to_type, to_id, kind, created_at)
      VALUES ('memory', ?, 'tag', ?, 'tagged_with', ?)
    `);
    const insertAudit = db.prepare(`
      INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
      VALUES (?, 'create', NULL, ?, ?, ?)
    `);

    const writer = this._writer;
    const tx = db.transaction(() => {
      const now = Date.now();
      const result = insertMemory.run(layer, content, source_session, source_timestamp, now, now, confidence, writer);
      const memoryId = Number(result.lastInsertRowid);

      for (const tagName of (tags || [])) {
        insertTagIgnore.run(tagName, now, now);
        const tag = selectTag.get(tagName);
        insertEdge.run(memoryId, tag.id, now);
      }

      insertAudit.run(memoryId, content, writer, now);

      return { id: memoryId };
    });

    return tx();
  }

  /**
   * Update an existing memory by ID. Only fields present in patch are updated.
   * If patch.tags is provided, existing tagged_with edges are replaced. Inserts memory_audit row.
   *
   * @param {{ id: number, patch: Partial<import('./types.js').Memory> }} opts
   */
  update({ id, patch }) {
    const db = this._db;

    const ALLOWED_PATCH_FIELDS = ['content', 'layer', 'confidence', 'source_session', 'source_timestamp'];

    const selectContent = db.prepare('SELECT content FROM memories WHERE id = ?');
    const deleteTaggedWith = db.prepare(`
      DELETE FROM edges WHERE from_type = 'memory' AND from_id = ? AND kind = 'tagged_with'
    `);
    const insertTagIgnore = db.prepare(`
      INSERT OR IGNORE INTO tags (name, description, level, created_at, updated_at)
      VALUES (?, '', 0, ?, ?)
    `);
    const selectTag = db.prepare('SELECT id FROM tags WHERE name = ?');
    const insertEdge = db.prepare(`
      INSERT INTO edges (from_type, from_id, to_type, to_id, kind, created_at)
      VALUES ('memory', ?, 'tag', ?, 'tagged_with', ?)
    `);
    const insertAudit = db.prepare(`
      INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
      VALUES (?, 'update', ?, ?, ?, ?)
    `);

    const writer = this._writer;
    const tx = db.transaction(() => {
      const existing = selectContent.get(id);
      if (!existing) throw new ValidationError(`Memory not found: ${id}`);
      const oldContent = existing.content;

      const now = Date.now();

      // Build dynamic UPDATE for scalar fields
      const setClauses = ['updated_at = ?'];
      const values = [now];

      for (const field of ALLOWED_PATCH_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, field) && field !== 'tags') {
          setClauses.push(`${field} = ?`);
          values.push(patch[field]);
        }
      }

      values.push(id);
      db.prepare(`UPDATE memories SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

      // Replace tags if provided
      if (Object.prototype.hasOwnProperty.call(patch, 'tags') && patch.tags != null) {
        deleteTaggedWith.run(id);
        for (const tagName of patch.tags) {
          insertTagIgnore.run(tagName, now, now);
          const tag = selectTag.get(tagName);
          insertEdge.run(id, tag.id, now);
        }
      }

      const newContent = Object.prototype.hasOwnProperty.call(patch, 'content') ? patch.content : oldContent;
      insertAudit.run(id, oldContent, newContent, writer, now);
    });

    tx();
  }

  /**
   * Create a new tag with a given name and description. level is hardcoded to 0.
   * Throws ValidationError if a tag with the same name already exists.
   *
   * @param {{ name: string, description: string }} opts
   * @returns {{ id: number, name: string, description: string, level: number, created_at: number, updated_at: number }}
   */
  createTag({ name, description }) {
    const db = this._db;
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO tags (name, description, level, created_at, updated_at) VALUES (?, ?, 0, ?, ?)`
      ).run(name, description, now, now);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new ValidationError(`Tag already exists: ${name}`);
      }
      throw err;
    }
    return db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
  }

  /**
   * Update the description of an existing tag.
   * Throws UnknownTagError if no tag with the given name exists.
   *
   * @param {{ name: string, description: string }} opts
   */
  updateTagDescription({ name, description }) {
    const db = this._db;
    const now = Date.now();
    const result = db.prepare(
      `UPDATE tags SET description = ?, updated_at = ? WHERE name = ?`
    ).run(description, now, name);
    if (result.changes === 0) throw new UnknownTagError(name);
  }

  /**
   * Create a directed edge between two tags.
   *
   * For non-tagged_with kinds, description and weight must both be non-null (Q11 dual enforcement).
   * For parent_of edges, the child tag's level is updated to parent.level + 1.
   * If the resulting child level would exceed 1000, throws ValidationError.
   *
   * @param {{ from: string, to: string, kind: import('./types.js').EdgeKind, description?: string, weight?: number }} opts
   */
  relateTags({ from, to, kind, description, weight }) {
    const db = this._db;

    // Q11: view-layer enforcement for non-tagged_with edges
    if (kind !== 'tagged_with' && (description == null || weight == null)) {
      throw new ValidationError('Non-tagged_with edges require description and weight');
    }

    const fromTag = db.prepare('SELECT * FROM tags WHERE name = ?').get(from);
    if (!fromTag) throw new UnknownTagError(from);

    const toTag = db.prepare('SELECT * FROM tags WHERE name = ?').get(to);
    if (!toTag) throw new UnknownTagError(to);

    const now = Date.now();

    const tx = db.transaction(() => {
      if (kind === 'parent_of') {
        // "from" is parent, "to" is child — new child level = parent.level + 1
        const newChildLevel = fromTag.level + 1;
        if (newChildLevel > 1000) {
          throw new ValidationError('Tag level would exceed max_level 1000');
        }
        db.prepare(
          `UPDATE tags SET level = ?, updated_at = ? WHERE id = ?`
        ).run(newChildLevel, now, toTag.id);
      }

      try {
        db.prepare(`
          INSERT INTO edges (from_type, from_id, to_type, to_id, kind, description, weight, created_at)
          VALUES ('tag', ?, 'tag', ?, ?, ?, ?, ?)
        `).run(fromTag.id, toTag.id, kind, description ?? null, weight ?? null, now);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
          throw new ValidationError('Edge already exists');
        }
        throw err;
      }
    });

    tx();
  }
}

// =================== CerebellumL2View ===================

/** Decay lambda constants per layer (DL-7). */
const DECAY_LAMBDA = {
  short: 0.077,
  long: 0.0063,
  short_skill: 0.0063,
  long_skill: 0.0021,
};

/** Access-count thresholds triggering promotion (DL-spec). */
const PROMOTION_THRESHOLDS = {
  short: 10,
  short_skill: 50,
};

export class CerebellumL2View extends CerebellumL1View {
  /** @param {import('better-sqlite3').Database|null} _db */
  constructor(_db) {
    super(_db, { writer: 'cerebellum-l2' });
  }

  /**
   * Recompute decay_score for ALL memories using:
   *   decay_score = e^(-λ * days_since_last_triggered)
   *
   * Memories with last_triggered_at IS NULL are skipped (decay_score stays 1.0).
   * Uses exp_decay() SQL function registered in client.js open().
   * Wrapped in a single db.transaction() for cross-layer atomicity.
   * Does NOT write memory_audit rows.
   *
   * @returns {{ updatedCount: number }}
   */
  recomputeDecayScores() {
    const db = this._db;

    // Verify exp_decay SQL function is registered (required by ThinkroidMemory.open())
    try {
      db.prepare('SELECT exp_decay(0.1, 0, 0)').get();
    } catch (e) {
      throw new Error(
        'exp_decay SQL function not registered. Ensure ThinkroidMemory.open() was used to create the database connection.'
      );
    }

    const nowMs = Date.now();

    const tx = db.transaction(() => {
      let total = 0;
      for (const [layer, lambda] of Object.entries(DECAY_LAMBDA)) {
        const info = db.prepare(
          `UPDATE memories
             SET decay_score = exp_decay(?, last_triggered_at, ?),
                 updated_at  = ?
           WHERE layer = ?
             AND last_triggered_at IS NOT NULL`
        ).run(lambda, nowMs, nowMs, layer);
        total += info.changes;
      }
      return { updatedCount: total };
    });

    return tx();
  }

  /**
   * Return memories in the given source layer whose access_count meets
   * the promotion threshold.
   *
   * @param {{ layer: 'short' | 'short_skill' }} opts
   * @returns {Array<{ id: number, newLayer: 'long' | 'long_skill' }>}
   */
  findPromotable({ layer, threshold: thresholdOverride }) {
    if (!Object.prototype.hasOwnProperty.call(PROMOTION_THRESHOLDS, layer)) {
      throw new ValidationError(
        `findPromotable: layer must be 'short' or 'short_skill', got '${layer}'`
      );
    }
    const threshold = thresholdOverride ?? PROMOTION_THRESHOLDS[layer];
    const rows = this._db.prepare(
      `SELECT id FROM memories WHERE layer = ? AND access_count >= ?`
    ).all(layer, threshold);

    const newLayer = layer === 'short' ? 'long' : 'long_skill';
    return rows.map(r => ({ id: r.id, newLayer }));
  }

  /**
   * Permanently remove a memory node and cascade its edges.
   *
   * The audit row is inserted before deletion with memory_id set to the memory's ID.
   * After the memory is deleted, ON DELETE SET NULL causes the audit row's memory_id
   * to become NULL — the row itself is preserved for traceability.
   *
   * @param {{ id: number }} opts
   * @returns {{ id: number, deletedContent: string }}
   */
  delete({ id }) {
    const db = this._db;
    const tx = db.transaction(() => {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!row) throw new MemoryNotFoundError(id);

      const now = Date.now();

      // Remove edges referencing this memory (from_type or to_type = 'memory')
      db.prepare(
        `DELETE FROM edges WHERE (from_type = 'memory' AND from_id = ?) OR (to_type = 'memory' AND to_id = ?)`
      ).run(id, id);

      // Insert audit row before deletion; ON DELETE SET NULL will null out memory_id after the memory is removed
      db.prepare(
        `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
         VALUES (?, 'delete', ?, NULL, 'cerebellum-l2', ?)`
      ).run(id, row.content, now);

      db.prepare('DELETE FROM memories WHERE id = ?').run(id);

      return { id, deletedContent: row.content };
    });
    return tx();
  }

  /**
   * Batch-delete memories whose decay_score is below the given threshold.
   * Optionally restrict to a specific layer.
   *
   * Each deleted memory gets an audit row (operation='prune', changed_by='cerebellum-l2').
   * Edges referencing any deleted memory (inbound and outbound) are removed.
   * ON DELETE SET NULL in memory_audit preserves audit rows with memory_id=NULL.
   *
   * Everything runs inside a single db.transaction() for atomicity.
   *
   * @param {{ belowDecayScore: number, layer?: string }} opts
   * @returns {{ deletedCount: number, deletedIds: number[] }}
   */
  prune({ belowDecayScore, layer }) {
    const db = this._db;

    const tx = db.transaction(() => {
      // 1. Identify candidates
      let candidates;
      if (layer !== undefined) {
        candidates = db.prepare(
          `SELECT id, content FROM memories WHERE decay_score < ? AND layer = ?`
        ).all(belowDecayScore, layer);
      } else {
        candidates = db.prepare(
          `SELECT id, content FROM memories WHERE decay_score < ?`
        ).all(belowDecayScore);
      }

      if (candidates.length === 0) {
        return { deletedCount: 0, deletedIds: [] };
      }

      const now = Date.now();
      const insertAudit = db.prepare(
        `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
         VALUES (?, 'prune', ?, NULL, 'cerebellum-l2', ?)`
      );
      const ids = candidates.map(c => c.id);

      // 2. Insert audit rows before deletion (ON DELETE SET NULL will null memory_id after)
      for (const c of candidates) {
        insertAudit.run(c.id, c.content, now);
      }

      // 3. Delete edges for all candidates in one pass using placeholders
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM edges
         WHERE (from_type = 'memory' AND from_id IN (${placeholders}))
            OR (to_type   = 'memory' AND to_id   IN (${placeholders}))`
      ).run(...ids, ...ids);

      // 4. Delete the memories
      db.prepare(
        `DELETE FROM memories WHERE id IN (${placeholders})`
      ).run(...ids);

      return { deletedCount: ids.length, deletedIds: ids };
    });

    return tx();
  }

  /**
   * Merge sourceId into targetId: sum access_counts, rewrite edges from source to target,
   * record a 'merge' audit on the target, then delete the source memory.
   *
   * For edges that would create a duplicate (target already has an identical edge), the
   * source edge is deleted without being moved. This is handled via DELETE of conflicting
   * edges before bulk UPDATE.
   *
   * @param {{ sourceId: number, targetId: number }} opts
   * @returns {{ mergedId: number }}
   */
  merge({ sourceId, targetId }) {
    const db = this._db;
    const tx = db.transaction(() => {
      if (sourceId === targetId) throw new ValidationError('Cannot merge memory with itself');

      const source = db.prepare('SELECT * FROM memories WHERE id = ?').get(sourceId);
      if (!source) throw new MemoryNotFoundError(sourceId);

      const target = db.prepare('SELECT * FROM memories WHERE id = ?').get(targetId);
      if (!target) throw new MemoryNotFoundError(targetId);

      const now = Date.now();
      const mergedAccessCount = source.access_count + target.access_count;

      // Update target: sum access_count, bump updated_at
      db.prepare(
        `UPDATE memories SET access_count = ?, updated_at = ? WHERE id = ?`
      ).run(mergedAccessCount, now, targetId);

      // Rewrite outbound edges from source to target (from_type='memory', from_id=sourceId)
      // Step 1: delete edges that would collide with an existing target edge
      db.prepare(
        `DELETE FROM edges
         WHERE from_type = 'memory' AND from_id = ?
         AND EXISTS (
           SELECT 1 FROM edges e2
           WHERE e2.from_type = 'memory' AND e2.from_id = ?
             AND e2.to_type = edges.to_type AND e2.to_id = edges.to_id AND e2.kind = edges.kind
         )`
      ).run(sourceId, targetId);
      // Step 2: move remaining source outbound edges to target
      db.prepare(
        `UPDATE edges SET from_id = ? WHERE from_type = 'memory' AND from_id = ?`
      ).run(targetId, sourceId);

      // Rewrite inbound edges pointing to source (to_type='memory', to_id=sourceId)
      db.prepare(
        `DELETE FROM edges
         WHERE to_type = 'memory' AND to_id = ?
         AND EXISTS (
           SELECT 1 FROM edges e2
           WHERE e2.to_type = 'memory' AND e2.to_id = ?
             AND e2.from_type = edges.from_type AND e2.from_id = edges.from_id AND e2.kind = edges.kind
         )`
      ).run(sourceId, targetId);
      db.prepare(
        `UPDATE edges SET to_id = ? WHERE to_type = 'memory' AND to_id = ?`
      ).run(targetId, sourceId);

      // Audit on the target memory with merge context
      db.prepare(
        `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
         VALUES (?, 'merge', ?, ?, 'cerebellum-l2', ?)`
      ).run(
        targetId,
        JSON.stringify({ sourceId, sourceContent: source.content }),
        JSON.stringify({ targetId, targetContent: target.content, mergedAccessCount }),
        now
      );

      // Delete source (cascade cleans up any remaining audit rows for source)
      db.prepare('DELETE FROM memories WHERE id = ?').run(sourceId);

      return { mergedId: targetId };
    });
    return tx();
  }

  /**
   * Promote a memory to a higher layer. Only valid transitions:
   *   short → long
   *   short_skill → long_skill
   *
   * The memory.writer field is NOT changed — it tracks the original creator, not the promoter.
   * Audit changed_by is 'cerebellum-l2'.
   *
   * @param {{ id: number, newLayer: import('./types.js').Layer }} opts
   */
  promote({ id, newLayer }) {
    const db = this._db;
    const VALID_TRANSITIONS = new Map([
      ['short', 'long'],
      ['short_skill', 'long_skill'],
    ]);

    const tx = db.transaction(() => {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      if (!row) throw new MemoryNotFoundError(id);

      const expectedNew = VALID_TRANSITIONS.get(row.layer);
      if (expectedNew !== newLayer) {
        throw new ValidationError(
          `Invalid layer transition: ${row.layer} → ${newLayer}. ` +
          `Only short→long and short_skill→long_skill are allowed.`
        );
      }

      const now = Date.now();
      db.prepare(`UPDATE memories SET layer = ?, updated_at = ? WHERE id = ?`).run(newLayer, now, id);

      db.prepare(
        `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
         VALUES (?, 'promote', ?, ?, 'cerebellum-l2', ?)`
      ).run(id, row.layer, newLayer, now);
    });

    tx();
  }

  /**
   * Rename a tag by its integer ID.
   * Throws UnknownTagError if no tag with the given id exists.
   * Throws ValidationError if the new name is already taken.
   * Writes a memory_audit row with memory_id=NULL and operation='rename_tag'.
   *
   * @param {{ tagId: number, newName: string }} opts
   */
  renameTag({ tagId, newName }) {
    const db = this._db;
    const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId);
    if (!existing) throw new UnknownTagError(tagId);

    const oldName = existing.name;
    const now = Date.now();
    try {
      db.prepare(`UPDATE tags SET name = ?, updated_at = ? WHERE id = ?`).run(newName, now, tagId);
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new ValidationError(`Tag name already exists: ${newName}`);
      }
      throw err;
    }

    db.prepare(
      `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
       VALUES (NULL, 'rename_tag', ?, ?, 'cerebellum-l2', ?)`
    ).run(oldName, newName, now);
  }

  /**
   * Remove a directed edge between two tags identified by integer IDs.
   * Throws ValidationError if the edge does not exist.
   * Writes a memory_audit row with memory_id=NULL and operation='unrelate_tags'.
   *
   * @param {{ fromId: number, toId: number, kind: import('./types.js').EdgeKind }} opts
   */
  unrelateTags({ fromId, toId, kind }) {
    const db = this._db;
    const edge = db.prepare(
      `SELECT id FROM edges
       WHERE from_type = 'tag' AND from_id = ? AND to_type = 'tag' AND to_id = ? AND kind = ?`
    ).get(fromId, toId, kind);

    if (!edge) throw new ValidationError(`Edge not found: tag(${fromId}) -[${kind}]-> tag(${toId})`);

    db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);

    const now = Date.now();
    db.prepare(
      `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
       VALUES (NULL, 'unrelate_tags', ?, NULL, 'cerebellum-l2', ?)`
    ).run(JSON.stringify({ fromId, toId, kind }), now);
  }

  /**
   * Detect cycles in the tag-to-tag parent_of graph using Tarjan's SCC algorithm.
   * Returns all strongly connected components of size >= 2 (actual cycles).
   * Writes one memory_audit row per cycle found, with memory_id=NULL and operation='detect_loop'.
   *
   * @returns {{ cycles: Array<{ tagIds: number[], tagNames: string[] }> }}
   */
  detectLoops() {
    const db = this._db;

    // Build adjacency list from all parent_of tag→tag edges
    const rows = db.prepare(
      `SELECT from_id, to_id FROM edges
       WHERE kind = 'parent_of' AND from_type = 'tag' AND to_type = 'tag'`
    ).all();

    const adjList = new Map();
    for (const { from_id, to_id } of rows) {
      if (!adjList.has(from_id)) adjList.set(from_id, []);
      adjList.get(from_id).push(to_id);
      // Ensure to_id is present as a key so tarjanSCC visits it
      if (!adjList.has(to_id)) adjList.set(to_id, []);
    }

    const sccs = tarjanSCC(adjList);

    // Resolve tag names for each SCC
    const cycles = sccs.map(scc => {
      const tagNames = scc.map(tagId => {
        const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(tagId);
        return tag ? tag.name : `unknown(${tagId})`;
      });
      return { tagIds: scc, tagNames };
    });

    // Write one audit row per detected cycle
    const now = Date.now();
    const insertAudit = db.prepare(
      `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
       VALUES (NULL, 'detect_loop', NULL, ?, 'cerebellum-l2', ?)`
    );
    for (const cycle of cycles) {
      insertAudit.run(JSON.stringify({ tagIds: cycle.tagIds, tagNames: cycle.tagNames }), now);
    }

    return { cycles };
  }

  /**
   * Write a summary entry.
   * @param {{ level: string, periodStart: number, periodEnd: number, content: string, sourceIds?: number[] }} opts
   * @returns {{ id: number }}
   */
  writeSummary({ level, periodStart, periodEnd, content, sourceIds = [] }) {
    const db = this._db;
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO summaries (level, period_start, period_end, content, source_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(level, periodStart, periodEnd, content, JSON.stringify(sourceIds), now);
    return { id: Number(result.lastInsertRowid) };
  }

  /**
   * Find summaries by level within a period range.
   * @param {{ level: string, periodStart: number, periodEnd: number }} opts
   * @returns {Array<Object>}
   */
  findSummaries({ level, periodStart, periodEnd }) {
    const db = this._db;
    const rows = db.prepare(`
      SELECT * FROM summaries
      WHERE level = ? AND period_start >= ? AND period_end <= ?
      ORDER BY period_start ASC
    `).all(level, periodStart, periodEnd);
    return rows.map(r => ({ ...r, source_ids: JSON.parse(r.source_ids) }));
  }

  /**
   * Get the most recent summary for a given level.
   * @param {{ level: string }} opts
   * @returns {Object|null}
   */
  latestSummary({ level }) {
    const db = this._db;
    const row = db.prepare(`
      SELECT * FROM summaries WHERE level = ? ORDER BY period_end DESC LIMIT 1
    `).get(level);
    if (!row) return null;
    return { ...row, source_ids: JSON.parse(row.source_ids) };
  }
}
