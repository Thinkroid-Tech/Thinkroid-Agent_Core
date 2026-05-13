// Phase 16γ.B.4a Commit #2 — `governance.delegate` daemon-side handler.
//
// Replaces the Commit #1 not-ready stub with the real per-agent execution
// path. The handler validates the locked contract surface, dispatches the
// request to a daemon-local text-chat callable (built from the existing
// `createDaemonTextChat(...)` helper for production, injectable in tests
// via the `textChat` dep), applies per-response-format post-processing,
// and emits the `token_usage` notification when the provider reports
// usage — mirroring the brain.chat handler's onTokenUsage flow at
// `bin/agent-core-daemon.js`.
//
// Response-format semantics (locked by the §4 Commit #2 plan):
//
//   - plain_text (default): return text unchanged.
//   - json_text: best-effort parse with leading/trailing ```json fences
//     stripped. Success → `parsedOk: true`; failure → `parsedOk: false`.
//     Never raises — Space's existing fallback ladder stays authoritative.
//   - decision_word: the first uppercase identifier-style token (regex
//     /^[A-Z][A-Z0-9_]*/) of the trimmed text must be in `validDecisions`;
//     mismatch raises `GOVERNANCE_DELEGATE_INVALID_RESPONSE` (non-retryable).
//     This is the only daemon-side invalid-response error path.
//
// Provider errors raised by `textChat` are wrapped as
// `GOVERNANCE_DELEGATE_PROVIDER_ERROR` (retryable) so the Space-side
// caller can map them to its own HTTP / fallback semantics.

import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import { validateRequestPayload } from '../ipc/agent-core-contract.js';
import { createDaemonTextChat } from './daemon-ipc-handlers.js';

const METHOD = 'governance.delegate';

const DECISION_TOKEN_RE = /^[A-Z][A-Z0-9_]*/;
const JSON_FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

function rejectApplication(message, data = {}) {
  throwJsonRpcError(IPC_ERROR_CODES.APPLICATION, message, { method: METHOD, ...data });
}

function validateRequest(params, boundAgentId) {
  const validation = validateRequestPayload(METHOD, params);
  if (!validation.ok) {
    rejectApplication(validation.errors.join('; '), { errors: validation.errors });
  }
  if (params.agentId !== boundAgentId) {
    rejectApplication(`agentId mismatch: expected ${boundAgentId}`, {
      expectedAgentId: boundAgentId,
      actualAgentId: params.agentId,
    });
  }
}

