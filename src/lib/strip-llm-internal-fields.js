// Phase 16.F.2 — strip internal-only fields from tool definitions
// before they fly to the LLM.
//
// The Space-side registry (and the daemon's cached toolList) carries
// metadata the LLM has no business seeing:
//
//   - `executor`           (Plan F.2 routing discriminator: 'local' |
//                          'remote'; the daemon uses it to decide
//                          whether to run the tool in-process or punt
//                          back through IPC to Space-side)
//   - `meta`               (registry-level tag/category/role gates)
//   - `defaultPermission`  (auto / confirm / always_confirm)
//   - `permission`         (back-compat alias)
//   - `category` / `tags`  (Context Engine ranking inputs)
//   - `postApproval`       (approval-flow knob)
//
// The OpenAI / Anthropic tool-call APIs only consume the OpenAI
// function-shape:
//
//   { type: 'function',
//     function: { name, description, parameters } }
//
// Any extra fields at the top level (or inside `function`) are at best
// ignored, at worst confusing — and they leak internal model-of-the-
// world to the LLM.
//
// `stripLlmInternalFields` returns a fresh object that is safe to
// serialize into a chat-completions payload. It does NOT mutate its
// input.

/**
 * Return a shallow clone of `tool` containing only the fields the LLM
 * is allowed to see. Per the OpenAI tool-call spec the only safe
 * top-level keys are `type` and `function`, and `function`'s only
 * load-bearing keys are `name`, `description`, `parameters`.
 *
 * @param {{ type?: string, function?: object } & Record<string, unknown>} tool
 * @returns {{ type: string, function: { name?: string, description?: string, parameters?: unknown } }}
 */
export function stripLlmInternalFields(tool) {
  const fn = tool?.function ?? {};
  const safeFn = {};
  if (typeof fn.name === 'string') safeFn.name = fn.name;
  if (typeof fn.description === 'string') safeFn.description = fn.description;
  if (fn.parameters !== undefined) safeFn.parameters = fn.parameters;
  return { type: tool?.type ?? 'function', function: safeFn };
}

/**
 * Map `stripLlmInternalFields` over an array of tool defs.
 *
 * @param {Array<object>} tools
 * @returns {Array<object>}
 */
export function stripLlmInternalFieldsAll(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(stripLlmInternalFields);
}
