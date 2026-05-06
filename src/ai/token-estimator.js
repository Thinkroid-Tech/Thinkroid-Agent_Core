// Token estimation utility for conversation messages.
// Lives inside agent-core/ to keep the AI entity portable — Space-side code
// may import it via re-export from services/ai/llm-client.js.

/**
 * Estimates total token count for conversation messages.
 * Uses the same rough heuristic as contextEngine: ~1 token per 3 characters.
 * @param {Array<object>} messages
 * @returns {number}
 */
export function estimateConversationTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    // content
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 3);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.text) total += Math.ceil(part.text.length / 3);
      }
    }
    // tool_calls arguments
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.arguments) {
          total += Math.ceil(tc.function.arguments.length / 3);
        }
      }
    }
  }
  return total;
}
