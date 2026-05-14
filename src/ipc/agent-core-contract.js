export const AGENT_CORE_IPC_PROTOCOL_VERSION = 'agent-core-ipc/v1';
export const AGENT_CORE_IPC_HANDSHAKE_FIELD = 'agentCoreProtocolVersion';

// Loose 8-4-4-4-12 lowercase/uppercase hex pattern. Intentionally NOT the
// strict RFC 4122 v1-v5 form: the Space side mints sentinel agent ids for
// system actors that fall outside the version/variant nibble ranges
// (e.g. the singleton Athena id `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`
// and the system/boss `0000...0001` / `0000...0002` rows). Rejecting
// those sentinels at the IPC boundary breaks every brain.* call routed
// for those actors. We only need shape-level uniqueness here; uniqueness
// across the agent table is enforced by the SQLite primary key.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAEMON_UNAVAILABLE_ERROR = Object.freeze({
  code: 'AGENT_CORE_DAEMON_UNAVAILABLE',
  message: 'Agent Core daemon is unavailable; Space must return an explicit service error.',
  retryable: true,
});

const TIMEOUT_ERROR = Object.freeze({
  code: 'IPC_TIMEOUT',
  jsonRpcCode: -32099,
  message: 'Agent Core IPC request timed out.',
  retryable: true,
});

const NON_QUEUED_TICK_SCHEDULER = Object.freeze({
  queued: false,
  blocking: false,
  skipIfPreviousInFlight: true,
});

const DEFAULT_SCHEDULER = Object.freeze({
  queued: false,
  blocking: false,
  skipIfPreviousInFlight: false,
});