function tryParseJsonText(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  const fenced = trimmed.match(JSON_FENCE_RE);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

function extractDecisionToken(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(DECISION_TOKEN_RE);
  return match ? match[0] : null;
}

function emitTokenUsage({ sendNotification, agentId, usage }) {
  if (typeof sendNotification !== 'function') return;
  if (!usage || typeof usage !== 'object') return;
  try {
    sendNotification('token_usage', { agentId, usage });
  } catch {
    // Notification emission is best-effort; a downstream serialization
    // failure must not bring down the governance call.
  }
}

/**
 * Build the real governance.delegate handler.
 *
 * @param {{
 *   agentId: string,
 *   textChat: (params: object) => Promise<string>,
 *   sendNotification?: (method: string, payload: object) => void,
 * }} deps
 */
export function createGovernanceDelegateHandler({ agentId, textChat, sendNotification }) {
  if (!agentId) {
    throw new TypeError('createGovernanceDelegateHandler requires agentId');
  }
  if (typeof textChat !== 'function') {
    throw new TypeError('createGovernanceDelegateHandler requires textChat function');
  }

  return async (params) => {
    validateRequest(params, agentId);

    const responseFormat = params.responseFormat ?? 'plain_text';
    const hasToolContext =
      params.toolContext &&
      typeof params.toolContext === 'object' &&
      !Array.isArray(params.toolContext) &&
      Object.keys(params.toolContext).length > 0;

    let capturedUsage;
    const onUsage = (usage) => {
      if (usage && typeof usage === 'object') {
        capturedUsage = usage;
      }
    };

    // B.4a wires a single-round text completion. The tool-text path is
    // a soft simulation: `toolContext` rides along on the call so future
    // sub-phases can wire a real tool loop, but `tools` is always `[]`
    // here so the provider stays in pure text mode. The streaming-chat
    // provider still raises on tool-call signals; callers that need a
    // multi-round tool loop should wait for the streaming sub-phase.
    let text;
    try {
      text = await textChat({
        messages: params.messages,
        maxTokens: params.maxTokens,
        tools: [],
        toolContext: hasToolContext ? params.toolContext : undefined,
        maxToolRounds: hasToolContext ? (params.maxToolRounds ?? 1) : undefined,
        onUsage,
        // Forward the per-call provider/model override into the daemon
        // text shim. Special-role agents (Athena summary, etc.) carry their
        // own provider config that the daemon's per-agent cache may not know
        // about; `createDaemonTextChat(...)` already prefers `configOverride`
        // over the cached brain config when it is supplied.
        configOverride: params.configOverride,
      });
    } catch (err) {
      rejectApplication(`provider error: ${err?.message ?? err}`, {
        code: 'GOVERNANCE_DELEGATE_PROVIDER_ERROR',
        retryable: true,
        cause: err?.message ?? String(err),
      });
    }

    if (typeof text !== 'string') {
      // Defensive: every supported textChat implementation must resolve
      // with a string. Treat anything else as a provider failure so the
      // Space-side caller can retry rather than receiving a malformed
      // response shape.
      rejectApplication('provider returned non-string text', {
        code: 'GOVERNANCE_DELEGATE_PROVIDER_ERROR',
        retryable: true,
      });
    }

    emitTokenUsage({ sendNotification, agentId, usage: capturedUsage });

    const base = {
      ok: true,
      text,
      agentId,
      capability: params.capability,
    };
    if (capturedUsage) base.usage = capturedUsage;

    if (responseFormat === 'json_text') {
      base.parsedOk = tryParseJsonText(text);
      return base;
    }

    if (responseFormat === 'decision_word') {
      const token = extractDecisionToken(text);
      const valid = Array.isArray(params.validDecisions)
        ? params.validDecisions
        : [];
      if (!token || !valid.includes(token)) {
        rejectApplication(
          `decision word "${token ?? ''}" is not in validDecisions [${valid.join(', ')}]`,
          {
            code: 'GOVERNANCE_DELEGATE_INVALID_RESPONSE',
            retryable: false,
            validDecisions: valid,
            extractedToken: token,
          },
        );
      }
      return base;
    }

    // plain_text — return text unchanged, no parsedOk flag.
    return base;
  };
}

/**
 * Register the governance.delegate handler against `kernel`. Builds a
 * production `textChat` callable from the existing `createDaemonTextChat`
 * helper when `deps.textChat` is not supplied, so tests can inject a
 * deterministic stub while production wiring stays single-source.
 */
export function registerGovernanceDelegateHandler(kernel, deps) {
  if (!kernel) {
    throw new TypeError('registerGovernanceDelegateHandler requires kernel');
  }
  const {
    agentId,
    textChat,
    sendNotification,
    brainConfig,
    aiConfigResolver,
    streamChatCompletion,
  } = deps ?? {};
  if (!agentId) {
    throw new TypeError('registerGovernanceDelegateHandler requires agentId');
  }

  const effectiveTextChat = typeof textChat === 'function'
    ? textChat
    : createDaemonTextChat({
      agentId,
      brainConfig,
      aiConfigResolver,
      streamChatCompletion,
    });

  kernel.registerHandler(
    METHOD,
    createGovernanceDelegateHandler({
      agentId,
      textChat: effectiveTextChat,
      sendNotification,
    }),
  );
}
