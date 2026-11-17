// HTTP plumbing: one server, four surfaces (git smart HTTP, REST v3, GraphQL,
// MCP), one auth check, one store. Boot binds an ephemeral port, registers it
// with the suite and long-polls for the done signal.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Forge } from './forge.ts';
import { advertise, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest, type RestResult } from './restapi.ts';
import { executeGraphQL } from './gql.ts';
import { handleMcp, mcpParseErrorBody } from './mcp.ts';

const MAX_BODY = 128 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

export function createForgeServer(forge: Forge): ReturnType<typeof createServer> {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authorized = (req: IncomingMessage): boolean => {
    if (expectedToken === '') return true;
    return req.headers.authorization === `Bearer ${expectedToken}`;
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId(),
      'x-oauth-scopes': 'repo',
      ...(extra ?? {}),
    });
    res.end(payload);
  };

  const sendRest = (res: ServerResponse, result: RestResult): void => {
    if (result.status === 204 || result.body === undefined) {
      res.writeHead(result.status, { 'x-github-request-id': requestId(), 'x-oauth-scopes': 'repo', ...(result.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (path === '/healthz') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch) {
          const [, owner, repoName, action] = gitMatch;
          forge.learnOwner(owner);
          if (!authorized(req)) {
            res.writeHead(401, { 'content-type': 'text/plain' });
            res.end('unauthorized');
            return;
          }
          const repo = forge.repos.get(repoName);
          if (!repo) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('repository not found');
            return;
          }
          if (action === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack';
            const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const body = advertise(forge, repo, service, version2);
            res.writeHead(200, {
              'content-type': `application/x-${service}-advertisement`,
              'cache-control': 'no-cache',
            });
            res.end(body);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            const out = handleUploadPack(forge, repo, body, version2);
            res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
            res.end(out);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const out = handleReceivePack(forge, repo, body);
            res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
            res.end(out);
            return;
          }
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('method not allowed');
          return;
        }

        if (path === '/api/graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method not allowed' });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              const item = entry as { query?: string; variables?: Record<string, unknown> };
              return executeGraphQL(forge, String(item.query ?? ''), item.variables ?? {});
            });
            sendJson(res, 200, results);
            return;
          }
          const item = parsed as { query?: string; variables?: Record<string, unknown> };
          const result = executeGraphQL(forge, String(item.query ?? ''), item.variables ?? {});
          sendJson(res, 200, result);
          return;
        }

        if (path === '/mcp') {
          if (!authorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, mcpParseErrorBody());
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => handleMcp(forge, entry as Record<string, unknown>).body).filter((entry) => entry !== undefined);
            sendJson(res, 200, results);
            return;
          }
          const outcome = handleMcp(forge, parsed as Record<string, unknown>);
          if (outcome.status === 202 || outcome.body === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          const headers: Record<string, string> = outcome.sessionId ? { 'mcp-session-id': outcome.sessionId } : {};
          sendJson(res, outcome.status, outcome.body, headers);
          return;
        }

        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const body = method === 'GET' || method === 'DELETE' && false ? Buffer.alloc(0) : await readBody(req);
          const subPath = path.slice('/api/v3'.length);
          const origin = `http://${req.headers.host ?? 'forge.local'}`;
          const result = handleRest(forge, method, subPath, url.searchParams, body, origin);
          sendRest(res, result);
          return;
        }

        if (path === '/') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('hazel-forge');
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: error instanceof Error ? error.message : String(error) });
          } catch {
            res.end();
          }
        } else {
          res.end();
        }
      }
    })();
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;
  return server;
}

/** Bind, register with the suite, and serve until the suite says done. */
export async function serve(): Promise<void> {
  const forge = new Forge();
  const server = createForgeServer(forge);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) return; // Local run: serve until killed.

  const register = async (): Promise<boolean> => {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await register()) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const poll = async (): Promise<void> => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      try {
        const response = await fetch(`${envUrl}/done`);
        if (response.ok) {
          const body = (await response.json()) as { done?: boolean };
          if (body.done) {
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // The suite is not answering yet; keep serving.
      }
    }
  };
  void poll();
}
