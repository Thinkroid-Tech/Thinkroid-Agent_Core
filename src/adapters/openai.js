// Phase 16α sub-phase J.2 — OpenAI REST stub adapter.
//
// Hosts the OpenAI-compatible REST endpoints (`/v1/*`) on a unix-socket
// HTTP listener. v1 J ships pure stubs: every endpoint returns HTTP 503
// with the OpenAI error shape per ADR §3 / Design §2.5. The kernel is
// NOT wired here — Phase 16.5 / 18 will replace the stub handlers with
// real LLM provider routing once the brain.* IPC contract is final.
//
// Dual-envelope split (Codex M4 v2): OpenAI clients disambiguate purely
// from `{error:{message,type,code}}` — the body MUST NOT carry a
// `jsonrpc` field, otherwise an MCP client could mistake the response
// for an MCP envelope and the dual-protocol contract collapses. Every
// stub response below is asserted by the unit suite to keep this
// invariant load-bearing.
//
// Two usage modes mirror the MCP adapter:
//   1. Standalone (unit tests): `new OpenAiRestAdapter({ socketPath })`
//      boots its own RestStubServer.
//   2. Co-hosted (daemon): `registerOpenAiRoutes(sharedServer)`.

import { RestStubServer } from './rest-stub-server.js';

const STUB_ERROR_MESSAGE =
  'Phase 16 ships REST stubs only; this endpoint is not implemented.';

/**
 * Build the OpenAI error envelope returned by every J-stage `/v1/*`
 * endpoint. Notably absent: any `jsonrpc` field — that discriminator
 * belongs exclusively to the MCP family.
 *
 * @returns {{ status: number, body: object }}
 */
function buildOpenAiStubError() {
  return {
    status: 503,
    body: {
      error: {
        message: STUB_ERROR_MESSAGE,
        type: 'server_error',
        code: 'not_implemented',
      },
    },
  };
}

/**
 * OpenAI REST endpoints exposed in Phase 16α. `GET /v1/models` is the
 * only body-less endpoint; the rest are POST with a JSON body the stub
 * still parses (so a malformed body trips the shared 400 path before
 * ever reaching this handler).
 */
const OPENAI_ROUTES = [
  { method: 'POST', path: '/v1/chat/completions' },
  { method: 'GET', path: '/v1/models' },
  { method: 'POST', path: '/v1/embeddings' },
];

/**
 * Register the OpenAI REST stub routes on a shared RestStubServer. Used
 * by the daemon entrypoint to co-host MCP + OpenAI on a single unix
 * socket.
 *
 * @param {RestStubServer} server
 */
export function registerOpenAiRoutes(server) {
  for (const route of OPENAI_ROUTES) {
    server.registerRoute({
      method: route.method,
      path: route.path,
      handler: async () => buildOpenAiStubError(),
    });
  }
}

/**
 * OpenAI REST adapter — owns its own RestStubServer when used standalone
 * (unit tests). Daemon co-hosting bypasses this class via
 * {@link registerOpenAiRoutes}.
 */
export class OpenAiRestAdapter {
  /**
   * @param {{ socketPath: string }} opts
   */
  constructor({ socketPath }) {
    if (!socketPath) {
      throw new Error('OpenAiRestAdapter: socketPath is required');
    }
    this.socketPath = socketPath;
    this._server = null;
  }

  /**
   * Boot a private RestStubServer + register `/v1/*` routes + listen.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._server) return;
    const server = new RestStubServer({ socketPath: this.socketPath });
    registerOpenAiRoutes(server);
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
