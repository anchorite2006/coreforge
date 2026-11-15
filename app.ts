// HTTP plumbing for the forge: a tiny router, the shared auth rule, and the
// error envelope every surface answers with.
//
// One server hosts four surfaces — REST under /api/v3, GraphQL at
// /api/graphql, MCP at /mcp, and the git smart-HTTP transport at
// /<owner>/<repo>.git — because the suite drives all of them against one
// base URL and one bearer token. Cross-cutting rules live here so the
// surfaces cannot drift apart: the health probe answers without auth, every
// other route requires the trial token when one is configured, every
// response carries an X-GitHub-Request-Id, and every error is a JSON
// {message} body, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Forge } from './lib/store.ts';
import type { LogicalClock } from './lib/clock.ts';

export interface AppContext {
  forge: Forge;
  clock: LogicalClock;
  /** The bearer token the suite presents; empty means "no auth configured". */
  token: string;
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export interface HandlerRequest {
  method: string;
  /** Decoded path segments, e.g. ['api', 'v3', 'user', 'repos']. */
  segments: string[];
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  ctx: AppContext;
}

export interface HandlerResponse {
  status: number;
  /** JSON-serializable body; takes precedence over `raw`. */
  json?: unknown;
  raw?: Buffer;
  contentType?: string;
  headers?: Record<string, string>;
}

type Handler = (req: HandlerRequest) => Promise<HandlerResponse> | HandlerResponse;

interface Route {
  method: string;
  /** Pattern segments: literal, ':name' (one segment), or ':name*' (the rest). */
  pattern: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern: pattern.split('/').filter((s) => s !== ''), handler });
  }

  match(method: string, segments: string[]): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      let i = 0;
      let ok = true;
      for (const part of route.pattern) {
        if (part.startsWith(':') && part.endsWith('*')) {
          params[part.slice(1, -1)] = segments.slice(i).join('/');
          i = segments.length;
          break;
        }
        if (i >= segments.length) {
          ok = false;
          break;
        }
        if (part.startsWith(':')) params[part.slice(1)] = segments[i]!;
        else if (part !== segments[i]) {
          ok = false;
          break;
        }
        i += 1;
      }
      if (ok && i === segments.length) return { handler: route.handler, params };
    }
    return null;
  }
}

/** Parse a JSON request body; a malformed body is a 400, as the API promises. */
export function jsonBody(req: HandlerRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function readBody(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 128 * 1024 * 1024) {
        reject(new HttpError(413, 'Request body too large'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export function createApp(ctx: AppContext, router: Router): Server {
  let requestCounter = 0;
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `F${requestCounter.toString(16).toUpperCase().padStart(4, '0')}:A1B2:${requestCounter}`;
      const send = (response: HandlerResponse): void => {
        const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(response.headers ?? {}) };
        let payload: Buffer;
        if (response.raw !== undefined) {
          payload = response.raw;
          if (response.contentType !== undefined) headers['content-type'] = response.contentType;
        } else if (response.json !== undefined) {
          payload = Buffer.from(JSON.stringify(response.json), 'utf8');
          headers['content-type'] = 'application/json; charset=utf-8';
        } else {
          payload = Buffer.alloc(0);
        }
        headers['content-length'] = String(payload.length);
        outgoing.writeHead(response.status, headers);
        outgoing.end(payload);
      };
      try {
        const url = new URL(incoming.url ?? '/', 'http://forge.invalid');
        const segments = url.pathname
          .split('/')
          .filter((s) => s !== '')
          .map((s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        const method = (incoming.method ?? 'GET').toUpperCase();

        // The boot probe: no auth, always the same tiny answer.
        if (method === 'GET' && url.pathname === '/healthz') {
          send({ status: 200, json: { ok: true } });
          return;
        }

        const body = await readBody(incoming);

        if (ctx.token !== '') {
          const presented = incoming.headers.authorization ?? '';
          if (presented !== `Bearer ${ctx.token}`) {
            send({ status: 401, json: { message: 'Bad credentials' } });
            return;
          }
        }

        const matched = router.match(method, segments);
        if (matched === null) {
          send({ status: 404, json: { message: 'Not Found' } });
          return;
        }
        const response = await matched.handler({
          method,
          segments,
          params: matched.params,
          query: url.searchParams,
          headers: incoming.headers,
          body,
          ctx,
        });
        send(response);
      } catch (error) {
        if (error instanceof HttpError) {
          send({ status: error.status, json: { message: error.message } });
        } else {
          console.error('unhandled handler error', error);
          send({ status: 500, json: { message: 'Internal Server Error' } });
        }
      }
    })();
  });
  return server;
}
