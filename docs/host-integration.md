# Host integration guide

Step-by-step recipe for embedding a `@thinkroid/agent-core` daemon in your
host application. The canonical reference implementation lives in the
Thinkroid-Space server's `services/agent-core/` directory.

## 1. Fork the daemon

```js
import { fork } from 'node:child_process';
import path from 'node:path';

const daemon = fork(
  path.resolve('node_modules/@thinkroid/agent-core/bin/agent-core-daemon.js'),
  [],
  {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Optional: pipe stderr to your supervisor's log aggregator.
  },
);
```

The daemon refuses to start without an active IPC channel — passing
`stdio: 'ipc'` (or the four-slot form above) is mandatory.

## 2. Send the init payload

```js
daemon.send({
  type: 'init',
  config: {
    agentCoreProtocolVersion: 'agent-core-ipc/v1',
    agentId,                // UUID
    agentName,              // human-readable display
    memoryDbPath,           // absolute path; daemon creates the file on first boot
    agentCoreDbPath,        // absolute path; same
    socketPath,             // absolute Unix socket path; daemon binds it
    brainConfig: {
      baseUrl, apiKey, model,
      // ... whatever the provider requires
    },
    toolList: [
      // { name, definition, executor: 'local' | 'remote' }
    ],
  },
});
```

### Required fields

| Field | Purpose |
|---|---|
| `agentCoreProtocolVersion` | Must equal `agent-core-ipc/v1`. Mismatch → exit 4. |
| `agentId` | Stable UUID. Used as the per-agent identity throughout the daemon. |
| `agentName` | Display string; used in log prefixes and notifications. |
| `memoryDbPath` | Where the daemon opens `memory.db`. Parent directory must exist + be writable. |
| `agentCoreDbPath` | Where the daemon opens `agent-core.db`. Same constraint. |
| `socketPath` | Unix socket for the REST stub. `sun_path` is 108 bytes on Linux — keep the path short. |
| `brainConfig` | Provider configuration. The daemon caches it and resolves per-call via `resolveAiConfig`. Hosts may pass `null` and prime the cache later via `config:changed`. |
| `toolList` | Initial tool definitions. Non-empty array; tool names must be unique. |

### Init validation failures

- Missing required field → exit 4 (`init payload validation error`).
- Protocol version mismatch → exit 4.
- Init message not received within 30 s → exit 3.
- `socketPath` parent directory not writable → exit 5.
- DB open fails → exit 6.

## 3. Wait for `daemon:ready`

```js
daemon.on('message', (msg) => {
  if (msg?.method === 'daemon:ready') {
    // The daemon is up; safe to send brain.toolLoop / brain.chatToolStream
    // and other request methods now.
    onReady(msg.params); // { agentId, pid, socketPath }
  }
});
```

Do not send any request before `daemon:ready` arrives. Pre-ready messages
are queued on the IPC channel and may interleave with the daemon's
startup sequence in surprising ways.

## 4. Implement the reverse-direction `space.tool.invoke` handler

If any entry in your `toolList` carries `executor: 'remote'`, the daemon
will dispatch tool calls back to the host via `space.tool.invoke`. Wire
this in your IPC kernel:

```js
daemon.on('message', async (msg) => {
  if (msg?.method !== 'space.tool.invoke' || typeof msg.id === 'undefined') return;

  const { name, args, agentId, toolContext } = msg.params;
  try {
    const result = await runHostTool({ name, args, agentId, toolContext });
    // Class A envelope:
    daemon.send({ jsonrpc: '2.0', id: msg.id, result: { content: result } });
  } catch (e) {
    // Tool error envelope:
    daemon.send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: e.message, isToolError: true },
    });
  }
});
```

### Approval-pending envelope

If your tool requires user approval before running, return the
approval-pending envelope instead of a Class A result:

```js
daemon.send({
  jsonrpc: '2.0',
  id: msg.id,
  result: {
    ok: false,
    code: 'APPROVAL_PENDING',
    approvalId,        // host-generated stable ID
    name,              // tool name
    args,              // captured arguments
  },
});
```

