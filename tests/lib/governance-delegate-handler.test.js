import { describe, expect, it } from 'vitest';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import { registerGovernanceDelegateHandler } from '../../src/handlers/governance-delegate-handler.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

function makeKernel() {
  const kernel = new Kernel();
  registerGovernanceDelegateHandler(kernel, {
    agentId: AGENT_ID,
    agentName: 'Daemon Alice',
  });
  return kernel;
}

function validPayload(overrides = {}) {
  return {
    agentId: AGENT_ID,
    capability: 'notification_reader',
    promptKey: 'notification_reader.decide',
    messages: [
      { role: 'system', content: 'You are a governance reviewer.' },
      { role: 'user', content: 'Decide whether to NOTIFY or SKIP.' },
    ],
    source: 'governanceRouter.notification_reader',
    ...overrides,
  };
}

function expectJsonRpcApplicationError(promise, predicate) {
  return promise.then(
    () => {
      throw new Error('expected promise to reject but it resolved');
    },
    (err) => {
      expect(err.jsonRpc).toMatchObject({ code: IPC_ERROR_CODES.APPLICATION });
      predicate(err);
    },
  );
}

describe('governance.delegate stub handler (B.4a Commit #1)', () => {
  it('registers a governance.delegate method on the kernel', () => {
    const kernel = makeKernel();
    expect(kernel.listMethods()).toContain('governance.delegate');
  });

  it('returns the not-ready stub error for a valid payload', async () => {
    const kernel = makeKernel();
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload()),
      (err) => {
        expect(err.jsonRpc.message).toContain('governance.delegate handler is not yet wired');
        expect(err.jsonRpc.data).toMatchObject({
          method: 'governance.delegate',
          code: 'GOVERNANCE_DELEGATE_NOT_READY',
          retryable: false,
        });
      },
    );
  });

  it('rejects payloads missing the messages field with a validation error', async () => {
    const kernel = makeKernel();
    const payload = validPayload();
    delete payload.messages;
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', payload),
      (err) => {
        expect(err.jsonRpc.message).toContain('messages must be a non-empty array');
        expect(err.jsonRpc.data?.code).not.toBe('GOVERNANCE_DELEGATE_NOT_READY');
      },
    );
  });

  it('rejects responseFormat=decision_word without validDecisions', async () => {
    const kernel = makeKernel();
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload({
        responseFormat: 'decision_word',
      })),
      (err) => {
        expect(err.jsonRpc.message).toContain('validDecisions');
        expect(err.jsonRpc.data?.code).not.toBe('GOVERNANCE_DELEGATE_NOT_READY');
      },
    );
  });

  it('rejects payloads whose agentId mismatches the bound agent', async () => {
    const kernel = makeKernel();
    await expectJsonRpcApplicationError(
      kernel.dispatch('governance.delegate', validPayload({
        agentId: OTHER_AGENT_ID,
      })),
      (err) => {
        expect(err.jsonRpc.message).toContain('agentId mismatch');
      },
    );
  });
});
