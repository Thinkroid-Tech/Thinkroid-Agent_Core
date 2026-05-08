// Phase 16 C.3 — daemon init handshake payload validator.
//
// The Space supervisor forks a per-agent daemon and `process.send()`s the
// init payload (Design §3.2). Step S4 of the daemon's startup sequence
// runs this validator before touching any sub-system; a bad payload makes
// the daemon exit(4) and surfaces as a structured `daemon_events` row on
// the supervisor side rather than a half-initialised process leaking
// into the breaker path.
//
// Validation rules are quoted from Design §3.2:
//   - msg.type === 'init'
//   - agentId matches /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
//   - memoryDbPath absolute + within office/agents/<agentId>/
//   - agentCoreDbPath absolute + within office/agents/<agentId>/
//   - socketPath ends '.sock' + parent dir exists
//   - toolList length > 0 (defensive: every daemon needs at least `recall`)
//   - brainConfig.providerId non-empty string
//
// On any failure: throw new Error(`Invalid init payload: <field>: <reason>`).
// The S4 caller catches → console.error → process.exit(4).

import fs from 'node:fs';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 16.C v2 (M52) — proper directory containment check.
 *
 * The original substring (`includes`) check was vulnerable to a
 * substring escape: `/tmp/office/agents/<id>-evil/memory.db` contains
 * the literal `office/agents/<id>` segment but actually lives in a
 * sibling directory `<id>-evil`. We now resolve the path, split it
 * into directory components, and verify the sequence
 * `office/agents/<agentId>` appears as three consecutive segments
 * with at least one further segment after `<agentId>` (the .db file).
 *
 * Splitting by `path.sep` after `path.resolve` neutralises any
 * `..`-based traversal attempt (resolve normalises) and treats
 * `<id>-evil` as a distinct segment from `<id>`.
 *
 * @param {string} actualPath - the field value (already verified absolute by caller).
 * @param {string} agentId    - the agent UUID that must appear as a path component.
 * @param {string} fieldName  - field name for the error message.
 * @throws {Error} when actualPath does not live strictly inside `**\/office/agents/<agentId>/`.
 */
function assertPathContainedInAgentDir(actualPath, agentId, fieldName) {
  const resolvedActual = path.resolve(actualPath);
  const parts = resolvedActual.split(path.sep);
  // Walk components looking for a 3-segment run [office, agents, <agentId>]
  // with at least one more component following (the file itself).
  let matched = false;
  for (let i = 0; i + 3 < parts.length; i++) {
    if (
      parts[i] === 'office' &&
      parts[i + 1] === 'agents' &&
      parts[i + 2] === agentId
    ) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw new Error(
      `Invalid init payload: ${fieldName}: must live under office/agents/${agentId}/, got ${JSON.stringify(resolvedActual)}`
    );
  }
}

/**
 * @param {unknown} msg - the raw object received via `process.on('message')`.
 * @returns {void} — returns silently on success; throws on failure.
 * @throws {Error} with message shaped `Invalid init payload: <field>: <reason>`.
 */
export function validateInitPayload(msg) {
  if (msg === null || typeof msg !== 'object') {
    throw new Error('Invalid init payload: msg: must be an object');
  }
  if (msg.type !== 'init') {
    throw new Error(
      `Invalid init payload: type: expected 'init', got ${JSON.stringify(msg.type)}`
    );
  }
  const config = msg.config;
  if (config === null || typeof config !== 'object') {
    throw new Error('Invalid init payload: config: must be an object');
  }

  // agentId — UUID v4-ish (case-insensitive, hex+dashes).
  const { agentId } = config;
  if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
    throw new Error(
      `Invalid init payload: agentId: must be a UUID matching ${UUID_RE.source}, got ${JSON.stringify(agentId)}`
    );
  }

  // memoryDbPath — absolute + within office/agents/<agentId>/.
  const { memoryDbPath } = config;
  if (typeof memoryDbPath !== 'string' || memoryDbPath.length === 0) {
    throw new Error('Invalid init payload: memoryDbPath: must be a non-empty string');
  }
  if (!path.isAbsolute(memoryDbPath)) {
    throw new Error(
      `Invalid init payload: memoryDbPath: must be an absolute path, got ${JSON.stringify(memoryDbPath)}`
    );
  }
  // Phase 16.C v2 (M52): path-segment containment instead of substring.
  assertPathContainedInAgentDir(memoryDbPath, agentId, 'memoryDbPath');

  // agentCoreDbPath — same constraints.
  const { agentCoreDbPath } = config;
  if (typeof agentCoreDbPath !== 'string' || agentCoreDbPath.length === 0) {
    throw new Error('Invalid init payload: agentCoreDbPath: must be a non-empty string');
  }
  if (!path.isAbsolute(agentCoreDbPath)) {
    throw new Error(
      `Invalid init payload: agentCoreDbPath: must be an absolute path, got ${JSON.stringify(agentCoreDbPath)}`
    );
  }
  assertPathContainedInAgentDir(agentCoreDbPath, agentId, 'agentCoreDbPath');

  // socketPath — ends `.sock`, parent dir exists, fits inside the
  // 108-byte UNIX domain socket address limit.
  const { socketPath } = config;
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new Error('Invalid init payload: socketPath: must be a non-empty string');
  }
  if (!socketPath.endsWith('.sock')) {
    throw new Error(
      `Invalid init payload: socketPath: must end with '.sock', got ${JSON.stringify(socketPath)}`
    );
  }
  // Phase 16γ.A — UNIX domain socket addresses are bounded by `sun_path`
  // (sys/un.h) which is 108 bytes on Linux (104 on BSD). bind(2) silently
  // truncates anything longer, which produces baffling "no such file"
  // failures at connect-time. We measure bytes (Buffer.byteLength), not
  // characters, because the limit is on the on-wire address string.
  const sockBytes = Buffer.byteLength(socketPath, 'utf8');
  if (sockBytes > 108) {
    throw new Error(
      `Invalid init payload: socketPath: exceeds 108-byte UNIX socket address limit ` +
      `(${sockBytes} bytes): ${JSON.stringify(socketPath)}`
    );
  }
  const socketParent = path.dirname(socketPath);
  if (!fs.existsSync(socketParent)) {
    throw new Error(
      `Invalid init payload: socketPath: parent directory does not exist (${socketParent})`
    );
  }

  // toolList — non-empty array. Defensive: every daemon needs at least `recall`.
  const { toolList } = config;
  if (!Array.isArray(toolList) || toolList.length === 0) {
    throw new Error(
      'Invalid init payload: toolList: must be a non-empty array (every daemon needs at least one tool)'
    );
  }

  // brainConfig.providerId — non-empty string.
  const { brainConfig } = config;
  if (brainConfig === null || typeof brainConfig !== 'object') {
    throw new Error('Invalid init payload: brainConfig: must be an object');
  }
  if (typeof brainConfig.providerId !== 'string' || brainConfig.providerId.length === 0) {
    throw new Error(
      `Invalid init payload: brainConfig.providerId: must be a non-empty string, got ${JSON.stringify(brainConfig.providerId)}`
    );
  }
}
