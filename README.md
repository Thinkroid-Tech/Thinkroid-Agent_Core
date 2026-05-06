# @thinkroid/agent-core

Per-agent daemon process for the Thinkroid-Space platform.

This sibling repo is the extracted Agent Core (Brain + Context Engine + Cerebellum + per-agent SQLite + IPC + REST stubs) from the Phase 16β refactor of the parent Thinkroid-Space repo.

## Status
- Phase 16α (sub-phases B-K): foundational daemon infrastructure + α A1-A5 acceptance — done
- Phase 16β (sub-phases L1'-L3'): Athena promotion + UI bridge + SSE streaming + configOverride + Athena modes — done
- Phase 16β M (current): repo extraction + Docker integration

## Origin
Code lifted from `thinkroid-space-server/src/services/agent-core/` of the Thinkroid-Space repo (branch `phase-16-agent-core-daemon`). Per-file blame in this repo points to the M.A initial commit; for archeology see the source branch.

## Layout
- `bin/agent-core-daemon.js` — daemon entrypoint (managed by Space supervisor via `child_process.fork()`)
- `src/kernel.js` — JSON-RPC kernel (handler registration + dispatch)
- `src/adapters/` — IPC + MCP + OpenAI adapters
- `src/brain/` — Brain (LLM tool loop, internal tools)
- `src/ce/` — Context Engine
- `src/cerebellum/` — Cerebellum (L1/L2 tickers, summarization)
- `src/lib/` — daemon-side utility helpers
- `src/stores/` — per-agent `agent-core.db` stores
- `src/supervisor/` — daemon-internal per-agent session FSM (Awake / Drowsy / Dormant)
- `src/types/` — shared JSDoc typedefs
- `modules/thinkroid-memory/` — bundled per-agent `memory.db` helper

## Standalone mode
v1 rejects standalone invocation with exit code 2 (Plan §Q24). The daemon must be forked by a Space supervisor that injects an init payload. Future phases may relax this for REPL access.

## License
See `LICENSE` in the parent Thinkroid-Space repo.
