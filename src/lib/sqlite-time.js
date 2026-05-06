// Phase 16 placeholder — re-export of the SQLite UTC timestamp parser.
//
// SQLite's `datetime('now')` produces `"YYYY-MM-DD HH:MM:SS"` in UTC with
// no zone suffix; passing that to `new Date()` would parse it as local
// time and skew the result by the host's UTC offset. This helper accepts
// the SQLite shape, ISO-formatted strings, and numeric epochs.
//
// The same function lives inline in services/tools/chat-with.js today.
// When Phase 16.M lifts the daemon out into a sibling repo, this module
// becomes the single canonical source and chat-with.js imports from here.

/**
 * @param {string|number|null|undefined} ts
 * @returns {number} epoch ms; NaN when input is unparseable.
 */
export function parseSqliteUtcTs(ts) {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  if (typeof ts !== 'string') return NaN;
  // If already ISO-formatted (has 'T' or trailing Z/±offset), trust it.
  const hasT = ts.includes('T');
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(ts);
  if (hasT || hasZone) return Date.parse(ts);
  // Plain "YYYY-MM-DD HH:MM:SS" → treat as UTC.
  return Date.parse(ts.replace(' ', 'T') + 'Z');
}