const REQUEST_CONTRACTS = Object.freeze({
  'ce.tick': makeRequestContract({
    method: 'ce.tick',
    timeoutMs: 30_000,
    idempotency: 'idempotent_per_agent_tick_window',
    mutatesDaemonDb: true,
    scheduler: DEFAULT_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      reason: 'optional non-empty string',
      now: 'optional ISO timestamp string',
    },
    responseShape: {
      ok: 'boolean',
      processed: 'optional boolean',
      skipped: 'optional boolean',
      reason: 'optional string',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'reason must be a non-empty string when provided',
      'now must be a non-empty string when provided',
    ],
  }),
  'cerebellum.l1Tick': makeRequestContract({
    method: 'cerebellum.l1Tick',
    timeoutMs: 60_000,
    idempotency: 'idempotent_per_agent_cursor_sweep',
    mutatesDaemonDb: true,
    scheduler: NON_QUEUED_TICK_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      reason: 'optional non-empty string',
      now: 'optional ISO timestamp string',
      settings: 'optional object',
    },
    responseShape: {
      ok: 'boolean',
      processed: 'boolean',
      skipped: 'optional boolean',
      reason: 'optional string',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'reason must be a non-empty string when provided',
      'now must be a non-empty string when provided',
      'settings must be an object when provided',
    ],
  }),
  'cerebellum.l2Tick': makeRequestContract({
    method: 'cerebellum.l2Tick',
    timeoutMs: 120_000,
    idempotency: 'idempotent_per_agent_summary_cursor_sweep',
    mutatesDaemonDb: true,
    scheduler: NON_QUEUED_TICK_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      reason: 'optional non-empty string',
      now: 'optional ISO timestamp string',
      settings: 'optional object',
    },
    responseShape: {
      ok: 'boolean',
      processed: 'boolean',
      skipped: 'optional boolean',
      reason: 'optional string',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'reason must be a non-empty string when provided',
      'now must be a non-empty string when provided',
      'settings must be an object when provided',
    ],
  }),
  'memory.read': makeRequestContract({
    method: 'memory.read',
    timeoutMs: 30_000,
    idempotency: 'safe_repeat_read_only',
    mutatesDaemonDb: false,
    scheduler: null,
    requestShape: {
      agentId: 'UUID string',
      query: 'non-empty string',
      limit: 'optional positive integer',
    },
    responseShape: {
      entries: 'array',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'query must be a non-empty string',
      'limit must be a positive integer when provided',
    ],
  }),
  'memory.write': makeRequestContract({
    method: 'memory.write',
    timeoutMs: 30_000,
    idempotency: 'caller_supplies_dedupe_key_when_needed',
    mutatesDaemonDb: true,
    scheduler: null,
    requestShape: {
      agentId: 'UUID string',
      entries: 'array',
    },
    responseShape: {
      ok: 'boolean',
      writtenCount: 'non-negative integer',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'entries must be an array',
    ],
  }),
  'session.receiveEvent': makeRequestContract({
    method: 'session.receiveEvent',
    timeoutMs: 30_000,
    idempotency: 'caller_supplies_event_id_for_replay_safety',
    mutatesDaemonDb: true,
    scheduler: null,
    requestShape: {
      agentId: 'UUID string',
      event: 'object with optional non-empty id and required non-empty type',
      options: 'optional object',
    },
    responseShape: {
      ok: 'boolean',
      accepted: 'boolean',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'event must be an object',
      'event.id must be a non-empty string when provided',
      'event.type must be a non-empty string',
      'options must be an object when provided',
    ],
  }),
  'brain.toolLoop': makeRequestContract({
    method: 'brain.toolLoop',
    timeoutMs: 300_000,
    idempotency: 'non_idempotent',
    // Approval-pending paths persist suspensions in a follow-up commit;
    // mark mutating now to keep the scheduler honest.
    mutatesDaemonDb: true,
    scheduler: DEFAULT_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      messages: 'non-empty array of {role,content} entries',
      tools: 'optional array of OpenAI-shape tool definitions with {type?: "function", function: {name, description?, parameters?}, executor?: "local"|"remote"}',
      toolContext: 'optional object — opaque, forwarded to remote tools',
      maxTokens: 'optional positive integer',
      maxToolRounds: 'optional positive integer; default 25, hard-cap 50',
      taskId: 'optional non-empty string',
      skipInterruptCheck: 'optional boolean',
      configOverride: 'optional object',
      correlationId: 'optional non-empty string',
      source: 'non-empty string',
    },
    responseShape: {
      ok: 'boolean',
      text: 'string',
      agentId: 'UUID string',
      status: '"completed" | "approval_pending" | "interrupted" | "failed"',
      usage: 'optional object',
      suspensionId: 'optional string — set when status==="approval_pending"',
      toolCallId: 'optional string — set when status==="approval_pending"',
      conversationMessages: 'optional array — full message history including tool calls/results, for caller persistence',
    },
    validationErrors: [
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
    ],
  }),
  'brain.toolLoop.resume': makeRequestContract({
    method: 'brain.toolLoop.resume',
    timeoutMs: 300_000,
    idempotency: 'idempotent_per_suspensionId_approvalId',
    mutatesDaemonDb: true,
    scheduler: DEFAULT_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      suspensionId: 'non-empty string',
      approvalId: 'non-empty string',
      toolResult: 'object with at least content: string OR isToolError: true',
      decidedBy: 'optional non-empty string',
      correlationId: 'optional non-empty string',
    },
    responseShape: {
      ok: 'boolean',
      text: 'string',
      agentId: 'UUID string',
      status: '"completed" | "approval_pending" | "interrupted" | "failed"',
      usage: 'optional object',
      suspensionId: 'optional string',
      toolCallId: 'optional string',
      conversationMessages: 'optional array',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'suspensionId must be a non-empty string',
      'approvalId must be a non-empty string',
      'toolResult must be an object',
      'toolResult.content must be a string when provided',
      'toolResult.isToolError must be a boolean when provided',
      'toolResult must include content (string) or isToolError: true',
      'decidedBy must be a non-empty string when provided',
      'correlationId must be a non-empty string when provided',
    ],
  }),
  'brain.chatToolStream': makeRequestContract({
    method: 'brain.chatToolStream',
    timeoutMs: 300_000,
    idempotency: 'non_idempotent',
    // The handler may persist an approval-pending suspension row mid-stream,
    // identical to the non-streaming brain.toolLoop path.
    mutatesDaemonDb: true,
    scheduler: DEFAULT_SCHEDULER,
    requestShape: {
      agentId: 'UUID string',
      messages: 'non-empty array of {role,content} entries',
      tools: 'optional array of OpenAI-shape tool definitions with {type?: "function", function: {name, description?, parameters?}, executor?: "local"|"remote"}',
      toolContext: 'optional object — opaque, forwarded to remote tools',
      maxTokens: 'optional positive integer',
      maxToolRounds: 'optional positive integer; default 25, hard-cap 50',
      taskId: 'optional non-empty string',
      skipInterruptCheck: 'optional boolean',
      stream: 'must be true',
      configOverride: 'optional object',
      backupConfigOverride:
        'optional object — fallback config when primary configOverride resolution is unavailable (special-role agent chat dual-path)',
      correlationId: 'optional non-empty string',
      source: 'non-empty string',
    },
    responseShape: {
      ok: 'boolean',
      text: 'string',
      agentId: 'UUID string',
      status: '"completed" | "approval_pending" | "interrupted" | "failed"',
      usage: 'optional object',
      suspensionId: 'optional string — set when status==="approval_pending"',
      toolCallId: 'optional string — set when status==="approval_pending"',
      conversationMessages: 'optional array — full message history including tool calls/results, for caller persistence',
    },
    validationErrors: [
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
    ],
  }),
  'governance.delegate': makeRequestContract({
    method: 'governance.delegate',
    timeoutMs: 120_000,
    idempotency: 'non_idempotent',
    mutatesDaemonDb: false,
    scheduler: DEFAULT_SCHEDULER,
    requestShape: {
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
    },
    responseShape: {
      ok: 'boolean',
      text: 'string',
      usage: 'optional object',
      agentId: 'UUID string',
      capability: 'non-empty string',
      parsedOk: 'optional boolean',
    },
    validationErrors: [
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
    ],
  }),
});

