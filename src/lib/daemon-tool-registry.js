// Phase 16.F.3 + F.4 — daemon-side tool registry and runtime push
// handler. Extracted from `bin/agent-core-daemon.js` so unit tests
// can import these helpers without triggering the daemon's top-level
// `main()` (which expects a live IPC channel and exits the process
// otherwise).
//
// The container stores the OpenAI-format tool list received in the
// init payload plus any runtime additions / removals notified via
// `tool:added` / `tool:removed` IPC messages. It exposes:
//
//   - `getAll()`    — full internal list including `executor` etc.
//   - `getForLlm()` — LLM-safe copy with internal fields stripped.
//   - `add(tool)`   — runtime mutator that re-runs `assertUniqueToolNames`
//                     on the post-mutation list (M44 v3 invariance).
//   - `remove(name)` — symmetric mutator.
//
// `installRuntimePushHandlers` taps into `process.on('message')` and
// routes supervisor → daemon notifications into the registry +
// provider/config caches.

import { assertUniqueToolNames } from './assertUniqueToolNames.js';
import { stripLlmInternalFieldsAll } from './strip-llm-internal-fields.js';

/**
 * Build a daemon-side tool registry pre-seeded from the init payload
 * `toolList`. Asserts uniqueness on construction; throws on duplicates
 * so the daemon exits 4 before serving any turn.
 *
 * @param {Array<object>} initialList
 */
export function createDaemonToolRegistry(initialList = []) {
  assertUniqueToolNames(initialList);
  const list = [...initialList];
  return {
    getAll() {
      return [...list];
    },
    getForLlm() {
      return stripLlmInternalFieldsAll(list);
    },
    add(tool) {
      if (!tool || typeof tool !== 'object') return;
      const next = [...list, tool];
      assertUniqueToolNames(next);
      list.push(tool);
    },
    remove(name) {
      if (typeof name !== 'string' || name.length === 0) return false;
      const idx = list.findIndex((t) => t?.function?.name === name);
      if (idx === -1) return false;
      list.splice(idx, 1);
      return true;
    },
    size() {
      return list.length;
    },
  };
}

/**
 * Wire the supervisor → daemon runtime push channel.
 *
 * Subscribes to `process.on('message')` and routes the F.4 family of
 * notifications (`tool:added` / `tool:removed` / `provider:changed` /
 * `config:changed`) into the registry + caches. Other methods (kernel
 * dispatch, init reply, etc.) are ignored — DaemonIpcAdapter handles
 * those on the same channel.
 *
 * L3'.A (Plan §L3'.3 step 4) adds the optional `aiConfigSetter` arm:
 * when a `config:changed` notification arrives the helper now also
 * forwards the params payload to the AI-config resolver cache so the
 * next `brain.chat` turn picks up the refreshed provider/model triple
 * without restarting the daemon.
 *
 * L3'.B (Plan §L3'.1 step 2) adds the optional `athenaModeSetter` arm.
 * `athena_mode` is a GLOBAL setting (`scope='global'`, no `agentId`)
 * so the supervisor's `broadcastConfigChanged` fans it out to every
 * daemon. The setter is intentionally separate from `aiConfigSetter`
 * because the latter rejects payloads without a matching `agentId`
 * (per L3'.A's two-layer filter). Both arms run on the same
 * `config:changed` notification — each with its own filter — so the
 * Athena daemon picks up mode flips while non-Athena daemons silently
 * ignore them.
 *
 * Returns a teardown function that removes the listener (used by tests
 * to keep `process` event-listener counts stable across runs).
 *
 * @param {{ toolRegistry: ReturnType<typeof createDaemonToolRegistry>, providerCache?: { set: Function }, configCache?: { set: Function }, aiConfigSetter?: (params: object) => void, athenaModeSetter?: (params: object) => void }} ctx
 * @returns {() => void}
 */
export function installRuntimePushHandlers({ toolRegistry, providerCache, configCache, aiConfigSetter, athenaModeSetter }) {
  const handler = (msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return;
    switch (msg.method) {
      case 'tool:added': {
        const tool = msg.params?.tool;
        if (tool) toolRegistry.add(tool);
        break;
      }
      case 'tool:removed': {
        const name = msg.params?.name;
        if (name) toolRegistry.remove(name);
        break;
      }
      case 'provider:changed': {
        if (providerCache) providerCache.set(msg.params ?? {});
        break;
      }
      case 'config:changed': {
        if (configCache) configCache.set(msg.params?.key, msg.params);
        if (typeof aiConfigSetter === 'function') {
          try { aiConfigSetter(msg.params ?? {}); }
          catch { /* swallow — refresh is best-effort */ }
        }
        if (typeof athenaModeSetter === 'function') {
          try { athenaModeSetter(msg.params ?? {}); }
          catch { /* swallow — refresh is best-effort */ }
        }
        break;
      }
      default:
        break;
    }
  };
  process.on('message', handler);
  return () => process.off('message', handler);
}
