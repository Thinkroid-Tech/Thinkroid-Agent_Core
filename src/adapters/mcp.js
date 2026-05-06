// Phase 16α sub-phase J.1 — MCP REST stub adapter.
//
// Hosts the agent's MCP REST endpoints (`/mcp/*`) on a unix-socket HTTP
// listener. v1 J ships pure stubs: every endpoint returns HTTP 503 with
// a JSON-RPC 2.0 error envelope per ADR §3 / §11.5. The kernel is NOT
// wired here — Phase 16.5 / 18 will replace the stub handlers with real
// kernel.dispatch routing once the MCP client lifecycle is finalised.
//
// The dual-envelope split (MCP = JSON-RPC, OpenAI = OpenAI shape) is
// codified by Codex M4 v2: clients of each family disambiguate purely
// from the body discriminator, so this adapter MUST emit the JSON-RPC
// envelope literally — `jsonrpc:'2.0'`, numeric `error.code`, the
// request `id` echoed back when present, and `method:'-32601'` to flag
// "Method not implemented" for stub endpoints.
//
// Two usage modes:
//   1. Standalone (unit tests): `new McpRestAdapter({ socketPath })`
//      → `start()` boots its own RestStubServer.
//   2. Co-hosted (daemon): `McpRestAdapter.registerRoutes(server)` on
//      a shared RestStubServer instance — see `bin/agent-core-daemon.js`
//      S10.

import { RestStubServer } from './rest-stub-server.js';

const STUB_ERROR_MESSAGE = 'Method not implemented in Phase 16α/β';
// JSON-RPC -32601 = "Method not found"; matches the ADR §3 wire shape
// for "endpoint exists but has no implementation yet".
const METHOD_NOT_FOUND = -32601;

/**
 * Build the JSON-RPC 2.0 error envelope returned by every J-stage MCP
 * endpoint. The `id` is echoed from the request body when present
 * (per JSON-RPC §5), `null` otherwise — matches MCP SDK clients that
 * key responses by id.
 *
 * @param {unknown} body - Parsed request body (may be null / not object).
 * @returns {{ status: number, body: object }}
 */
function buildJsonRpcStubError(body) {
  const id =
    body && typeof body === 'object' && 'id' in body
      ? /** @type {{ id: unknown }} */ (body).id
      : null;
  return {
    status: 503,
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code: METHOD_NOT_FOUND,
        message: STUB_ERROR_MESSAGE,
      },
    },
  };
}

/**
 * The five MCP REST endpoints exposed in Phase 16α. All share the same
 * stub handler — Phase 16.5 / 18 will swap each one out independently
 * for a real kernel-routed implementation.
 */
const MCP_ROUTES = [
  { method: 'POST', path: '/mcp/initialize' },
  { method: 'POST', path: '/mcp/tools/list' },
  { method: 'POST', path: '/mcp/tools/call' },
  { method: 'POST', path: '/mcp/resources/read' },
  { method: 'POST', path: '/mcp/resources/list' },
];

/**
 * Register the MCP REST stub routes on a shared RestStubServer. Pure
 * function so the daemon entrypoint can wire MCP + OpenAI onto the same
 * server without instantiating the McpRestAdapter class.
 *
 * @param {RestStubServer} server
 */
export function registerMcpRoutes(server) {
  for (const route of MCP_ROUTES) {
    server.registerRoute({
      method: route.method,
      path: route.path,
      handler: async ({ body }) => buildJsonRpcStubError(body),
    });
  }
}

/**
 * MCP REST adapter — owns its own RestStubServer when used standalone
 * (unit tests). Daemon co-hosting bypasses this class via
 * {@link registerMcpRoutes}.
 */
export class McpRestAdapter {
  /**
   * @param {{ socketPath: string }} opts
   */
  constructor({ socketPath }) {
    if (!socketPath) {
      throw new Error('McpRestAdapter: socketPath is required');
    }
    this.socketPath = socketPath;
    this._server = null;
  }

  /**
   * Boot a private RestStubServer + register MCP routes + listen.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._server) return;
    const server = new RestStubServer({ socketPath: this.socketPath });
    registerMcpRoutes(server);
    await server.start();
    this._server = server;
  }

  /**
   * Stop the private RestStubServer if one was started.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._server) return;
    await this._server.stop();
    this._server = null;
  }
}
