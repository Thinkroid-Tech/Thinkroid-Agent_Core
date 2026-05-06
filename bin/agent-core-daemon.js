#!/usr/bin/env node
// Phase 16.C — per-agent daemon entrypoint.
//
// The Space supervisor `fork()`s one of these per registered agent, then
// `process.send({type:'init', config})`s the resolved init payload (Design
// §3.2). The child runs the locked S1-S17 startup sequence below, opens
// its per-agent SQLite handles, replies with `daemon:ready`, and stays
// resident handling IPC requests until SIGTERM.
//
// Exit code map (Design §3.1, table reproduced verbatim — the supervisor
// reads exit codes back from `child.exit` and writes them into
// `daemon_events.payload.reason`, so they MUST stay stable):
//
//   | Code  | Meaning                                                 |
//   | ----- | ------------------------------------------------------- |
//   | 0     | Graceful shutdown (SIGTERM completed)                   |
//   | 1     | Uncaught exception (default Node)                       |
//   | 2     | Standalone mode attempted (Q24)                         |
//   | 3     | Init handshake timeout (no `init` message in 30s)       |
//   | 4     | Init payload validation error                           |
//   | 5     | Unix socket bind failed                                 |
//   | 6     | SQLite open failed                                      |
//   | 128+N | Signal-induced (SIGTERM=143, SIGKILL=137)               |
//
// Standalone mode (running this file directly via `node bin/...`) is
// intentionally rejected with exit(2) — Phase 16 v1 only supports the
// supervisor-managed path. Q24 in the ADR keeps the door open for a
// future standalone REPL but the entrypoint will need a mode discriminator
// branch first.

// Phase 16.C v3 (M51 / M56) — Top-level SIGTERM stub.
//
// Registered immediately after ESM imports resolve. Covers SIGTERM
// during S1-S14 (post-import init, payload validation, console wrap,
// DB open, recovery sweep) until S15 swaps to the full handler.
//
// KNOWN GAP (v1, accepted): the fork-load window between the
// supervisor's fork() syscall and the daemon ESM import evaluation
// completing is NOT covered. ES modules evaluate static imports BEFORE
// any top-level code runs (regardless of textual order), so the
// `process.once('SIGTERM', ...)` below only takes effect after the
// import graph (better-sqlite3 native bindings, Kernel, validators,
// migration helpers) finishes loading — typically a few hundred
// milliseconds on cold start. SIGTERM landing inside that window
// kills the daemon silently via Node's default SIGTERM action.
//
// Mitigation: the supervisor waits for the `daemon:ready` notification
// before sending SIGTERM in the normal lifecycle, so this gap is only
// reachable in emergency-stop scenarios (where the silent-kill
// trade-off is acceptable). Phase 17+ revisit: switch to a CJS
// wrapper entrypoint that registers the stub before `require()`-ing
// the ESM daemon — true coverage requires that restructure.
process.once('SIGTERM', () => {
  try {
    process.stderr.write(
      '[agent-core-daemon] SIGTERM received before DB open; exiting clean.\n'
    );
  } catch { /* swallow */ }
  process.exit(0);
});

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { Kernel } from '../src/kernel.js';
import { DaemonIpcAdapter } from '../src/adapters/ipc.js';
import { RestStubServer } from '../src/adapters/rest-stub-server.js';
import { registerMcpRoutes } from '../src/adapters/mcp.js';
import { registerOpenAiRoutes } from '../src/adapters/openai.js';
import { registerTestEchoHandlers } from '../src/test-handlers.js';
import { wrapConsole } from '../src/lib/console-wrap.js';
import { migrateThinkDeeperReferences } from '../src/lib/migrate-think-deeper.js';
import { validateInitPayload } from '../src/lib/validate-init-payload.js';
import {
  createDaemonToolRegistry,
  installRuntimePushHandlers,
} from '../src/lib/daemon-tool-registry.js';
import { createToolInvokeHandler } from '../src/lib/daemon-tool-invoke.js';
import { createThinkDeeper } from '../src/lib/daemon-ce-stage-4.js';
import { createBrainChatHandler } from '../src/lib/brain-chat-handler.js';
import { resolveAiConfig, setAiConfig } from '../src/lib/resolveAiConfig.js';
import {
  setAthenaMode,
  getAthenaModeAllowlist,
} from '../src/lib/athena-mode.js';