const NOTIFICATION_CONTRACTS = Object.freeze({
  debug_log: makeNotificationContract({
    method: 'debug_log',
    requestShape: {
      agentId: 'UUID string',
      level: 'debug | info | warn | error',
      message: 'non-empty string',
      context: 'optional object',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'level must be one of debug, info, warn, error',
      'message must be a non-empty string',
      'context must be an object when provided',
    ],
  }),
  hook_event: makeNotificationContract({
    method: 'hook_event',
    requestShape: {
      agentId: 'UUID string',
      event: 'object',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'event must be an object',
    ],
  }),
  token_usage: makeNotificationContract({
    method: 'token_usage',
    requestShape: {
      agentId: 'UUID string',
      usage: 'object',
    },
    validationErrors: [
      'payload must be an object',
      'agentId must be a UUID string',
      'usage must be an object',
    ],
  }),
});

export function listRequestMethods() {
  return Object.keys(REQUEST_CONTRACTS);
}

export function listNotificationMethods() {
  return Object.keys(NOTIFICATION_CONTRACTS);
}

export function getRequestContract(method) {
  return REQUEST_CONTRACTS[method] ?? null;
}

export function getNotificationContract(method) {
  return NOTIFICATION_CONTRACTS[method] ?? null;
}

export function validateRequestPayload(method, payload) {
  if (!REQUEST_CONTRACTS[method]) {
    return invalid(`unknown request method: ${method}`);
  }
  const objectErrors = validateObjectPayload(payload);
  if (objectErrors.length > 0) return { ok: false, errors: objectErrors };

  switch (method) {
    case 'ce.tick':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...optionalNonEmptyString(payload.reason, 'reason'),
        ...optionalNonEmptyString(payload.now, 'now'),
      ]);
    case 'cerebellum.l1Tick':
    case 'cerebellum.l2Tick':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...optionalNonEmptyString(payload.reason, 'reason'),
        ...optionalNonEmptyString(payload.now, 'now'),
        ...optionalPlainObject(payload.settings, 'settings'),
      ]);
    case 'memory.read':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.query, 'query'),
        ...optionalPositiveInteger(payload.limit, 'limit'),
      ]);
    case 'memory.write':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireArray(payload.entries, 'entries'),
      ]);
    case 'session.receiveEvent':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requirePlainObject(payload.event, 'event'),
        ...validateEventPayload(payload.event),
        ...optionalPlainObject(payload.options, 'options'),
      ]);
    case 'governance.delegate':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.capability, 'capability'),
        ...requireNonEmptyString(payload.promptKey, 'promptKey'),
        ...requireNonEmptyString(payload.source, 'source'),
        ...validateGovernanceMessages(payload.messages),
        ...optionalPlainObject(payload.toolContext, 'toolContext'),
        ...optionalPositiveInteger(payload.maxTokens, 'maxTokens'),
        ...optionalPositiveInteger(payload.maxToolRounds, 'maxToolRounds'),
        ...optionalResponseFormat(payload.responseFormat),
        ...optionalPlainObject(payload.configOverride, 'configOverride'),
        ...optionalNonEmptyString(payload.correlationId, 'correlationId'),
        ...validateGovernanceValidDecisions(payload.responseFormat, payload.validDecisions),
      ]);
    case 'brain.toolLoop':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.source, 'source'),
        ...validateGovernanceMessages(payload.messages),
        ...validateBrainToolLoopTools(payload.tools),
        ...optionalPlainObject(payload.toolContext, 'toolContext'),
        ...optionalPositiveInteger(payload.maxTokens, 'maxTokens'),
        ...validateMaxToolRounds(payload.maxToolRounds),
        ...optionalNonEmptyString(payload.taskId, 'taskId'),
        ...optionalBoolean(payload.skipInterruptCheck, 'skipInterruptCheck'),
        ...optionalPlainObject(payload.configOverride, 'configOverride'),
        ...optionalNonEmptyString(payload.correlationId, 'correlationId'),
      ]);
    case 'brain.chatToolStream':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.source, 'source'),
        ...validateGovernanceMessages(payload.messages),
        ...validateBrainToolLoopTools(payload.tools),
        ...optionalPlainObject(payload.toolContext, 'toolContext'),
        ...optionalPositiveInteger(payload.maxTokens, 'maxTokens'),
        ...validateMaxToolRounds(payload.maxToolRounds),
        ...optionalNonEmptyString(payload.taskId, 'taskId'),
        ...optionalBoolean(payload.skipInterruptCheck, 'skipInterruptCheck'),
        ...requireStreamTrue(payload.stream),
        ...optionalPlainObject(payload.configOverride, 'configOverride'),
        ...optionalPlainObject(payload.backupConfigOverride, 'backupConfigOverride'),
        ...optionalNonEmptyString(payload.correlationId, 'correlationId'),
      ]);
    case 'brain.toolLoop.resume':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.suspensionId, 'suspensionId'),
        ...requireNonEmptyString(payload.approvalId, 'approvalId'),
        ...validateToolResult(payload.toolResult),
        ...optionalNonEmptyString(payload.decidedBy, 'decidedBy'),
        ...optionalNonEmptyString(payload.correlationId, 'correlationId'),
      ]);
    default:
      return invalid(`unknown request method: ${method}`);
  }
}

