// Phase 16 (B.3) — historical session_history `tool_calls` migration.
//
// Phase 11 Tier D registered the deep-memory Brain tool as `think_deeper`.
// Phase 16 (ADR §11 / Design §10) merged it with the Space-side `recall`
// tool into a single internal tool named `recall`. session_history rows
// minted before the rename still carry tool_calls JSON whose embedded
// `function.name` is `think_deeper`. When those rows are replayed (resume,
// summary regeneration, or the Cerebellum L1 / L2 aggregators), the
// `think_deeper` strings would no longer match any registered tool —
// so we rewrite them to `recall` once at daemon boot.
//
// Boundary invariant (ADR §1.3 / Design §3 INV-1): the Space process MUST
// NOT open the per-agent `agent-core.db`. This migration therefore lives
// in a daemon-internal helper and is wired from the daemon entrypoint
// (S13, sub-phase C) — never from a Space-side startup path.

/**
 * Walk the `session_history` rows whose `tool_calls` JSON contains the
 * literal `think_deeper` and rewrite the embedded function name to
 * `recall`. The function:
 *
 *  - is **idempotent**: a second run finds zero matching rows because the
 *    LIKE filter selects on the literal `think_deeper`, which no longer
 *    appears after the first pass.
 *  - **tolerates malformed JSON**: a row whose `tool_calls` does not parse
 *    is logged as a warning and skipped. Returning early on a single bad
 *    row would leave the rest of the agent's history half-migrated.
 *  - **preserves other tool calls** in the same array: only entries whose
 *    `function.name === 'think_deeper'` are rewritten. Any sibling call
 *    (`read_record`, `chat_with`, …) round-trips unchanged byte-for-byte
 *    apart from the JSON.stringify reformat (no whitespace differences
 *    matter — SQLite stores the string verbatim).
 *
 * @param {import('better-sqlite3').Database} db - per-agent agent-core.db
 *   handle (NOT a Space-side DB).
 * @returns {number} Number of rows whose `tool_calls` was rewritten.
 */
export function migrateThinkDeeperReferences(db) {
  const rows = db.prepare(
    "SELECT id, tool_calls FROM session_history WHERE tool_calls LIKE '%think_deeper%'"
  ).all();

  const updateStmt = db.prepare(
    'UPDATE session_history SET tool_calls = ? WHERE id = ?'
  );

  let migrated = 0;
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.tool_calls);
    } catch (e) {
      // Malformed row — log and move on. The LIKE filter brought us here
      // because the literal string `think_deeper` appeared somewhere in
      // the column, but the value isn't a parseable JSON array. Surfacing
      // a warning is enough; throwing would block daemon boot for one
      // bad row.
      console.warn(
        `[migrate-think-deeper] session_history id=${row.id} tool_calls is not valid JSON; skipping`
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      // Same defence: tool_calls is expected to be an array per the
      // OpenAI tool-calling shape. Anything else gets skipped, not
      // rewritten — silently mutating an unexpected shape would mask a
      // real bug.
      console.warn(
        `[migrate-think-deeper] session_history id=${row.id} tool_calls is not an array; skipping`
      );
      continue;
    }

    let changed = false;
    const rewritten = parsed.map((tc) => {
      if (tc?.function?.name === 'think_deeper') {
        changed = true;
        return { ...tc, function: { ...tc.function, name: 'recall' } };
      }
      return tc;
    });

    if (!changed) continue;

    const updatedJson = JSON.stringify(rewritten);
    updateStmt.run(updatedJson, row.id);
    migrated += 1;
  }

  if (migrated > 0) {
    console.log(
      `[migrate-think-deeper] migrateThinkDeeperReferences: ${migrated} row(s) updated`
    );
  }
  return migrated;
}