// Init handshake timeout. Overridable via env var so the integration test
// can shrink it to ~1s instead of waiting 30s for the timeout-exit-3 path.
const INIT_TIMEOUT_MS = Number.parseInt(
  process.env.INIT_TIMEOUT_MS ?? '30000',
  10
);

/**
 * S1 — mode discriminator (Q24).
 * Standalone mode is not supported in Phase 16 v1; running the file
 * outside of `child_process.fork()` exits 2 immediately.
 */
function assertManagedMode() {
  if (!process.send || !process.connected) {
    // Use the underlying stderr write — wrapping (S5) hasn't happened yet
    // and we have no agentId to prefix anyway.
    process.stderr.write(
      '[agent-core-daemon] Standalone mode not implemented in Phase 16\n'
    );
    process.exit(2);
  }
}

/**
 * S3 — wait for the supervisor's init message. Resolves with the full
 * raw message; rejects on timeout (caller maps to exit 3).
 *
 * @returns {Promise<unknown>}
 */
function awaitInitMessage() {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onMessage = (msg) => {
      if (settled) return;
      // First message wins — S2 listener is one-shot. Anything that isn't
      // an init handshake counts as a protocol violation; let validation
      // (S4) report the structured reason.
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      resolve(msg);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      process.off('message', onMessage);
      reject(new Error(`init timeout after ${INIT_TIMEOUT_MS}ms`));
    }, INIT_TIMEOUT_MS);
    // Don't keep the event loop alive just for the handshake timer — the
    // child should exit via the timeout's reject path even if no other
    // listeners are pending.
    timer.unref?.();

    process.on('message', onMessage);
  });
}

/**
 * S5 — wrap console.* with `[daemon:<agentId-short>] ` prefix is
 * delegated to {@link wrapConsole} in `lib/console-wrap.js`. Extracted
 * (M57) so the idempotency invariant can be exercised by a direct
 * unit test instead of indirectly counting prefix occurrences in a
 * live daemon's stdout.
 */

/**
 * S10 — REST stub bind. Validates the parent directory is writable +
 * the path isn't blocked by a regular file (both are surfaced as exit
 * 5 so the supervisor's `daemon_events` row matches the J-stage
 * failure mode), then boots a unified {@link RestStubServer} that
 * co-hosts the MCP and OpenAI REST stub families on a single unix
 * socket (Plan §J: "v1 J 阶段 daemon 暴露单一 unix socket").
 *
 * Path-prefix routing keeps the dual-envelope contract intact —
 * `/mcp/*` flows through {@link registerMcpRoutes} and emits the
 * JSON-RPC error shape; `/v1/*` flows through
 * {@link registerOpenAiRoutes} and emits the OpenAI error shape. The
 * split is documented in ADR §11.5 and asserted by the J unit suites.
 *
 * @param {string} socketPath
 * @returns {Promise<RestStubServer>}
 */
async function startRestStubServer(socketPath) {
  const parent = path.dirname(socketPath);
  // Parent existence is also asserted in validateInitPayload, but we
  // double-check here so the exit-5 path is exercised consistently.
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch (e) {
    throw new Error(
      `socket parent directory not writable: ${parent}: ${e.message}`
    );
  }
  // If a real file (not just a stale socket) already sits at socketPath
  // and isn't a socket, the listener will fail to bind. Surface as exit
  // 5 here so the failure shape matches the pre-J behaviour and the
  // supervisor's recorded `reason` stays stable.
  if (fs.existsSync(socketPath)) {
    const stat = fs.statSync(socketPath);
    if (stat.isFile()) {
      throw new Error(
        `socket path is occupied by a regular file: ${socketPath}`
      );
    }
  }

  const server = new RestStubServer({ socketPath });
  registerMcpRoutes(server);
  registerOpenAiRoutes(server);
  await server.start();
  return server;
}

/**
 * S11 / S12 — open existing SQLite file. Per ADR §1.3 DB Bootstrap
 * Ownership, the Space `hire_agent` flow creates the file; the daemon
 * never lazy-creates it. Missing file → exit 6 with reason
 * `sqlite_open_missing_db`.
 *
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
function openExistingSqliteDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite file does not exist: ${dbPath}`);
  }
  // `fileMustExist: true` is belt-and-braces: even if the file is
  // racy-deleted between existsSync and the open, better-sqlite3 raises
  // SQLITE_CANTOPEN instead of silently re-creating it.
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * S14 — startup recovery sweep. Any session_history row that wasn't
 * cleanly finalised before the previous daemon died (status not in the
 * terminal enum, or NULL because of a B.4 trigger bypass) is marked
 * `'interrupted'` so the next CE pass treats it as a finished session
 * (Design §7.0 + ADR §1 hung-daemon fallback step 3).
 *
 * The `OR status IS NULL` clause is required because SQLite evaluates
 * `NULL NOT IN (…)` as NULL, which the optimiser treats as false — so
 * the simple `NOT IN` filter would skip orphan NULL rows (M47 v4).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {number} rows updated
 */
