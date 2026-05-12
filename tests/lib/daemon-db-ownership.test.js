import { afterEach, describe, expect, it } from 'vitest';
import { fork, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { openAgentCoreDb } from '../../src/stores/agent-core-db/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const DAEMON_BIN = path.join(REPO_ROOT, 'bin/agent-core-daemon.js');
const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const children = new Set();
const tempDirs = new Set();

function makeTempOffice() {
  const root = fs.mkdtempSync(path.join('/tmp', 'acd-'));
  tempDirs.add(root);
  const agentDir = path.join(root, 'office', 'agents', AGENT_ID);
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    root,
    agentDir,
    memoryDbPath: path.join(agentDir, 'memory.db'),
    agentCoreDbPath: path.join(agentDir, 'agent-core.db'),
    socketPath: path.join(root, 'd.sock'),
  };
}

function buildInitPayload(paths, overrides = {}) {
  return {
    type: 'init',
    config: {
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      memoryDbPath: paths.memoryDbPath,
      agentCoreDbPath: paths.agentCoreDbPath,
      socketPath: paths.socketPath,
      toolList: [
        {
          type: 'function',
          function: {
            name: 'recall',
            description: 'Recall memory.',
            parameters: { type: 'object', properties: {} },
          },
          executor: 'local',
        },
      ],
      brainConfig: { providerId: 'test-provider', model: 'test-model' },
      ...overrides,
    },
  };
}

function forkDaemon() {
  const child = fork(DAEMON_BIN, [], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, INIT_TIMEOUT_MS: '2000' },
  });
  children.add(child);
  return child;
}

function waitForReady(child, initPayload) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon did not become ready. stdout=${stdout} stderr=${stderr}`));
    }, 5000);

    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.stderr?.off('data', onStderr);
      child.stdout?.off('data', onStdout);
    };
    const onStdout = (chunk) => { stdout += chunk.toString(); };
    const onStderr = (chunk) => { stderr += chunk.toString(); };
    const onMessage = (msg) => {
      if (msg?.method !== 'daemon:ready') return;
      cleanup();
      resolve(msg.params);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`daemon exited before ready: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send(initPayload);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function stopDaemon(child) {
  if (!children.has(child)) return;
  children.delete(child);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
  }
  return waitForExit(child);
}

function queryTableExists(dbPath, tableName) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName)?.ok === 1;
  } finally {
    db.close();
  }
}

async function leaveStaleSocket(socketPath) {
  const child = spawn(process.execPath, [
    '-e',
    [
      "const net = require('node:net');",
      'const server = net.createServer();',
      "server.listen(process.argv[1], () => process.send('listening'));",
      "process.on('message', () => {});",
    ].join(' '),
    socketPath,
  ], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stale socket helper did not listen')), 3000);
    child.once('message', (msg) => {
      if (msg === 'listening') {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`stale socket helper exited early: code=${code} signal=${signal}`));
    });
  });

  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  expect(fs.statSync(socketPath).isSocket()).toBe(true);
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stopDaemon(child)));
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('agent-core daemon DB ownership and startup recovery', () => {
  it('creates memory.db and agent-core.db during startup for a clean office', async () => {
    const paths = makeTempOffice();
    expect(fs.existsSync(paths.memoryDbPath)).toBe(false);
    expect(fs.existsSync(paths.agentCoreDbPath)).toBe(false);

    const child = forkDaemon();
    await waitForReady(child, buildInitPayload(paths));

    expect(fs.existsSync(paths.memoryDbPath)).toBe(true);
    expect(fs.existsSync(paths.agentCoreDbPath)).toBe(true);
    expect(queryTableExists(paths.memoryDbPath, 'memories')).toBe(true);
    expect(queryTableExists(paths.agentCoreDbPath, 'session_history')).toBe(true);
  });

  it('restarts against existing daemon-owned DB files', async () => {
    const paths = makeTempOffice();

    const first = forkDaemon();
    await waitForReady(first, buildInitPayload(paths));
    await stopDaemon(first);

    const db = openAgentCoreDb(paths.agentCoreDbPath);
    try {
      db.prepare(
        'INSERT INTO agent_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)'
      ).run('restart-marker', 'present', Date.now(), 'test');
    } finally {
      db.close();
    }

    const second = forkDaemon();
    await waitForReady(second, buildInitPayload(paths));

    const reopened = new Database(paths.agentCoreDbPath, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.prepare('SELECT value FROM agent_config WHERE key = ?').get('restart-marker')?.value)
        .toBe('present');
    } finally {
      reopened.close();
    }
  });

  it('marks in-flight session_history rows interrupted on startup', async () => {
    const paths = makeTempOffice();
    const db = openAgentCoreDb(paths.agentCoreDbPath);
    try {
      db.prepare(
        'INSERT INTO session_history (session_id, turn_index, role, content, created_at, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('session-1', 0, 'assistant', 'pending', Date.now(), 'in_progress');
    } finally {
      db.close();
    }

    const child = forkDaemon();
    await waitForReady(child, buildInitPayload(paths));

    const reopened = new Database(paths.agentCoreDbPath, { readonly: true, fileMustExist: true });
    try {
      expect(reopened.prepare('SELECT status FROM session_history WHERE session_id = ?').get('session-1')?.status)
        .toBe('interrupted');
    } finally {
      reopened.close();
    }
  });

  it('removes a stale unix socket before successful rebind', async () => {
    const paths = makeTempOffice();
    await leaveStaleSocket(paths.socketPath);

    const child = forkDaemon();
    const ready = await waitForReady(child, buildInitPayload(paths));

    expect(ready.socketPath).toBe(paths.socketPath);
  });

  it('does not delete a regular file at socketPath', async () => {
    const paths = makeTempOffice();
    fs.writeFileSync(paths.socketPath, 'not a socket');

    const child = forkDaemon();
    child.send(buildInitPayload(paths));
    const exit = await waitForExit(child);
    children.delete(child);

    expect(exit.code).toBe(5);
    expect(fs.readFileSync(paths.socketPath, 'utf8')).toBe('not a socket');
  });

  it('fails loudly for malformed init payloads before creating DB files', async () => {
    const paths = makeTempOffice();
    const child = forkDaemon();
    child.send(buildInitPayload(paths, { brainConfig: null }));
    const exit = await waitForExit(child);
    children.delete(child);

    expect(exit.code).toBe(4);
    expect(fs.existsSync(paths.memoryDbPath)).toBe(false);
    expect(fs.existsSync(paths.agentCoreDbPath)).toBe(false);
  });
});
