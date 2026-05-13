# IPC contracts

Authoritative reference for the JSON-RPC surface the daemon exposes over
its host IPC channel. Schemas are frozen in
[`src/ipc/agent-core-contract.js`](../src/ipc/agent-core-contract.js); this
document is a human-readable lift of that source. When the two disagree,
the source wins.

## Protocol

- Transport: Node IPC channel (created by `child_process.fork(..., {stdio: [..., 'ipc']})`).
- Envelope: JSON-RPC 2.0 (`{ jsonrpc, method, params, id? }`).
- Handshake field: `agentCoreProtocolVersion`.
- Current protocol version: `agent-core-ipc/v1`.

The host MUST send the protocol version in the init payload's `config`
object. A mismatch is reported as an init validation failure (exit code 4).

## Handshake

```jsonc
// host → daemon (first message after fork)
{
  "type": "init",
  "config": {
    "agentCoreProtocolVersion": "agent-core-ipc/v1",
    "agentId": "<UUID>",
    "agentName": "<display>",
    "memoryDbPath": "<absolute path>",
    "agentCoreDbPath": "<absolute path>",
    "socketPath": "<absolute unix socket path>",
    "brainConfig": { /* provider config — { baseUrl, apiKey, model, ... } */ },
    "toolList": [
      { "name": "<tool>", "definition": { /* ... */ }, "executor": "local" | "remote" }
    ]
  }
}
```

```jsonc
// daemon → host (emitted once at end of startup)
{ "jsonrpc": "2.0", "method": "daemon:ready", "params": { "agentId": "...", "pid": 1234, "socketPath": "..." } }
```

## Request methods

All payloads are validated by `validateRequestPayload(method, payload)` in
the contract module. Validation failures return a JSON-RPC error with
machine-readable messages from the contract's `validationErrors` list.

### `brain.toolLoop`

Non-streaming multi-round tool loop. The daemon owns the LLM call; tool
calls returned by the model are dispatched to either the daemon-local
`tool.invoke` handler or the host-side `space.tool.invoke` based on each
tool entry's `executor` field.

| Field | Type |
|---|---|
| Timeout | 300 000 ms |
| Mutates daemon DB | yes (persists approval-pending suspensions) |
| Idempotency | non-idempotent |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `messages` | yes | non-empty array of `{role, content}` |
| `source` | yes | non-empty string |
| `tools` | no | array of `{name, definition?, executor: "local" \| "remote"}` |
| `toolContext` | no | object (opaque, forwarded to remote tools) |
| `maxTokens` | no | positive integer |
| `maxToolRounds` | no | positive integer (default 25, hard-cap 50) |
| `taskId` | no | non-empty string |
| `skipInterruptCheck` | no | boolean |
| `configOverride` | no | object (per-call provider/model override) |
| `correlationId` | no | non-empty string |

**Response shape**

| Field | Type |
|---|---|
| `ok` | boolean |
| `text` | string |
| `agentId` | UUID string |
| `status` | `"completed" \| "approval_pending" \| "interrupted" \| "failed"` |
| `usage` | optional object |
| `suspensionId` | optional string (set when `status === "approval_pending"`) |
| `toolCallId` | optional string (set when `status === "approval_pending"`) |
| `conversationMessages` | optional array (full transcript for caller persistence) |

### `brain.toolLoop.resume`

Idempotent resume of an approval-pending tool loop. The caller passes the
approval decision back through `toolResult`; the daemon re-enters the
suspended loop with the result injected as the next tool message.

| Field | Type |
|---|---|
| Timeout | 300 000 ms |
| Mutates daemon DB | yes |
| Idempotency | idempotent per `(suspensionId, approvalId)` |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `suspensionId` | yes | non-empty string |
| `approvalId` | yes | non-empty string |
| `toolResult` | yes | `{ content: string }` OR `{ isToolError: true }` (at least one) |
| `decidedBy` | no | non-empty string |
| `correlationId` | no | non-empty string |

Response shape matches `brain.toolLoop`.

### `brain.chatToolStream`

Streaming variant of `brain.toolLoop`. Provider text deltas surface as
`text_chunk` partials; tool dispatch surfaces as `tool_use` /
`tool_result` partials; approval-pending dispatches emit an
`approval_required` partial alongside the durable suspension row.

