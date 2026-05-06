/**
 * Memory access count increments.
 *
 * Source: 顶層设计 4.6 节, 第 882-883 行 (grep-verified)
 *   - CE access 了 (读取但未放入 Brain context) → access_count +1
 *   - CE access 了且被用于 Brain context → access_count +2,
 *     同步 last_triggered_at = now、decay_score = 1.0
 *
 * Phase 2: only the access_count increments are consumed.
 * Phase 3: CeAccessView.touchAccess(true) will need to sync all three fields
 *          (access_count, last_triggered_at, decay_score) in a single UPDATE.
 */

/** access_count increment when memory entry was used in Brain context */
export const ACCESS_COUNT_SELECTED = 2;

/** access_count increment when memory entry was seen but not used in Brain context */
export const ACCESS_COUNT_SEEN = 1;