export function validateResponsePayload(method, payload) {
  if (!REQUEST_CONTRACTS[method]) {
    return invalid(`unknown request method: ${method}`);
  }
  const objectErrors = validateObjectPayload(payload);
  if (objectErrors.length > 0) return { ok: false, errors: objectErrors };

  switch (method) {
    case 'ce.tick':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...optionalBoolean(payload.processed, 'processed'),
        ...optionalBoolean(payload.skipped, 'skipped'),
        ...optionalString(payload.reason, 'reason'),
      ]);
    case 'cerebellum.l1Tick':
    case 'cerebellum.l2Tick':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...requireBoolean(payload.processed, 'processed'),
        ...optionalBoolean(payload.skipped, 'skipped'),
        ...optionalString(payload.reason, 'reason'),
      ]);
    case 'memory.read':
      return validationResult(requireArray(payload.entries, 'entries'));
    case 'memory.write':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...requireNonNegativeInteger(payload.writtenCount, 'writtenCount'),
      ]);
    case 'session.receiveEvent':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...requireBoolean(payload.accepted, 'accepted'),
      ]);
    case 'governance.delegate':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...requireString(payload.text, 'text'),
        ...optionalPlainObject(payload.usage, 'usage'),
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireNonEmptyString(payload.capability, 'capability'),
        ...optionalBoolean(payload.parsedOk, 'parsedOk'),
      ]);
    case 'brain.toolLoop':
    case 'brain.toolLoop.resume':
    case 'brain.chatToolStream':
      return validationResult([
        ...requireBoolean(payload.ok, 'ok'),
        ...requireString(payload.text, 'text'),
        ...requireUuidString(payload.agentId, 'agentId'),
        ...validateBrainToolLoopStatus(payload.status),
        ...optionalPlainObject(payload.usage, 'usage'),
        ...optionalNonEmptyString(payload.suspensionId, 'suspensionId'),
        ...optionalNonEmptyString(payload.toolCallId, 'toolCallId'),
        ...optionalArray(payload.conversationMessages, 'conversationMessages'),
      ]);
    default:
      return invalid(`unknown request method: ${method}`);
  }
}

