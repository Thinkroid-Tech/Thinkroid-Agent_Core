// Phase 16 — daemon-side `tool.invoke` dispatcher tests for the
// remote-executor branch (`createToolInvokeHandler` → `invokeRemoteTool`).
//
// Exercises the envelope contract spoken between the daemon and Space's
// `space.tool.invoke` handler:
//
//   - Class A success envelope from Space → returned unchanged.
//   - Class A tool-error envelope → returned unchanged.
//   - Class B (IPC adapter throw) → wrapped as a Class A tool-error.
//   - Empty / non-object response → wrapped as a Class A tool-error.
//   - APPROVAL_PENDING envelope (daemon→Space tool callback approval
//     bridge): `{ ok: false, code: 'APPROVAL_PENDING', approvalId,
//     name, args }` → returned unchanged.
//   - Generic `{ ok: false }` (no code) → returned unchanged
//     (defensive pass-through; never coerced into `{ content }`).
//
// `invokeRemoteTool` is internal so we drive it through the public
// factory `createToolInvokeHandler` with a registry whose tool entry
// carries `executor: 'remote'`.

import { describe, expect, it, vi } from 'vitest';

import { createToolInvokeHandler } from '../../src/lib/daemon-tool-invoke.js';

function makeRemoteRegistry() {
  return {
    getAll: () => [
      {
        executor: 'remote',
        function: { name: 'file_write' },
      },
    ],
  };
}

function makeAdapter(responder) {
  return { request: vi.fn(async (...args) => responder(...args)) };
}

function makeHandler({ adapter, agentId = 'a-1', agentName = 'Alice' } = {}) {
  return createToolInvokeHandler({
    toolRegistry: makeRemoteRegistry(),
    localContext: {},
    ipcAdapter: adapter,
    agentId,
    agentName,
  });
}

describe('daemon tool.invoke — remote dispatch envelope handling', () => {
  it('passes through Class A success envelopes unchanged', async () => {
    const adapter = makeAdapter(async () => ({ content: 'wrote 12 bytes' }));
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: { path: 'x.txt' }, ctx: { sessionId: 's1' } },
      {},
    );

    expect(out).toEqual({ result: { content: 'wrote 12 bytes' } });
    expect(adapter.request).toHaveBeenCalledTimes(1);
    expect(adapter.request.mock.calls[0][0]).toBe('space.tool.invoke');
    expect(adapter.request.mock.calls[0][1]).toEqual({
      name: 'file_write',
      args: { path: 'x.txt' },
      ctx: { agentId: 'a-1', agentName: 'Alice', sessionId: 's1' },
    });
  });

  it('passes through Class A tool-error envelopes unchanged', async () => {
    const adapter = makeAdapter(async () => ({
      content: 'Permission denied: file_write is not allowed.',
      isToolError: true,
    }));
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: {}, ctx: {} },
      {},
    );

    expect(out).toEqual({
      result: {
        content: 'Permission denied: file_write is not allowed.',
        isToolError: true,
      },
    });
  });

  it('wraps Class B (IPC throw) as a Class A tool-error', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('IPC transport timed out');
    });
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: {}, ctx: {} },
      {},
    );

    expect(out.result.isToolError).toBe(true);
    expect(out.result.content).toMatch(/Tool execution failed/);
    expect(out.result.content).toMatch(/IPC transport timed out/);
  });

  it('wraps empty / non-object responses as a Class A tool-error', async () => {
    const adapter = makeAdapter(async () => undefined);
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: {}, ctx: {} },
      {},
    );

    expect(out.result.isToolError).toBe(true);
    expect(out.result.content).toMatch(/empty response from Space for file_write/);
  });

  it('passes through APPROVAL_PENDING envelopes unchanged', async () => {
    const adapter = makeAdapter(async () => ({
      ok: false,
      code: 'APPROVAL_PENDING',
      approvalId: 'approval-abc',
      name: 'file_write',
      args: { path: 'x.txt' },
    }));
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: { path: 'x.txt' }, ctx: {} },
      {},
    );

    expect(out).toEqual({
      result: {
        ok: false,
        code: 'APPROVAL_PENDING',
        approvalId: 'approval-abc',
        name: 'file_write',
        args: { path: 'x.txt' },
      },
    });
  });

  it('passes through generic { ok: false } envelopes unchanged', async () => {
    const adapter = makeAdapter(async () => ({ ok: false }));
    const handler = makeHandler({ adapter });

    const out = await handler(
      { name: 'file_write', args: {}, ctx: {} },
      {},
    );

    expect(out).toEqual({ result: { ok: false } });
  });
});
