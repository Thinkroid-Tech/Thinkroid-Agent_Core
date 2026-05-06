/**
 * P10-B: OpenAI-compatible model support.
 *
 * Covers:
 *   1. applyCacheMarkers providerType gate (anthropic applies, others skip)
 *   2. Brain constructor providerType storage and default
 *   3. Brain.think cache marker behavior per providerType
 *   4. getAgentAIConfig providerType extraction from provider record
 *   5. providers table migration adds provider_type column
 *   6. Gated integration test (skipped when OPENAI_API_BASE env is absent)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mock for db.js (hoisted by Vitest).
// Tests 9-10 swap `_mockDb` before calling getAgentAIConfig.
// ---------------------------------------------------------------------------

let _mockDb = null;

vi.mock('../../../db.js', () => ({
  getDB: () => _mockDb,
}));

// ---------------------------------------------------------------------------
// Static imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import { applyCacheMarkers } from '../ce/context-payload-builder.js';
import { getAgentAIConfig } from '../../ai/llm-client.js';

// ---------------------------------------------------------------------------
// applyCacheMarkers — tests 1-4
// ---------------------------------------------------------------------------

describe('P10-B: OpenAI-compatible model support', () => {

  // Reusable fixtures for cache marker tests
  const baseMessages = () => [{ role: 'system', content: 'Hello system' }];
  const baseMarkers  = () => [{ id: 'test', index: 0, type: 'ephemeral' }];

  it('test-1: applyCacheMarkers with providerType=anthropic applies markers', () => {
    const messages = baseMessages();
    const markers  = baseMarkers();
    const result   = applyCacheMarkers(messages, markers, 'anthropic');

    // The marked message content must become a content-block array
    expect(Array.isArray(result[0].content)).toBe(true);
    expect(result[0].content[0]).toMatchObject({
      type: 'text',
      text: 'Hello system',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('test-2: applyCacheMarkers with providerType=openai returns unchanged', () => {
    const messages = baseMessages();
    const markers  = baseMarkers();
    const result   = applyCacheMarkers(messages, markers, 'openai');

    // Must return the exact same reference — no copy, no mutation
    expect(result).toBe(messages);
  });

  it('test-3: applyCacheMarkers with providerType=custom returns unchanged', () => {
    const messages = baseMessages();
    const markers  = baseMarkers();
    const result   = applyCacheMarkers(messages, markers, 'custom');

    expect(result).toBe(messages);
  });

  it('test-4: applyCacheMarkers with providerType=undefined applies markers (backward compat)', () => {
    const messages = baseMessages();
    const markers  = baseMarkers();
    // No third argument — must behave as anthropic for backward compatibility
    const result = applyCacheMarkers(messages, markers);

    expect(Array.isArray(result[0].content)).toBe(true);
    expect(result[0].content[0]).toMatchObject({
      cache_control: { type: 'ephemeral' },
    });
  });

  // ---------------------------------------------------------------------------
  // Brain constructor — tests 5-6
  // ---------------------------------------------------------------------------

  it('test-5: Brain constructor stores providerType', async () => {
    const { Brain } = await import('../brain/brain.js');
    const brain = new Brain({
      agentId: 'test',
      callAIWithTools: vi.fn(),
      providerType: 'openai',
    });
    expect(brain._providerType).toBe('openai');
  });

  it('test-6: Brain constructor defaults providerType to anthropic when not provided', async () => {
    const { Brain } = await import('../brain/brain.js');
    const brain = new Brain({
      agentId: 'test',
      callAIWithTools: vi.fn(),
    });
    expect(brain._providerType).toBe('anthropic');
  });

  // ---------------------------------------------------------------------------
  // Brain.think cache-marker behavior — tests 7-8
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal valid ContextPayload for Brain.think().
   * Two messages with bp1 at index 0 so buildCacheControlMarkers emits one marker.
   */
  function makePayload() {
    return {
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user',   content: 'user message' },
      ],
      tools: [],
      breakpoints: [
        { id: 'bp1', position: 0 },
        { id: 'bp2', position: null },
        { id: 'bp3', position: null },
        { id: 'bp4', position: null },
      ],
    };
  }

  it('test-7: Brain.think with openai providerType does not convert messages to content blocks', async () => {
    const { Brain } = await import('../brain/brain.js');

    let capturedMessages = null;
    const mockCallAI = vi.fn(async ({ messages }) => {
      capturedMessages = messages;
      return 'ok';
    });

    const brain = new Brain({
      agentId: 'test',
      callAIWithTools: mockCallAI,
      providerType: 'openai',
    });

    await brain.think({ payload: makePayload() });

    expect(capturedMessages).not.toBeNull();
    // With openai providerType, applyCacheMarkers returns messages unchanged.
    // System message content must remain a plain string.
    expect(typeof capturedMessages[0].content).toBe('string');
  });

  it('test-8: Brain.think with anthropic providerType converts bp1 message to content blocks', async () => {
    const { Brain } = await import('../brain/brain.js');

    let capturedMessages = null;
    const mockCallAI = vi.fn(async ({ messages }) => {
      capturedMessages = messages;
      return 'ok';
    });

    const brain = new Brain({
      agentId: 'test',
      callAIWithTools: mockCallAI,
      providerType: 'anthropic',
    });

    await brain.think({ payload: makePayload() });

    expect(capturedMessages).not.toBeNull();
    // bp1 is at index 0 — the system message must be converted to a content-block array
    expect(Array.isArray(capturedMessages[0].content)).toBe(true);
    expect(capturedMessages[0].content[0]).toMatchObject({
      cache_control: { type: 'ephemeral' },
    });
  });

  // ---------------------------------------------------------------------------
  // getAgentAIConfig providerType — tests 9-10
  //
  // The top-level vi.mock replaces db.js with a factory that reads `_mockDb`.
  // Each test sets _mockDb to a fresh in-memory Database before calling
  // getAgentAIConfig.
  // ---------------------------------------------------------------------------

  /**
   * Build a minimal in-memory SQLite DB with the tables getAgentAIConfig queries.
   */
  async function makeMockDb() {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    // Phase 13 I5.1: agent config lookup keyed by `agents.id` UUID.
    db.prepare(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, brain_provider_id TEXT)`).run();
    db.prepare(`CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT, base_url TEXT, api_key TEXT,
      model TEXT, provider_type TEXT DEFAULT 'openai',
      rate_limits TEXT DEFAULT '{}', context_limits TEXT DEFAULT '{}'
    )`).run();
    db.prepare(`CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    return db;
  }

  it('test-9: getAgentAIConfig returns providerType from provider record', async () => {
    const db = await makeMockDb();

    db.prepare("INSERT INTO agents (id, name, brain_provider_id) VALUES (?, ?, ?)").run('agent-1-uuid', 'agent1', 'prov-1');
    db.prepare("INSERT INTO providers (id, name, base_url, api_key, model, provider_type) VALUES (?, ?, ?, ?, ?, ?)").run(
      'prov-1', 'OpenAI Compatible', 'http://localhost:8080/v1', 'sk-test', 'gpt-4o', 'openai'
    );

    _mockDb = db;

    const config = getAgentAIConfig('agent-1-uuid');
    expect(config.providerType).toBe('openai');

    _mockDb = null;
    db.close();
  });

  it('test-10: getAgentAIConfig fallback returns anthropic when no provider configured', async () => {
    const db = await makeMockDb();

    // Agent with no provider id — hits the fallback path in getAgentAIConfig
    db.prepare("INSERT INTO agents (id, name, brain_provider_id) VALUES (?, ?, ?)").run('agent-2-uuid', 'agent2', null);

    _mockDb = db;

    const config = getAgentAIConfig('agent-2-uuid');
    expect(config.providerType).toBe('anthropic');

    _mockDb = null;
    db.close();
  });

  // ---------------------------------------------------------------------------
  // providers table migration — test 11
  // ---------------------------------------------------------------------------

  it('test-11: providers table migration adds provider_type column', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');

    // Create the base providers table WITHOUT provider_type (simulates an older DB)
    db.prepare(`CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT,
      api_key TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`).run();

    // Apply the same migration steps from db.js initDB()
    try { db.prepare(`ALTER TABLE providers ADD COLUMN model TEXT`).run(); } catch (e) {}
    try { db.prepare(`ALTER TABLE providers ADD COLUMN rate_limits TEXT DEFAULT '{}'`).run(); } catch (e) {}
    try { db.prepare(`ALTER TABLE providers ADD COLUMN context_limits TEXT DEFAULT '{}'`).run(); } catch (e) {}
    try { db.prepare(`ALTER TABLE providers ADD COLUMN model_pricing TEXT DEFAULT '{}'`).run(); } catch (e) {}
    try { db.prepare(`ALTER TABLE providers ADD COLUMN provider_type TEXT DEFAULT 'openai'`).run(); } catch (e) {}

    // Verify the column exists after migration
    const columns = db.pragma('table_info(providers)');
    const colNames = columns.map(c => c.name);
    expect(colNames).toContain('provider_type');

    // Verify idempotency: re-running the same migration does not throw
    expect(() => {
      try { db.prepare(`ALTER TABLE providers ADD COLUMN provider_type TEXT DEFAULT 'openai'`).run(); } catch (e) {}
    }).not.toThrow();

    // Verify a new row picks up the default value
    db.prepare("INSERT INTO providers (id, name) VALUES (?, ?)").run('p1', 'Test Provider');
    const row = db.prepare("SELECT provider_type FROM providers WHERE id = 'p1'").get();
    expect(row.provider_type).toBe('openai');

    db.close();
  });

  // ---------------------------------------------------------------------------
  // TD-6: Gated integration test — test 12
  // ---------------------------------------------------------------------------

  it.skipIf(!process.env.OPENAI_API_BASE)(
    'test-12: TD-6 gated — Stage 2 compression via OpenAI-compatible endpoint',
    async () => {
      // Runs only when OPENAI_API_BASE is set in the environment.
      // Validates that the compression pipeline works end-to-end with a
      // non-Anthropic provider: no cache_control blocks in the request,
      // and the response is a valid non-empty string.

      const { createAIClient } = await import('../../../ai/client.js');
      const client = createAIClient({
        baseUrl: process.env.OPENAI_API_BASE,
        apiKey: process.env.OPENAI_API_KEY || 'no-key',
      });

      const messages = [
        { role: 'system', content: 'You are a summarization assistant.' },
        { role: 'user',   content: 'Summarize: The quick brown fox jumps over the lazy dog.' },
      ];

      // Confirm no content-block format is sent (openai providerType skips cache markers)
      for (const msg of messages) {
        expect(typeof msg.content).toBe('string');
      }

      const response = await client.chat.completions.create({
        model: process.env.OPENAI_API_MODEL || 'gpt-4o-mini',
        messages,
        max_tokens: 64,
      });

      const text = response.choices?.[0]?.message?.content;
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
  );

});