export function validateNotificationPayload(method, payload) {
  if (!NOTIFICATION_CONTRACTS[method]) {
    return invalid(`unknown notification method: ${method}`);
  }
  const objectErrors = validateObjectPayload(payload);
  if (objectErrors.length > 0) return { ok: false, errors: objectErrors };

  switch (method) {
    case 'debug_log':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requireOneOf(payload.level, 'level', ['debug', 'info', 'warn', 'error']),
        ...requireNonEmptyString(payload.message, 'message'),
        ...optionalPlainObject(payload.context, 'context'),
      ]);
    case 'hook_event':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requirePlainObject(payload.event, 'event'),
      ]);
    case 'token_usage':
      return validationResult([
        ...requireUuidString(payload.agentId, 'agentId'),
        ...requirePlainObject(payload.usage, 'usage'),
      ]);
    default:
      return invalid(`unknown notification method: ${method}`);
  }
}

export function validateHandshake(payload) {
  const objectErrors = validateObjectPayload(payload);
  if (objectErrors.length > 0) return { ok: false, errors: objectErrors };

  const actual = payload[AGENT_CORE_IPC_HANDSHAKE_FIELD];
  if (actual !== AGENT_CORE_IPC_PROTOCOL_VERSION) {
    return invalid(
      `protocol version mismatch: expected ${AGENT_CORE_IPC_PROTOCOL_VERSION}, got ${String(actual)}`,
    );
  }
  return validationResult([]);
}

function makeRequestContract(contract) {
  return Object.freeze({
    ...contract,
    spaceRegistryFallback: false,
    requestPathUnavailableBehavior: 'return_service_error',
    scheduledUnavailableBehavior: contract.scheduler
      ? 'log_and_skip_cycle_when_daemon_unavailable'
      : 'not_scheduled',
    daemonUnavailableError: DAEMON_UNAVAILABLE_ERROR,
    timeoutError: {
      ...TIMEOUT_ERROR,
      timeoutMs: contract.timeoutMs,
    },
  });
}

function makeNotificationContract(contract) {
  return Object.freeze({
    ...contract,
    spaceRegistryFallback: false,
    responseShape: null,
  });
}

function validateObjectPayload(payload) {
  return isPlainObject(payload) ? [] : ['payload must be an object'];
}

function validationResult(errors) {
  return { ok: errors.length === 0, errors };
}

function invalid(error) {
  return validationResult([error]);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value, field) {
  return typeof value === 'string' && value.length > 0
    ? []
    : [`${field} must be a non-empty string`];
}

function requireUuidString(value, field) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? []
    : [`${field} must be a UUID string`];
}

function optionalNonEmptyString(value, field) {
  if (value === undefined) return [];
  return requireNonEmptyString(value, field).map(
    () => `${field} must be a non-empty string when provided`,
  );
}

