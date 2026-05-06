// Phase 16.G.2 — Daemon-side CE Stage 4 (recall) implementation.
//
// Per ADR §4 (E3 thin-daemon scope) the daemon owns the recall path — it
// must not round-trip through Space. This module exposes a factory that
// builds a `thinkDeeper(query)` closure bound to the daemon's own
// memory.db handle (opened at S11 in agent-core-daemon.js).
//
// The implementation mirrors the existing CE Stage 4 logic in
// `services/agent-core/ce/context-engine.js#stage4ThinkDeeper`:
//
//   1. Tag-based search: split the query on whitespace, take tokens of
//      length > 2, look each one up as a tag (with descendant traversal).
//   2. Keyword search: case-insensitive LIKE over `memories.content`
//      union LIKE over `tags.name` (limit 20).
//   3. Deduplicate by id.
//   4. touchAccess on every found memory (access_count += selectedIncrement,
//      last_triggered_at = now, decay_score = 1.0).
//   5. Format grouped by layer with the same section labels CE uses.
//
// We deliberately re-implement the SQL inline rather than importing
// `modules/thinkroid-memory/src/views.js` because:
//   (a) the daemon owns memory.db directly via better-sqlite3 (Design §7),
//       so an extra view-class indirection would just wrap the same DB
//       handle without adding behaviour;
//   (b) the views module pulls in graph-utils and tarjanSCC which the
//       daemon doesn't need for the Stage 4 read path;
//   (c) the daemon exit path (S11/S12) is the single point of DB
//       ownership — keeping the SQL local makes that ownership obvious.
//
// If memory.db schema evolves the daemon-side queries here MUST be kept
// in sync with `modules/thinkroid-memory/src/schema.sql`.

// Defaults match `stores/constants.js` so daemon-side decay accounting
// agrees with Space-side accounting when both paths exist (post-Phase 16).
const DEFAULT_SELECTED_INCREMENT = 2;

/**
 * Build a CE Stage 4 `thinkDeeper(query)` closure bound to the given DB
 * handle. The closure is what daemon S8 injects into the tool-invoke
 * context so `recall.js` can call `ctx.thinkDeeper(query)` without
 * knowing which DB it's talking to.
 *
 * @param {{ memDb: import('better-sqlite3').Database, agentCoreDb?: import('better-sqlite3').Database, selectedIncrement?: number }} deps
 * @returns {(query: string) => Promise<string>}
 */
export function createThinkDeeper({ memDb, agentCoreDb, selectedIncrement = DEFAULT_SELECTED_INCREMENT } = {}) {
  if (!memDb) {
    throw new TypeError('createThinkDeeper: memDb is required');
  }
  void agentCoreDb; // currently unused by Stage 4 itself but reserved for
                    // future enrichment (e.g. session_history cross-ref).

  return async function thinkDeeper(query) {
    if (typeof query !== 'string' || query.trim().length === 0) return '';

    // Step 1: keyword extraction (mirror context-engine.js).
    const keywords = query
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 10);

    // Step 2: tag-based search with descendant traversal.
    const tagResults = [];
    for (const kw of keywords) {
      tagResults.push(...findByTag(memDb, kw, /* includeDescendants */ true));
    }

    // Step 3: keyword search (content LIKE + tag-name LIKE).
    const kwResults = searchByKeyword(memDb, query.slice(0, 200), 20);

    // Step 4: deduplicate by id.
    const seen = new Map();
    for (const m of [...tagResults, ...kwResults]) {
      if (!seen.has(m.id)) seen.set(m.id, m);
    }
    const allResults = [...seen.values()];
    if (allResults.length === 0) return '';

    // Step 5: touchAccess for every found memory.
    const now = Date.now();
    const touchStmt = memDb.prepare(
      `UPDATE memories SET
         access_count = access_count + ?,
         last_triggered_at = ?,
         decay_score = 1.0,
         updated_at = ?
       WHERE id = ?`,
    );
    for (const m of allResults) {
      try {
        touchStmt.run(selectedIncrement, now, now, m.id);
      } catch {
        // Best-effort: a failed touch must not abort the recall response.
      }
    }

    // Step 6: format grouped by layer.
    return formatResults(allResults);
  };
}