function runStartupRecoverySweep(db) {
  const stmt = db.prepare(
    "UPDATE session_history " +
      "SET status = 'interrupted' " +
      "WHERE status NOT IN ('completed','interrupted','failed') " +
      "OR status IS NULL"
  );
  const info = stmt.run();
  if (info.changes > 0) {
    console.log(
      `[startup-recovery] marked ${info.changes} session_history row(s) as 'interrupted'`
    );
  }
  return info.changes;
}

/**
 * S8 — register kernel handlers. Phase 16.E adds the `_test.echo` /
 * `_test.echo_stream` pair plus exposes a `_stubHandler` for handlers
 * that future sub-phases will fill in (brain.*, ce.*, cerebellum.*,
 * tool.*, memory.*, daemon.*).
 *
 * @param {Kernel} kernel
 * @param {{ agentId: string }} bindings — daemon-bound identity / data
 *   threaded into per-handler factories. Currently only `agentId` is
 *   needed (for `brain.chat`'s `resolveAiConfig` wire — Plan §L3'.3);
 *   the next sub-phases will likely add memDb / agentCoreDb here too.
 */
function registerStubKernelHandlers(kernel, { agentId } = {}) {
  // E.5 — minimal _test.* fixtures. Used by:
  //   - the in-process kernel unit tests (registered against a fresh
  //     Kernel instance via `registerTestEchoHandlers`),
  //   - the minimal-echo-daemon test fixture (Plan §E.6),
  //   - the contract integration suite that forks this entrypoint
  //     directly (validates the streaming + correlation path end-to-
  //     end through real `child_process.fork`).
  registerTestEchoHandlers(kernel);

  // L2'.4 — real-but-stubbed `brain.chat` streaming handler. Until L3'
  // wires the provider adapters, the handler emits a deterministic
  // token sequence so the SSE streaming + back-pressure + cancel
  // pipeline can be exercised end-to-end without an LLM. Test fixtures
  // override the LLM factory; production gets the default 3-token
  // sequence (`['Hello', ' ', 'world']`) which is enough to prove the
  // wire is alive but never gets handed to a real user (the chat route
  // wires the real LLM call in L3').
  //
  // L3'.A — bind the daemon's agentId + the local `resolveAiConfig`
  // resolver into the handler factory so each turn picks the right
  // provider/model triple per Design §8.3.3 (caller-supplied
  // configOverride wins; otherwise fall back to the cache primed at
  // init via setAiConfig + refreshed by the F.4 config:changed push).
  kernel.registerHandler('brain.chat', createBrainChatHandler({
    agentId,
    aiConfigResolver: resolveAiConfig,
  }));

  // Generic fall-back for unimplemented methods. F-K sub-phases will
  // replace this with real ce.* / cerebellum.* handlers as they land.
  const stub = () => Promise.resolve({ status: 'unimplemented' });
  kernel._stubHandler = stub;
}

/**
 * S6b + §3.3 — Full SIGTERM handler. Phase 16.C does not yet track
 * `currentTurnId`; the `turn:interrupting` notification + the
 * `markSessionHistoryInterrupted` write land in sub-phase E/G when the
 * turn lifecycle is wired. Until then, this handler emits the
 * `daemon:shutting_down` notification, closes its DB handles, and
 * exits 0 within the supervisor's 10s grace window.
 *
 * Phase 16.C v2 (M51): This handler REPLACES the early stub installed
 * by `installEarlySigtermStub` — we explicitly `removeAllListeners`
 * first so we don't end up running both paths on the same signal.
 *
 * @param {{ agentId: string, sendNotification: (method: string, params: object) => void, closeAll: () => Promise<void> }} ctx
 */