function optionalString(value, field) {
  return value === undefined || typeof value === 'string'
    ? []
    : [`${field} must be a string when provided`];
}

function requireBoolean(value, field) {
  return typeof value === 'boolean' ? [] : [`${field} must be a boolean`];
}

function optionalBoolean(value, field) {
  return value === undefined || typeof value === 'boolean'
    ? []
    : [`${field} must be a boolean when provided`];
}

function requireArray(value, field) {
  return Array.isArray(value) ? [] : [`${field} must be an array`];
}

function requirePlainObject(value, field) {
  return isPlainObject(value) ? [] : [`${field} must be an object`];
}

function optionalPlainObject(value, field) {
  if (value === undefined) return [];
  return requirePlainObject(value, field).map(
    () => `${field} must be an object when provided`,
  );
}

function validateEventPayload(event) {
  if (!isPlainObject(event)) return [];
  return [
    ...optionalNonEmptyString(event.id, 'event.id'),
    ...requireNonEmptyString(event.type, 'event.type'),
  ];
}

function optionalPositiveInteger(value, field) {
  if (value === undefined) return [];
  return Number.isInteger(value) && value > 0
    ? []
    : [`${field} must be a positive integer when provided`];
}

function requireNonNegativeInteger(value, field) {
  return Number.isInteger(value) && value >= 0
    ? []
    : [`${field} must be a non-negative integer`];
}

function requireOneOf(value, field, allowed) {
  return allowed.includes(value)
    ? []
    : [`${field} must be one of ${allowed.join(', ')}`];
}

function requireString(value, field) {
  return typeof value === 'string' ? [] : [`${field} must be a string`];
}

const GOVERNANCE_RESPONSE_FORMATS = ['plain_text', 'json_text', 'decision_word'];

function optionalResponseFormat(value) {
  if (value === undefined) return [];
  if (typeof value === 'string' && GOVERNANCE_RESPONSE_FORMATS.includes(value)) {
    return [];
  }
  return [`responseFormat must be one of ${GOVERNANCE_RESPONSE_FORMATS.join(', ')} when provided`];
}

function validateGovernanceMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return ['messages must be a non-empty array of {role,content} entries'];
  }
  const errors = [];
  for (let i = 0; i < messages.length; i += 1) {
    const entry = messages[i];
    if (!isPlainObject(entry)) {
      errors.push(`messages[${i}] must be an object`);
      continue;
    }
    if (typeof entry.role !== 'string' || entry.role.length === 0) {
      errors.push(`messages[${i}].role must be a non-empty string`);
    }
    if (typeof entry.content !== 'string' || entry.content.length === 0) {
      errors.push(`messages[${i}].content must be a non-empty string`);
    }
  }
  return errors;
}

function validateGovernanceValidDecisions(responseFormat, validDecisions) {
  const isDecisionWord = responseFormat === 'decision_word';

  if (validDecisions === undefined) {
    return isDecisionWord
      ? ['validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word']
      : [];
  }

  if (!Array.isArray(validDecisions) || validDecisions.length === 0) {
    return isDecisionWord
      ? ['validDecisions must be a non-empty array of uppercase tokens when responseFormat is decision_word']
      : ['validDecisions must be a non-empty array of uppercase tokens when provided'];
  }

  for (const token of validDecisions) {
    if (typeof token !== 'string' || !VALID_DECISION_TOKEN_PATTERN.test(token)) {
      return ['validDecisions entries must be uppercase non-empty tokens'];
    }
  }

  return [];
}

// Uppercase identifier-style tokens: must start with an ASCII letter A-Z,
// followed by zero or more A-Z / 0-9 / underscore characters. This rejects
// whitespace, punctuation, lowercase letters, leading digits, and leading
// underscores — keeping decision words safe to interpolate into prompts and
// downstream consumers.
const VALID_DECISION_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const BRAIN_TOOL_LOOP_MAX_ROUNDS_CAP = 50;
const BRAIN_TOOL_LOOP_STATUSES = ['completed', 'approval_pending', 'interrupted', 'failed'];
const BRAIN_TOOL_LOOP_EXECUTORS = ['local', 'remote'];

