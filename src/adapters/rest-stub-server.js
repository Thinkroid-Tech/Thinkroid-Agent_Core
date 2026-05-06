// Phase 16α sub-phase J — unified REST stub HTTP server.
//
// The daemon exposes a single unix socket whose request path determines
// which adapter family (MCP vs OpenAI) handles the inbound call. Both
// `McpRestAdapter` and `OpenAiRestAdapter` register their route handlers
// against an instance of this class; the daemon entrypoint owns the
// shared instance so MCP requests and OpenAI requests reach the same
// listener (Design §2.4 + §2.5; ADR §3 cross-protocol contract).
//
// All endpoints in J return HTTP 503 with a family-specific error
// envelope — MCP uses the JSON-RPC 2.0 shape (`code` is a number and
// the body has a `jsonrpc:'2.0'` discriminator), OpenAI uses the OpenAI
// error shape (`code` is a string, no `jsonrpc` field). The split is
// codified by ADR §11.5 / Codex M4 v2 dual envelope decision and must
// not collapse: clients on each family already distinguish 503 stubs
// from "real" responses via the body discriminator alone.
//
// Phase 16.5 / 18 will replace these stubs with kernel-routed handlers;
// for J the server intentionally does NOT touch `kernel.dispatch`.

import http from 'node:http';
import fs from 'node:fs';

/**
 * Route entry registered by an adapter.
 *
 * @typedef {Object} RouteEntry
 * @property {string} method - HTTP method (uppercase).
 * @property {string} path - Exact path to match (no params; J stubs are
 *   fixed-path).
 * @property {(ctx: { body: unknown, rawBody: string, req: http.IncomingMessage }) => Promise<{ status: number, body: object }> | { status: number, body: object }} handler
 */

/**
 * Unified REST stub HTTP server bound to a unix socket.
 *
 * Lifecycle:
 *   1. `new RestStubServer({ socketPath })` — does not bind yet.
 *   2. Adapters call `registerRoute({ method, path, handler })` repeatedly.
 *   3. `await server.start()` — binds the unix socket. Throws if the path
 *      is occupied by a non-socket file or the parent directory is not
 *      writable.
 *   4. `await server.stop()` — closes the listener and removes the
 *      socket file (best-effort).
 */
export class RestStubServer {
  /**
   * @param {{ socketPath: string }} opts
   */
  constructor({ socketPath }) {
    if (!socketPath || typeof socketPath !== 'string') {
      throw new Error('RestStubServer: socketPath is required');
    }
    this.socketPath = socketPath;
    /** @type {RouteEntry[]} */
    this._routes = [];
    /** @type {http.Server | null} */
    this._server = null;
    this._started = false;
  }

  /**
   * Register a single route. Adapters call this once per endpoint they
   * own. Duplicate (method, path) pairs throw — keeps mis-wirings loud.
   *
   * @param {RouteEntry} entry
   */
  registerRoute(entry) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('RestStubServer.registerRoute: entry required');
    }
    const { method, path, handler } = entry;
    if (typeof method !== 'string' || typeof path !== 'string') {
      throw new Error('RestStubServer.registerRoute: method+path required');
    }
    if (typeof handler !== 'function') {
      throw new Error('RestStubServer.registerRoute: handler required');
    }
    const normMethod = method.toUpperCase();
    if (this._routes.some((r) => r.method === normMethod && r.path === path)) {
      throw new Error(
        `RestStubServer.registerRoute: duplicate ${normMethod} ${path}`
      );
    }
    this._routes.push({ method: normMethod, path, handler });
  }

  /**
   * Bind the unix socket and start accepting connections.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._started) return;

    // Stale-socket cleanup: a leftover unix socket file from a previous
    // crashed daemon would cause EADDRINUSE on bind. We only remove it
    // if it is actually a socket — never a regular file.
    if (fs.existsSync(this.socketPath)) {
      const stat = fs.statSync(this.socketPath);
      if (stat.isSocket()) {
        try { fs.unlinkSync(this.socketPath); } catch { /* swallow */ }
      } else {
        throw new Error(
          `RestStubServer.start: path is not a socket: ${this.socketPath}`
        );
      }
    }

    this._server = http.createServer((req, res) => {
      this._handle(req, res).catch((e) => {
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
          }
          res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }));
        } catch { /* swallow */ }
      });
    });

    await new Promise((resolve, reject) => {
      const onErr = (err) => {
        this._server.off('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        this._server.off('error', onErr);
        resolve();
      };
      this._server.once('error', onErr);
      this._server.once('listening', onListen);
      this._server.listen(this.socketPath);
    });

    this._started = true;
  }

  /**
   * Close the listener and remove the socket file.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._started || !this._server) return;
    await new Promise((resolve) => {
      this._server.close(() => resolve());
    });
    this._server = null;
    this._started = false;
    // Best-effort socket file cleanup; ignore ENOENT race with the OS.
    try {
      if (fs.existsSync(this.socketPath)) {
        const stat = fs.statSync(this.socketPath);
        if (stat.isSocket()) {
          fs.unlinkSync(this.socketPath);
        }
      }
    } catch { /* swallow */ }
  }

  /**
   * Internal request dispatcher. Reads the body up to a hard cap, finds a
   * matching route, and lets the adapter handler emit the family-specific
   * 503 envelope. Body parsing failures short-circuit to HTTP 400 with a
   * generic JSON error — both families treat malformed JSON the same way
   * because the request never reached the family-specific handler.
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async _handle(req, res) {
    const url = req.url ?? '/';
    // Strip query string for routing — J stubs ignore query params.
    const pathOnly = url.split('?', 1)[0];

    const route = this._routes.find(
      (r) => r.method === req.method && r.path === pathOnly
    );
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found', path: pathOnly } }));
      return;
    }

    // Collect body. Cap at 1 MiB so a misbehaving client can't OOM the
    // daemon — well above any plausible JSON-RPC envelope.
    const MAX_BODY = 1024 * 1024;
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    let aborted = false;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY) {
        aborted = true;
        break;
      }
      chunks.push(buf);
    }
    if (aborted) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Payload Too Large' } }));
      return;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');

    // GET (and other body-less methods) skip JSON parsing entirely. POST
    // with an empty body is allowed; only a non-empty body that fails to
    // parse is a 400.
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD' && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
        return;
      }
    }

    const result = await route.handler({ body, rawBody, req });
    const status = result?.status ?? 200;
    const respBody = result?.body ?? {};
    // K.4 / Plan §J.1 — every REST stub response carries the
    // `X-Daemon-Mode: stub` header so the tri-protocol contract suite
    // can disambiguate "real handler not yet wired" 503 responses
    // from incidental 503s emitted by future kernel-routed handlers
    // (which will omit the header). The header sits on every status
    // code, not just 503, because the J/K stub server does not host
    // any non-stub routes — Phase 16.5 / 18 will swap individual
    // routes to real handlers and drop the header on a per-route
    // basis.
    const headers = {
      'content-type': 'application/json',
      'x-daemon-mode': 'stub',
    };
    if (result?.headers && typeof result.headers === 'object') {
      Object.assign(headers, result.headers);
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(respBody));
  }
}