| Field | Type |
|---|---|
| Timeout | 300 000 ms |
| Mutates daemon DB | yes (suspensions identical to `brain.toolLoop`) |
| Idempotency | non-idempotent |

**Request shape**

Same as `brain.toolLoop`, plus:

| Field | Required | Type |
|---|---|---|
| `stream` | yes | must be `true` |
| `backupConfigOverride` | no | object — fallback config when primary resolution is unavailable |

Response shape matches `brain.toolLoop`.

### `governance.delegate`

Non-tool-loop single-round text completion for governance / decision
workflows. Supports a `decision_word` response format that constrains the
model to one of a caller-supplied uppercase allowlist.

| Field | Type |
|---|---|
| Timeout | 120 000 ms |
| Mutates daemon DB | no |
| Idempotency | non-idempotent |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `capability` | yes | non-empty string |
| `promptKey` | yes | non-empty string |
| `messages` | yes | non-empty array of `{role, content}` |
| `source` | yes | non-empty string |
| `toolContext` | no | object |
| `maxTokens` | no | positive integer |
| `maxToolRounds` | no | positive integer |
| `responseFormat` | no | `"plain_text" \| "json_text" \| "decision_word"` |
| `validDecisions` | conditional | non-empty array of uppercase tokens (required when `responseFormat === "decision_word"`) |
| `configOverride` | no | object |
| `correlationId` | no | non-empty string |

**Response shape**

| Field | Type |
|---|---|
| `ok` | boolean |
| `text` | string |
| `usage` | optional object |
| `agentId` | UUID string |
| `capability` | non-empty string |
| `parsedOk` | optional boolean |

### `ce.tick`

Drive one context-engine pass for the agent.

| Field | Type |
|---|---|
| Timeout | 30 000 ms |
| Mutates daemon DB | yes |
| Idempotency | idempotent per agent / tick window |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `reason` | no | non-empty string |
| `now` | no | ISO timestamp string |

**Response shape**

| Field | Type |
|---|---|
| `ok` | boolean |
| `processed` | optional boolean |
| `skipped` | optional boolean |
| `reason` | optional string |

### `cerebellum.l1Tick` / `cerebellum.l2Tick`

Drive one L1 (fast) or L2 (slower) cerebellum memory-consolidation pass.

| Field | L1 | L2 |
|---|---|---|
| Timeout | 60 000 ms | 120 000 ms |
| Mutates daemon DB | yes | yes |
| Idempotency | idempotent per agent / cursor sweep | idempotent per agent / summary cursor sweep |
| Scheduler | non-queued, skip-if-previous-in-flight | non-queued, skip-if-previous-in-flight |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `reason` | no | non-empty string |
| `now` | no | ISO timestamp string |
| `settings` | no | object (host-allowed overrides) |

**Response shape** — same fields as `ce.tick` plus `processed: boolean` (required).

### `memory.read` / `memory.write`

Direct memory-store access.

| Field | `memory.read` | `memory.write` |
|---|---|---|
| Timeout | 30 000 ms | 30 000 ms |
| Mutates daemon DB | no | yes |
| Idempotency | safe to repeat | caller supplies dedupe key when needed |

**`memory.read` request**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `query` | yes | non-empty string |
| `limit` | no | positive integer |

**`memory.read` response**

| Field | Type |
|---|---|
| `entries` | array |

**`memory.write` request**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `entries` | yes | array |

**`memory.write` response**

| Field | Type |
|---|---|
| `ok` | boolean |
| `writtenCount` | non-negative integer |

### `session.receiveEvent`

Deliver one event to the per-agent conversation FSM.

| Field | Type |
|---|---|
| Timeout | 30 000 ms |
| Mutates daemon DB | yes |
| Idempotency | caller supplies `event.id` for replay safety |

**Request shape**

| Field | Required | Type |
|---|---|---|
| `agentId` | yes | UUID string |
| `event` | yes | object with required non-empty `type`, optional non-empty `id` |
| `options` | no | object |

**Response shape**

| Field | Type |
|---|---|
| `ok` | boolean |
| `accepted` | boolean |

### `tool.invoke`

