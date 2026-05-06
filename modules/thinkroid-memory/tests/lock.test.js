import { describe, it, expect } from 'vitest';
import { Lock } from '../src/lock.js';

describe('Lock', () => {
  it('single acquire/release round-trip', async () => {
    const lock = new Lock();
    expect(lock.isHeld).toBe(false);
    const release = await lock.acquire();
    expect(lock.isHeld).toBe(true);
    release();
    expect(lock.isHeld).toBe(false);
  });

  it('two concurrent acquires: second waits until first releases', async () => {
    const lock = new Lock();
    const order = [];

    const release1 = await lock.acquire();
    order.push('acquired-1');

    // Start second acquire — it should NOT resolve yet
    const p2 = lock.acquire().then((release2) => {
      order.push('acquired-2');
      return release2;
    });

    // Yield microtask — p2 should still be waiting
    await Promise.resolve();
    expect(order).toEqual(['acquired-1']);

    // Release first — p2 should now resolve
    release1();
    const release2 = await p2;
    expect(order).toEqual(['acquired-1', 'acquired-2']);
    release2();
  });

  it('three queued acquires execute in FIFO order', async () => {
    const lock = new Lock();
    const order = [];

    const release1 = await lock.acquire();

    const p2 = lock.acquire().then((r) => { order.push(2); return r; });
    const p3 = lock.acquire().then((r) => { order.push(3); return r; });

    release1();

    const release2 = await p2;
    release2();

    const release3 = await p3;
    release3();

    expect(order).toEqual([2, 3]);
  });

  it('withLock wraps sync function', async () => {
    const lock = new Lock();
    const result = await lock.withLock(() => 42);
    expect(result).toBe(42);
    expect(lock.isHeld).toBe(false);
  });

  it('withLock wraps async function', async () => {
    const lock = new Lock();
    const result = await lock.withLock(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 'async-result';
    });
    expect(result).toBe('async-result');
    expect(lock.isHeld).toBe(false);
  });

  it('withLock releases on thrown error and next acquire proceeds', async () => {
    const lock = new Lock();

    // First withLock throws
    await expect(lock.withLock(() => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(lock.isHeld).toBe(false);

    // Next acquire should proceed immediately
    const release = await lock.acquire();
    expect(lock.isHeld).toBe(true);
    release();
  });

  it('lock is re-usable after error', async () => {
    const lock = new Lock();

    // Error path
    await expect(lock.withLock(() => { throw new Error('fail'); })).rejects.toThrow();

    // Normal path still works
    const result = await lock.withLock(() => 'ok');
    expect(result).toBe('ok');
  });

  it('two Lock instances do not block each other', async () => {
    const lock1 = new Lock();
    const lock2 = new Lock();
    const order = [];

    const release1 = await lock1.acquire();
    const release2 = await lock2.acquire();
    order.push('both-acquired');

    release1();
    release2();
    order.push('both-released');

    expect(order).toEqual(['both-acquired', 'both-released']);
  });
});
