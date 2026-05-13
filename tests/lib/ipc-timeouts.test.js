import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIMEOUT_MS,
  IPC_METHOD_TIMEOUTS_MS,
  resolveTimeoutMs,
} from '../../src/adapters/ipc-timeouts.js';

describe('IPC method timeouts', () => {
  it('exposes the locked per-method timeout table', () => {
    expect(IPC_METHOD_TIMEOUTS_MS['ce.tick']).toBe(30_000);
    expect(IPC_METHOD_TIMEOUTS_MS['cerebellum.l1Tick']).toBe(60_000);
    expect(IPC_METHOD_TIMEOUTS_MS['cerebellum.l2Tick']).toBe(120_000);
    expect(IPC_METHOD_TIMEOUTS_MS['memory.read']).toBe(30_000);
    expect(IPC_METHOD_TIMEOUTS_MS['memory.write']).toBe(30_000);
    expect(IPC_METHOD_TIMEOUTS_MS['session.receiveEvent']).toBe(30_000);
    expect(IPC_METHOD_TIMEOUTS_MS['governance.delegate']).toBe(120_000);
  });

  it('keeps the timeout table frozen', () => {
    expect(Object.isFrozen(IPC_METHOD_TIMEOUTS_MS)).toBe(true);
  });

  it('resolves governance.delegate to 120_000 ms when no opts override is supplied', () => {
    expect(resolveTimeoutMs('governance.delegate')).toBe(120_000);
  });

  it('honors caller-supplied opts timeout for governance.delegate', () => {
    expect(resolveTimeoutMs('governance.delegate', 5_000)).toBe(5_000);
  });

  it('falls back to DEFAULT_TIMEOUT_MS for unknown methods', () => {
    expect(resolveTimeoutMs('unknown.method')).toBe(DEFAULT_TIMEOUT_MS);
  });
});
