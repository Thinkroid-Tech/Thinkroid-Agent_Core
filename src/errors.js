/**
 * Custom error classes for the agent-core runtime.
 * Kept inside agent-core/ so the portable AI entity does not depend on
 * Space-side error modules. Space-side callers import via re-export from
 * services/ai/errors.js.
 */

/**
 * Thrown when context overflow cannot be resolved by compression.
 * Specifically: Zone A + Zone B (pinned zones) alone exceed the 85% threshold,
 * meaning no amount of Zone C compaction can help.
 */
export class UnrecoverableOverflowError extends Error {
  constructor(agentName, estimatedTokens, pinnedSize) {
    super(
      `Unrecoverable context overflow for ${agentName}: pinned zones (Zone A+B: ${pinnedSize} tokens) exceed 85% threshold. Total estimated: ${estimatedTokens}.`
    );
    this.name = 'UnrecoverableOverflowError';
    this.agentName = agentName;
    this.estimatedTokens = estimatedTokens;
    this.pinnedSize = pinnedSize;
  }
}
