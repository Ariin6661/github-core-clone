// One HTTP server for all four surfaces: git smart HTTP, REST v3, GraphQL
// and MCP, plus /healthz. Keep-alive is on (Node's default): the benchmark's
// 2,000 sequential reads reuse one socket. Auth is a bearer token from
// MAKEFUN_SHOP_TOKEN; git routes and /healthz take none.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { scenarioIdentity } from './scenario.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ServerOptions {
  token: string;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
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

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': nextRequestId() });
  res.end(body);
}

function badCredentials(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function checkAuth(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length).trim();
  if (presented === '') return false;
  if (token !== '') return presented === token;
  return true;
}

export function createApp(options: ServerOptions): { server: Server; forge: Forge } {
  const forge = new Forge();
  const viewer = scenarioIdentity().viewer.login;
  const token = options.token;

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const method = req.method ?? 'GET';
        const path = url.pathname;
        const origin = `http://${req.headers.host ?? 'localhost'}`;

        if (path === '/healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!checkAuth(req, token)) {
            badCredentials(res);
            return;
          }
          const bodyText = (await readBody(req)).toString('utf8');
          let body: unknown;
          try {
            body = JSON.parse(bodyText) as unknown;
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const result = executeGraphQL(body, {}, { forge, viewer });
          sendJson(res, 200, result);
          return;
        }

        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (!checkAuth(req, token)) {
            badCredentials(res);
            return;
          }
          const bodyText = (await readBody(req)).toString('utf8');
          const reply = handleMcp(bodyText, { forge, viewer });
          if (reply.json === null) {
            res.writeHead(reply.status, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.json);
          return;
        }

        if (path.startsWith('/api/v3')) {
          const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
          const segments = restPath.split('/').filter((s) => s !== '');
          const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
          if (!isPublic && !checkAuth(req, token)) {
            badCredentials(res);
            return;
          }
          const bodyText = method === 'GET' || method === 'HEAD' ? '' : (await readBody(req)).toString('utf8');
          const reply = handleRest(method, segments, url.searchParams, bodyText, { forge, viewer, origin });
          if (reply.status === 204) {
            res.writeHead(204, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.json, reply.headers);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] ?? '';
          if (suffix === '/info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const reply = infoRefs(forge, owner, repoName, service, wantsV2);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          if (suffix === '/git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = uploadPack(forge, owner, repoName, body);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          if (suffix === '/git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const reply = receivePack(forge, owner, repoName, body);
            sendRaw(res, reply.status, reply.contentType, reply.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: (err as Error).message });
        else res.destroy();
      }
    })();
  });

  return { server, forge };
}