function installSigtermHandler(ctx) {
  // Replace the S6a early stub.
  process.removeAllListeners('SIGTERM');
  process.on('SIGTERM', async () => {
    try {
      ctx.sendNotification('daemon:shutting_down', {
        agentId: ctx.agentId,
        reason: 'SIGTERM',
      });
      // currentTurnId tracking lands in sub-phase E. The block below is
      // the locked shape per Design §3.3 — kept commented so the diff
      // against E is minimal:
      //
      //   if (currentTurnId) {
      //     ctx.sendNotification('turn:interrupting', { agentId, turnId: currentTurnId });
      //     await markSessionHistoryInterrupted(currentTurnId);
      //   }
      await ctx.closeAll();
    } catch (e) {
      // Best-effort: even if shutdown logic throws, we must still exit
      // (otherwise the supervisor's 10s grace expires and we get SIGKILL,
      // which would then surface as exit 137 instead of the clean 0).
      try {
        process.stderr.write(
          `[daemon:${String(ctx.agentId).slice(0, 8)}] SIGTERM handler error: ${e.message}\n`
        );
      } catch { /* swallow */ }
    } finally {
      process.exit(0);
    }
  });
}

/**
 * Helper for IPC notifications — wraps process.send with a JSON-RPC
 * envelope. Sub-phase E will replace this with the real
 * DaemonIpcAdapter; for now we send directly so daemon:ready /
 * daemon:shutting_down can fly even without the adapter.
 */
function sendNotification(method, params) {
  if (!process.send) return;
  try {
    process.send({ jsonrpc: '2.0', method, params });
  } catch {
    // Parent disconnected mid-notification; nothing to do.
  }
}

/**
 * Top-level daemon main. Executes S1-S17 in order. Each labelled comment
 * matches Design §3.1 step number for byte-traceable review.
 */
