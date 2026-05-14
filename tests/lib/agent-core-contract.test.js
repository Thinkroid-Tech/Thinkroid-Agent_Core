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
      'brain.toolLoop',
      'brain.toolLoop.resume',
      'brain.chatToolStream',
      'governance.delegate',
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

  it('accepts Space sentinel agent ids that fall outside the strict RFC 4122 v1-5 nibble ranges', () => {
    // The Space side mints these constants for the three system actors;
    // they intentionally do not satisfy RFC 4122's version (1-5) and
    // variant (8-b) nibble constraints. The IPC contract must accept
    // them at the boundary so brain.* / memory.* / cerebellum.* calls
    // for those actors do not get rejected as INVALID_PAYLOAD.
    const SYSTEM_AGENT_ID = '00000000-0000-0000-0000-000000000001';
    const BOSS_AGENT_ID = '00000000-0000-0000-0000-000000000002';
    const ATHENA_AGENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    for (const id of [SYSTEM_AGENT_ID, BOSS_AGENT_ID, ATHENA_AGENT_ID]) {
      expect(validateRequestPayload('ce.tick', { agentId: id })).toEqual({ ok: true, errors: [] });
      expect(validateRequestPayload('memory.read', { agentId: id, query: 'q' })).toEqual({ ok: true, errors: [] });
    }

    // Truly malformed strings still fail.
    for (const id of ['', 'not-a-uuid', '00000000-0000-0000-0000-00000000000', '0000-0000-0000-0000-000000000000']) {
      expect(validateRequestPayload('ce.tick', { agentId: id })).toEqual({
        ok: false,
        errors: ['agentId must be a UUID string'],
      });
    }
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

  describe('governance.delegate contract', () => {
    const validMessages = [
      { role: 'system', content: 'You are a governance reviewer.' },
      { role: 'user', content: 'Decide whether to NOTIFY or SKIP.' },
    ];

    const validBase = {
      agentId: AGENT_ID,
      capability: 'notification_reader',
      promptKey: 'notification_reader.decide',
      messages: validMessages,
      source: 'governanceRouter.notification_reader',
    };

    it('locks request shape, timeout, and idempotency', () => {
      const contract = getRequestContract('governance.delegate');

      expect(contract).toMatchObject({
        method: 'governance.delegate',
        timeoutMs: 120_000,
        idempotency: 'non_idempotent',
        mutatesDaemonDb: false,
        requestShape: expect.any(Object),
        responseShape: expect.any(Object),
        validationErrors: expect.any(Array),
      });
      expect(contract.requestShape).toMatchObject({
        agentId: 'UUID string',
        capability: 'non-empty string',
        promptKey: 'non-empty string',
        messages: 'non-empty array of {role,content} entries',
        source: 'non-empty string',
      });
      expect(contract.responseShape).toMatchObject({
        ok: 'boolean',
        text: 'string',
        agentId: 'UUID string',
        capability: 'non-empty string',
      });
      expect(contract.timeoutError).toMatchObject({
        code: 'IPC_TIMEOUT',
        timeoutMs: 120_000,
      });
    });

    it('accepts a minimal valid request payload', () => {
      expect(validateRequestPayload('governance.delegate', { ...validBase })).toEqual({
        ok: true,
        errors: [],
      });
    });

    it('accepts a fully populated request payload', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        toolContext: { name: 'lookup' },
        maxTokens: 1024,
        maxToolRounds: 3,
        responseFormat: 'decision_word',
        validDecisions: ['NOTIFY', 'SKIP'],
        correlationId: 'corr-1',
      })).toEqual({ ok: true, errors: [] });
    });

    it('rejects non-UUID agentId', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        agentId: 'not-a-uuid',
      })).toEqual({
        ok: false,
        errors: ['agentId must be a UUID string'],
      });
    });

    it('rejects empty / non-string capability', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        capability: '',
      })).toEqual({
        ok: false,
        errors: ['capability must be a non-empty string'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        capability: 42,
      })).toEqual({
        ok: false,
        errors: ['capability must be a non-empty string'],
      });
    });

    it('rejects empty / non-string promptKey and source', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        promptKey: '',
      })).toEqual({
        ok: false,
        errors: ['promptKey must be a non-empty string'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        source: '',
      })).toEqual({
        ok: false,
        errors: ['source must be a non-empty string'],
      });
    });

    it('rejects empty / non-array messages', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        messages: [],
      })).toEqual({
        ok: false,
        errors: ['messages must be a non-empty array of {role,content} entries'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        messages: 'not-an-array',
      })).toEqual({
        ok: false,
        errors: ['messages must be a non-empty array of {role,content} entries'],
      });
    });

    it('rejects messages entries missing role or content', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        messages: [{ role: 'user' }],
      })).toEqual({
        ok: false,
        errors: ['messages[0].content must be a non-empty string'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        messages: [{ content: 'hi' }],
      })).toEqual({
        ok: false,
        errors: ['messages[0].role must be a non-empty string'],
      });
    });

    it('requires validDecisions when responseFormat is decision_word', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        responseFormat: 'decision_word',
      })).toEqual({
        ok: false,
        errors: ['validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        responseFormat: 'decision_word',
        validDecisions: [],
      })).toEqual({
        ok: false,
        errors: ['validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        responseFormat: 'decision_word',
        validDecisions: 'NOTIFY,SKIP',
      })).toEqual({
        ok: false,
        errors: ['validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        responseFormat: 'decision_word',
        validDecisions: ['notify', 'SKIP'],
      })).toEqual({
        ok: false,
        errors: ['validDecisions entries must be uppercase non-empty tokens'],
      });
    });

    it('rejects validDecisions tokens containing whitespace, punctuation, or lowercase letters', () => {
      const cases = [
        ['NOTIFY NOW'],
        ['YES!'],
        ['Notify'],
        ['notify'],
        ['NOTIFY', 'sk!p'],
        ['1NOTIFY'],
        ['_NOTIFY'],
        ['NOTIFY-NOW'],
      ];

      for (const validDecisions of cases) {
        expect(validateRequestPayload('governance.delegate', {
          ...validBase,
          responseFormat: 'decision_word',
          validDecisions,
        })).toEqual({
          ok: false,
          errors: ['validDecisions entries must be uppercase non-empty tokens'],
        });
      }
    });

    it('accepts validDecisions tokens that match the uppercase identifier shape', () => {
      const cases = [
        ['NOTIFY', 'SKIP'],
        ['APPROVE_ALL', 'ESCALATE_NOW'],
        ['A1B', 'NOTIFY_2'],
      ];

      for (const validDecisions of cases) {
        expect(validateRequestPayload('governance.delegate', {
          ...validBase,
          responseFormat: 'decision_word',
          validDecisions,
        })).toEqual({ ok: true, errors: [] });
      }
    });

    it('locks the exact requestShape structure', () => {
      const contract = getRequestContract('governance.delegate');

      expect(contract.requestShape).toStrictEqual({
        agentId: 'UUID string',
        capability: 'non-empty string',
        promptKey: 'non-empty string',
        messages: 'non-empty array of {role,content} entries',
        toolContext: 'optional object',
        maxTokens: 'optional positive integer',
        maxToolRounds: 'optional positive integer',
        responseFormat: "optional 'plain_text'|'json_text'|'decision_word'",
        validDecisions: 'optional non-empty array of uppercase tokens; required when responseFormat === decision_word',
        configOverride:
          'optional object — per-call provider/model override; daemon applies for this call only without mutating per-agent cached config',
        correlationId: 'optional non-empty string',
        source: 'non-empty string',
      });
    });

    it('locks the exact responseShape structure', () => {
      const contract = getRequestContract('governance.delegate');

      expect(contract.responseShape).toStrictEqual({
        ok: 'boolean',
        text: 'string',
        usage: 'optional object',
        agentId: 'UUID string',
        capability: 'non-empty string',
        parsedOk: 'optional boolean',
      });
    });

    it('locks the exact validationErrors list', () => {
      const contract = getRequestContract('governance.delegate');

      expect(contract.validationErrors).toStrictEqual([
        'payload must be an object',
        'agentId must be a UUID string',
        'capability must be a non-empty string',
        'promptKey must be a non-empty string',
        'source must be a non-empty string',
        'messages must be a non-empty array of {role,content} entries',
        'messages[i].role must be a non-empty string',
        'messages[i].content must be a non-empty string',
        'toolContext must be an object when provided',
        'maxTokens must be a positive integer when provided',
        'maxToolRounds must be a positive integer when provided',
        'responseFormat must be one of plain_text, json_text, decision_word when provided',
        'configOverride must be an object when provided',
        'correlationId must be a non-empty string when provided',
        'validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word',
        'validDecisions entries must be uppercase non-empty tokens',
      ]);
    });

    it('accepts a configOverride object as an optional field', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        configOverride: { model: 'gpt-4o', baseUrl: 'https://x', apiKey: 'sk-x' },
      })).toEqual({ ok: true, errors: [] });
    });

    it('rejects a non-object configOverride', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        configOverride: 'not-object',
      })).toEqual({
        ok: false,
        errors: ['configOverride must be an object when provided'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        configOverride: ['arr'],
      })).toEqual({
        ok: false,
        errors: ['configOverride must be an object when provided'],
      });
    });

    it('rejects unknown responseFormat values', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        responseFormat: 'binary',
      })).toEqual({
        ok: false,
        errors: ['responseFormat must be one of plain_text, json_text, decision_word when provided'],
      });
    });

    it('rejects malformed optional fields', () => {
      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        toolContext: 'not-object',
      })).toEqual({
        ok: false,
        errors: ['toolContext must be an object when provided'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        maxTokens: 0,
      })).toEqual({
        ok: false,
        errors: ['maxTokens must be a positive integer when provided'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        maxToolRounds: -1,
      })).toEqual({
        ok: false,
        errors: ['maxToolRounds must be a positive integer when provided'],
      });

      expect(validateRequestPayload('governance.delegate', {
        ...validBase,
        correlationId: '',
      })).toEqual({
        ok: false,
        errors: ['correlationId must be a non-empty string when provided'],
      });
    });

    it('validates a valid response payload', () => {
      expect(validateResponsePayload('governance.delegate', {
        ok: true,
        text: 'NOTIFY',
        agentId: AGENT_ID,
        capability: 'notification_reader',
      })).toEqual({ ok: true, errors: [] });
    });

    it('accepts response payload with parsedOk and usage', () => {
      expect(validateResponsePayload('governance.delegate', {
        ok: true,
        text: '{"actions":[]}',
        agentId: AGENT_ID,
        capability: 'governance_loop',
        parsedOk: true,
        usage: { input_tokens: 12 },
      })).toEqual({ ok: true, errors: [] });
    });

    it('rejects malformed response payloads', () => {
      expect(validateResponsePayload('governance.delegate', {
        ok: 'true',
        text: 'NOTIFY',
        agentId: AGENT_ID,
        capability: 'notification_reader',
      })).toEqual({
        ok: false,
        errors: ['ok must be a boolean'],
      });

      expect(validateResponsePayload('governance.delegate', {
        ok: true,
        text: 'NOTIFY',
        agentId: 'agent-1',
        capability: 'notification_reader',
      })).toEqual({
        ok: false,
        errors: ['agentId must be a UUID string'],
      });
    });
  });

  describe('brain.toolLoop / brain.chatToolStream — tools validation (OpenAI shape)', () => {
    // The Space-side tool registry emits tools in the OpenAI function-calling
    // shape; daemon-internal tools (e.g. `recall`) emit the same shape with
    // `executor: 'local'`. The contract validator must accept that shape
    // verbatim so every OpenAI-compatible upstream provider (vLLM, OpenAI,
    // OpenRouter, ...) receives a valid `tools[]` payload after the daemon's
    // `stripExecutorFromTools` pass.
    const validMessages = [{ role: 'user', content: 'hi' }];

    function baseToolLoopPayload(tools) {
      return {
        agentId: AGENT_ID,
        source: 'test',
        messages: validMessages,
        tools,
      };
    }

    function baseChatToolStreamPayload(tools) {
      return {
        agentId: AGENT_ID,
        source: 'test',
        messages: validMessages,
        stream: true,
        tools,
      };
    }

    it('accepts the canonical OpenAI-shape registry fixture on brain.chatToolStream', () => {
      // Mirrors the Space tool registry's wire shape:
      // `{type:'function', function:{name,description,parameters}, executor:'remote'}`.
      const tools = [
        {
          type: 'function',
          function: {
            name: 'web_fetch',
            description: 'Fetch a URL',
            parameters: { type: 'object', properties: { url: { type: 'string' } } },
          },
          executor: 'remote',
        },
        {
          type: 'function',
          function: { name: 'recall' },
          executor: 'local',
        },
      ];
      expect(validateRequestPayload('brain.chatToolStream', baseChatToolStreamPayload(tools)))
        .toEqual({ ok: true, errors: [] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload(tools)))
        .toEqual({ ok: true, errors: [] });
    });

    it('accepts entries that omit the optional `type` discriminator', () => {
      const tools = [{ function: { name: 'no_type' }, executor: 'remote' }];
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload(tools)))
        .toEqual({ ok: true, errors: [] });
    });

    it('accepts entries that omit the optional `executor` field', () => {
      const tools = [{ type: 'function', function: { name: 'no_executor' } }];
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload(tools)))
        .toEqual({ ok: true, errors: [] });
    });

    it('accepts entries that omit description/parameters', () => {
      const tools = [{
        type: 'function',
        function: { name: 'bare' },
        executor: 'remote',
      }];
      expect(validateRequestPayload('brain.chatToolStream', baseChatToolStreamPayload(tools)))
        .toEqual({ ok: true, errors: [] });
    });

    it('rejects a non-array `tools` field', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload('not-array')))
        .toEqual({ ok: false, errors: ['tools must be an array when provided'] });
    });

    it('rejects entries that are not plain objects', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload(['nope'])))
        .toEqual({ ok: false, errors: ['tools[0] must be an object'] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([null])))
        .toEqual({ ok: false, errors: ['tools[0] must be an object'] });
    });

    it('rejects entries missing the function object', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ type: 'function', executor: 'remote' }])))
        .toEqual({ ok: false, errors: ['tools[0].function must be an object'] });
    });

    it('rejects entries whose function object is not a plain object', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ function: 'web_fetch' }])))
        .toEqual({ ok: false, errors: ['tools[0].function must be an object'] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ function: ['w'] }])))
        .toEqual({ ok: false, errors: ['tools[0].function must be an object'] });
    });

    it('rejects entries whose function.name is missing or blank', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ function: {} }])))
        .toEqual({ ok: false, errors: ['tools[0].function.name must be a non-empty string'] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ function: { name: '' } }])))
        .toEqual({ ok: false, errors: ['tools[0].function.name must be a non-empty string'] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([{ function: { name: 42 } }])))
        .toEqual({ ok: false, errors: ['tools[0].function.name must be a non-empty string'] });
    });

    it('rejects entries whose `type` is set to something other than "function"', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([
        { type: 'tool', function: { name: 'x' } },
      ]))).toEqual({ ok: false, errors: ['tools[0].type must be "function" when provided'] });
    });

    it('rejects entries whose `executor` is not "local" or "remote" when provided', () => {
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([
        { function: { name: 'x' }, executor: 'space' },
      ]))).toEqual({ ok: false, errors: ['tools[0].executor must be "local" or "remote" when provided'] });
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([
        { function: { name: 'x' }, executor: 7 },
      ]))).toEqual({ ok: false, errors: ['tools[0].executor must be "local" or "remote" when provided'] });
    });

    it('rejects legacy flat-shape entries that lack the OpenAI function object', () => {
      // Pre-rollback Space code mistakenly converted to this shape; the
      // contract now rejects it at the boundary so a future regression
      // is caught loudly instead of silently producing 400s from the
      // upstream provider.
      expect(validateRequestPayload('brain.toolLoop', baseToolLoopPayload([
        { name: 'legacy', executor: 'remote' },
      ]))).toEqual({ ok: false, errors: ['tools[0].function must be an object'] });
    });

    it('locks the documented validationErrors list on brain.toolLoop', () => {
      expect(getRequestContract('brain.toolLoop').validationErrors).toStrictEqual([
        'payload must be an object',
        'agentId must be a UUID string',
        'source must be a non-empty string',
        'messages must be a non-empty array of {role,content} entries',
        'messages[i].role must be a non-empty string',
        'messages[i].content must be a non-empty string',
        'tools must be an array when provided',
        'tools[i] must be an object',
        'tools[i].type must be "function" when provided',
        'tools[i].function must be an object',
        'tools[i].function.name must be a non-empty string',
        'tools[i].executor must be "local" or "remote" when provided',
        'toolContext must be an object when provided',
        'maxTokens must be a positive integer when provided',
        'maxToolRounds must be a positive integer when provided',
        'maxToolRounds must not exceed 50',
        'taskId must be a non-empty string when provided',
        'skipInterruptCheck must be a boolean when provided',
        'configOverride must be an object when provided',
        'correlationId must be a non-empty string when provided',
      ]);
    });

    it('locks the documented validationErrors list on brain.chatToolStream', () => {
      expect(getRequestContract('brain.chatToolStream').validationErrors).toStrictEqual([
        'payload must be an object',
        'agentId must be a UUID string',
        'source must be a non-empty string',
        'messages must be a non-empty array of {role,content} entries',
        'messages[i].role must be a non-empty string',
        'messages[i].content must be a non-empty string',
        'tools must be an array when provided',
        'tools[i] must be an object',
        'tools[i].type must be "function" when provided',
        'tools[i].function must be an object',
        'tools[i].function.name must be a non-empty string',
        'tools[i].executor must be "local" or "remote" when provided',
        'toolContext must be an object when provided',
        'maxTokens must be a positive integer when provided',
        'maxToolRounds must be a positive integer when provided',
        'maxToolRounds must not exceed 50',
        'taskId must be a non-empty string when provided',
        'skipInterruptCheck must be a boolean when provided',
        'stream must be true',
        'configOverride must be an object when provided',
        'backupConfigOverride must be an object when provided',
        'correlationId must be a non-empty string when provided',
      ]);
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
