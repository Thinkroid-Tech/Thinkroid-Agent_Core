// Phase 16γ.B.4a Commit #1 — `governance.delegate` daemon-side handler stub.
//
// Commit #1 only locks the IPC contract surface and registers a handler that
// validates the request and otherwise returns a not-ready error. Commit #2
// swaps the stub for the real per-agent Brain execution path.
//
// The stub still runs full payload validation + the agentId-mismatch check so
// callers exercising the locked contract see the right rejection shape
// immediately, and Space-side regression tests can pin behavior before the
// execution wiring lands.

import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import { validateRequestPayload } from '../ipc/agent-core-contract.js';

const METHOD = 'governance.delegate';
const NOT_READY_MESSAGE = 'governance.delegate handler is not yet wired (B.4a Commit #2)';

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

export function createGovernanceDelegateStubHandler({ agentId }) {
  if (!agentId) {
    throw new TypeError('createGovernanceDelegateStubHandler requires agentId');
  }

  return async (params) => {
    validateRequest(params, agentId);
    rejectApplication(NOT_READY_MESSAGE, {
      code: 'GOVERNANCE_DELEGATE_NOT_READY',
      retryable: false,
    });
    // Unreachable — rejectApplication always throws.
    return undefined;
  };
}

export function registerGovernanceDelegateHandler(kernel, deps) {
  if (!kernel) {
    throw new TypeError('registerGovernanceDelegateHandler requires kernel');
  }
  const { agentId } = deps ?? {};
  if (!agentId) {
    throw new TypeError('registerGovernanceDelegateHandler requires agentId');
  }
  kernel.registerHandler(METHOD, createGovernanceDelegateStubHandler({ agentId }));
}
