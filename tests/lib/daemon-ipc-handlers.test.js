import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Kernel } from '../../src/kernel.js';
import { IPC_ERROR_CODES } from '../../src/adapters/ipc-errors.js';
import {
  createDaemonBuildSystemPrompt,
  registerDaemonIpcHandlers,
} from '../../src/handlers/daemon-ipc-handlers.js';
import { ThinkroidMemory } from '../../modules/thinkroid-memory/src/api.js';
import { openAgentCoreDb } from '../../src/stores/agent-core-db/db.js';
import { SessionMetaStore } from '../../src/stores/agent-core-db/session-meta-store.js';
import { SessionHistoryStore } from '../../src/stores/agent-core-db/session-history-store.js';
import { CerebellumL2 } from '../../src/cerebellum/layer2.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222';

const tempDirs = new Set();

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-ipc-'));
  tempDirs.add(dir);

  const memoryClient = new ThinkroidMemory(path.join(dir, 'memory.db'), AGENT_ID);
  memoryClient.open();
  const agentCoreDb = openAgentCoreDb(path.join(dir, 'agent-core.db'));
  const kernel = new Kernel();

  registerDaemonIpcHandlers(kernel, {
    agentId: AGENT_ID,
    agentName: 'Daemon Alice',
    memoryClient,
    memDb: memoryClient.db,
    agentCoreDb,
    ...overrides,
  });

  return { kernel, memoryClient, agentCoreDb };
}

function createSession(agentCoreDb, overrides = {}) {
  const now = Date.now();
  const metaStore = new SessionMetaStore(agentCoreDb);
  const historyStore = new SessionHistoryStore(agentCoreDb);
  metaStore.create({
    session_id: overrides.session_id ?? 'session-1',
    parent_session_id: null,
    agent_id: overrides.agent_id ?? AGENT_ID,
    summary: '',
    tags: [],
    status: overrides.status ?? 'awake',
    turn_count: overrides.turn_count ?? 0,
    context_size_pct: 0,
    pending_requests: 0,
    keepalive_renewals: 0,
    keepalive_start_time: null,
    linger: false,
    linger_count: 0,
    cerebellum_l1_cursor: overrides.cerebellum_l1_cursor ?? 0,
    cerebellum_l2_cursor: overrides.cerebellum_l2_cursor ?? 0,
    created_at: now,
    last_active_at: now,
  });
  return { metaStore, historyStore };
}