/**
 * Look up `tagName` and (optionally) its descendants, then return the
 * memories tagged with any of those tag ids.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagName
 * @param {boolean} includeDescendants
 * @returns {Array<object>}
 */
function findByTag(db, tagName, includeDescendants) {
  const root = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
  if (!root) return [];

  let tagIds;
  if (!includeDescendants) {
    tagIds = [root.id];
  } else {
    const visited = new Set([root.id]);
    const stack = [root.id];
    const childStmt = db.prepare(
      "SELECT to_id FROM edges " +
        "WHERE from_type = 'tag' AND from_id = ? " +
        "AND to_type = 'tag' AND kind = 'parent_of'",
    );
    while (stack.length > 0) {
      const cur = stack.pop();
      const children = childStmt.all(cur);
      for (const { to_id } of children) {
        if (!visited.has(to_id)) {
          visited.add(to_id);
          stack.push(to_id);
        }
      }
    }
    tagIds = Array.from(visited);
  }

  if (tagIds.length === 0) return [];
  const placeholders = tagIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      "SELECT DISTINCT m.* FROM memories m " +
        "INNER JOIN edges e ON e.from_type = 'memory' AND e.from_id = m.id " +
        "WHERE e.to_type = 'tag' AND e.kind = 'tagged_with' " +
        `AND e.to_id IN (${placeholders})`,
    )
    .all(...tagIds);
  return rows;
}

/**
 * Keyword search: union of `memories.content LIKE %kw%` and
 * `tags.name LIKE %kw%` (then memories with those tags). Capped at
 * `limit` post-union.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} kw
 * @param {number} limit
 * @returns {Array<object>}
 */
function searchByKeyword(db, kw, limit) {
  if (typeof kw !== 'string' || kw.length === 0) return [];

  const contentRows = db
    .prepare("SELECT * FROM memories WHERE content LIKE '%' || ? || '%'")
    .all(kw);

  const matchingTags = db
    .prepare("SELECT id FROM tags WHERE name LIKE '%' || ? || '%'")
    .all(kw);

  const seen = new Set();
  const results = [];
  for (const row of contentRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      results.push(row);
    }
  }
  if (matchingTags.length > 0) {
    const memEdgeStmt = db.prepare(
      "SELECT from_id FROM edges " +
        "WHERE from_type = 'memory' AND to_type = 'tag' " +
        "AND kind = 'tagged_with' AND to_id = ?",
    );
    const memIds = new Set();
    for (const t of matchingTags) {
      for (const r of memEdgeStmt.all(t.id)) memIds.add(r.from_id);
    }
    if (memIds.size > 0) {
      const ids = [...memIds].filter((id) => !seen.has(id));
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(', ');
        const rows = db
          .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
          .all(...ids);
        for (const row of rows) {
          if (!seen.has(row.id)) {
            seen.add(row.id);
            results.push(row);
          }
        }
      }
    }
  }

  return results.slice(0, limit);
}

/**
 * Group results by `layer` and emit the canonical Stage 4 section
 * headings (matches `context-engine.js#stage4ThinkDeeper`).
 *
 * @param {Array<object>} memories
 * @returns {string}
 */
function formatResults(memories) {
  const groups = { long: [], long_skill: [], short: [], short_skill: [] };
  for (const m of memories) {
    const layer = m.layer || 'short';
    if (groups[layer]) groups[layer].push(m);
    else groups.short.push(m);
  }

  const sections = [];
  if (groups.long.length > 0) {
    sections.push(
      `[Long-term Memory]\n${groups.long.map((m) => `- ${m.content}`).join('\n')}`,
    );
  }
  if (groups.long_skill.length > 0) {
    sections.push(
      `[Learned Skills]\n${groups.long_skill.map((m) => `- ${m.content}`).join('\n')}`,
    );
  }
  if (groups.short.length > 0) {
    sections.push(
      `[Recent Context]\n${groups.short.map((m) => `- ${m.content}`).join('\n')}`,
    );
  }
  if (groups.short_skill.length > 0) {
    sections.push(
      `[Working Patterns]\n${groups.short_skill.map((m) => `- ${m.content}`).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}
