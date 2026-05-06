/**
 * P10-A TD-5: sceneId call-site structural verification.
 *
 * This is a structural test — no production code changes are made.
 *
 * Test 1: Verify that every call site in src/ that invokes receiveEvent()
 *   passes a sceneId in the options object.
 *
 * Test 2: Verify ContextEngine.handleEvent accepts any non-empty sceneId string
 *   (scene-ID semantics are a Space-side concern post-P11; agent-core is neutral).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ContextEngine } from '../ce/context-engine.js';

// Derive __dirname for this ES module file
const __filename = fileURLToPath(import.meta.url);
const __dirname_test = dirname(__filename);

// src/ is 3 levels up from __tests__/
// __tests__/ -> agent-core/ -> services/ -> src/
const SRC_ROOT = join(__dirname_test, '..', '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .js file paths under a directory,
 * excluding __tests__ subdirectories (which contain test-only call patterns).
 * @param {string} dir
 * @returns {string[]}
 */
function walkJs(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walkJs(full));
    } else if (entry.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Strip single-line // comments from a source line.
 * Handles the common case; precise enough for call-site detection.
 * @param {string} line
 * @returns {string}
 */
function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * Extract all receiveEvent call-site snippets from source code.
 *
 * Identifies lines with `.receiveEvent(` (excluding the method definition),
 * then captures an 8-line window to cover the multi-line options argument.
 *
 * @param {string} source
 * @returns {Array<{ lineNumber: number, context: string }>}
 */
function extractReceiveEventCallSites(source) {
  const lines = source.split('\n');
  const callSites = [];
  for (let i = 0; i < lines.length; i++) {
    const codeLine = stripLineComment(lines[i]);
    if (!codeLine.includes('.receiveEvent(')) continue;
    // Skip the method definition itself
    if (/async\s+receiveEvent\s*\(/.test(codeLine)) continue;
    const window = lines.slice(i, Math.min(i + 8, lines.length)).join('\n');
    callSites.push({ lineNumber: i + 1, context: window });
  }
  return callSites;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SG-5 TD-5: sceneId call-site verification', () => {

  it('test-1: all receiveEvent() call sites in src/ pass sceneId in the options argument', () => {
    const allJsFiles = walkJs(SRC_ROOT);
    const violations = [];

    for (const filePath of allJsFiles) {
      const source = readFileSync(filePath, 'utf8');
      if (!source.includes('.receiveEvent(')) continue;

      const callSites = extractReceiveEventCallSites(source);
      for (const { lineNumber, context } of callSites) {
        if (!context.includes('sceneId')) {
          violations.push(
            `${filePath}:${lineNumber} — missing sceneId\n  > ${context.split('\n')[0].trim()}`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('test-2: ContextEngine.handleEvent rejects empty sceneId and accepts any non-empty string', async () => {
    // P11 Tier A: scene-ID semantics are a Space-side concern; agent-core only
    // enforces that sceneId is a non-empty string. The hardcoded VALID_SCENE_IDS
    // allowlist has been removed.
    expect(ContextEngine.VALID_SCENE_IDS).toBeUndefined();

    // Minimal stubs to construct a ContextEngine instance.
    const noop = () => {};
    const asyncNoop = async () => '';
    const ce = new ContextEngine({
      agentId: 'test-agent',
      ceAccessView: { search: () => [], touchAccess: noop, getById: () => null },
      metaStore: { list: () => [], create: noop, update: noop, get: () => null },
      historyStore: { list: () => [], append: noop },
      ceChannel: asyncNoop,
      buildSystemPrompt: () => '',
      getToolsForAgent: () => [],
      // Fix B-4: agentManager required — stub with empty personality.
      agentManager: { getPersonality: async () => '' },
    });

    // Empty / non-string sceneId → rejected
    await expect(ce.handleEvent({ type: 'test' }, { sceneId: '' }))
      .rejects.toThrow(/non-empty sceneId/);
    await expect(ce.handleEvent({ type: 'test' }, { sceneId: null }))
      .rejects.toThrow(/non-empty sceneId/);
    await expect(ce.handleEvent({ type: 'test' }, {}))
      .rejects.toThrow(/non-empty sceneId/);

    // Any non-empty string is acceptable at the validation layer.
    // We don't care whether the downstream logic succeeds — we only assert that
    // the sceneId validator itself does NOT reject these values.
    const arbitraryIds = [
      'task', 'chat_employee', 'meeting_turn',           // previously in allowlist
      'custom_scene_never_seen', 'future_scene_v2',       // previously rejected
    ];
    for (const sceneId of arbitraryIds) {
      try {
        await ce.handleEvent({ type: 'test' }, { sceneId });
      } catch (err) {
        expect(err.message).not.toMatch(/non-empty sceneId/);
      }
    }
  });

});