function expectJsonRpcApplicationError(promise, message) {
  return expect(promise).rejects.toMatchObject({
    jsonRpc: expect.objectContaining({
      code: IPC_ERROR_CODES.APPLICATION,
      message: expect.stringContaining(message),
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('daemon IPC handlers', () => {
  it('registers locked daemon-side methods including session.receiveEvent runtime', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      expect(kernel.listMethods()).toEqual([
        'ce.tick',
        'cerebellum.l1Tick',
        'cerebellum.l2Tick',
        'memory.read',
        'memory.write',
        'session.receiveEvent',
      ]);

      await expect(kernel.dispatch('ce.tick', { agentId: AGENT_ID }))
        .resolves.toEqual({
          ok: true,
          processed: false,
          skipped: true,
          reason: 'no_scheduled_ce_work',
        });
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('routes session.receiveEvent through the lazy daemon supervisor runtime', async () => {
    const supervisor = {
      receiveEvent: vi.fn(async () => ({
        action: 'create_session',
        session_id: 'session-runtime-1',
        brainResponse: 'daemon reply',
      })),
    };
    const createSessionRuntime = vi.fn(() => supervisor);
    const { kernel, memoryClient, agentCoreDb } = makeDeps({ createSessionRuntime });

    try {
      await expect(kernel.dispatch('session.receiveEvent', {
        agentId: AGENT_ID,
        event: { type: 'user.message', payload: { content: 'hello' } },
        options: { sceneId: 'chat', dynamicData: { mood: 'focused' } },
      })).resolves.toEqual({
        ok: true,
        accepted: true,
        action: 'create_session',
        session_id: 'session-runtime-1',
        brainResponse: 'daemon reply',
      });

      expect(createSessionRuntime).toHaveBeenCalledTimes(1);
      expect(supervisor.receiveEvent).toHaveBeenCalledWith(
        { type: 'user.message', payload: { content: 'hello' } },
        { sceneId: 'chat', dynamicData: { mood: 'focused' } },
      );
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('builds a text-only daemon Supervisor runtime for session.receiveEvent', async () => {
    const ipcAdapter = {
      request: vi.fn(async () => ({
        system: 'Runtime system prompt',
        user: 'Runtime user prompt',
      })),
    };
    const toolRegistry = {
      getForLlm: vi.fn(() => [{
        type: 'function',
        function: {
          name: 'remote_tool',
          description: 'Must not be passed to the Task 9 text shim provider call.',
          parameters: { type: 'object', properties: {} },
        },
      }]),
    };
    const providerCalls = [];
    const streamChatCompletion = vi.fn(async function* fakeTextOnlyProvider(params) {
      providerCalls.push(params);
      yield 'runtime ';
      yield 'brain reply';
    });
    const { kernel, memoryClient, agentCoreDb } = makeDeps({
      ipcAdapter,
      toolRegistry,
      brainConfig: {
        provider: 'openai-compatible',
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: 'http://example.invalid/v1',
      },
      streamChatCompletion,
    });

    try {
      const result = await kernel.dispatch('session.receiveEvent', {
        agentId: AGENT_ID,
        event: { type: 'user.message', payload: { content: 'hello runtime' } },
        options: { sceneId: 'chat' },
      });

      expect(result).toMatchObject({
        ok: true,
        accepted: true,
        action: 'create_session',
        brainResponse: 'runtime brain reply',
      });
      expect(result.session_id).toEqual(expect.any(String));
      expect(ipcAdapter.request).toHaveBeenCalledWith(
        'space.scene.render',
        expect.objectContaining({
          agentId: AGENT_ID,
          agentName: 'Daemon Alice',
          sceneId: 'chat',
        }),
        { timeoutMs: 30000 },
      );
      expect(toolRegistry.getForLlm).toHaveBeenCalled();
      expect(streamChatCompletion).toHaveBeenCalled();
      expect(providerCalls[0]).not.toHaveProperty('tools');
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('builds system prompts through space.scene.render IPC', async () => {
    const ipcAdapter = {
      request: vi.fn(async () => ({
        system: 'Rendered system prompt',
        user: 'Rendered user prompt',
      })),
    };
    const buildSystemPrompt = createDaemonBuildSystemPrompt({
      ipcAdapter,
      agentId: AGENT_ID,
      agentName: 'Daemon Alice',
    });

    await expect(buildSystemPrompt({
      sceneId: 'chat',
      dynamicData: { foo: 'bar' },
      contextParams: { source: 'test' },
    })).resolves.toEqual({
      system: 'Rendered system prompt',
      user: 'Rendered user prompt',
    });

    expect(ipcAdapter.request).toHaveBeenCalledWith(
      'space.scene.render',
      {
        agentId: AGENT_ID,
        agentName: 'Daemon Alice',
        sceneId: 'chat',
        dynamicData: { foo: 'bar' },
        contextParams: { source: 'test' },
      },
      { timeoutMs: 30000 },
    );
  });

  it('rejects malformed payloads and mismatched agent IDs as application errors', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      await expectJsonRpcApplicationError(
        kernel.dispatch('memory.read', { agentId: AGENT_ID }),
        'query must be a non-empty string',
      );
      await expectJsonRpcApplicationError(
        kernel.dispatch('memory.read', { agentId: OTHER_AGENT_ID, query: 'x' }),
        'agentId mismatch',
      );
      await expectJsonRpcApplicationError(
        kernel.dispatch('memory.write', { agentId: AGENT_ID, entries: [{ content: ' ' }] }),
        'entries[0].content must be a non-empty string',
      );
      await expectJsonRpcApplicationError(
        kernel.dispatch('session.receiveEvent', { agentId: AGENT_ID, event: { type: '' } }),
        'event.type must be a non-empty string',
      );
      await expectJsonRpcApplicationError(
        kernel.dispatch('session.receiveEvent', {
          agentId: OTHER_AGENT_ID,
          event: { type: 'user.message' },
        }),
        'agentId mismatch',
      );
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('writes daemon-owned memory rows and reads them through read-only search', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      await expect(kernel.dispatch('memory.write', {
        agentId: AGENT_ID,
        entries: [{
          content: 'Daemon IPC memory write stores project launch facts.',
          layer: 'short',
          tags: ['ipc', 'launch'],
          sourceSession: 'session-abc',
          confidence: 'high',
        }],
      })).resolves.toEqual({ ok: true, writtenCount: 1 });

      const row = memoryClient.db.prepare('SELECT * FROM memories').get();
      expect(row).toMatchObject({
        layer: 'short',
        content: 'Daemon IPC memory write stores project launch facts.',
        source_session: 'session-abc',
        confidence: 'high',
        writer: 'cerebellum-l1',
      });
      expect(memoryClient.db.prepare('SELECT name FROM tags ORDER BY name').all())
        .toEqual([{ name: 'ipc' }, { name: 'launch' }]);

      const result = await kernel.dispatch('memory.read', {
        agentId: AGENT_ID,
        query: 'launch',
        limit: 5,
      });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        content: 'Daemon IPC memory write stores project launch facts.',
        tags: ['ipc', 'launch'],
      });
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('accepts memory.write type aliases such as fact and maps them to a valid layer', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      await expect(kernel.dispatch('memory.write', {
        agentId: AGENT_ID,
        entries: [{ type: 'fact', content: 'The fact alias should write as a long memory.' }],
      })).resolves.toEqual({ ok: true, writtenCount: 1 });

      const row = memoryClient.db.prepare('SELECT layer, content FROM memories').get();
      expect(row).toEqual({
        layer: 'long',
        content: 'The fact alias should write as a long memory.',
      });
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('runs L1 tick with injected channel and advances eligible session cursor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-ipc-'));
    tempDirs.add(dir);
    const memoryClient = new ThinkroidMemory(path.join(dir, 'memory.db'), AGENT_ID);
    memoryClient.open();
    const agentCoreDb = openAgentCoreDb(path.join(dir, 'agent-core.db'));
    const kernel = new Kernel();
    const channel = vi.fn(async () => '[none]');
    registerDaemonIpcHandlers(kernel, {
      agentId: AGENT_ID,
      agentName: 'Daemon Alice',
      memoryClient,
      memDb: memoryClient.db,
      agentCoreDb,
      cerebellumChannel: channel,
    });

    try {
      const { metaStore, historyStore } = createSession(agentCoreDb);
      historyStore.append({
        sessionId: 'session-1',
        role: 'user',
        content: 'Remember that this session should advance L1.',
        status: 'completed',
      });

      await expect(kernel.dispatch('cerebellum.l1Tick', { agentId: AGENT_ID }))
        .resolves.toEqual({ ok: true, processed: true, skipped: false });
      expect(metaStore.get('session-1').cerebellum_l1_cursor).toBe(1);
      expect(channel).toHaveBeenCalled();
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('skips L1 tick without a channel and leaves pending cursors unchanged', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      const { metaStore, historyStore } = createSession(agentCoreDb);
      historyStore.append({
        sessionId: 'session-1',
        role: 'user',
        content: 'This pending turn must not be discarded without a channel.',
        status: 'completed',
      });

      await expect(kernel.dispatch('cerebellum.l1Tick', { agentId: AGENT_ID }))
        .resolves.toEqual({
          ok: true,
          processed: false,
          skipped: true,
          reason: 'cerebellum_channel_unavailable',
        });
      expect(metaStore.get('session-1').cerebellum_l1_cursor).toBe(0);
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('skips L2 tick without a channel and leaves dormant cursors unchanged', async () => {
    const { kernel, memoryClient, agentCoreDb } = makeDeps();
    try {
      const { metaStore, historyStore } = createSession(agentCoreDb, {
        status: 'dormant',
        turn_count: 1,
      });
      historyStore.append({
        sessionId: 'session-1',
        role: 'user',
        content: 'This dormant turn must not be summarized without a channel.',
        status: 'completed',
      });

      await expect(kernel.dispatch('cerebellum.l2Tick', { agentId: AGENT_ID }))
        .resolves.toEqual({
          ok: true,
          processed: false,
          skipped: true,
          reason: 'cerebellum_channel_unavailable',
        });
      expect(metaStore.get('session-1').cerebellum_l2_cursor).toBe(0);
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('runs L2 tick safely when no sessions are eligible', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-ipc-'));
    tempDirs.add(dir);
    const memoryClient = new ThinkroidMemory(path.join(dir, 'memory.db'), AGENT_ID);
    memoryClient.open();
    const agentCoreDb = openAgentCoreDb(path.join(dir, 'agent-core.db'));
    const kernel = new Kernel();
    registerDaemonIpcHandlers(kernel, {
      agentId: AGENT_ID,
      agentName: 'Daemon Alice',
      memoryClient,
      memDb: memoryClient.db,
      agentCoreDb,
      cerebellumChannel: vi.fn(async () => '[none]'),
    });
    try {
      await expect(kernel.dispatch('cerebellum.l2Tick', { agentId: AGENT_ID }))
        .resolves.toEqual({ ok: true, processed: false, skipped: false });
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });

  it('passes validated L2 settings into CerebellumL2 constructor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-core-ipc-'));
    tempDirs.add(dir);
    const memoryClient = new ThinkroidMemory(path.join(dir, 'memory.db'), AGENT_ID);
    memoryClient.open();
    const agentCoreDb = openAgentCoreDb(path.join(dir, 'agent-core.db'));
    const kernel = new Kernel();
    const observed = [];
    const tickSpy = vi
      .spyOn(CerebellumL2.prototype, 'tick')
      .mockImplementation(function captureConstructorOptions() {
        observed.push({
          pruneThreshold: this._pruneThreshold,
          promotionThresholds: this._promotionThresholds,
          arbitrary: this.arbitrary,
        });
        return Promise.resolve();
      });

    registerDaemonIpcHandlers(kernel, {
      agentId: AGENT_ID,
      agentName: 'Daemon Alice',
      memoryClient,
      memDb: memoryClient.db,
      agentCoreDb,
      cerebellumChannel: vi.fn(async () => '[none]'),
    });

    try {
      await expect(kernel.dispatch('cerebellum.l2Tick', {
        agentId: AGENT_ID,
        settings: {
          pruneThreshold: 0.42,
          promotionThresholds: { short: 4, short_skill: 9 },
          arbitrary: 'must-not-be-forwarded',
        },
      })).resolves.toEqual({ ok: true, processed: false, skipped: false });

      expect(tickSpy).toHaveBeenCalledTimes(1);
      expect(observed).toEqual([{
        pruneThreshold: 0.42,
        promotionThresholds: { short: 4, short_skill: 9 },
        arbitrary: undefined,
      }]);
    } finally {
      agentCoreDb.close();
      memoryClient.close();
    }
  });
});
