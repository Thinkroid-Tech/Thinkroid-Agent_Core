# @thinkroid/agent-core

Per-agent AI daemon for the [Thinkroid-Space](https://github.com/Thinkroid-Tech/Thinkroid-Space) platform.

A self-contained daemon process that runs one AI agent's brain, context engine,
cerebellum (background memory consolidation), per-agent SQLite store, and
LLM tool loop. Hosts integrate via `child_process.fork()` IPC and a Unix-socket
JSON-RPC kernel; future iterations will expose the same surface as REST / MCP /
A2A adapters for third-party hosts.

## Status

Pre-1.0 — API surface is stable and used in production by Thinkroid-Space.
A 1.0 release will accompany the first non-Thinkroid host integration.

## Architecture

The daemon owns the LLM call, the tool dispatch loop, the multi-round
suspension-and-resume state (so an approval-bearing tool loop can survive
a daemon restart), and the per-agent memory and conversation FSM. Tools whose
implementations live in the host process are reached over the bidirectional
IPC channel; tools whose implementations live in the daemon (`recall`,
`think_deeper`, `mem:*`) run inline. The host pushes a tool list at init time
and incrementally subscribes to runtime adds/removes. Hosts that prefer
not to drive the daemon through Node IPC can talk to it over a Unix-socket
REST adapter (the same surface the MCP and OpenAI-compatible adapters share).

See [`docs/architecture.md`](docs/architecture.md) for a longer walkthrough.

## IPC contracts

| Method | Purpose | Timeout |
|---|---|---|
| `daemon:ready` (notification) | Init handshake — daemon → host | n/a |
| `brain.chat` | Text-only streaming completion (legacy single-round) | n/a |
| `brain.toolLoop` | Non-streaming multi-round tool loop | 300 s |
| `brain.toolLoop.resume` | Idempotent resume of an approval-pending tool loop | 300 s |
| `brain.chatToolStream` | Streaming multi-round tool loop with `text_chunk` / `tool_use` / `tool_result` / `approval_required` partials | 300 s |
| `governance.delegate` | Non-streaming text completion for governance / decision workflows | 120 s |
| `tool.invoke` | Daemon-local tool dispatch (`recall`, `think_deeper`, `mem:*`) | 60 s |
| `space.tool.invoke` | Host-side tool callback (the host implements this method) | 60 s |
| `session.receiveEvent` | Per-agent conversation FSM event | 30 s |
| `cerebellum.l1Tick` / `cerebellum.l2Tick` | Background memory consolidation drivers | 60 s / 120 s |
| `memory.read` / `memory.write` | Memory store access | 30 s |
| `ce.tick` | Context engine tick | 30 s |

The frozen request/response/error schemas live in
[`src/ipc/agent-core-contract.js`](src/ipc/agent-core-contract.js). The
notification methods (`debug_log`, `hook_event`, `token_usage`,
`daemon:ready`, `daemon:shutting_down`) live in the same module / entrypoint.
For the full reference see [`docs/ipc-contracts.md`](docs/ipc-contracts.md).

## Layout

- `bin/agent-core-daemon.js` — daemon entrypoint (managed by a host supervisor via `child_process.fork()`)
- `src/kernel.js` — JSON-RPC kernel (handler registration + dispatch)
- `src/adapters/` — IPC + MCP + OpenAI Unix-socket adapters
- `src/brain/` — Brain (LLM tool loop, internal tools)
- `src/ce/` — Context Engine
- `src/cerebellum/` — Cerebellum (L1/L2 tickers, summarization)
- `src/handlers/` — kernel IPC handler registrations
- `src/lib/` — daemon-side utility helpers
- `src/stores/` — per-agent `agent-core.db` stores
- `src/supervisor/` — daemon-internal per-agent session FSM (Awake / Drowsy / Dormant)
- `src/types/` — shared JSDoc typedefs
- `modules/thinkroid-memory/` — bundled per-agent `memory.db` helper

## Standalone mode

The daemon refuses standalone invocation with exit code 2 — it requires a
host-supplied init payload that fixes the per-agent identity, provider
config, tool list, and memory backing. Future releases may relax this for
REPL access; today the host fork (`child_process.fork()`) is mandatory.

## Getting started (host integration)

```js
import { fork } from 'node:child_process';
import path from 'node:path';

const daemon = fork(
  path.resolve('node_modules/@thinkroid/agent-core/bin/agent-core-daemon.js'),
  [],
  {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  },
);

daemon.send({
  type: 'init',
  config: {
    agentCoreProtocolVersion: 'agent-core-ipc/v1',
    agentId: '<UUID>',
    agentName: '<display name>',
    memoryDbPath: '<host-controlled per-agent memory.db>',
    agentCoreDbPath: '<host-controlled per-agent agent-core.db>',
    socketPath: '<host-controlled per-daemon unix socket>',
    brainConfig: { baseUrl, apiKey, model, /* ... */ },
    toolList: [
      // { name, definition, executor: 'local' | 'remote' }
    ],
  },
});

daemon.on('message', (msg) => {
  if (msg?.method === 'daemon:ready') {
    // Daemon is up; safe to send brain.toolLoop / brain.chatToolStream
    // requests via the same `daemon.send(...)` channel.
  }
});
```

For the host-side IPC kernel — responding to `space.tool.invoke`, relaying
`token_usage` / `debug_log` / `hook_event` notifications, and driving the
SIGTERM shutdown sequence — see the Thinkroid-Space server's
`services/agent-core/` directory for a reference implementation. A condensed
walkthrough is in [`docs/host-integration.md`](docs/host-integration.md).

## Testing

```bash
npm install
npm test  # scoped to tests/lib (unit suite)
```

## License

Apache License 2.0 — see [`LICENSE`](LICENSE).

## Origin

Extracted from [Thinkroid-Space](https://github.com/Thinkroid-Tech/Thinkroid-Space)
during a 2026 architecture pass that separated agent execution from the host
process. Per-file blame in this repo starts at the extraction commit;
archeology lives in the upstream `Thinkroid-Space` repo's history.