The daemon persists this as a suspension row in `agent-core.db` and
returns the in-flight `brain.toolLoop` (or streaming variant) with
`status: 'approval_pending'` plus `suspensionId` + `toolCallId`. When the
user decides, the host calls `brain.toolLoop.resume` with the resolved
`toolResult`.

## 5. Subscribe to telemetry notifications

```js
daemon.on('message', (msg) => {
  if (!msg?.method) return;

  switch (msg.method) {
    case 'token_usage':
      // { agentId, usage } — daemon also writes a durable row to agent-core.db
      recordTokenUsage(msg.params);
      break;
    case 'debug_log':
      forwardLog(msg.params);
      break;
    case 'hook_event':
      fanOutHook(msg.params);
      break;
  }
});
```

Notifications have no `id` field and never expect a reply. The daemon
emits them via `process.send()` and continues regardless of host
acknowledgement.

## 6. Push runtime configuration changes

When global settings change at runtime, push them through the same IPC
channel:

```js
daemon.send({
  jsonrpc: '2.0',
  method: 'config:changed',
  params: {
    agentId,       // OR omit for global keys like 'athena_mode'
    key,
    value,
  },
});
```

The daemon applies two filters: AI configuration is accepted only when
`params.agentId` matches the daemon's bound agent AND the value looks
like a provider config (has `provider` or `model`). Global keys like
`athena_mode` are accepted regardless of `agentId` but are restricted to
a known allowlist of values.

Tool registry updates use a parallel notification:

```js
daemon.send({
  jsonrpc: '2.0',
  method: 'toolRegistry.add',
  params: { tool: { name, definition, executor: 'local' | 'remote' } },
});

daemon.send({
  jsonrpc: '2.0',
  method: 'toolRegistry.remove',
  params: { name },
});
```

## 7. Shutdown sequence

```js
async function shutdown(daemon, { graceMs = 10_000 } = {}) {
  const exited = new Promise((resolve) => daemon.once('exit', resolve));

  daemon.kill('SIGTERM');

  const killTimer = setTimeout(() => {
    // Daemon didn't exit in time; escalate.
    daemon.kill('SIGKILL');
  }, graceMs);

  const code = await exited;
  clearTimeout(killTimer);
  return code;
}
```

The daemon's SIGTERM handler:

1. Emits `daemon:shutting_down`.
2. Stops accepting new IPC requests.
3. Closes the REST stub listener (in-flight HTTP responses drain).
4. Closes `agent-core.db`.
5. Closes `memory.db`.
6. Exits with code 0.

A 10-second grace window matches the daemon's own internal close-budget
expectation. Hosts that need a different budget should adjust both sides.

## 8. Crash recovery

The daemon writes a one-off recovery sweep on every startup that flips
any non-terminal `session_history` row to `'interrupted'`. The host
supervisor only needs to:

1. Restart the daemon on non-zero exit.
2. Record `(pid, exitCode, signal, timestamp)` in its own audit log.
3. Re-send the same init payload (it is idempotent against existing
   per-agent DB files).

The supervisor SHOULD apply a back-off policy (the reference
implementation uses exponential back-off with a cap) so a daemon stuck
in a crash loop doesn't burn CPU.

## 9. Optional: REST adapter access

Each daemon also binds a Unix socket at `socketPath` that hosts can reach
without going through Node IPC. The same socket co-hosts two REST
families via path-prefix routing:

- `/mcp/*` — Model Context Protocol surface.
- `/v1/*` — OpenAI-compatible surface (`POST /v1/chat/completions`, etc.).

Use cases include CLI tools that talk to the daemon directly, or
out-of-process workers that prefer HTTP over Node IPC. The IPC kernel
remains the authoritative integration path; the REST adapters are
convenience wrappers over the same kernel handlers.

## Reference implementation

See `services/agent-core/` in the Thinkroid-Space server repository for a
complete host integration covering all of the above: per-agent supervisor
state machine, `auto_retry_on_crash` back-off, `space.tool.invoke`
kernel, notification fan-out, and admin REST endpoints exposing per-agent
daemon health.
