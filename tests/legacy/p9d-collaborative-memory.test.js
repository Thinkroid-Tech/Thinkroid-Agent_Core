/**
 * P9-D: Collaborative memory prompt tests.
 *
 * Verifies that L1 extraction and L2 summarization / aggregation prompts
 * correctly guide collaboration memory extraction using the canonical
 * 'collaboration' tag.
 *
 * No mocks needed — all functions under test are pure prompt builders
 * and parsers.
 */

import { describe, it, expect } from 'vitest';

import {
  buildExtractionPrompt,
  parseExtractionResponse,
} from '../cerebellum/extraction-prompt.js';
import {
  buildSummarizationPrompt,
  parseSummarizationResponse,
} from '../cerebellum/summarization-prompt.js';
import { buildAggregationPrompt } from '../cerebellum/summary-aggregation-prompt.js';

// ---------------------------------------------------------------------------
// Part 1: L1 Extraction Prompt
// ---------------------------------------------------------------------------

describe('P9-D Part 1: L1 extraction prompt — collaboration tag guidance', () => {

  it("test-1: system prompt contains instruction to include 'collaboration' tag", () => {
    const messages = buildExtractionPrompt([], 'TestAgent');
    const systemContent = messages[0].content;

    expect(systemContent).toContain("MUST include 'collaboration' tag");
  });

  it('test-2: system prompt contains agent-specific collaboration example sentence', () => {
    const messages = buildExtractionPrompt([], 'TestAgent');
    const systemContent = messages[0].content;

    expect(systemContent).toContain('Worked with Bob on API migration');
  });

  it('test-3: output format example includes collaboration-tagged memory line', () => {
    const messages = buildExtractionPrompt([], 'TestAgent');
    const systemContent = messages[0].content;

    // The canonical format example line must appear in the output format section
    expect(systemContent).toContain('[tags:collaboration,api-migration]');
  });

  it('test-4: parser extracts collaboration tag from a collaboration-tagged memory line', () => {
    const response =
      '[short] [tags:collaboration,api-migration] [importance:0.7] Worked with Bob on API migration';

    const results = parseExtractionResponse(response);

    expect(results).toHaveLength(1);
    expect(results[0].tags).toContain('collaboration');
    expect(results[0].tags).toContain('api-migration');
  });

  it('test-5: collaboration memory with importance 0.7 passes the 0.5 threshold', () => {
    const response =
      '[short] [tags:collaboration,api-migration] [importance:0.7] Worked with Bob on API migration';

    const results = parseExtractionResponse(response);

    // Should not be filtered out
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.7);
  });

});

// ---------------------------------------------------------------------------
// Part 2: L2 Summarization Prompt
// ---------------------------------------------------------------------------

describe('P9-D Part 2: L2 summarization prompt — collaboration memory section', () => {

  it('test-6: system prompt contains a Collaboration Memory section header', () => {
    const messages = buildSummarizationPrompt([], 'TestAgent');
    const systemContent = messages[0].content;

    expect(systemContent).toContain('## Collaboration Memory');
  });

  it("test-7: system prompt specifies 'collaboration' as the canonical tag for collaboration memories", () => {
    const messages = buildSummarizationPrompt([], 'TestAgent');
    const systemContent = messages[0].content;

    expect(systemContent).toContain("'collaboration' tag");
  });

});

// ---------------------------------------------------------------------------
// Part 3: L2 Aggregation Prompt
// ---------------------------------------------------------------------------

describe('P9-D Part 3: L2 aggregation prompt — collaboration detail preservation', () => {

  it('test-8: system prompt instructs preserving inter-agent collaboration details with agent names', () => {
    const messages = buildAggregationPrompt('daily', ['summary 1'], 'TestAgent');
    const systemContent = messages[0].content;

    expect(systemContent).toContain('inter-agent collaboration details');
    expect(systemContent).toContain('agent names');
  });

});