Daemon-local tool dispatch. Used internally by the brain handlers when a
tool entry's `executor === 'local'`; hosts can also call it directly to
exercise daemon-side tools (`recall`, `think_deeper`, `mem:*`).

### `space.tool.invoke` (reverse direction)

The host implements this method. The daemon calls it when a tool entry's
`executor === 'remote'`. Returns either a Class A tool-result envelope
(`{ content, isToolError? }`) or the special approval-pending envelope
(`{ ok: false, code: "APPROVAL_PENDING", approvalId, name, args }`).

## Notification methods

Notifications are fire-and-forget — the daemon emits them via
`process.send()` and never blocks on a host reply.

| Method | Direction | Purpose |
|---|---|---|
| `daemon:ready` | daemon → host | Emitted once at end of startup. Carries `{agentId, pid, socketPath}`. |
| `daemon:shutting_down` | daemon → host | Emitted on SIGTERM before shutdown. |
| `token_usage` | daemon → host | One per LLM call with `{agentId, usage}`. Daemon also persists durable token usage rows to `agent-core.db`. |
| `debug_log` | daemon → host | `{agentId, level: "debug" \| "info" \| "warn" \| "error", message, context?}`. |
| `hook_event` | daemon → host | `{agentId, event}`. Opaque host hook fan-out. |
| `config:changed` | host → daemon | Host pushes a configuration change. Filtered by `agentId` for AI config; `athena_mode` is broadcast globally. |
| `toolRegistry.add` / `toolRegistry.remove` | host → daemon | Runtime tool list updates. |

## Errors

| Code | JSON-RPC code | Retryable | Meaning |
|---|---|---|---|
| `AGENT_CORE_DAEMON_UNAVAILABLE` | — | yes | Daemon process not running. Host should surface as service error. |
| `IPC_TIMEOUT` | -32099 | yes | Request exceeded the per-method timeout. |
| `BRAIN_TOOL_LOOP_PROVIDER_ERROR` | — | depends | Provider call failed inside `brain.toolLoop`. |
| `BRAIN_TOOL_LOOP_CONFIG_UNAVAILABLE` | — | no | No provider config resolved for the agent. |
| `BRAIN_TOOL_LOOP_APPROVAL_NOT_READY` | — | yes | Resume called before suspension persisted. |
| `BRAIN_TOOL_LOOP_RESUME_INVALID_STATE` | — | no | Suspension is in a non-resumable state. |
| `BRAIN_TOOL_LOOP_RESUME_CONFLICT` | — | no | Suspension already consumed by another resume. |
| `BRAIN_TOOL_LOOP_RESUME_AGENT_MISMATCH` | — | no | Resume `agentId` does not match suspension. |
| `BRAIN_TOOL_LOOP_RESUME_NOT_FOUND` | — | no | No suspension row for the given `suspensionId`. |
| `BRAIN_TOOL_LOOP_RESUME_PROVIDER_ERROR` | — | depends | Provider call failed inside the resumed loop. |
| `BRAIN_CHAT_TOOL_STREAM_PROVIDER_ERROR` | — | depends | Provider call failed inside the streaming tool loop. |
| `BRAIN_CHAT_TOOL_STREAM_INTERRUPTED` | — | yes | Host signalled interrupt mid-stream. |
| `BRAIN_CHAT_TOOL_STREAM_CONFIG_UNAVAILABLE` | — | no | No provider config resolved for the agent. |
| `GOVERNANCE_DELEGATE_PROVIDER_ERROR` | — | depends | Provider call failed inside `governance.delegate`. |
| `GOVERNANCE_DELEGATE_INVALID_RESPONSE` | — | no | Decision-word parse failed against `validDecisions`. |

The host should treat any non-listed code as `retryable: false` and surface
the error to the originating caller without auto-retrying.

## Scheduler hints

The frozen contract records a scheduler hint per method so a host can pick
a sensible queueing policy:

- **`queued: false`** — host should not buffer multiple concurrent calls.
- **`blocking: false`** — host should not block the event loop waiting for
  the request.
- **`skipIfPreviousInFlight: true`** — host should skip the new call if a
  previous call for the same method/agent is still in flight (used for the
  cerebellum ticks so a slow consolidation pass doesn't queue up).
