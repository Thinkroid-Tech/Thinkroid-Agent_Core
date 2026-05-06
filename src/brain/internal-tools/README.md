# Internal Tool Registry

Agent Core-owned Brain tools. Routed by the tool-loop *before* Space tools,
and never pass through Space permission checks or the Space approval flow.

**Runtime policy still applies.** Internal tools go through the same
runtime-policy gate as Space tools (see `tool-loop.js` — the gate runs
before dispatch). For example, `think_deeper` is rejected in linger mode
because it is not in `LINGER_SAFE_TOOLS`. If a future internal tool needs
to bypass gating in a given mode, it must be explicitly allow-listed in
`runtime-policy.js`.

## Contract

Each module exports:

- `schema` — OpenAI-style tool definition (`{ type: 'function', function: {...} }`).
- `createHandler(ctx)` — returns `async (args) => rawResult`.

`rawResult` is normalized by `services/ai/normalize-tool-result.js`, so the
handler may return any string / object / envelope shape.

## Adding a new internal tool

1. Create `<name>.js` with the two named exports.
2. Register it in `index.js` inside `internalToolRegistry` (a `Map`).
   Insertion order matters: it fixes the tool ordering in the Brain payload
   and therefore the BP1 cache prefix.
3. If the handler needs extra closures, ensure `Supervisor` injects them
   into `toolContext` (see `thinkDeeper` for the canonical pattern).

## Why not just use `services/tools/`?

- Internal tools need to work without Space (e.g. when Supervisor is running
  headless for tests).
- They bypass the Space permission / approval flow — they are trusted
  implementations owned by Agent Core itself. (Runtime policy still applies;
  see above.)
- Keeping them in a separate registry makes the tool-loop dispatch explicit.

## Current tools

| Name           | Purpose                                    |
| -------------- | ------------------------------------------ |
| `think_deeper` | CE Stage 4 deep memory search (DL-46).     |
