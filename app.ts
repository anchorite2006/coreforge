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
  /** (method, segments) -> the route a full scan would pick, or null. */
  private readonly matchCache = new Map<string, Route | null>();

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, pattern: pattern.split('/').filter((s) => s !== ''), handler });
    this.matchCache.clear();
  }

  /** Whether `route` matches `segments` (params aside), in registration order semantics. */
  private static matches(route: Route, segments: string[]): boolean {
    let i = 0;
    for (const part of route.pattern) {
      if (part.startsWith(':') && part.endsWith('*')) return true;
      if (i >= segments.length) return false;
      if (!part.startsWith(':') && part !== segments[i]) return false;
      i += 1;
    }
    return i === segments.length;
  }

  private static paramsOf(route: Route, segments: string[]): Record<string, string> {
    const params: Record<string, string> = {};
    let i = 0;
    for (const part of route.pattern) {
      if (part.startsWith(':') && part.endsWith('*')) {
        params[part.slice(1, -1)] = segments.slice(i).join('/');
        break;
      }
      if (part.startsWith(':')) params[part.slice(1)] = segments[i]!;
      i += 1;
    }
    return params;
  }

  match(method: string, segments: string[]): { handler: Handler; params: Record<string, string> } | null {
    // The route table is fixed once registration ends, so the winning route
    // for a (method, path) pair never changes; only params are per-request.
    // Hot paths (the suite re-reads one issue thousands of times) skip the
    // linear scan over every registered route.
    // Length-prefixed key: collision-safe even when a decoded segment
    // contains '/' or ':' (e.g. from %2F), unlike a naive join.
    let key = method;
    for (const segment of segments) key += ` ${segment.length}:${segment}`;
    let route = this.matchCache.get(key);
    if (route === undefined) {
      route = this.routes.find((candidate) => candidate.method === method && Router.matches(candidate, segments)) ?? null;
      if (this.matchCache.size >= 1024) this.matchCache.clear();
      this.matchCache.set(key, route);
    }
    if (route === null) return null;
    return { handler: route.handler, params: Router.paramsOf(route, segments) };
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

const EMPTY_BODY: Buffer = Buffer.alloc(0);

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
        const headers: Record<string, string> = { 'x-github-request-id': requestId };
        if (response.headers !== undefined) {
          for (const name of Object.keys(response.headers)) headers[name] = response.headers[name]!;
        }
        let payload: Buffer;
        if (response.raw !== undefined) {
          payload = response.raw;
          if (response.contentType !== undefined) headers['content-type'] = response.contentType;
        } else if (response.json !== undefined) {
          payload = Buffer.from(JSON.stringify(response.json), 'utf8');
          headers['content-type'] = 'application/json; charset=utf-8';
        } else {
          payload = EMPTY_BODY;
        }
        headers['content-length'] = String(payload.length);
        outgoing.writeHead(response.status, headers);
        outgoing.end(payload);
      };
      try {
        // Fast path for the origin-form URLs the suite sends: split the
        // query off by hand instead of paying a WHATWG URL parse per
        // request. Anything the WHATWG parser would normalize (dot
        // segments, backslashes, fragments, controls) takes the exact
        // original path through `new URL`.
        const rawUrl = incoming.url ?? '/';
        let pathname: string;
        let query: URLSearchParams;
        if (
          rawUrl.startsWith('/') &&
          !rawUrl.includes('#') &&
          !rawUrl.includes('\\') &&
          !rawUrl.includes('/.') &&
          !/[^\x21-\x7e]/.test(rawUrl)
        ) {
          const q = rawUrl.indexOf('?');
          pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
          query = new URLSearchParams(q < 0 ? '' : rawUrl.slice(q + 1));
        } else {
          const url = new URL(rawUrl, 'http://forge.invalid');
          pathname = url.pathname;
          query = url.searchParams;
        }
        const segments = pathname
          .split('/')
          .filter((s) => s !== '')
          .map((s) => {
            // decodeURIComponent is the identity on strings without '%'.
            if (!s.includes('%')) return s;
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        const method = (incoming.method ?? 'GET').toUpperCase();

        // The boot probe: no auth, always the same tiny answer.
        if (method === 'GET' && pathname === '/healthz') {
          send({ status: 200, json: { ok: true } });
          return;
        }

        // Bodyless requests skip readBody entirely: attaching stream
        // listeners and waiting for 'end' costs an extra event-loop turn
        // per request. A request carries a body only when its headers say
        // so; GET/HEAD/DELETE without body headers never have one.
        const contentLength = incoming.headers['content-length'];
        const hasBodyHeaders = contentLength !== undefined || incoming.headers['transfer-encoding'] !== undefined;
        const bodylessMethod = method === 'GET' || method === 'HEAD' || method === 'DELETE';
        const body = contentLength === '0' || (bodylessMethod && !hasBodyHeaders) ? EMPTY_BODY : await readBody(incoming);

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
        const result = matched.handler({
          method,
          segments,
          params: matched.params,
          query,
          headers: incoming.headers,
          body,
          ctx,
        });
        // Most handlers are synchronous; awaiting a non-promise still costs
        // a microtask turn per request on the sequential workloads.
        const response = result instanceof Promise ? await result : result;
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