function optionalArray(value, field) {
  if (value === undefined) return [];
  return Array.isArray(value) ? [] : [`${field} must be an array when provided`];
}

// Validate tool definitions in the OpenAI function-calling shape:
//
//   { type?: 'function', function: { name, description?, parameters? },
//     executor?: 'local' | 'remote' }
//
// This is the wire shape every OpenAI-compatible upstream provider expects
// (vLLM, OpenAI, Anthropic with the OpenAI compat shim, etc.) and the shape
// the daemon's downstream `stripExecutorFromTools` helper passes through
// verbatim to the provider. The Space-side tool registry emits the same
// shape with `executor: 'remote'` as the daemon-routing discriminator;
// daemon-internal tools (e.g. `recall`) emit it with `executor: 'local'`.
//
// `type` is OPTIONAL — many OpenAI-compatible providers tolerate its
// absence, and forcing callers to set it adds no real safety here. When
// the caller does send it, it must equal `'function'` (matching the
// OpenAI tool schema). `executor` is also OPTIONAL because tools that
// flow through this IPC boundary already always come from Space (`remote`
// is the only reachable value via this method); we still pin the allowed
// set so future internal callers can't drift the daemon's routing.
function validateBrainToolLoopTools(tools) {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    return ['tools must be an array when provided'];
  }
  const errors = [];
  for (let i = 0; i < tools.length; i += 1) {
    const entry = tools[i];
    if (!isPlainObject(entry)) {
      errors.push(`tools[${i}] must be an object`);
      continue;
    }
    if (entry.type !== undefined && entry.type !== 'function') {
      errors.push(`tools[${i}].type must be "function" when provided`);
    }
    if (!isPlainObject(entry.function)) {
      errors.push(`tools[${i}].function must be an object`);
    } else if (
      typeof entry.function.name !== 'string' ||
      entry.function.name.length === 0
    ) {
      errors.push(`tools[${i}].function.name must be a non-empty string`);
    }
    if (
      entry.executor !== undefined &&
      (typeof entry.executor !== 'string' ||
        !BRAIN_TOOL_LOOP_EXECUTORS.includes(entry.executor))
    ) {
      errors.push(`tools[${i}].executor must be "local" or "remote" when provided`);
    }
  }
  return errors;
}

function validateMaxToolRounds(value) {
  if (value === undefined) return [];
  if (!Number.isInteger(value) || value <= 0) {
    return ['maxToolRounds must be a positive integer when provided'];
  }
  if (value > BRAIN_TOOL_LOOP_MAX_ROUNDS_CAP) {
    return ['maxToolRounds must not exceed 50'];
  }
  return [];
}

function requireStreamTrue(value) {
  return value === true ? [] : ['stream must be true'];
}

function validateBrainToolLoopStatus(value) {
  return typeof value === 'string' && BRAIN_TOOL_LOOP_STATUSES.includes(value)
    ? []
    : [`status must be one of ${BRAIN_TOOL_LOOP_STATUSES.join(', ')}`];
}

function validateToolResult(value) {
  if (!isPlainObject(value)) {
    return ['toolResult must be an object'];
  }
  const errors = [];
  if (value.content !== undefined && typeof value.content !== 'string') {
    errors.push('toolResult.content must be a string when provided');
  }
  if (value.isToolError !== undefined && typeof value.isToolError !== 'boolean') {
    errors.push('toolResult.isToolError must be a boolean when provided');
  }
  // The caller must supply at least one of `content` (the tool's return
  // text) or `isToolError: true` (an explicit tool-error signal with no
  // text payload). An empty object would resume the loop with no signal
  // for the LLM, which is almost certainly a caller bug.
  const hasContent = typeof value.content === 'string';
  const hasToolError = value.isToolError === true;
  if (!hasContent && !hasToolError) {
    errors.push(
      'toolResult must include content (string) or isToolError: true',
    );
  }
  return errors;
}