async function main() {
  // S0 (M51 / M56 narrowed) — the early SIGTERM stub is registered at
  // module top-level (after ESM static imports evaluate, before main()
  // runs). It covers SIGTERM during S1–S14 only. The fork-load window
  // (between supervisor fork() syscall and ESM import evaluation
  // completing) is NOT covered — accepted v1 limitation, see the
  // `process.once('SIGTERM', ...)` block at the top of this file.

  // S1 — mode discriminator.
  assertManagedMode();

  // S2 — listener registration is folded into awaitInitMessage so it can
  // be a one-shot listener that auto-removes after the first message.
  let rawInit;
  try {
    rawInit = await awaitInitMessage();
  } catch (e) {
    // S3 timeout.
    process.stderr.write(`[agent-core-daemon] ${e.message}\n`);
    process.exit(3);
  }

  // S4 — validate payload.
  try {
    validateInitPayload(rawInit);
  } catch (e) {
    process.stderr.write(`[agent-core-daemon] ${e.message}\n`);
    process.exit(4);
  }

  const config = rawInit.config;
  const { agentId, memoryDbPath, agentCoreDbPath, socketPath } = config;

  // S5 — agentId-prefix console wrap. Must come before any console.*
  // call that should carry the prefix. (The S6a early stub installed
  // in S0 above is still active and handles any pre-S15 SIGTERM.)
  wrapConsole(agentId);

  // F.3 — daemon-side tool registry. The supervisor's init payload
  // carries `toolList` (already validated non-empty by validateInitPayload).
  // The registry runs `assertUniqueToolNames` on construction so a
  // buggy push from the supervisor short-circuits before the daemon
  // ever serves a turn.
  let toolRegistry;
  try {
    toolRegistry = createDaemonToolRegistry(config.toolList);
  } catch (e) {
    console.error(`tool registry init failed: ${e.message}`);
    process.exit(4);
  }

  // F.4 — provider / config caches updated by runtime push handlers.
  const providerCache = {
    _value: config.brainConfig ?? null,
    set(v) { this._value = v; },
    get() { return this._value; },
  };
  const configCache = {
    _values: new Map(),
    set(key, value) {
      if (typeof key === 'string') this._values.set(key, value);
    },
    get(key) { return this._values.get(key); },
  };

  // F.4 — install supervisor → daemon push listener. This taps into
  // the same `process.on('message')` channel that DaemonIpcAdapter
  // uses; the IPC adapter ignores these notification methods (they
  // have no `id` so dispatch routing skips them), so the two
  // listeners coexist cleanly.
  //
  // L3'.A (Plan §L3'.3 step 4 + review fix [13]) — seed the
  // `resolveAiConfig` cache when a `config:changed` notification
  // names this daemon. The supervisor's `broadcastConfigChanged`
  // (supervisor.js §F.4) fans out every global_settings update on
  // this same channel — including non-AI keys like `athena_mode`.
  // Two-layer filter: (1) require `params.agentId` to match this
  // daemon (no global broadcasts), (2) require the payload to look
  // like an AI config object (has provider and/or model field). A
  // permissive accept-all path would cache strings like 'awake' as
  // this daemon's AI config and corrupt the resolver.
  installRuntimePushHandlers({
    toolRegistry,
    providerCache,
    configCache,
    aiConfigSetter: (params) => {
      if (!params || typeof params !== 'object') return;
      // L3'.A review fix [13]: only accept payloads scoped to this
      // daemon's agent + that look like a real AI config triple.
      // The supervisor's broadcastConfigChange channel carries every
      // global_settings update — including non-AI keys like
      // athena_mode='awake' — and a permissive accept-all-no-agentId
      // path would cache 'awake' as this daemon's AI config and
      // corrupt the resolver.
      //
      // Two-layer filter:
      //   (1) require `params.agentId` to match (no global broadcasts)
      //   (2) require the payload to look like an AI config object
      //       (has provider and/or model field)
      if (!params.agentId || params.agentId !== agentId) return;
      const next = params.value ?? params.config ?? null;
      if (!next || typeof next !== 'object') return;
      const looksLikeAiConfig =
        typeof next.provider === 'string' || typeof next.model === 'string';
      if (!looksLikeAiConfig) return;
      setAiConfig(agentId, next);
    },
    // L3'.B (Plan §L3'.1 step 2) — Athena mode propagation.
    // `athena_mode` is a GLOBAL setting (legitimately broadcast
    // without agentId), so this filter is INTENTIONALLY DIFFERENT
    // from `aiConfigSetter`'s strict-agentId branch:
    //   (1) require `params.key === 'athena_mode'`
    //   (2) require `params.value` to be one of the four known
    //       modes (boot / awake / drowsy / dormant)
    // No agentId check — every daemon receives the broadcast, but
    // only Athena's daemon will have a cerebellum L1 ticker that
    // actually consumes the mode (other daemons no-op gracefully).
    athenaModeSetter: (params) => {
      if (!params || typeof params !== 'object') return;
      if (params.key !== 'athena_mode') return;
      const value = params.value;
      if (typeof value !== 'string') return;
      if (!getAthenaModeAllowlist().includes(value)) return;
      setAthenaMode(value);
    },
  });

  // L3'.A (Plan §L3'.3 step 3) — prime the cache from the init
  // payload's `brainConfig` field. Per INV-5 the daemon never reads
  // the Space DB directly; the supervisor resolves the per-agent
  // config in `getAgentAIConfig(agentId)` and ships it inside the
  // init payload. From this point on, brain.chat turns on the
  // default path (no configOverride) hit a primed cache.
  if (config.brainConfig) {
    setAiConfig(agentId, config.brainConfig);
  }

  // S7 — kernel.
  const kernel = new Kernel();
  // Expose the F.3 / F.4 caches on the kernel so future sub-phase
  // handlers (brain.* / ce.*) can read the daemon's tool list, LLM
  // provider, and config snapshot through a single context object.
  kernel.toolRegistry = toolRegistry;
  kernel.providerCache = providerCache;
  kernel.configCache = configCache;

  // S8 — register kernel handlers (E.5 _test.* + future F-K dispatch
  // table). Sub-phases F-K append real handlers as they land.
  // The G-phase `tool.invoke` handler is registered later (after S11/S12
  // open the DBs) because its localContext needs the live `memDb` /
  // `agentCoreDb` handles to drive CE Stage 4.
  //
  // L3'.A — pass the daemon's bound `agentId` so the brain.chat
  // factory can thread it into resolveAiConfig (Plan §L3'.3).
  registerStubKernelHandlers(kernel, { agentId });

  // S9 — IPC adapter. Construct now but DO NOT call `start()` yet —
  // the daemon:ready notification (S15) still flies as a plain
  // `process.send`, and we don't want the adapter to intercept any
  // pre-ready messages (the S2/S3 init handshake already consumed
  // its own one-shot listener; nothing else should be in flight).
  const ipcAdapter = new DaemonIpcAdapter({ kernel });

  // S10 — start unified REST stub server (MCP + OpenAI families,
  // single unix socket, path-prefix routed).
  let restServer;
  try {
    restServer = await startRestStubServer(socketPath);
  } catch (e) {
    console.error(`socket bind failed: ${e.message}`);
    process.exit(5);
  }

  // S11 — open memory.db (existing-only).
  let memDb;
  try {
    memDb = openExistingSqliteDb(memoryDbPath);
  } catch (e) {
    console.error(`memoryDbPath open failed: ${e.message}`);
    process.exit(6);
  }

  // S12 — open agent-core.db (existing-only).
  let agentCoreDb;
  try {
    agentCoreDb = openExistingSqliteDb(agentCoreDbPath);
  } catch (e) {
    console.error(`agentCoreDbPath open failed: ${e.message}`);
    try { memDb.close(); } catch { /* ignore */ }
    process.exit(6);
  }

  // S13 — historical think_deeper → recall data migration (idempotent).
  try {
    migrateThinkDeeperReferences(agentCoreDb);
  } catch (e) {
    // The helper already swallows malformed-row warnings; only a
    // catastrophic failure (DB-level) reaches here. Surface and continue
    // — the daemon can still serve fresh turns even if old rows didn't
    // migrate.
    console.warn(`migrateThinkDeeperReferences failed: ${e.message}`);
  }

  // S14 — startup recovery sweep.
  try {
    runStartupRecoverySweep(agentCoreDb);
  } catch (e) {
    console.warn(`startup recovery sweep failed: ${e.message}`);
  }

  // G.1 — wire the real `tool.invoke` handler now that memDb /
  // agentCoreDb are open. The kernel.toolRegistry (set above) is the
  // F.3-extended container and stays the single registry the handler
  // queries; ctx.thinkDeeper is the daemon-owned CE Stage 4 closure
  // (G.2) that reads the daemon's own memory.db. Per ADR §4 the
  // daemon never round-trips through Space for the local-tool path.
  //
  // H.1 — additionally thread `ipcAdapter` + agent identity into the
  // factory so `executor:'remote'` tools delegate back to Space's
  // `space.tool.invoke` kernel handler (registered Space-side once per
  // supervisor — see supervisor.js / space-tool-invoke.js). The
  // ipcAdapter is constructed in S9 above; we pass it here even though
  // it hasn't `start()`'d yet because remote dispatch only fires on
  // tool.invoke calls (post-S15 ready), at which point start() has run.
  const thinkDeeper = createThinkDeeper({ memDb, agentCoreDb });
  const toolInvokeHandler = createToolInvokeHandler({
    toolRegistry,
    localContext: { thinkDeeper, memDb, agentCoreDb },
    ipcAdapter,
    agentId,
    agentName: config.agentName ?? null,
  });
  kernel.registerHandler('tool.invoke', toolInvokeHandler);

  // S6b — Full SIGTERM handler (M51). Replaces the S6a early stub.
  // We install the full version after the DB handles exist so the
  // close path is meaningful; agentId is already in scope so the
  // notification carries the right ID.
  //
  // Shutdown order (Plan §J.3): close IPC → close REST listener →
  // close DB. IPC goes first so no new requests land mid-shutdown;
  // REST goes second so any in-flight HTTP responses finish before
  // the DB handles disappear; DB goes last so its WAL flush sees a
  // quiescent daemon.
  installSigtermHandler({
    agentId,
    sendNotification,
    closeAll: async () => {
      try { ipcAdapter?.stop?.(); } catch { /* ignore close errors on shutdown */ }
      try { await restServer?.stop(); } catch { /* ignore close errors on shutdown */ }
      try { agentCoreDb?.close(); } catch { /* ignore close errors on shutdown */ }
      try { memDb?.close(); } catch { /* ignore close errors on shutdown */ }
    },
  });

  // S15 — emit daemon:ready. Still uses the bare `sendNotification`
  // helper because the DaemonIpcAdapter intentionally hasn't started
  // listening yet — see S9 above.
  sendNotification('daemon:ready', {
    agentId,
    pid: process.pid,
    socketPath,
  });

  // S16 — placeholder: v1 has no daemon-side bookkeeping (Design §3.1).
  void kernel;

  // S17 — enter event loop. The DaemonIpcAdapter `start()` registers
  // its `process.on('message', ...)` listener which (a) keeps the
  // event loop alive so the daemon stays resident waiting for SIGTERM
  // and (b) routes inbound JSON-RPC envelopes to `kernel.dispatch`.
  ipcAdapter.start();
}

main().catch((e) => {
  // Last-resort: if anything escapes the labelled handlers above, fall
  // through to default Node behaviour (exit 1) but still surface the
  // message so supervisor logs aren't blank.
  try {
    process.stderr.write(`[agent-core-daemon] uncaught: ${e?.stack ?? e}\n`);
  } catch { /* swallow */ }
  process.exit(1);
});
