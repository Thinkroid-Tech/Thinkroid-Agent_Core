/**
 * Internal tool: recall.
 *
 * Phase 16 (ADR §11 / Design §10) merged the legacy `think_deeper` Brain
 * tool and the Space-side `recall` tool into a single Agent Core internal
 * tool named `recall`. The handler is a thin closure over the toolContext
 * injected by Supervisor: `ctx.thinkDeeper(query)`. The closure name on
 * the context object is unrelated to the public tool name — it is the
 * CE Stage 4 implementation accessor and stays as `thinkDeeper` for now.
 *
 * The wire-level response shape mirrors the original deep-think output
 * so downstream prompts continue to see identical text.
 */

export const schema = {
  type: 'function',
  // executor: 'local' marks this as a Phase 16 daemon-local internal tool
  // (ADR §4 / Design §6.1). Once the daemon owns its own tool dispatcher
  // (sub-phase F), the kernel reads this field to route the call without
  // round-tripping to Space. The legacy think_deeper module did not carry
  // this field; B.2 introduces it as part of the merge.
  executor: 'local',
  function: {
    name: 'recall',
    description: 'Search agent memory by keyword/tag and return matching memory fragments within token budget.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The topic or keywords to search agent memory for',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * Build an execution handler bound to the given runtime context.
 *
 * The returned function receives the LLM-decoded arguments and returns the
 * raw tool result; normalization is applied by tool-loop.
 *
 * @param {Object} ctx - toolContext passed into executeTool
 * @returns {(input: { query: string }) => Promise<string>}
 */
export function createHandler(ctx) {
  return async (input) => {
    const query = input?.query;
    if (!query || String(query).trim().length === 0) {
      return 'No query provided for recall.';
    }
    if (typeof ctx?.thinkDeeper !== 'function') {
      // Supervisor enriches toolContext with thinkDeeper; if it's missing
      // we surface a clear error instead of crashing.
      return 'recall unavailable: no thinkDeeper accessor injected into toolContext.';
    }
    try {
      const result = await ctx.thinkDeeper(query);
      if (!result || String(result).trim().length === 0) {
        return `No relevant memories found for: "${query}"`;
      }
      return `[Recall Results]\n\n${result}`;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('[internal-tool recall] CE Stage 4 failed:', msg);
      return `Recall failed: ${msg}`;
    }
  };
}
