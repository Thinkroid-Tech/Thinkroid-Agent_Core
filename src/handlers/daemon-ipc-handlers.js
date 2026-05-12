import { IPC_ERROR_CODES } from '../adapters/ipc-errors.js';
import { throwJsonRpcError } from '../kernel.js';
import {
  validateRequestPayload,
  validateResponsePayload,
} from '../ipc/agent-core-contract.js';
import { CerebellumL1 } from '../cerebellum/layer1.js';
import { CerebellumL2 } from '../cerebellum/layer2.js';
import { SessionMetaStore } from '../stores/agent-core-db/session-meta-store.js';
import { SessionHistoryStore } from '../stores/agent-core-db/session-history-store.js';

const MEMORY_LAYERS = new Set(['short', 'long', 'short_skill', 'long_skill']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
const MEMORY_TYPE_LAYER_ALIASES = Object.freeze({
  fact: 'long',
});

function rejectApplication(method, message, data = {}) {
  throwJsonRpcError(IPC_ERROR_CODES.APPLICATION, message, { method, ...data });
}

function validateRequest(method, params, boundAgentId) {
  const validation = validateRequestPayload(method, params);
  if (!validation.ok) {
    rejectApplication(method, validation.errors.join('; '), {
      errors: validation.errors,
    });
  }
  if (params.agentId !== boundAgentId) {
    rejectApplication(method, `agentId mismatch: expected ${boundAgentId}`, {
      expectedAgentId: boundAgentId,
      actualAgentId: params.agentId,
    });
  }
}

function validateResponse(method, payload) {
  const validation = validateResponsePayload(method, payload);
  if (!validation.ok) {
    rejectApplication(method, `invalid ${method} response: ${validation.errors.join('; ')}`, {
      errors: validation.errors,
    });
  }
  return payload;
}

function normalizeLayer(entry, index) {
  const raw = entry.layer ?? entry.type ?? 'long';
  const candidate = entry.layer === undefined && typeof raw === 'string'
    ? (MEMORY_TYPE_LAYER_ALIASES[raw] ?? raw)
    : raw;
  if (typeof candidate !== 'string' || !MEMORY_LAYERS.has(candidate)) {
    rejectApplication('memory.write', `entries[${index}].layer/type must be one of: ${[...MEMORY_LAYERS].join(', ')}`);
  }
  return candidate;
}

function normalizeTags(entry, index) {
  if (entry.tags === undefined) return [];
  if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== 'string')) {
    rejectApplication('memory.write', `entries[${index}].tags must be an array of strings`);
  }
  return entry.tags;
}

function normalizeConfidence(entry, index) {
  const confidence = entry.confidence ?? 'medium';
  if (typeof confidence !== 'string' || !CONFIDENCE_LEVELS.has(confidence)) {
    rejectApplication('memory.write', `entries[${index}].confidence must be one of: high, medium, low`);
  }
  return confidence;
}

function normalizeMemoryEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    rejectApplication('memory.write', `entries[${index}] must be an object`);
  }
  if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
    rejectApplication('memory.write', `entries[${index}].content must be a non-empty string`);
  }

  return {
    content: entry.content.trim(),
    layer: normalizeLayer(entry, index),
    tags: normalizeTags(entry, index),
    source_session: entry.sourceSession ?? entry.source_session ?? 'memory.write',
    source_timestamp: entry.sourceTimestamp ?? entry.source_timestamp ?? Date.now(),
    confidence: normalizeConfidence(entry, index),
  };
}

function buildStores(agentCoreDb) {
  return {
    metaStore: new SessionMetaStore(agentCoreDb),
    historyStore: new SessionHistoryStore(agentCoreDb),
  };
}

function hasPendingL1Work({ agentId, metaStore, historyStore }) {
  return metaStore
    .list({ agentId })
    .some((session) => (
      ['awake', 'drowsy', 'dormant'].includes(session.status)
      && historyStore.length(session.session_id) > (session.cerebellum_l1_cursor || 0)
    ));
}

function hasPendingL2Work({ agentId, metaStore, historyStore }) {
  return metaStore
    .list({ agentId })
    .some((session) => (
      session.status === 'dormant'
      && historyStore.length(session.session_id) > (session.cerebellum_l2_cursor || 0)
    ));
}

