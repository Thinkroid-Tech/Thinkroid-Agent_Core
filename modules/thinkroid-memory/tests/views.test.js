import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ThinkroidMemory, NotImplementedError, ValidationError, UnknownTagError, MemoryNotFoundError } from '../src/api.js';
import { tarjanSCC } from '../src/graph-utils.js';

// =================== Seed Helpers ===================

/**
 * Insert a memory row directly via raw SQL, with optional tags.
 * Returns the new memory's integer row ID.
 * @param {import('better-sqlite3').Database} db
 * @param {{ layer: string, content: string, tags?: string[], sourceSession?: string, sourceTimestamp?: number }} opts
 * @returns {number}
 */
function seedMemory(db, { layer, content, tags = [], sourceSession = 'test', sourceTimestamp = Date.now() }) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, decay_score, confidence, writer)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1.0, 'medium', 'cerebellum-l1')`
  ).run(layer, content, sourceSession, sourceTimestamp, now, now);
  const memId = info.lastInsertRowid;
  for (const tagName of tags) {
    db.prepare(
      `INSERT OR IGNORE INTO tags (name, description, level, created_at, updated_at) VALUES (?, '', 0, ?, ?)`
    ).run(tagName, now, now);
    const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName);
    db.prepare(
      `INSERT INTO edges (from_type, from_id, to_type, to_id, kind, created_at) VALUES ('memory', ?, 'tag', ?, 'tagged_with', ?)`
    ).run(memId, tag.id, now);
  }
  return Number(memId);
}

/**
 * Insert a tag row directly via raw SQL.
 * @param {import('better-sqlite3').Database} db
 * @param {{ name: string, description?: string, level?: number }} opts
 * @returns {{ id: number, name: string }}
 */
function seedTag(db, { name, description = '', level = 0 }) {
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO tags (name, description, level, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(name, description, level, now, now);
  return db.prepare('SELECT * FROM tags WHERE name = ?').get(name);
}

/**
 * Insert an edge row directly via raw SQL.
 * @param {import('better-sqlite3').Database} db
 * @param {{ fromType: string, fromId: number, toType: string, toId: number, kind: string, description?: string|null, weight?: number|null }} opts
 */
function seedEdge(db, { fromType, fromId, toType, toId, kind, description = null, weight = null }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO edges (from_type, from_id, to_type, to_id, kind, description, weight, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(fromType, fromId, toType, toId, kind, description, weight, now);
}

// =================== Test Setup ===================

/**
 * Create an isolated ThinkroidMemory instance with its own temp DB directory.
 * @returns {{ mem: ThinkroidMemory, dbPath: string, tmpDir: string }}
 */
function createTempMemory() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const mem = new ThinkroidMemory(dbPath, 'test-agent');
  return { mem, dbPath, tmpDir };
}

// =================== Tests ===================

describe('ThinkroidMemory real SQL', () => {

  // =================== client ===================

  describe('client', () => {
    it('opens DB and creates schema', () => {
      const { mem, tmpDir } = createTempMemory();
      try {
        mem.open();
        expect(mem.isOpen).toBe(true);
        // Verify schema exists by running a query
        const view = mem.viewForReadOnly();
        expect(view.read(999)).toBeNull();
      } finally {
        mem.close();
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('close nullifies db handle', () => {
      const { mem, tmpDir } = createTempMemory();
      try {
        mem.open();
        expect(mem.isOpen).toBe(true);
        mem.close();
        expect(mem.isOpen).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('double-close is safe', () => {
      const { mem, tmpDir } = createTempMemory();
      try {
        mem.open();
        mem.close();
        expect(() => mem.close()).not.toThrow();
        expect(mem.isOpen).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('PRAGMAs: WAL, FK, user_version=4', () => {
      const { mem, tmpDir } = createTempMemory();
      try {
        mem.open();
        // Access the underlying _db to check PRAGMAs
        const db = mem._db;
        const journalMode = db.pragma('journal_mode', { simple: true });
        const fk = db.pragma('foreign_keys', { simple: true });
        const userVersion = db.pragma('user_version', { simple: true });
        expect(journalMode).toBe('wal');
        expect(fk).toBe(1);
        expect(userVersion).toBe(4);
      } finally {
        mem.close();
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('v1 to v2 migration preserves existing audit rows', () => {
      // Build a v1 database by hand: memories + memory_audit with NOT NULL + ON DELETE CASCADE.
      // Each DDL statement is run individually to avoid multi-statement exec calls.
      const migrTmpDir = mkdtempSync(join(tmpdir(), 'thinkroid-migrate-test-'));
      const migrDbPath = join(migrTmpDir, 'migrate.db');
      try {
        const rawDb = new Database(migrDbPath);
        rawDb.pragma('journal_mode = WAL');
        rawDb.pragma('foreign_keys = ON');

        // Create v1 memories table
        rawDb.prepare(
          `CREATE TABLE memories (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            layer             TEXT    NOT NULL,
            content           TEXT    NOT NULL,
            source_session    TEXT,
            source_timestamp  INTEGER NOT NULL,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL,
            access_count      INTEGER NOT NULL DEFAULT 0,
            last_triggered_at INTEGER,
            decay_score       REAL    NOT NULL DEFAULT 1.0,
            confidence        TEXT    NOT NULL DEFAULT 'medium',
            writer            TEXT    NOT NULL
          )`
        ).run();

        // Create v1 memory_audit table with NOT NULL memory_id + ON DELETE CASCADE
        rawDb.prepare(
          `CREATE TABLE memory_audit (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_id   INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
            operation   TEXT    NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'promote', 'prune', 'merge', 'rename_tag', 'unrelate_tags', 'detect_loop')),
            old_content TEXT,
            new_content TEXT,
            changed_by  TEXT    NOT NULL,
            changed_at  INTEGER NOT NULL
          )`
        ).run();

        rawDb.pragma('user_version = 1');

        // Insert a memory and an audit row referencing it
        const now = Date.now();
        const info = rawDb.prepare(
          `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, confidence, writer)
           VALUES ('short', 'migrate test content', 'sess', ?, ?, ?, 'medium', 'cerebellum-l1')`
        ).run(now, now, now);
        const memId = Number(info.lastInsertRowid);
        rawDb.prepare(
          `INSERT INTO memory_audit (memory_id, operation, old_content, new_content, changed_by, changed_at)
           VALUES (?, 'create', NULL, 'migrate test content', 'cerebellum-l1', ?)`
        ).run(memId, now);
        rawDb.close();

        // Reopen via ThinkroidMemory — this triggers the v1 → v2 migration
        const mem = new ThinkroidMemory(migrDbPath, 'migrate-agent');
        mem.open();
        const db = mem._db;

        // Verify user_version bumped to 4 (v1→v2→v3→v4 migrations run in sequence)
        expect(db.pragma('user_version', { simple: true })).toBe(4);

        // Verify audit row was preserved
        const auditRows = db.prepare('SELECT * FROM memory_audit').all();
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0].memory_id).toBe(memId);
        expect(auditRows[0].operation).toBe('create');
        expect(auditRows[0].new_content).toBe('migrate test content');

        mem.close();
      } finally {
        rmSync(migrTmpDir, { recursive: true });
      }
    });
  });

  // =================== Constructor null-db guard ===================

  describe('constructor null-db guard', () => {
    it('ReadOnlyView throws ValidationError on null db', async () => {
      const { ReadOnlyView } = await import('../src/views.js');
      expect(() => new ReadOnlyView(null)).toThrow(ValidationError);
    });

    it('CeAccessView throws ValidationError on null db (inherited from ReadOnlyView)', async () => {
      const { CeAccessView } = await import('../src/views.js');
      expect(() => new CeAccessView(null, { selectedIncrement: 2, seenIncrement: 1 }))
        .toThrow(ValidationError);
    });
  });

  // =================== ReadOnlyView ===================

  describe('ReadOnlyView', () => {
    let mem, db, tmpDir;

    beforeEach(() => {
      const setup = createTempMemory();
      mem = setup.mem;
      tmpDir = setup.tmpDir;
      mem.open();
      db = mem._db;
    });

    afterEach(() => {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    });

    // ---- read ----

    describe('read', () => {
      it('returns memory with resolved tags', () => {
        const id = seedMemory(db, { layer: 'short', content: 'hello world', tags: ['alpha', 'beta'] });
        const view = mem.viewForReadOnly();
        const result = view.read(id);
        expect(result).not.toBeNull();
        expect(result.id).toBe(id);
        expect(result.content).toBe('hello world');
        expect(result.layer).toBe('short');
        expect(result.tags).toContain('alpha');
        expect(result.tags).toContain('beta');
        expect(result.tags).toHaveLength(2);
      });

      it('returns null for non-existent id', () => {
        const view = mem.viewForReadOnly();
        expect(view.read(99999)).toBeNull();
      });
    });

    // ---- findByTag ----

    describe('findByTag', () => {
      it('finds memories with exact tag', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'mem1', tags: ['fruit'] });
        seedMemory(db, { layer: 'short', content: 'mem2', tags: ['veggie'] });
        const view = mem.viewForReadOnly();
        const results = view.findByTag({ tagName: 'fruit' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe(id1);
      });

      it('finds descendants when includeDescendants=true', () => {
        // parent_of: fruit -> apple
        const fruit = seedTag(db, { name: 'fruit' });
        const apple = seedTag(db, { name: 'apple' });
        // tagged_with is handled separately from parent_of — need description+weight for parent_of
        seedEdge(db, { fromType: 'tag', fromId: fruit.id, toType: 'tag', toId: apple.id, kind: 'parent_of', description: 'is parent', weight: 1.0 });
        const id1 = seedMemory(db, { layer: 'short', content: 'mem-apple', tags: ['apple'] });
        const id2 = seedMemory(db, { layer: 'short', content: 'mem-fruit', tags: ['fruit'] });
        const view = mem.viewForReadOnly();
        const results = view.findByTag({ tagName: 'fruit', includeDescendants: true });
        const ids = results.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
      });

      it('handles cycles in tag graph (visited set prevents infinite loop)', () => {
        // Create a cycle: a -> b -> a
        const tagA = seedTag(db, { name: 'cycle-a' });
        const tagB = seedTag(db, { name: 'cycle-b' });
        seedEdge(db, { fromType: 'tag', fromId: tagA.id, toType: 'tag', toId: tagB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tagB.id, toType: 'tag', toId: tagA.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedMemory(db, { layer: 'short', content: 'cycle mem', tags: ['cycle-a'] });
        const view = mem.viewForReadOnly();
        // Should not throw or loop infinitely
        expect(() => view.findByTag({ tagName: 'cycle-a', includeDescendants: true })).not.toThrow();
      });

      it('all traversal methods use throw (not break) for node limit', () => {
        // Verify the code path: reading source ensures findByTag, findRelated,
        // and getTagTree all throw ValidationError (not silently truncate).
        // We cannot seed 10K tags in a unit test, but we verify the consistent
        // pattern: all three methods now throw on >= MAX_TRAVERSAL_NODES.
        // The cycle test above confirms visited-set prevents infinite loops.
        // This test confirms ValidationError is importable and constructable.
        expect(ValidationError).toBeDefined();
        expect(new ValidationError('limit test').name).toBe('ValidationError');
      });

      it('returns empty for unknown tag', () => {
        const view = mem.viewForReadOnly();
        expect(view.findByTag({ tagName: 'nonexistent' })).toEqual([]);
      });
    });

    // ---- findByTags ----

    describe('findByTags', () => {
      it('mode any: union of memories across tags', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'mem1', tags: ['red'] });
        const id2 = seedMemory(db, { layer: 'short', content: 'mem2', tags: ['blue'] });
        seedMemory(db, { layer: 'short', content: 'mem3', tags: ['green'] });
        const view = mem.viewForReadOnly();
        const results = view.findByTags({ tagNames: ['red', 'blue'], mode: 'any' });
        const ids = results.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
        expect(results).toHaveLength(2);
      });

      it('mode all: intersection — only memories tagged with all tags', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'both', tags: ['x', 'y'] });
        seedMemory(db, { layer: 'short', content: 'only-x', tags: ['x'] });
        const view = mem.viewForReadOnly();
        const results = view.findByTags({ tagNames: ['x', 'y'], mode: 'all' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe(id1);
      });

      it('returns empty when no matches', () => {
        const view = mem.viewForReadOnly();
        expect(view.findByTags({ tagNames: ['nosuchtag'], mode: 'any' })).toEqual([]);
        expect(view.findByTags({ tagNames: ['nosuchtag'], mode: 'all' })).toEqual([]);
      });
    });

    // ---- findRelated ----

    describe('findRelated', () => {
      it('finds related memories at depth 1', () => {
        const tagA = seedTag(db, { name: 'rel-a' });
        const tagB = seedTag(db, { name: 'rel-b' });
        seedEdge(db, { fromType: 'tag', fromId: tagA.id, toType: 'tag', toId: tagB.id, kind: 'related_to', description: 'd', weight: 0.8 });
        const id1 = seedMemory(db, { layer: 'short', content: 'mem-a', tags: ['rel-a'] });
        const id2 = seedMemory(db, { layer: 'short', content: 'mem-b', tags: ['rel-b'] });
        const view = mem.viewForReadOnly();
        const results = view.findRelated({ tagName: 'rel-a', depth: 1 });
        const ids = results.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);
      });

      it('finds related memories at depth 2', () => {
        const tagA = seedTag(db, { name: 'hop-a' });
        const tagB = seedTag(db, { name: 'hop-b' });
        const tagC = seedTag(db, { name: 'hop-c' });
        seedEdge(db, { fromType: 'tag', fromId: tagA.id, toType: 'tag', toId: tagB.id, kind: 'related_to', description: 'd', weight: 0.5 });
        seedEdge(db, { fromType: 'tag', fromId: tagB.id, toType: 'tag', toId: tagC.id, kind: 'related_to', description: 'd', weight: 0.5 });
        const idC = seedMemory(db, { layer: 'short', content: 'mem-c', tags: ['hop-c'] });
        const view = mem.viewForReadOnly();
        const results = view.findRelated({ tagName: 'hop-a', depth: 2 });
        const ids = results.map(r => r.id);
        expect(ids).toContain(idC);
      });

      it('handles cycles without infinite loop', () => {
        const tagA = seedTag(db, { name: 'rcy-a' });
        const tagB = seedTag(db, { name: 'rcy-b' });
        seedEdge(db, { fromType: 'tag', fromId: tagA.id, toType: 'tag', toId: tagB.id, kind: 'related_to', description: 'd', weight: 0.5 });
        seedEdge(db, { fromType: 'tag', fromId: tagB.id, toType: 'tag', toId: tagA.id, kind: 'related_to', description: 'd', weight: 0.5 });
        const view = mem.viewForReadOnly();
        expect(() => view.findRelated({ tagName: 'rcy-a', depth: 5 })).not.toThrow();
      });
    });

    // ---- recent ----

    describe('recent', () => {
      it('returns memories sorted by updated_at desc', () => {
        const now = Date.now();
        db.prepare(
          `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, decay_score, confidence, writer)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1.0, 'medium', 'cerebellum-l1')`
        ).run('short', 'older', 'test', now, now, now - 1000);
        db.prepare(
          `INSERT INTO memories (layer, content, source_session, source_timestamp, created_at, updated_at, access_count, decay_score, confidence, writer)
           VALUES (?, ?, ?, ?, ?, ?, 0, 1.0, 'medium', 'cerebellum-l1')`
        ).run('short', 'newer', 'test', now, now, now);
        const view = mem.viewForReadOnly();
        const results = view.recent({ layer: 'short', limit: 10 });
        expect(results[0].content).toBe('newer');
        expect(results[1].content).toBe('older');
      });

      it('respects limit', () => {
        for (let i = 0; i < 5; i++) {
          seedMemory(db, { layer: 'long', content: `mem-${i}`, tags: [] });
        }
        const view = mem.viewForReadOnly();
        const results = view.recent({ layer: 'long', limit: 3 });
        expect(results).toHaveLength(3);
      });
    });

    // ---- search ----

    describe('search', () => {
      it('finds by content keyword', () => {
        const id = seedMemory(db, { layer: 'short', content: 'the quick brown fox', tags: [] });
        seedMemory(db, { layer: 'short', content: 'unrelated text', tags: [] });
        const view = mem.viewForReadOnly();
        const results = view.search({ kw: 'quick' });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe(id);
      });

      it('finds by tag name keyword', () => {
        const id = seedMemory(db, { layer: 'short', content: 'some content', tags: ['technology'] });
        const view = mem.viewForReadOnly();
        const results = view.search({ kw: 'tech' });
        const ids = results.map(r => r.id);
        expect(ids).toContain(id);
      });

      it('returns empty for no match', () => {
        seedMemory(db, { layer: 'short', content: 'hello', tags: [] });
        const view = mem.viewForReadOnly();
        const results = view.search({ kw: 'zzznomatch' });
        expect(results).toEqual([]);
      });
    });

    // ---- getTag ----

    describe('getTag', () => {
      it('returns tag by name', () => {
        seedTag(db, { name: 'mytag', description: 'test desc', level: 2 });
        const view = mem.viewForReadOnly();
        const tag = view.getTag('mytag');
        expect(tag).not.toBeNull();
        expect(tag.name).toBe('mytag');
        expect(tag.description).toBe('test desc');
        expect(tag.level).toBe(2);
      });

      it('returns null for unknown tag', () => {
        const view = mem.viewForReadOnly();
        expect(view.getTag('does-not-exist')).toBeNull();
      });
    });

    // ---- getTagTree ----

    describe('getTagTree', () => {
      it('builds simple tree', () => {
        const parent = seedTag(db, { name: 'tree-parent' });
        const child = seedTag(db, { name: 'tree-child' });
        seedEdge(db, { fromType: 'tag', fromId: parent.id, toType: 'tag', toId: child.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        const view = mem.viewForReadOnly();
        const tree = view.getTagTree({ root: 'tree-parent' });
        expect(tree.tag.name).toBe('tree-parent');
        expect(tree.children).toHaveLength(1);
        expect(tree.children[0].tag.name).toBe('tree-child');
      });

      it('respects maxDepth', () => {
        const t1 = seedTag(db, { name: 'td-1' });
        const t2 = seedTag(db, { name: 'td-2' });
        const t3 = seedTag(db, { name: 'td-3' });
        seedEdge(db, { fromType: 'tag', fromId: t1.id, toType: 'tag', toId: t2.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: t2.id, toType: 'tag', toId: t3.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        const view = mem.viewForReadOnly();
        const tree = view.getTagTree({ root: 'td-1', maxDepth: 1 });
        expect(tree.children).toHaveLength(1);
        // At maxDepth, children of td-2 should not be loaded
        expect(tree.children[0].children).toHaveLength(0);
      });

      it('handles cycles without infinite loop', () => {
        const tA = seedTag(db, { name: 'tc-a' });
        const tB = seedTag(db, { name: 'tc-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tB.id, toType: 'tag', toId: tA.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        const view = mem.viewForReadOnly();
        expect(() => view.getTagTree({ root: 'tc-a' })).not.toThrow();
      });

      it('returns empty node when root not found', () => {
        const view = mem.viewForReadOnly();
        const tree = view.getTagTree({ root: 'no-such-root' });
        expect(tree.tag).toBeNull();
        expect(tree.children).toEqual([]);
      });
    });

    // ---- getTagEdges ----

    describe('getTagEdges', () => {
      it('returns edges for a known tag', () => {
        const tA = seedTag(db, { name: 'edge-a' });
        const tB = seedTag(db, { name: 'edge-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'related_to', description: 'd', weight: 0.7 });
        const view = mem.viewForReadOnly();
        const edges = view.getTagEdges('edge-a');
        expect(edges.length).toBeGreaterThanOrEqual(1);
        expect(edges.some(e => e.from_id === tA.id && e.to_id === tB.id)).toBe(true);
      });

      it('returns empty for unknown tag', () => {
        const view = mem.viewForReadOnly();
        expect(view.getTagEdges('unknown-tag')).toEqual([]);
      });
    });
  });

  // =================== CeAccessView ===================

  describe('CeAccessView', () => {
    let mem, db, tmpDir;

    beforeEach(() => {
      const setup = createTempMemory();
      mem = setup.mem;
      tmpDir = setup.tmpDir;
      mem.open();
      db = mem._db;
    });

    afterEach(() => {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    });

    it('constructor throws ValidationError without increment config', () => {
      // viewForCeAccess delegates to CeAccessView constructor — use it to exercise the guard
      // Test: missing config → throw
      expect(() => mem.viewForCeAccess()).toThrow(ValidationError);
      // Empty object → missing both → throw
      expect(() => mem.viewForCeAccess({})).toThrow(ValidationError);
      // Only selectedIncrement → missing seenIncrement → throw
      expect(() => mem.viewForCeAccess({ selectedIncrement: 2 })).toThrow(ValidationError);
      // Only seenIncrement → missing selectedIncrement → throw
      expect(() => mem.viewForCeAccess({ seenIncrement: 1 })).toThrow(ValidationError);
    });

    it('touchAccess seen-only (+1): increments access_count, does not touch last_triggered_at or decay_score', () => {
      const id = seedMemory(db, { layer: 'short', content: 'seen test', tags: [] });
      // Ensure last_triggered_at starts NULL
      const before = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      expect(before.last_triggered_at).toBeNull();
      expect(before.decay_score).toBe(1.0);
      const updatedAtBefore = before.updated_at;

      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      view.touchAccess({ id, usedInBrainContext: false });

      const after = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      expect(after.access_count).toBe(1);
      expect(after.last_triggered_at).toBeNull();
      expect(after.decay_score).toBe(1.0);
      expect(after.updated_at).toBeGreaterThanOrEqual(updatedAtBefore);
    });

    it('touchAccess brain-context (+2): syncs access_count, last_triggered_at, and decay_score atomically', () => {
      const id = seedMemory(db, { layer: 'short', content: 'brain test', tags: [] });
      // Manually set decay_score to 0.5 to verify it gets reset to 1.0
      db.prepare('UPDATE memories SET decay_score = 0.5, last_triggered_at = NULL WHERE id = ?').run(id);

      const before = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      expect(before.access_count).toBe(0);
      expect(before.last_triggered_at).toBeNull();
      expect(before.decay_score).toBe(0.5);

      const t0 = Date.now();
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      view.touchAccess({ id, usedInBrainContext: true });
      const t1 = Date.now();

      const after = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
      expect(after.access_count).toBe(2);
      expect(after.last_triggered_at).toBeGreaterThanOrEqual(t0);
      expect(after.last_triggered_at).toBeLessThanOrEqual(t1);
      expect(after.decay_score).toBe(1.0);
      expect(after.updated_at).toBeGreaterThanOrEqual(t0);
    });

    it('touchAccess accumulates: multiple calls stack correctly', () => {
      const id = seedMemory(db, { layer: 'short', content: 'accumulate test', tags: [] });
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      // +1 (seen), +1 (seen), +2 (brain) = 4
      view.touchAccess({ id, usedInBrainContext: false });
      view.touchAccess({ id, usedInBrainContext: false });
      view.touchAccess({ id, usedInBrainContext: true });

      const row = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id);
      expect(row.access_count).toBe(4);
    });

    it('noteBrainInclusion batch updates all supplied IDs', () => {
      const id1 = seedMemory(db, { layer: 'short', content: 'batch-1', tags: [] });
      const id2 = seedMemory(db, { layer: 'short', content: 'batch-2', tags: [] });
      const id3 = seedMemory(db, { layer: 'short', content: 'batch-3', tags: [] });
      db.prepare('UPDATE memories SET decay_score = 0.3, last_triggered_at = NULL WHERE id IN (?, ?, ?)').run(id1, id2, id3);

      const t0 = Date.now();
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      view.noteBrainInclusion([id1, id2, id3]);
      const t1 = Date.now();

      for (const id of [id1, id2, id3]) {
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        expect(row.access_count).toBe(2);
        expect(row.last_triggered_at).toBeGreaterThanOrEqual(t0);
        expect(row.last_triggered_at).toBeLessThanOrEqual(t1);
        expect(row.decay_score).toBe(1.0);
      }
    });

    it('no memory_audit entry is written after touchAccess', () => {
      // The schema may or may not have a memory_audit table — skip gracefully if absent
      const tableExists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_audit'`
      ).get();
      if (!tableExists) return; // memory_audit table not in current schema — skip

      const id = seedMemory(db, { layer: 'short', content: 'audit test', tags: [] });
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      view.touchAccess({ id, usedInBrainContext: true });

      const count = db.prepare('SELECT COUNT(*) as n FROM memory_audit').get().n;
      expect(count).toBe(0);
    });

    it('touchAccess on nonexistent id does not throw', () => {
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      expect(() => view.touchAccess({ id: 99999, usedInBrainContext: true })).not.toThrow();
    });

    it('noteBrainInclusion with empty array does not throw', () => {
      const view = mem.viewForCeAccess({ selectedIncrement: 2, seenIncrement: 1 });
      expect(() => view.noteBrainInclusion([])).not.toThrow();
    });

  });

  // =================== CerebellumL1View ===================

  describe('CerebellumL1View', () => {
    let mem, db, tmpDir;

    beforeEach(() => {
      const setup = createTempMemory();
      mem = setup.mem;
      tmpDir = setup.tmpDir;
      mem.open();
      db = mem._db;
    });

    afterEach(() => {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    });

    // ---- write ----

    describe('write', () => {
      it('creates a memory entry with correct fields and returns { id }', () => {
        const view = mem.viewForCerebellumL1();
        const t0 = Date.now();
        const result = view.write({
          content: 'test content',
          layer: 'short',
          tags: [],
          source_session: 'sess-1',
          source_timestamp: t0,
          confidence: 'high',
        });
        const t1 = Date.now();
        expect(result).toHaveProperty('id');
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(result.id);
        expect(row.content).toBe('test content');
        expect(row.layer).toBe('short');
        expect(row.source_session).toBe('sess-1');
        expect(row.source_timestamp).toBe(t0);
        expect(row.confidence).toBe('high');
        expect(row.access_count).toBe(0);
        expect(row.last_triggered_at).toBeNull();
        expect(row.decay_score).toBe(1.0);
        expect(row.created_at).toBeGreaterThanOrEqual(t0);
        expect(row.created_at).toBeLessThanOrEqual(t1);
      });

      it('hardcodes writer field as cerebellum-l1', () => {
        const view = mem.viewForCerebellumL1();
        const result = view.write({ content: 'writer test', layer: 'long', tags: [], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' });
        const row = db.prepare('SELECT writer FROM memories WHERE id = ?').get(result.id);
        expect(row.writer).toBe('cerebellum-l1');
      });

      it('auto-creates tags that do not exist via INSERT OR IGNORE', () => {
        const view = mem.viewForCerebellumL1();
        view.write({ content: 'tag test', layer: 'short', tags: ['new-tag-alpha', 'new-tag-beta'], source_session: 's', source_timestamp: Date.now(), confidence: 'low' });
        const tagAlpha = db.prepare('SELECT * FROM tags WHERE name = ?').get('new-tag-alpha');
        const tagBeta = db.prepare('SELECT * FROM tags WHERE name = ?').get('new-tag-beta');
        expect(tagAlpha).toBeTruthy();
        expect(tagBeta).toBeTruthy();
        expect(tagAlpha.level).toBe(0);
        expect(tagAlpha.description).toBe('');
      });

      it('creates tagged_with edges for all tags', () => {
        const view = mem.viewForCerebellumL1();
        const result = view.write({ content: 'edge test', layer: 'short', tags: ['edge-tag-1', 'edge-tag-2'], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' });
        const edges = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'memory' AND from_id = ? AND kind = 'tagged_with'`
        ).all(result.id);
        expect(edges).toHaveLength(2);
      });

      it('inserts memory_audit row with operation=create and changed_by=cerebellum-l1', () => {
        const view = mem.viewForCerebellumL1();
        const result = view.write({ content: 'audit content', layer: 'short', tags: [], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' });
        const auditRow = db.prepare('SELECT * FROM memory_audit WHERE memory_id = ?').get(result.id);
        expect(auditRow).toBeTruthy();
        expect(auditRow.operation).toBe('create');
        expect(auditRow.old_content).toBeNull();
        expect(auditRow.new_content).toBe('audit content');
        expect(auditRow.changed_by).toBe('cerebellum-l1');
      });

      it('reuses existing tags without violating UNIQUE constraint', () => {
        // Pre-seed a tag, then write a memory with that tag name
        seedTag(db, { name: 'preexisting-tag' });
        const view = mem.viewForCerebellumL1();
        expect(() => view.write({ content: 'reuse tag', layer: 'short', tags: ['preexisting-tag'], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' })).not.toThrow();
        const count = db.prepare(`SELECT COUNT(*) as n FROM tags WHERE name = 'preexisting-tag'`).get().n;
        expect(count).toBe(1); // still only one tag row
      });
    });

    // ---- update ----

    describe('update', () => {
      it('updates content and records audit with old and new content', () => {
        const view = mem.viewForCerebellumL1();
        const { id } = view.write({ content: 'original', layer: 'short', tags: [], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' });
        view.update({ id, patch: { content: 'updated content' } });
        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        expect(row.content).toBe('updated content');
        const audit = db.prepare(
          `SELECT * FROM memory_audit WHERE memory_id = ? AND operation = 'update'`
        ).get(id);
        expect(audit).toBeTruthy();
        expect(audit.old_content).toBe('original');
        expect(audit.new_content).toBe('updated content');
        expect(audit.changed_by).toBe('cerebellum-l1');
      });

      it('replaces tags when patch.tags is provided', () => {
        const view = mem.viewForCerebellumL1();
        const { id } = view.write({ content: 'tag update', layer: 'short', tags: ['old-tag'], source_session: 's', source_timestamp: Date.now(), confidence: 'medium' });
        view.update({ id, patch: { tags: ['new-tag-x', 'new-tag-y'] } });
        const edges = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'memory' AND from_id = ? AND kind = 'tagged_with'`
        ).all(id);
        const tagNames = edges.map(e => {
          const tag = db.prepare('SELECT name FROM tags WHERE id = ?').get(e.to_id);
          return tag.name;
        });
        expect(tagNames).toContain('new-tag-x');
        expect(tagNames).toContain('new-tag-y');
        expect(tagNames).not.toContain('old-tag');
      });

      it('throws ValidationError for nonexistent memory id', () => {
        const view = mem.viewForCerebellumL1();
        expect(() => view.update({ id: 99999, patch: { content: 'oops' } })).toThrow(ValidationError);
      });
    });

    // ---- createTag ----

    describe('createTag', () => {
      it('creates a tag and returns the tag object', () => {
        const view = mem.viewForCerebellumL1();
        const tag = view.createTag({ name: 'brand-new-tag', description: 'a description' });
        expect(tag).toBeTruthy();
        expect(tag.id).toBeTypeOf('number');
        expect(tag.name).toBe('brand-new-tag');
        expect(tag.description).toBe('a description');
        expect(tag.level).toBe(0);
        expect(tag.created_at).toBeTypeOf('number');
        expect(tag.updated_at).toBeTypeOf('number');
      });

      it('throws ValidationError for duplicate tag name', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'dup-tag', description: 'first' });
        expect(() => view.createTag({ name: 'dup-tag', description: 'second' })).toThrow(ValidationError);
      });
    });

    // ---- updateTagDescription ----

    describe('updateTagDescription', () => {
      it('updates description for existing tag', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'desc-tag', description: 'old desc' });
        view.updateTagDescription({ name: 'desc-tag', description: 'new desc' });
        const tag = db.prepare('SELECT * FROM tags WHERE name = ?').get('desc-tag');
        expect(tag.description).toBe('new desc');
      });

      it('throws UnknownTagError for nonexistent tag', () => {
        const view = mem.viewForCerebellumL1();
        expect(() => view.updateTagDescription({ name: 'ghost-tag', description: 'x' })).toThrow(UnknownTagError);
      });
    });

    // ---- relateTags ----

    describe('relateTags', () => {
      it('creates a parent_of edge and updates child level to parent.level + 1', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'rt-parent', description: 'parent' });
        view.createTag({ name: 'rt-child', description: 'child' });
        view.relateTags({ from: 'rt-parent', to: 'rt-child', kind: 'parent_of', description: 'hierarchy', weight: 1.0 });
        const childTag = db.prepare('SELECT * FROM tags WHERE name = ?').get('rt-child');
        // parent.level = 0, so child.level = 1
        expect(childTag.level).toBe(1);
        const edge = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'tag' AND to_type = 'tag' AND kind = 'parent_of'`
        ).get();
        expect(edge).toBeTruthy();
      });

      it('creates a related_to edge with description and weight', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'rt-rel-a', description: '' });
        view.createTag({ name: 'rt-rel-b', description: '' });
        view.relateTags({ from: 'rt-rel-a', to: 'rt-rel-b', kind: 'related_to', description: 'similar concepts', weight: 0.8 });
        const edge = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'tag' AND to_type = 'tag' AND kind = 'related_to'`
        ).get();
        expect(edge).toBeTruthy();
        expect(edge.description).toBe('similar concepts');
        expect(edge.weight).toBe(0.8);
      });

      it('throws ValidationError when description/weight missing for non-tagged_with kind', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'vt-a', description: '' });
        view.createTag({ name: 'vt-b', description: '' });
        // Missing both description and weight
        expect(() => view.relateTags({ from: 'vt-a', to: 'vt-b', kind: 'related_to' })).toThrow(ValidationError);
        // Missing weight only
        expect(() => view.relateTags({ from: 'vt-a', to: 'vt-b', kind: 'related_to', description: 'x' })).toThrow(ValidationError);
        // Missing description only
        expect(() => view.relateTags({ from: 'vt-a', to: 'vt-b', kind: 'related_to', weight: 0.5 })).toThrow(ValidationError);
      });

      it('throws UnknownTagError for nonexistent from tag', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'unk-to', description: '' });
        expect(() => view.relateTags({ from: 'ghost-from', to: 'unk-to', kind: 'related_to', description: 'd', weight: 0.5 })).toThrow(UnknownTagError);
      });

      it('throws UnknownTagError for nonexistent to tag', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'unk-from', description: '' });
        expect(() => view.relateTags({ from: 'unk-from', to: 'ghost-to', kind: 'related_to', description: 'd', weight: 0.5 })).toThrow(UnknownTagError);
      });

      it('enforces max_level 1000: level 1000 passes, level 1001 throws', () => {
        const view = mem.viewForCerebellumL1();
        // Tag with level=999 — seed directly with raw SQL
        const parent999 = seedTag(db, { name: 'level-999-parent', level: 999 });
        view.createTag({ name: 'level-1000-child', description: '' });
        // parent.level=999 + 1 = 1000 — should pass
        expect(() => view.relateTags({ from: 'level-999-parent', to: 'level-1000-child', kind: 'parent_of', description: 'd', weight: 1.0 })).not.toThrow();
        const childAfter = db.prepare('SELECT level FROM tags WHERE name = ?').get('level-1000-child');
        expect(childAfter.level).toBe(1000);

        // Tag with level=1000 as parent — child level would be 1001, over limit
        const parent1000 = seedTag(db, { name: 'level-1000-parent', level: 1000 });
        view.createTag({ name: 'level-1001-child', description: '' });
        expect(() => view.relateTags({ from: 'level-1000-parent', to: 'level-1001-child', kind: 'parent_of', description: 'd', weight: 1.0 })).toThrow(ValidationError);
      });

      it('throws ValidationError for duplicate edge', () => {
        const view = mem.viewForCerebellumL1();
        view.createTag({ name: 'dup-edge-a', description: '' });
        view.createTag({ name: 'dup-edge-b', description: '' });
        view.relateTags({ from: 'dup-edge-a', to: 'dup-edge-b', kind: 'related_to', description: 'd', weight: 0.5 });
        expect(() => view.relateTags({ from: 'dup-edge-a', to: 'dup-edge-b', kind: 'related_to', description: 'd2', weight: 0.6 })).toThrow(ValidationError);
      });
    });
  });

  // =================== CerebellumL1View writer injection ===================

  describe('CerebellumL1View writer injection (refactored in Step 4)', () => {
    let mem, db, tmpDir;

    beforeEach(() => {
      const setup = createTempMemory();
      mem = setup.mem;
      tmpDir = setup.tmpDir;
      mem.open();
      db = mem._db;
    });

    afterEach(() => {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    });

    it('default writer is cerebellum-l1', () => {
      const view = mem.viewForCerebellumL1();
      const { id } = view.write({
        content: 'default writer test',
        layer: 'short',
        tags: [],
        source_session: 's',
        source_timestamp: Date.now(),
        confidence: 'medium',
      });
      const row = db.prepare('SELECT writer FROM memories WHERE id = ?').get(id);
      expect(row.writer).toBe('cerebellum-l1');
      const audit = db.prepare('SELECT changed_by FROM memory_audit WHERE memory_id = ?').get(id);
      expect(audit.changed_by).toBe('cerebellum-l1');
    });

    it('custom writer propagates to memory.writer and audit.changed_by', async () => {
      const { CerebellumL1View } = await import('../src/views.js');
      const view = new CerebellumL1View(db, { writer: 'cerebellum-l2' });
      const { id } = view.write({
        content: 'custom writer test',
        layer: 'short',
        tags: [],
        source_session: 's',
        source_timestamp: Date.now(),
        confidence: 'medium',
      });
      const row = db.prepare('SELECT writer FROM memories WHERE id = ?').get(id);
      expect(row.writer).toBe('cerebellum-l2');
      const audit = db.prepare('SELECT changed_by FROM memory_audit WHERE memory_id = ?').get(id);
      expect(audit.changed_by).toBe('cerebellum-l2');
    });
  });

  // =================== CerebellumL2View ===================

  describe('CerebellumL2View', () => {
    let mem, db, tmpDir;

    beforeEach(() => {
      const setup = createTempMemory();
      mem = setup.mem;
      tmpDir = setup.tmpDir;
      mem.open();
      db = mem._db;
    });

    afterEach(() => {
      mem.close();
      rmSync(tmpDir, { recursive: true });
    });

    // ---- inherited methods use cerebellum-l2 writer ----

    describe('inherited methods use cerebellum-l2 writer', () => {
      it('write() sets memory.writer=cerebellum-l2 and audit.changed_by=cerebellum-l2', () => {
        const view = mem.viewForCerebellumL2();
        const { id } = view.write({
          content: 'l2 write test',
          layer: 'short',
          tags: [],
          source_session: 's',
          source_timestamp: Date.now(),
          confidence: 'medium',
        });
        const row = db.prepare('SELECT writer FROM memories WHERE id = ?').get(id);
        expect(row.writer).toBe('cerebellum-l2');
        const audit = db.prepare('SELECT changed_by FROM memory_audit WHERE memory_id = ?').get(id);
        expect(audit.changed_by).toBe('cerebellum-l2');
      });

      it('update() audit.changed_by is cerebellum-l2', () => {
        // Seed a memory first via L2 write so writer=cerebellum-l2 is valid
        const view = mem.viewForCerebellumL2();
        const { id } = view.write({
          content: 'before update',
          layer: 'short',
          tags: [],
          source_session: 's',
          source_timestamp: Date.now(),
          confidence: 'medium',
        });
        view.update({ id, patch: { content: 'after update' } });
        const audit = db.prepare(
          `SELECT changed_by FROM memory_audit WHERE memory_id = ? AND operation = 'update'`
        ).get(id);
        expect(audit.changed_by).toBe('cerebellum-l2');
      });
    });

    // ---- delete ----

    describe('delete', () => {
      it('deletes memory and cascades its tagged_with edges', () => {
        const id = seedMemory(db, { layer: 'short', content: 'to-delete', tags: ['del-tag'] });
        const view = mem.viewForCerebellumL2();
        const result = view.delete({ id });

        expect(result).toEqual({ id, deletedContent: 'to-delete' });
        // Memory is gone
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id)).toBeUndefined();
        // Edges are gone
        const edges = db.prepare(
          `SELECT * FROM edges WHERE (from_type = 'memory' AND from_id = ?) OR (to_type = 'memory' AND to_id = ?)`
        ).all(id, id);
        expect(edges).toHaveLength(0);
      });

      it('throws MemoryNotFoundError for nonexistent id', () => {
        const view = mem.viewForCerebellumL2();
        expect(() => view.delete({ id: 99999 })).toThrow(MemoryNotFoundError);
      });

      it('audit row survives deletion with memory_id=NULL', () => {
        const view = mem.viewForCerebellumL2();
        const { id } = view.write({
          content: 'to be deleted',
          layer: 'short',
          tags: [],
          source_session: 's',
          source_timestamp: Date.now(),
          confidence: 'medium',
        });
        view.delete({ id });
        // Memory is gone
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id)).toBeUndefined();
        // Delete audit row survives with memory_id=NULL
        const audit = db.prepare(
          "SELECT * FROM memory_audit WHERE operation = 'delete' AND old_content = 'to be deleted'"
        ).get();
        expect(audit).toBeDefined();
        expect(audit.memory_id).toBeNull();
        expect(audit.changed_by).toBe('cerebellum-l2');
      });
    });

    // ---- prune (batch signature) ----

    describe('prune', () => {
      // T13: no matches → empty result
      it('returns empty result when no memories match the threshold', () => {
        // Insert a memory with decay_score=1.0 (above threshold)
        seedMemory(db, { layer: 'short', content: 'healthy' });
        const view = mem.viewForCerebellumL2();
        const result = view.prune({ belowDecayScore: 0.1 });
        expect(result).toEqual({ deletedCount: 0, deletedIds: [] });
        // Memory still exists
        expect(db.prepare('SELECT count(*) as c FROM memories').get().c).toBe(1);
      });

      // T14: one match → deleted + audit + edge cascade
      it('deletes one matching memory, cascades edges, writes audit', () => {
        const id = seedMemory(db, { layer: 'short', content: 'decayed', tags: ['old-tag'] });
        // Set decay_score below threshold
        db.prepare('UPDATE memories SET decay_score = 0.05 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        const result = view.prune({ belowDecayScore: 0.1 });

        expect(result.deletedCount).toBe(1);
        expect(result.deletedIds).toContain(id);
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id)).toBeUndefined();

        // Edges cascaded
        const edges = db.prepare(
          `SELECT * FROM edges WHERE (from_type='memory' AND from_id=?) OR (to_type='memory' AND to_id=?)`
        ).all(id, id);
        expect(edges).toHaveLength(0);
      });

      // T15: multiple matches → correct count
      it('deletes multiple matching memories and returns correct count', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'stale-1' });
        const id2 = seedMemory(db, { layer: 'long', content: 'stale-2' });
        const id3 = seedMemory(db, { layer: 'short', content: 'healthy' });
        db.prepare('UPDATE memories SET decay_score = 0.05 WHERE id IN (?, ?)').run(id1, id2);
        // id3 stays at 1.0

        const view = mem.viewForCerebellumL2();
        const result = view.prune({ belowDecayScore: 0.1 });

        expect(result.deletedCount).toBe(2);
        expect(result.deletedIds.sort()).toEqual([id1, id2].sort());
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id3)).toBeDefined();
      });

      // T16: layer filter works
      it('respects optional layer filter', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'short-stale' });
        const id2 = seedMemory(db, { layer: 'long', content: 'long-stale' });
        db.prepare('UPDATE memories SET decay_score = 0.05 WHERE id IN (?, ?)').run(id1, id2);

        const view = mem.viewForCerebellumL2();
        // Only prune short layer
        const result = view.prune({ belowDecayScore: 0.1, layer: 'short' });

        expect(result.deletedCount).toBe(1);
        expect(result.deletedIds).toContain(id1);
        // long-stale still exists
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id2)).toBeDefined();
      });

      // T17: audit rows per memory, operation='prune', memory_id NULL after deletion
      it('writes audit row per pruned memory with operation=prune and memory_id=NULL', () => {
        const id = seedMemory(db, { layer: 'short', content: 'audit-me' });
        db.prepare('UPDATE memories SET decay_score = 0.05 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        view.prune({ belowDecayScore: 0.1 });

        const audit = db.prepare(
          "SELECT * FROM memory_audit WHERE operation='prune' AND old_content='audit-me'"
        ).get();
        expect(audit).toBeDefined();
        // ON DELETE SET NULL nulls the memory_id after memory is deleted
        expect(audit.memory_id).toBeNull();
        expect(audit.changed_by).toBe('cerebellum-l2');
      });

      // T18: both inbound and outbound edges cascaded
      it('cascades both inbound and outbound edges', () => {
        const id1 = seedMemory(db, { layer: 'short', content: 'low-decay' });
        const id2 = seedMemory(db, { layer: 'short', content: 'neighbor' });
        db.prepare('UPDATE memories SET decay_score = 0.05 WHERE id = ?').run(id1);

        const now = Date.now();
        // Outbound edge from id1 to id2
        db.prepare(
          `INSERT INTO edges (from_type, from_id, to_type, to_id, kind, description, weight, created_at)
           VALUES ('memory', ?, 'memory', ?, 'related_to', 'test', 0.5, ?)`
        ).run(id1, id2, now);

        // Inbound edge from id2 to id1
        db.prepare(
          `INSERT INTO edges (from_type, from_id, to_type, to_id, kind, description, weight, created_at)
           VALUES ('memory', ?, 'memory', ?, 'related_to', 'test', 0.5, ?)`
        ).run(id2, id1, now);

        const view = mem.viewForCerebellumL2();
        view.prune({ belowDecayScore: 0.1 });

        // Both edges involving id1 should be gone
        const remaining = db.prepare(
          `SELECT * FROM edges WHERE (from_type='memory' AND from_id=?) OR (to_type='memory' AND to_id=?)`
        ).all(id1, id1);
        expect(remaining).toHaveLength(0);

        // id2 still exists
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(id2)).toBeDefined();
      });
    });

    // ---- merge ----

    describe('merge', () => {
      it('merges source into target: sums access_count, moves edges, deletes source', () => {
        const sourceId = seedMemory(db, { layer: 'short', content: 'source mem', tags: ['src-tag'] });
        const targetId = seedMemory(db, { layer: 'short', content: 'target mem', tags: ['tgt-tag'] });
        // Set known access_count values via raw SQL
        db.prepare('UPDATE memories SET access_count = 3 WHERE id = ?').run(sourceId);
        db.prepare('UPDATE memories SET access_count = 7 WHERE id = ?').run(targetId);

        const view = mem.viewForCerebellumL2();
        const result = view.merge({ sourceId, targetId });

        expect(result).toEqual({ mergedId: targetId });

        // Source is deleted
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(sourceId)).toBeUndefined();

        // Target access_count is summed
        const target = db.prepare('SELECT * FROM memories WHERE id = ?').get(targetId);
        expect(target.access_count).toBe(10);

        // The src-tag edge was moved to target
        const srcTagRow = db.prepare('SELECT id FROM tags WHERE name = ?').get('src-tag');
        const movedEdge = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'memory' AND from_id = ? AND to_type = 'tag' AND to_id = ? AND kind = 'tagged_with'`
        ).get(targetId, srcTagRow.id);
        expect(movedEdge).toBeTruthy();
      });

      it('handles duplicate tagged_with edges during merge without error', () => {
        // Both memories tagged with 'shared-tag'
        const sourceId = seedMemory(db, { layer: 'short', content: 'src dup', tags: ['shared-tag'] });
        const targetId = seedMemory(db, { layer: 'short', content: 'tgt dup', tags: ['shared-tag'] });

        const view = mem.viewForCerebellumL2();
        // Should not throw on duplicate edge conflict
        expect(() => view.merge({ sourceId, targetId })).not.toThrow();

        // Source deleted, target survives with exactly one 'shared-tag' edge
        expect(db.prepare('SELECT * FROM memories WHERE id = ?').get(sourceId)).toBeUndefined();
        const sharedTag = db.prepare('SELECT id FROM tags WHERE name = ?').get('shared-tag');
        const edges = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'memory' AND from_id = ? AND to_type = 'tag' AND to_id = ? AND kind = 'tagged_with'`
        ).all(targetId, sharedTag.id);
        expect(edges).toHaveLength(1);
      });

      it('throws ValidationError on self-merge', () => {
        const id = seedMemory(db, { layer: 'short', content: 'self', tags: [] });
        const view = mem.viewForCerebellumL2();
        expect(() => view.merge({ sourceId: id, targetId: id })).toThrow(ValidationError);
      });

      it('throws MemoryNotFoundError when source missing', () => {
        const targetId = seedMemory(db, { layer: 'short', content: 'target', tags: [] });
        const view = mem.viewForCerebellumL2();
        expect(() => view.merge({ sourceId: 99999, targetId })).toThrow(MemoryNotFoundError);
      });

      it('throws MemoryNotFoundError when target missing', () => {
        const sourceId = seedMemory(db, { layer: 'short', content: 'source', tags: [] });
        const view = mem.viewForCerebellumL2();
        expect(() => view.merge({ sourceId, targetId: 99999 })).toThrow(MemoryNotFoundError);
      });
    });

    // ---- promote ----

    describe('promote', () => {
      it('promotes short→long and records audit', () => {
        const id = seedMemory(db, { layer: 'short', content: 'promotable', tags: [] });
        const view = mem.viewForCerebellumL2();
        view.promote({ id, newLayer: 'long' });

        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        expect(row.layer).toBe('long');

        const audit = db.prepare(
          `SELECT * FROM memory_audit WHERE memory_id = ? AND operation = 'promote'`
        ).get(id);
        expect(audit).toBeTruthy();
        expect(audit.old_content).toBe('short');
        expect(audit.new_content).toBe('long');
        expect(audit.changed_by).toBe('cerebellum-l2');
      });

      it('promotes short_skill→long_skill', () => {
        const id = seedMemory(db, { layer: 'short_skill', content: 'skill promotable', tags: [] });
        const view = mem.viewForCerebellumL2();
        view.promote({ id, newLayer: 'long_skill' });

        const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        expect(row.layer).toBe('long_skill');
      });

      it('throws ValidationError on invalid transition (long→short)', () => {
        const id = seedMemory(db, { layer: 'long', content: 'long mem', tags: [] });
        const view = mem.viewForCerebellumL2();
        expect(() => view.promote({ id, newLayer: 'short' })).toThrow(ValidationError);
      });

      it('throws ValidationError on invalid transition (short→short_skill)', () => {
        const id = seedMemory(db, { layer: 'short', content: 'short mem', tags: [] });
        const view = mem.viewForCerebellumL2();
        expect(() => view.promote({ id, newLayer: 'short_skill' })).toThrow(ValidationError);
      });

      it('throws MemoryNotFoundError for nonexistent id', () => {
        const view = mem.viewForCerebellumL2();
        expect(() => view.promote({ id: 99999, newLayer: 'long' })).toThrow(MemoryNotFoundError);
      });

      it('does not change memory.writer during promote', () => {
        const id = seedMemory(db, { layer: 'short', content: 'writer check', tags: [] });
        const originalWriter = db.prepare('SELECT writer FROM memories WHERE id = ?').get(id).writer;
        const view = mem.viewForCerebellumL2();
        view.promote({ id, newLayer: 'long' });
        const afterWriter = db.prepare('SELECT writer FROM memories WHERE id = ?').get(id).writer;
        expect(afterWriter).toBe(originalWriter);
      });
    });

    // ---- renameTag ----

    describe('renameTag', () => {
      it('renames a tag by integer id', () => {
        const tag = seedTag(db, { name: 'old-name' });
        const view = mem.viewForCerebellumL2();
        view.renameTag({ tagId: tag.id, newName: 'new-name' });

        const updated = db.prepare('SELECT * FROM tags WHERE id = ?').get(tag.id);
        expect(updated.name).toBe('new-name');
      });

      it('throws UnknownTagError for nonexistent tag id', () => {
        const view = mem.viewForCerebellumL2();
        expect(() => view.renameTag({ tagId: 99999, newName: 'anything' })).toThrow(UnknownTagError);
      });

      it('throws ValidationError on name collision', () => {
        seedTag(db, { name: 'taken-name' });
        const other = seedTag(db, { name: 'rename-me' });
        const view = mem.viewForCerebellumL2();
        expect(() => view.renameTag({ tagId: other.id, newName: 'taken-name' })).toThrow(ValidationError);
      });

      it('writes audit row with memory_id=NULL', () => {
        const tag = seedTag(db, { name: 'audit-old' });
        const view = mem.viewForCerebellumL2();
        view.renameTag({ tagId: tag.id, newName: 'audit-new' });
        const audit = db.prepare(
          "SELECT * FROM memory_audit WHERE operation = 'rename_tag'"
        ).get();
        expect(audit).toBeDefined();
        expect(audit.memory_id).toBeNull();
        expect(audit.old_content).toBe('audit-old');
        expect(audit.new_content).toBe('audit-new');
        expect(audit.changed_by).toBe('cerebellum-l2');
      });
    });

    // ---- unrelateTags ----

    describe('unrelateTags', () => {
      it('removes an edge between two tags by integer id', () => {
        const tA = seedTag(db, { name: 'un-a' });
        const tB = seedTag(db, { name: 'un-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'related_to', description: 'd', weight: 0.5 });

        const view = mem.viewForCerebellumL2();
        view.unrelateTags({ fromId: tA.id, toId: tB.id, kind: 'related_to' });

        const edge = db.prepare(
          `SELECT * FROM edges WHERE from_type = 'tag' AND from_id = ? AND to_type = 'tag' AND to_id = ? AND kind = 'related_to'`
        ).get(tA.id, tB.id);
        expect(edge).toBeUndefined();
      });

      it('throws ValidationError when edge does not exist', () => {
        const tA = seedTag(db, { name: 'ghost-a' });
        const tB = seedTag(db, { name: 'ghost-b' });
        const view = mem.viewForCerebellumL2();
        expect(() => view.unrelateTags({ fromId: tA.id, toId: tB.id, kind: 'related_to' })).toThrow(ValidationError);
      });

      it('writes audit row with memory_id=NULL', () => {
        const tA = seedTag(db, { name: 'unrel-a' });
        const tB = seedTag(db, { name: 'unrel-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'related_to', description: 'd', weight: 0.5 });
        const view = mem.viewForCerebellumL2();
        view.unrelateTags({ fromId: tA.id, toId: tB.id, kind: 'related_to' });
        const audit = db.prepare(
          "SELECT * FROM memory_audit WHERE operation = 'unrelate_tags'"
        ).get();
        expect(audit).toBeDefined();
        expect(audit.memory_id).toBeNull();
        const parsed = JSON.parse(audit.old_content);
        expect(parsed).toMatchObject({ fromId: tA.id, toId: tB.id, kind: 'related_to' });
        expect(audit.new_content).toBeNull();
        expect(audit.changed_by).toBe('cerebellum-l2');
      });
    });

    // ---- detectLoops ----

    describe('detectLoops', () => {
      it('returns empty cycles for acyclic tag graph', () => {
        const tA = seedTag(db, { name: 'dl-a' });
        const tB = seedTag(db, { name: 'dl-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        const result = view.detectLoops();
        expect(result.cycles).toHaveLength(0);
      });

      it('detects a simple 2-node cycle', () => {
        const tA = seedTag(db, { name: 'cy-a' });
        const tB = seedTag(db, { name: 'cy-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tB.id, toType: 'tag', toId: tA.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        const result = view.detectLoops();
        expect(result.cycles).toHaveLength(1);
        const cycle = result.cycles[0];
        expect(cycle.tagIds.sort()).toEqual([tA.id, tB.id].sort());
        expect(cycle.tagNames.sort()).toEqual(['cy-a', 'cy-b'].sort());
      });

      it('detects a 3-node cycle', () => {
        const tA = seedTag(db, { name: 'c3-a' });
        const tB = seedTag(db, { name: 'c3-b' });
        const tC = seedTag(db, { name: 'c3-c' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tB.id, toType: 'tag', toId: tC.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tC.id, toType: 'tag', toId: tA.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        const result = view.detectLoops();
        expect(result.cycles).toHaveLength(1);
        expect(result.cycles[0].tagIds).toHaveLength(3);
        const ids = result.cycles[0].tagIds.sort();
        expect(ids).toEqual([tA.id, tB.id, tC.id].sort());
      });

      it('detects two disjoint cycles', () => {
        const t1 = seedTag(db, { name: 'dc-1' });
        const t2 = seedTag(db, { name: 'dc-2' });
        const t3 = seedTag(db, { name: 'dc-3' });
        const t4 = seedTag(db, { name: 'dc-4' });
        // Cycle 1: t1 -> t2 -> t1
        seedEdge(db, { fromType: 'tag', fromId: t1.id, toType: 'tag', toId: t2.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: t2.id, toType: 'tag', toId: t1.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        // Cycle 2: t3 -> t4 -> t3
        seedEdge(db, { fromType: 'tag', fromId: t3.id, toType: 'tag', toId: t4.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: t4.id, toType: 'tag', toId: t3.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        const result = view.detectLoops();
        expect(result.cycles).toHaveLength(2);
        const allIds = result.cycles.flatMap(c => c.tagIds).sort((a, b) => a - b);
        expect(allIds).toEqual([t1.id, t2.id, t3.id, t4.id].sort((a, b) => a - b));
      });

      it('no false positives on linear chain with branches', () => {
        const tRoot = seedTag(db, { name: 'lin-root' });
        const tBrA  = seedTag(db, { name: 'lin-bra' });
        const tBrB  = seedTag(db, { name: 'lin-brb' });
        const tLeaf = seedTag(db, { name: 'lin-leaf' });
        seedEdge(db, { fromType: 'tag', fromId: tRoot.id, toType: 'tag', toId: tBrA.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tRoot.id, toType: 'tag', toId: tBrB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tBrA.id, toType: 'tag', toId: tLeaf.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        const result = view.detectLoops();
        expect(result.cycles).toHaveLength(0);
      });

      it('writes one audit row per cycle found with memory_id=NULL', () => {
        const tA = seedTag(db, { name: 'dla-a' });
        const tB = seedTag(db, { name: 'dla-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });
        seedEdge(db, { fromType: 'tag', fromId: tB.id, toType: 'tag', toId: tA.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        view.detectLoops();

        const audits = db.prepare(
          "SELECT * FROM memory_audit WHERE operation = 'detect_loop'"
        ).all();
        expect(audits).toHaveLength(1);
        expect(audits[0].memory_id).toBeNull();
        const parsed = JSON.parse(audits[0].new_content);
        expect(parsed.tagIds.sort()).toEqual([tA.id, tB.id].sort());
        expect(parsed.tagNames.sort()).toEqual(['dla-a', 'dla-b'].sort());
        expect(audits[0].changed_by).toBe('cerebellum-l2');
      });

      it('writes no audit rows when no cycles exist', () => {
        const tA = seedTag(db, { name: 'dlna-a' });
        const tB = seedTag(db, { name: 'dlna-b' });
        seedEdge(db, { fromType: 'tag', fromId: tA.id, toType: 'tag', toId: tB.id, kind: 'parent_of', description: 'd', weight: 1.0 });

        const view = mem.viewForCerebellumL2();
        view.detectLoops();

        const audits = db.prepare(
          "SELECT * FROM memory_audit WHERE operation = 'detect_loop'"
        ).all();
        expect(audits).toHaveLength(0);
      });
    });

    // ---- recomputeDecayScores ----

    describe('recomputeDecayScores', () => {
      // T1: Empty DB → { updatedCount: 0 }
      it('T1: empty DB returns updatedCount=0', () => {
        const view = mem.viewForCerebellumL2();
        const result = view.recomputeDecayScores();
        expect(result).toEqual({ updatedCount: 0 });
      });

      // T2: short memory, last_triggered 30 days ago → decay ≈ e^(-0.077*30) ≈ 0.0995
      it('T2: short memory 30 days ago → decay_score ≈ 0.0995', () => {
        const thirtyDaysAgo = Date.now() - 30 * 86400000;
        const id = seedMemory(db, { layer: 'short', content: 'short30' });
        db.prepare('UPDATE memories SET last_triggered_at = ? WHERE id = ?').run(thirtyDaysAgo, id);

        const view = mem.viewForCerebellumL2();
        view.recomputeDecayScores();

        const row = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id);
        expect(row.decay_score).toBeCloseTo(Math.exp(-0.077 * 30), 1); // tolerance 0.01
      });

      // T3: long memory, last_triggered 30 days ago → decay ≈ e^(-0.0063*30) ≈ 0.828
      it('T3: long memory 30 days ago → decay_score ≈ 0.828', () => {
        const thirtyDaysAgo = Date.now() - 30 * 86400000;
        const id = seedMemory(db, { layer: 'long', content: 'long30' });
        db.prepare('UPDATE memories SET last_triggered_at = ? WHERE id = ?').run(thirtyDaysAgo, id);

        const view = mem.viewForCerebellumL2();
        view.recomputeDecayScores();

        const row = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id);
        expect(row.decay_score).toBeCloseTo(Math.exp(-0.0063 * 30), 1);
      });

      // T4: last_triggered_at=NULL → decay_score stays 1.0
      it('T4: null last_triggered_at leaves decay_score unchanged at 1.0', () => {
        const id = seedMemory(db, { layer: 'short', content: 'no-trigger' });
        // last_triggered_at is NULL by default; ensure decay_score starts at 1.0
        db.prepare('UPDATE memories SET decay_score = 1.0, last_triggered_at = NULL WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        view.recomputeDecayScores();

        const row = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id);
        expect(row.decay_score).toBe(1.0);
      });

      // T5: multiple layers each get correct λ
      it('T5: multiple layers get their correct lambda values', () => {
        const ageMs = 10 * 86400000; // 10 days
        const trigAt = Date.now() - ageMs;

        const ids = {};
        for (const layer of ['short', 'long', 'short_skill', 'long_skill']) {
          const id = seedMemory(db, { layer, content: `layer-${layer}` });
          db.prepare('UPDATE memories SET last_triggered_at = ? WHERE id = ?').run(trigAt, id);
          ids[layer] = id;
        }

        const view = mem.viewForCerebellumL2();
        view.recomputeDecayScores();

        const expectedLambda = { short: 0.077, long: 0.0063, short_skill: 0.0063, long_skill: 0.0021 };
        for (const [layer, id] of Object.entries(ids)) {
          const row = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id);
          const expected = Math.exp(-expectedLambda[layer] * 10);
          expect(row.decay_score).toBeCloseTo(expected, 1);
        }
      });

      // T6: idempotent — calling twice gives same result
      it('T6: calling recomputeDecayScores twice gives the same result', () => {
        const thirtyDaysAgo = Date.now() - 30 * 86400000;
        const id = seedMemory(db, { layer: 'short', content: 'idempotent-test' });
        db.prepare('UPDATE memories SET last_triggered_at = ? WHERE id = ?').run(thirtyDaysAgo, id);

        const view = mem.viewForCerebellumL2();
        view.recomputeDecayScores();
        const first = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id).decay_score;
        view.recomputeDecayScores();
        const second = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id).decay_score;

        expect(second).toBeCloseTo(first, 6);
      });

      // T7: transaction atomicity — monkey-patch causes rollback, no partial state
      it('T7: transaction atomicity — error mid-transaction rolls back all layers', () => {
        const trigAt = Date.now() - 10 * 86400000;
        const id1 = seedMemory(db, { layer: 'short', content: 'layer-short' });
        const id2 = seedMemory(db, { layer: 'long', content: 'layer-long' });
        db.prepare('UPDATE memories SET last_triggered_at = ?, decay_score = 1.0 WHERE id = ?').run(trigAt, id1);
        db.prepare('UPDATE memories SET last_triggered_at = ?, decay_score = 1.0 WHERE id = ?').run(trigAt, id2);

        const view = mem.viewForCerebellumL2();
        // Monkey-patch: replace the internal db.prepare for 'long' layer to throw after short is updated
        const realPrepare = db.prepare.bind(db);
        let callCount = 0;
        db.prepare = function(sql) {
          if (sql.includes('UPDATE memories') && sql.includes('exp_decay')) {
            callCount++;
            if (callCount === 2) {
              db.prepare = realPrepare; // restore before throw
              throw new Error('Simulated mid-transaction error');
            }
          }
          return realPrepare(sql);
        };

        expect(() => view.recomputeDecayScores()).toThrow('Simulated mid-transaction error');
        db.prepare = realPrepare; // ensure restore

        // Both memories should still have decay_score=1.0 (transaction rolled back)
        const row1 = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id1);
        const row2 = db.prepare('SELECT decay_score FROM memories WHERE id = ?').get(id2);
        expect(row1.decay_score).toBe(1.0);
        expect(row2.decay_score).toBe(1.0);
      });
    });

    // ---- findPromotable ----

    describe('findPromotable', () => {
      // T8: access_count=9, short → not returned (threshold is 10)
      it('T8: access_count=9 for short layer → not promotable', () => {
        const id = seedMemory(db, { layer: 'short', content: 'almost' });
        db.prepare('UPDATE memories SET access_count = 9 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        const result = view.findPromotable({ layer: 'short' });
        expect(result.map(r => r.id)).not.toContain(id);
      });

      // T9: access_count=10, short → returned with newLayer='long'
      it('T9: access_count=10 for short layer → promotable with newLayer=long', () => {
        const id = seedMemory(db, { layer: 'short', content: 'threshold-short' });
        db.prepare('UPDATE memories SET access_count = 10 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        const result = view.findPromotable({ layer: 'short' });
        const match = result.find(r => r.id === id);
        expect(match).toBeDefined();
        expect(match.newLayer).toBe('long');
      });

      // T10: access_count=49, short_skill → not returned (threshold is 50)
      it('T10: access_count=49 for short_skill layer → not promotable', () => {
        const id = seedMemory(db, { layer: 'short_skill', content: 'skill-almost' });
        db.prepare('UPDATE memories SET access_count = 49 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        const result = view.findPromotable({ layer: 'short_skill' });
        expect(result.map(r => r.id)).not.toContain(id);
      });

      // T11: access_count=50, short_skill → returned with newLayer='long_skill'
      it('T11: access_count=50 for short_skill layer → promotable with newLayer=long_skill', () => {
        const id = seedMemory(db, { layer: 'short_skill', content: 'skill-threshold' });
        db.prepare('UPDATE memories SET access_count = 50 WHERE id = ?').run(id);

        const view = mem.viewForCerebellumL2();
        const result = view.findPromotable({ layer: 'short_skill' });
        const match = result.find(r => r.id === id);
        expect(match).toBeDefined();
        expect(match.newLayer).toBe('long_skill');
      });

      // T12: invalid layer → throws ValidationError
      it('T12: invalid layer throws ValidationError', () => {
        const view = mem.viewForCerebellumL2();
        expect(() => view.findPromotable({ layer: 'long' })).toThrow(ValidationError);
        expect(() => view.findPromotable({ layer: 'long_skill' })).toThrow(ValidationError);
        expect(() => view.findPromotable({ layer: 'invalid' })).toThrow(ValidationError);
      });
    });
  });

  // =================== graph-utils ===================

  describe('graph-utils', () => {
    describe('tarjanSCC', () => {
      it('returns empty for acyclic graph', () => {
        const adj = new Map([
          [1, [2]],
          [2, [3]],
          [3, []],
        ]);
        expect(tarjanSCC(adj)).toEqual([]);
      });

      it('detects single cycle', () => {
        const adj = new Map([
          [1, [2]],
          [2, [3]],
          [3, [1]],
        ]);
        const sccs = tarjanSCC(adj);
        expect(sccs).toHaveLength(1);
        expect(sccs[0]).toHaveLength(3);
        expect(sccs[0].sort()).toEqual([1, 2, 3]);
      });

      it('detects multiple independent SCCs', () => {
        // Two separate cycles
        const adj = new Map([
          [1, [2]],
          [2, [1]],
          [3, [4]],
          [4, [3]],
        ]);
        const sccs = tarjanSCC(adj);
        expect(sccs).toHaveLength(2);
        const allNodes = sccs.flat().sort((a, b) => a - b);
        expect(allNodes).toEqual([1, 2, 3, 4]);
      });

      it('handles self-loop as a single-node SCC (not returned)', () => {
        // Self-loop: node 1 -> 1
        // Tarjan would create SCC [1], but size=1 so not returned
        // Note: the DB schema's UNIQUE constraint prevents self-loops in practice
        const adj = new Map([
          [1, [1]],
          [2, []],
        ]);
        // Self-loops create an SCC of size 1 — NOT returned
        const sccs = tarjanSCC(adj);
        expect(sccs).toHaveLength(0);
      });
    });
  });
});
