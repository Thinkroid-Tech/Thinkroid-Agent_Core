// Phase 16.F.1 — assertUniqueToolNames invariant.
//
// Validates that no two tool definitions in a single list share a
// `function.name`. The invariant is checked at TWO sites:
//
//   1. Space-side, immediately after the registry finishes loading the
//      tools/ directory (`initRegistry` epilogue). A duplicate caught
//      here surfaces a buggy plugin / merge mistake before any agent
//      ever boots.
//
//   2. Daemon-side, after the init payload arrives (M44 v3 startup
//      check) and again after every runtime `tool:added` IPC event
//      mutates the daemon's cached tool list. Any duplicate that
//      slipped through the Space-side check, or arrived through a
//      racey runtime push, hard-fails the dispatch path.
//
// This is intentionally fail-fast: a duplicate name means the daemon
// would otherwise route a tool call to the wrong implementation, which
// is a silent correctness bug. The OpenAI tool-call protocol resolves
// `tool_call.name` against the exact same names the LLM was shown, so
// a Space-side `chat_with` colliding with a skill-bundled `chat_with`
// produces non-deterministic dispatch — both registries claim ownership.
//
// The error message lists every duplicate name so logs surface the
// full set in one shot, not one-by-one across debug cycles.

/**
 * Throws if any two tool definitions share a name.
 *
 * Called BOTH on Space-side at registry init AND daemon-side after
 * receiving the tool list (init payload + runtime `tool:added` IPC
 * events).
 *
 * @param {Array<{ function?: { name?: string } }>} tools
 * @returns {void}
 * @throws {Error} on a missing name OR on duplicate names
 */
export function assertUniqueToolNames(tools) {
  if (!Array.isArray(tools)) {
    throw new Error(
      `assertUniqueToolNames: expected an array of tool definitions, got ${typeof tools}`,
    );
  }

  const seen = new Set();
  const duplicates = new Set();
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        'assertUniqueToolNames: tool definition missing function.name',
      );
    }
    if (seen.has(name)) {
      duplicates.add(name);
    }
    seen.add(name);
  }

  if (duplicates.size > 0) {
    const list = [...duplicates].sort();
    throw new Error(
      `assertUniqueToolNames: duplicate tool name(s): ${list.join(', ')}`,
    );
  }
}
