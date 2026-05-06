/**
 * Cerebellum tick drivers.
 * Both use the setTimeout-recursive pattern (matching idleLoop convention) for drift-free scheduling.
 */

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Start a recurring Cerebellum L1 tick loop.
 * Calls tickFn on the given interval. Errors in tickFn are caught and logged —
 * the loop continues on the next interval regardless.
 *
 * @param {() => Promise<void>} tickFn - Async function called on each tick
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs=300000] - Tick interval in milliseconds
 * @returns {{ stop: () => void }}
 */
export function startCerebellumL1Tick(tickFn, { intervalMs = DEFAULT_TICK_INTERVAL_MS } = {}) {
  let timerId = null;
  let stopped = false;

  async function scheduleTick() {
    if (stopped) return;
    try {
      await tickFn();
    } catch (err) {
      console.error('[CerebellumL1] Tick error (will retry next interval):', err.message);
    }
    if (!stopped) {
      timerId = setTimeout(scheduleTick, intervalMs);
    }
  }

  // Schedule first tick after one full interval (don't run immediately on startup)
  timerId = setTimeout(scheduleTick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}

const DEFAULT_L2_TICK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Start a recurring Cerebellum L2 tick loop.
 * Same setTimeout-recursive pattern as L1.
 * Errors in tickFn are caught and logged — the loop continues on the next interval.
 *
 * @param {() => Promise<void>} tickFn - Async function called on each tick
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs=1800000] - Tick interval in milliseconds
 * @returns {{ stop: () => void }}
 */
export function startCerebellumL2Tick(tickFn, { intervalMs = DEFAULT_L2_TICK_INTERVAL_MS } = {}) {
  let timerId = null;
  let stopped = false;

  async function scheduleTick() {
    if (stopped) return;
    try {
      await tickFn();
    } catch (err) {
      console.error('[CerebellumL2] Tick error (will retry next interval):', err.message);
    }
    if (!stopped) {
      timerId = setTimeout(scheduleTick, intervalMs);
    }
  }

  // Schedule first tick after one full interval (don't run immediately on startup)
  timerId = setTimeout(scheduleTick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
    },
  };
}
