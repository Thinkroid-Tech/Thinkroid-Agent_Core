export const AGENT_CORE_IPC_PROTOCOL_VERSION = 'agent-core-ipc/v1';
export const AGENT_CORE_IPC_HANDSHAKE_FIELD = 'agentCoreProtocolVersion';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
