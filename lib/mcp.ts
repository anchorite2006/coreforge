// The MCP surface: JSON-RPC 2.0 over POST /mcp, speaking the current
// stateless revision (server/discover, no handshake, no session) and the
// older initialize handshake with the same tool set.
//
// The tools are the github-mcp-server core six, implemented over the same
// store and domain operations as REST and GraphQL, so an object created
// over MCP reads back over /api/v3 as the very same object. Tool results
// carry the payload twice — as a JSON text block and as structuredContent —
// because clients read either. The tools/list answer is a module constant:
// two calls must return it byte for byte.

import { HttpError, type AppContext, type HandlerRequest, type Router } from '../app.ts';
import { VIEWER } from './identity.ts';
import type { RepoRecord } from './store.ts';
import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const tool = (
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDefinition => ({ name, description, inputSchema: { type: 'object', properties, required } });

const OWNER_PROP = { type: 'string', description: 'The repository owner login.' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };
const FULL_NAME_PROP = { type: 'string', description: 'The repository full name, owner/repo.' };

const TOOLS: ToolDefinition[] = [
  tool(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    { owner: OWNER_PROP, repo: REPO_PROP, full_name: FULL_NAME_PROP },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', description: 'Label names to apply; each must already exist.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository, optionally filtered by state (open, closed, all).',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      state: { type: 'string', description: 'open, closed, or all (default open).' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request (squash) into its base branch.',
    {
      owner: OWNER_PROP,
      repo: REPO_PROP,
      full_name: FULL_NAME_PROP,
      pull_number: { type: 'number', description: 'The pull request number.' },
      merge_method: { type: 'string', description: 'The merge method; squash is supported.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

// ---------------------------------------------------------------- JSON-RPC core

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolSuccess(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFromArgs(ctx: AppContext, args: Record<string, unknown>): RepoRecord {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const [fullOwner, fullRepo] = args.full_name.split('/');
    if (owner === '' && fullOwner !== undefined) owner = fullOwner;
    if (repo === '' && fullRepo !== undefined) repo = fullRepo;
  }
  const found = ctx.forge.getRepo(owner, repo);
  if (found === undefined) throw new Error(`repository ${owner}/${repo} not found`);
  return found;
}

function callTool(ctx: AppContext, params: Record<string, unknown>): Record<string, unknown> | RpcError {
  const name = typeof params.name === 'string' ? params.name : '';
  const definition = TOOLS.find((candidate) => candidate.name === name);
  if (definition === undefined) return { code: -32602, message: `Unknown tool: ${name}` };
  const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined) return { code: -32602, message: `Missing required argument: ${required}` };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = ctx.forge.createRepo(
          VIEWER.login,
          String(args.name),
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
          ctx.clock.nowIso(),
        );
        if (repo === null) return toolFailure(`a repository named ${String(args.name)} already exists`);
        return toolSuccess(repoJson(repo));
      }
      case 'get_repo': {
        return toolSuccess(repoJson(repoFromArgs(ctx, args)));
      }
      case 'create_issue': {
        const repo = repoFromArgs(ctx, args);
        const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
        const issue = createIssue(ctx, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          labels,
        });
        return toolSuccess(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = repoFromArgs(ctx, args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        return toolSuccess(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = repoFromArgs(ctx, args);
        const pull = createPull(ctx, repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolSuccess(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = repoFromArgs(ctx, args);
        const pull = repo.pulls.get(Number(args.pull_number));
        if (pull === undefined) return toolFailure(`pull request ${String(args.pull_number)} not found`);
        mergePull(ctx, repo, pull);
        return toolSuccess(pullJson(repo, pull));
      }
      default:
        return { code: -32602, message: `Unknown tool: ${name}` };
    }
  } catch (error) {
    if (error instanceof HttpError) return toolFailure(error.message);
    return toolFailure(error instanceof Error ? error.message : String(error));
  }
}

function handleMessage(ctx: AppContext, message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, { code: -32600, message: 'Invalid Request' });
  const record = message as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const isNotification = !('id' in record);
  if (isNotification) return null;
  const id = record.id ?? null;
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const outcome = callTool(ctx, params);
      if ('code' in outcome) return rpcError(id, outcome);
      return rpcResult(id, outcome);
    }
    default:
      return rpcError(id, { code: -32601, message: `Method not found: ${method}` });
  }
}

export function registerMcpRoutes(router: Router): void {
  router.add('POST', '/mcp', (req: HandlerRequest) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      return {
        status: 400,
        json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      };
    }
    if (Array.isArray(parsed)) {
      const responses = parsed.map((entry) => handleMessage(req.ctx, entry)).filter((entry) => entry !== null);
      if (responses.length === 0) return { status: 202, raw: Buffer.alloc(0) };
      return { status: 200, json: responses };
    }
    const response = handleMessage(req.ctx, parsed);
    if (response === null) return { status: 202, raw: Buffer.alloc(0) };
    return { status: 200, json: response };
  });
}
