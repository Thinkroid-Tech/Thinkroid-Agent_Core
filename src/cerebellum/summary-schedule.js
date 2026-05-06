/**
 * Time-based trigger logic for multi-level summaries.
 * Determines which summary levels should run based on current time
 * and when each level last ran.
 *
 * All timestamps are UTC milliseconds (Date.now() convention).
 */

/**
 * Determine which summary levels need running this tick.
 * @param {{ daily?: number|null, weekly?: number|null, monthly?: number|null, quarterly?: number|null, yearly?: number|null }} latestByLevel
 *   - For each level, the period_end of the most recent summary (or null if never run)
 * @param {number} now - Current timestamp in ms
 * @returns {string[]} Levels to run, ordered from lowest to highest
 */
export function getSummaryLevelsToRun(latestByLevel, now) {
  const levels = [];

  const todayStart = startOfDay(now);
  if (!latestByLevel.daily || latestByLevel.daily < todayStart) {
    levels.push('daily');
  }

  const weekStart = startOfWeek(now);
  if (!latestByLevel.weekly || latestByLevel.weekly < weekStart) {
    levels.push('weekly');
  }

  const monthStart = startOfMonth(now);
  if (!latestByLevel.monthly || latestByLevel.monthly < monthStart) {
    levels.push('monthly');
  }

  const quarterStart = startOfQuarter(now);
  if (!latestByLevel.quarterly || latestByLevel.quarterly < quarterStart) {
    levels.push('quarterly');
  }

  const yearStart = startOfYear(now);
  if (!latestByLevel.yearly || latestByLevel.yearly < yearStart) {
    levels.push('yearly');
  }

  return levels;
}

/** Start of day (00:00:00 UTC) for the given timestamp. */
export function startOfDay(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Start of week (Monday 00:00:00 UTC) for the given timestamp. */
export function startOfWeek(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
}

/** Start of month (1st 00:00:00 UTC) for the given timestamp. */
export function startOfMonth(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Start of quarter (Jan/Apr/Jul/Oct 1st 00:00:00 UTC) for the given timestamp. */
export function startOfQuarter(ts) {
  const d = new Date(ts);
  const quarterMonth = Math.floor(d.getUTCMonth() / 3) * 3;
  return Date.UTC(d.getUTCFullYear(), quarterMonth, 1);
}

/** Start of year (Jan 1st 00:00:00 UTC) for the given timestamp. */
export function startOfYear(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

/**
 * Get the source level and period boundaries for a given summary level.
 * @param {string} level
 * @param {number} now
 * @returns {{ sourceLevel: string|null, periodStart: number, periodEnd: number }}
 */
export function getSummaryPeriod(level, now) {
  switch (level) {
    case 'daily': {
      const start = startOfDay(now);
      return { sourceLevel: null, periodStart: start, periodEnd: now };
    }
    case 'weekly': {
      const start = startOfWeek(now);
      return { sourceLevel: 'daily', periodStart: start, periodEnd: now };
    }
    case 'monthly': {
      const start = startOfMonth(now);
      return { sourceLevel: 'weekly', periodStart: start, periodEnd: now };
    }
    case 'quarterly': {
      const start = startOfQuarter(now);
      return { sourceLevel: 'monthly', periodStart: start, periodEnd: now };
    }
    case 'yearly': {
      const start = startOfYear(now);
      return { sourceLevel: 'quarterly', periodStart: start, periodEnd: now };
    }
    default:
      throw new Error(`Unknown summary level: ${level}`);
  }
}
