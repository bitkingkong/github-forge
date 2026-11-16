// The forge's HTTP server: one Node process, stdlib only. It routes by path:
//
//  GET  /healthz                                   -> 200 {"ok":true} (no auth; the boot dials it)
//  GET  /{owner}/{repo}.git/info/refs             -> git advertisement (v2 or v0)
//  POST /{owner}/{repo}.git/git-upload-pack       -> git fetch / ls-refs
//  POST /{owner}/{repo}.git/git-receive-pack      -> git push
//  POST /api/graphql                             -> GraphQL v4 (single or batch)
//  POST /mcp                                     -> MCP (JSON-RPC 2.0)
//  *    /api/v3/*                                -> REST v3
//
// Authentication: every route except /healthz requires a non-empty Bearer token. The token
// does not encode the viewer — the suite's token is the shop token, and the viewer is the
// scenario's fixed identity (src/viewer.ts) — so any non-empty token is accepted as the
// viewer. The only 401s are for a missing token, which is what the checks assert.
//
// Every reply carries a non-empty X-GitHub-Request-Id. REST replies are application/json;
// git replies carry their own content types. A malformed JSON body is a 400; an unknown
// route is a JSON 404; a handler that throws is a JSON 500 (and never takes the server down).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(store, req, res, ++requestCounter).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[entry] request failed: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': `req-${requestCounter}` });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body exceeds the size limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string>, requestId: string): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId, ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string>, requestId: string): void {
  send(res, status, 'application/json', Buffer.from(JSON.stringify(value), 'utf8'), headers, requestId);
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse, requestNumber: number): Promise<void> {
  const requestId = `req-${requestNumber}`;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

  // The boot's health check carries no token.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true }, {}, requestId);
    return;
  }

  // Authentication: a non-empty Bearer token is the viewer. No token is a 401.
  const authorization = req.headers.authorization ?? '';
  if (!/^Bearer\s+\S+$/.test(authorization)) {
    sendJson(res, 401, { message: 'Requires authentication' }, {}, requestId);
    return;
  }

  const body = await readBody(req);

  // Git smart HTTP.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    const [, owner, repoName, action] = gitMatch as [string, string, string, string];
    const gitProtocol = req.headers['git-protocol'];
    if (method === 'GET' && action === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      const result = handleInfoRefs(store, owner!, repoName!, service, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      send(res, result.status, result.contentType, result.body, {}, requestId);
      return;
    }
    if (method === 'POST' && action === 'git-upload-pack') {
      const result = handleUploadPack(store, owner!, repoName!, body, typeof gitProtocol === 'string' ? gitProtocol : undefined);
      send(res, result.status, result.contentType, result.body, {}, requestId);
      return;
    }
    if (method === 'POST' && action === 'git-receive-pack') {
      const result = handleReceivePack(store, owner!, repoName!, body);
      send(res, result.status, result.contentType, result.body, {}, requestId);
      return;
    }
    sendJson(res, 405, { message: 'Method Not Allowed' }, {}, requestId);
    return;
  }

  // GraphQL v4 (single operation or a batch array).
  if (method === 'POST' && pathname === '/api/graphql') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, {}, requestId);
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((operation) => executeGraphQL(store, operation as { query?: unknown; variables?: unknown }));
      sendJson(res, 200, results.map((result) => result.body), {}, requestId);
      return;
    }
    const result = executeGraphQL(store, parsed as { query?: unknown; variables?: unknown });
    sendJson(res, result.status, result.body, {}, requestId);
    return;
  }

  // MCP.
  if (method === 'POST' && pathname === '/mcp') {
    const result = handleMcp(store, body);
    send(res, result.status, result.contentType, result.body, {}, requestId);
    return;
  }
  if (method === 'DELETE' && pathname === '/mcp') {
    send(res, 405, 'application/json', Buffer.from(JSON.stringify({ message: 'Method Not Allowed' }), 'utf8'), {}, requestId);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    let parsed: unknown = undefined;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Request body is not valid JSON' }, {}, requestId);
        return;
      }
    }
    const result = handleRest({ store, origin }, method, pathname, url.searchParams, parsed);
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' }, {}, requestId);
      return;
    }
    const headers: Record<string, string> = { ...(result.headers ?? {}) };
    if (pathname === '/api/v3') headers['x-oauth-scopes'] = 'repo';
    send(res, result.status, result.contentType, result.body, headers, requestId);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' }, {}, requestId);
}
