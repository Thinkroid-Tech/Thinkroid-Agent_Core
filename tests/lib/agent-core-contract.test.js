import { describe, expect, it } from 'vitest';

import { IPC_METHOD_TIMEOUTS_MS } from '../../src/adapters/ipc-timeouts.js';
import {
  AGENT_CORE_IPC_HANDSHAKE_FIELD,
  AGENT_CORE_IPC_PROTOCOL_VERSION,
  getNotificationContract,
  getRequestContract,
  listNotificationMethods,
  listRequestMethods,
  validateHandshake,
  validateNotificationPayload,
  validateRequestPayload,
  validateResponsePayload,
} from '../../src/ipc/agent-core-contract.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

describe('agent-core IPC contract', () => {
  it('locks the daemon request and notification method names', () => {
    expect(listRequestMethods()).toEqual([
      'ce.tick',
      'cerebellum.l1Tick',
      'cerebellum.l2Tick',
      'memory.read',
      'memory.write',
      'session.receiveEvent',
    ]);

    expect(listNotificationMethods()).toEqual([
      'debug_log',
      'hook_event',
      'token_usage',
    ]);
  });

  it('describes required behavior and timeout surface for every request method', () => {
    for (const method of listRequestMethods()) {
      const contract = getRequestContract(method);

      expect(contract).toMatchObject({
        method,
        spaceRegistryFallback: false,
        requestPathUnavailableBehavior: 'return_service_error',
        scheduledUnavailableBehavior: expect.any(String),
        timeoutMs: expect.any(Number),
        idempotency: expect.any(String),
        mutatesDaemonDb: expect.any(Boolean),
        requestShape: expect.any(Object),
        responseShape: expect.any(Object),
        validationErrors: expect.any(Array),
        daemonUnavailableError: expect.objectContaining({
          code: 'AGENT_CORE_DAEMON_UNAVAILABLE',
        }),
        timeoutError: expect.objectContaining({
          code: 'IPC_TIMEOUT',
        }),
      });
      expect(contract.timeoutMs).toBe(IPC_METHOD_TIMEOUTS_MS[method]);
    }
  });

  it('locks non-queued scheduler semantics for L1 and L2 ticks', () => {
    expect(getRequestContract('cerebellum.l1Tick')).toMatchObject({
      idempotency: 'idempotent_per_agent_cursor_sweep',
      scheduler: {
        queued: false,
        blocking: false,
        skipIfPreviousInFlight: true,
      },
    });
    expect(getRequestContract('cerebellum.l2Tick')).toMatchObject({
      idempotency: 'idempotent_per_agent_summary_cursor_sweep',
      scheduler: {
        queued: false,
        blocking: false,
        skipIfPreviousInFlight: true,
      },
    });
  });

  it('validates required request payload fields per method', () => {
    const validPayloads = {
      'ce.tick': { agentId: AGENT_ID, reason: 'scheduled' },
      'cerebellum.l1Tick': { agentId: AGENT_ID, reason: 'scheduled' },
      'cerebellum.l2Tick': { agentId: AGENT_ID, settings: { maxSessions: 3 } },
      'memory.read': { agentId: AGENT_ID, query: 'recent project state', limit: 5 },
      'memory.write': { agentId: AGENT_ID, entries: [{ type: 'fact', content: 'Project X uses daemon IPC.' }] },
      'session.receiveEvent': {
        agentId: AGENT_ID,
        event: { id: 'event-1', type: 'user_message', agent_id: AGENT_ID },
        options: { sceneId: 'scene-1', dynamicData: { priority: 'normal' } },
      },
    };

    for (const [method, payload] of Object.entries(validPayloads)) {
      expect(validateRequestPayload(method, payload)).toEqual({ ok: true, errors: [] });
    }

    expect(validateRequestPayload('memory.read', { agentId: AGENT_ID })).toEqual({
      ok: false,
      errors: ['query must be a non-empty string'],
    });
    expect(validateRequestPayload('session.receiveEvent', {
      agentId: AGENT_ID,
    })).toEqual({
      ok: false,
      errors: ['event must be an object'],
    });
  });

  it('requires UUID agent ids and keeps per-agent tick payloads session-free', () => {
    expect(getRequestContract('ce.tick').requestShape.agentId).toBe('UUID string');
    expect(getRequestContract('cerebellum.l1Tick').requestShape).not.toHaveProperty('sessionId');
    expect(getRequestContract('cerebellum.l2Tick').requestShape).not.toHaveProperty('sessionId');

    expect(validateRequestPayload('ce.tick', { agentId: 'agent-1' })).toEqual({
      ok: false,
      errors: ['agentId must be a UUID string'],
    });
    expect(validateRequestPayload('cerebellum.l1Tick', { agentId: AGENT_ID })).toEqual({ ok: true, errors: [] });
    expect(validateRequestPayload('cerebellum.l2Tick', { agentId: AGENT_ID })).toEqual({ ok: true, errors: [] });
  });

  it('locks session.receiveEvent to event/options payload instead of sessionId', () => {
    const contract = getRequestContract('session.receiveEvent');

    expect(contract.requestShape).toMatchObject({
      agentId: 'UUID string',
      event: 'object with optional non-empty id and required non-empty type',
      options: 'optional object',
    });
    expect(contract.requestShape).not.toHaveProperty('sessionId');

    expect(validateRequestPayload('session.receiveEvent', {
      agentId: AGENT_ID,
      event: { id: 'event-1', type: 'tool_result', agent_id: OTHER_AGENT_ID },
      options: { toolContext: { name: 'lookup' }, callerOptions: { source: 'scheduler' } },
    })).toEqual({ ok: true, errors: [] });
    expect(validateRequestPayload('session.receiveEvent', {
      agentId: AGENT_ID,
      event: { id: '', type: 'tool_result' },
    })).toEqual({
      ok: false,
      errors: ['event.id must be a non-empty string when provided'],
    });
    expect(validateRequestPayload('session.receiveEvent', {
      agentId: AGENT_ID,
      event: { id: 'event-1' },
      options: 'not-object',
    })).toEqual({
      ok: false,
      errors: [
        'event.type must be a non-empty string',
        'options must be an object when provided',
      ],
    });
  });

  it('validates response payloads and rejects malformed payloads', () => {
    expect(validateResponsePayload('memory.read', { entries: [] })).toEqual({ ok: true, errors: [] });
    expect(validateResponsePayload('memory.write', { ok: true, writtenCount: 1 })).toEqual({ ok: true, errors: [] });
    expect(validateResponsePayload('cerebellum.l1Tick', { ok: true, processed: false, skipped: true })).toEqual({ ok: true, errors: [] });

    expect(validateRequestPayload('ce.tick', null)).toEqual({
      ok: false,
      errors: ['payload must be an object'],
    });
    expect(validateResponsePayload('memory.read', { entries: 'not-array' })).toEqual({
      ok: false,
      errors: ['entries must be an array'],
    });
    expect(validateRequestPayload('unknown.method', {})).toEqual({
      ok: false,
      errors: ['unknown request method: unknown.method'],
    });
  });

  it('validates notification payloads', () => {
    expect(validateNotificationPayload('token_usage', {
      agentId: AGENT_ID,
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    })).toEqual({ ok: true, errors: [] });
    expect(validateNotificationPayload('hook_event', {
      agentId: AGENT_ID,
      event: { type: 'tool.started' },
    })).toEqual({ ok: true, errors: [] });
    expect(validateNotificationPayload('debug_log', {
      agentId: AGENT_ID,
      level: 'info',
      message: 'ready',
    })).toEqual({ ok: true, errors: [] });

    expect(getNotificationContract('debug_log')).toMatchObject({
      method: 'debug_log',
      requestShape: expect.any(Object),
    });
    expect(validateNotificationPayload('debug_log', { agentId: AGENT_ID, message: 'ready' })).toEqual({
      ok: false,
      errors: ['level must be one of debug, info, warn, error'],
    });
    expect(validateNotificationPayload('debug_log', {
      agentId: 'agent-1',
      level: 'info',
      message: 'ready',
    })).toEqual({
      ok: false,
      errors: ['agentId must be a UUID string'],
    });
  });

  it('detects protocol version mismatches through the handshake field', () => {
    expect(AGENT_CORE_IPC_HANDSHAKE_FIELD).toBe('agentCoreProtocolVersion');
    expect(validateHandshake({
      [AGENT_CORE_IPC_HANDSHAKE_FIELD]: AGENT_CORE_IPC_PROTOCOL_VERSION,
    })).toEqual({ ok: true, errors: [] });

    expect(validateHandshake({
      [AGENT_CORE_IPC_HANDSHAKE_FIELD]: 'agent-core-ipc/v0',
    })).toEqual({
      ok: false,
      errors: [`protocol version mismatch: expected ${AGENT_CORE_IPC_PROTOCOL_VERSION}, got agent-core-ipc/v0`],
    });
  });
});