export function createCeTickHandler({ agentId }) {
  return async (params) => {
    const method = 'ce.tick';
    validateRequest(method, params, agentId);
    return validateResponse(method, {
      ok: true,
      processed: false,
      skipped: true,
      reason: 'no_scheduled_ce_work',
    });
  };
}

export function createMemoryReadHandler({ agentId, memoryClient }) {
  return async (params) => {
    const method = 'memory.read';
    validateRequest(method, params, agentId);
    const entries = memoryClient
      .viewForReadOnly()
      .search({ kw: params.query, limit: params.limit ?? 10 });
    return validateResponse(method, { entries });
  };
}

export function createMemoryWriteHandler({ agentId, memoryClient }) {
  return async (params) => {
    const method = 'memory.write';
    validateRequest(method, params, agentId);
    const entries = params.entries.map((entry, index) => normalizeMemoryEntry(entry, index));

    await memoryClient.lock.withLock(() => {
      const view = memoryClient.viewForCerebellumL1();
      for (const entry of entries) {
        view.write(entry);
      }
    });

    return validateResponse(method, { ok: true, writtenCount: entries.length });
  };
}

export function createCerebellumL1TickHandler({
  agentId,
  agentName,
  memoryClient,
  agentCoreDb,
  cerebellumChannel,
}) {
  return async (params) => {
    const method = 'cerebellum.l1Tick';
    validateRequest(method, params, agentId);
    if (typeof cerebellumChannel !== 'function') {
      return validateResponse(method, {
        ok: true,
        processed: false,
        skipped: true,
        reason: 'cerebellum_channel_unavailable',
      });
    }
    const { metaStore, historyStore } = buildStores(agentCoreDb);
    const processed = hasPendingL1Work({ agentId, metaStore, historyStore });
    const l1 = new CerebellumL1({
      agentId,
      agentName,
      memory: memoryClient,
      metaStore,
      historyStore,
      cerebellumChannel,
    });
    await l1.tick();
    return validateResponse(method, { ok: true, processed, skipped: false });
  };
}

export function createCerebellumL2TickHandler({
  agentId,
  agentName,
  memoryClient,
  agentCoreDb,
  cerebellumChannel,
}) {
  return async (params) => {
    const method = 'cerebellum.l2Tick';
    validateRequest(method, params, agentId);
    if (typeof cerebellumChannel !== 'function') {
      return validateResponse(method, {
        ok: true,
        processed: false,
        skipped: true,
        reason: 'cerebellum_channel_unavailable',
      });
    }
    const { metaStore, historyStore } = buildStores(agentCoreDb);
    const processed = hasPendingL2Work({ agentId, metaStore, historyStore });
    const l2 = new CerebellumL2({
      agentId,
      agentName,
      memory: memoryClient,
      metaStore,
      historyStore,
      cerebellumChannel,
    });
    await l2.tick();
    return validateResponse(method, { ok: true, processed, skipped: false });
  };
}

export function createSessionReceiveEventHandler({ agentId }) {
  return async (params) => {
    const method = 'session.receiveEvent';
    validateRequest(method, params, agentId);
    return { ok: false, accepted: false, reason: 'not_ready' };
  };
}

export function registerDaemonIpcHandlers(kernel, deps) {
  const { agentId, memoryClient, memDb, agentCoreDb } = deps ?? {};
  if (!kernel) throw new TypeError('registerDaemonIpcHandlers requires kernel');
  if (!agentId) throw new TypeError('registerDaemonIpcHandlers requires agentId');
  if (!memoryClient) throw new TypeError('registerDaemonIpcHandlers requires memoryClient');
  if (!memDb) throw new TypeError('registerDaemonIpcHandlers requires memDb');
  if (!agentCoreDb) throw new TypeError('registerDaemonIpcHandlers requires agentCoreDb');

  kernel.registerHandler('ce.tick', createCeTickHandler(deps));
  kernel.registerHandler('cerebellum.l1Tick', createCerebellumL1TickHandler(deps));
  kernel.registerHandler('cerebellum.l2Tick', createCerebellumL2TickHandler(deps));
  kernel.registerHandler('memory.read', createMemoryReadHandler(deps));
  kernel.registerHandler('memory.write', createMemoryWriteHandler(deps));
  kernel.registerHandler('session.receiveEvent', createSessionReceiveEventHandler(deps));
}
