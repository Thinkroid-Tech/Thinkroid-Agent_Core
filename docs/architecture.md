# Architecture

## Process model

One daemon process per agent. The host (a supervisor in the host's process)
calls `child_process.fork()` to start the daemon, sends a single `init`
message with the per-agent identity and configuration, and waits for the
daemon's `daemon:ready` notification before issuing IPC requests. The
daemon stays resident until the host sends SIGTERM, at which point it
runs an orderly shutdown sequence (IPC drain → REST listener close → DB
close → exit 0).

The daemon refuses to start without a host-supplied init payload — running
the entrypoint directly under `node` exits with code 2. Init handshake
times out after 30 s (exit code 3).

## Components

```
                ┌──────────────────────────────────────────────┐
                │  Host process (e.g. Thinkroid-Space server)  │
                │                                              │
                │   ┌──────────────┐    ┌────────────────────┐ │
                │   │  Supervisor  │◀──▶│  IPC adapter       │ │
                │   │  (per-agent  │    │  (Node IPC channel │ │
                │   │   spawn,     │    │   + JSON-RPC)      │ │
                │   │   crash      │    └──────┬─────────────┘ │
                │   │   recovery)  │           │               │
                │   └──────────────┘           │               │
                └──────────────────────────────┼───────────────┘
                                               │
                                               ▼  Node IPC channel
                ┌──────────────────────────────────────────────┐
                │  Agent Core daemon (one per agent)           │
                │                                              │
                │   ┌────────────────────────────────────────┐ │
                │   │  Kernel (JSON-RPC, handler dispatch)   │ │
                │   └─┬──────┬────────┬───────────┬──────────┘ │
                │     │      │        │           │            │
                │     ▼      ▼        ▼           ▼            │
                │   Brain   CE   Cerebellum  tool.invoke       │
                │     │      │        │           │            │
                │     └──────┴────────┴───────────┘            │
                │                  │                            │
                │      ┌───────────┴───────────┐                │
                │      ▼                       ▼                │
                │   memory.db            agent-core.db          │
                │   (per agent)          (per agent)            │
                │                                              │
                │   ┌────────────────────────────────────────┐ │
                │   │  Unix-socket REST stub                 │ │
                │   │  (MCP + OpenAI-compat adapters,        │ │
                │   │   path-prefix routed on one socket)    │ │
                │   └────────────────────────────────────────┘ │
                └──────────────────────────────────────────────┘
```

### Kernel + adapters

The kernel is a JSON-RPC dispatcher. It owns handler registration, payload
validation, response shaping, and per-method timeout enforcement. Adapters
wrap the kernel in different transports:

- **IPC adapter** (`src/adapters/ipc.js`) — the default transport. Reads
  envelopes off Node's IPC channel and replies via `process.send()`.
- **REST stub server** (`src/adapters/rest-stub-server.js`) — a Unix-socket
  HTTP listener that hosts both the MCP and OpenAI-compatible adapters on
  a single socket via path-prefix routing (`/mcp/*` and `/v1/*`).

### Brain

Owns the LLM call and the multi-round tool dispatch loop. Three flavours:

- `brain.chat` — text-only, single-round streaming. Legacy surface; emits
  `text_chunk` partials.
- `brain.toolLoop` — non-streaming multi-round tool loop. Returns the full
  assistant message + tool transcript at the end of the loop.
- `brain.chatToolStream` — streaming multi-round tool loop. Emits
  `text_chunk`, `tool_use`, `tool_result`, `approval_required` partials
  during the run; closes with a final response envelope.

The `governance.delegate` method is a separate non-tool-loop text path
intended for governance / decision workflows (single-round prompt → text
or `decision_word` parse → response).

### Tool dispatch (local vs remote)

Each tool entry in the host-supplied `toolList` carries an `executor`
field:

- `executor: 'local'` — the daemon resolves the tool against its built-in
  registry (`recall`, `think_deeper`, `mem:*`, …). Dispatch is in-process.
- `executor: 'remote'` — the daemon dispatches via a `space.tool.invoke`
  IPC call back to the host. The host implements `space.tool.invoke` as a
  reverse-direction handler.

The host can add and remove tools at runtime by pushing
`toolRegistry.add` / `toolRegistry.remove` notifications over the same
IPC channel.

### Context engine (CE)

Per-agent runtime state: open conversation sessions, working memory, the
"what should this agent be doing now" decision logic invoked by
`ce.tick`. CE state lives entirely in the per-agent `agent-core.db`.

### Cerebellum

Background memory consolidation. Two ticker depths:

- `cerebellum.l1Tick` (default 5-minute cadence) — fast pass that promotes
  recent conversation rows to memory entries.
- `cerebellum.l2Tick` (default 30-minute cadence) — slower pass that
  summarises older entries.

Tickers are driven by the host; the daemon simply replies to each tick
request. Hosts that don't want background consolidation can omit the
schedulers entirely.

### Conversation FSM (session lifecycle)

`session.receiveEvent` drives a per-agent finite-state machine across
session states (`idle` → `in_progress` → `completed` / `interrupted` /
`failed`). The FSM owns `session_history` row creation and finalisation;
an orderly shutdown writes the closing row, while a crashed daemon's
next start runs a recovery sweep that flips orphan non-terminal rows to
`'interrupted'`.

## Per-agent SQLite topology

Each daemon owns two SQLite files in a host-controlled directory:

- **`memory.db`** — the per-agent memory store. Holds memory entries
  surfaced by `recall` and written by `mem:*` tools / cerebellum. Schema
  ships with the bundled `thinkroid-memory` module.
- **`agent-core.db`** — daemon runtime state: open sessions, CE working
  state, approval-pending suspensions (so a `brain.toolLoop` paused on a
  tool approval can survive a daemon restart), durable token usage rows,
  hook event history.

The daemon opens (and creates, on first boot) both files during startup.
A clean office can start the daemon with only the agent directory present
— no migration step is required.

## Crash recovery

The host supervisor records every spawn / exit / signal in its own
`daemon_events` audit log and applies an `auto_retry_on_crash` policy
when the daemon exits non-zero. Exit codes are stable:

| Code | Meaning |
|---|---|
| 0 | Graceful shutdown (SIGTERM completed) |
| 1 | Uncaught exception |
| 2 | Standalone mode attempted |
| 3 | Init handshake timed out (no `init` message in 30 s) |
| 4 | Init payload validation error |
| 5 | Unix socket bind failed |
| 6 | SQLite open failed |
| 128+N | Signal-induced (SIGTERM=143, SIGKILL=137) |

The daemon's own startup runs an `interrupted` recovery sweep on the
`session_history` table so that any session row left in a non-terminal
status by a previous crash is recorded as interrupted before the new run
issues any new turns.

## Shutdown sequence

On SIGTERM the daemon emits a `daemon:shutting_down` notification, then
closes resources in order:

1. IPC adapter (`process.off('message')`) — no new requests accepted.
2. REST listener — in-flight HTTP responses drain.
3. `agent-core.db` close.
4. `memory.db` close.
5. `process.exit(0)`.

If any close step throws, the daemon still exits 0 — the supervisor's
10-second grace window would otherwise upgrade SIGTERM to SIGKILL
(reported as exit code 137).
