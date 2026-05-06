/**
 * Promise-chain mutex for serializing L1/L2 memory operations.
 *
 * Each ThinkroidMemory instance owns one Lock. Bootstrap acquires the lock
 * before calling L1/L2 writer methods (views do NOT acquire it themselves).
 *
 * Pattern: a linked chain of promises. acquire() appends a gate and waits
 * for the previous gate to open. release() opens the current gate, letting
 * the next waiter proceed.
 *
 * @module thinkroid-memory/lock
 */

export class Lock {
  constructor() {
    /** @type {Promise<void>} */
    this._tail = Promise.resolve();
    this._held = false;
  }

  /**
   * Acquire exclusive access. Resolves when no other holder is active.
   * @returns {Promise<() => void>} Release function — call in `finally` block.
   */
  async acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const prev = this._tail;
    this._tail = this._tail.then(() => next);
    await prev;
    this._held = true;
    return () => {
      this._held = false;
      release();
    };
  }

  /**
   * Convenience wrapper: acquire, run fn, release on success or error.
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withLock(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @returns {boolean} True if the lock is currently held. */
  get isHeld() {
    return this._held;
  }
}
