// The GraphQL surface: a small parser and executor for the document shapes
// the suite sends, over the same store the REST surface serves.
//
// There is deliberately no general GraphQL engine here — the forge answers
// the GitHub schema subset its clients use (viewer, repository, issue and
// pull-request reads, five mutations, node(id:) round-trips, and __type
// introspection). The parser handles the full surface syntax those documents
// need: variables, aliases, arguments with enum/list/input-object literals,
// inline fragments, and batched operations. Field resolution is table-driven
// per type, and the same tables feed introspection, so a field the executor
// cannot answer is also a field introspection never claims.
//
// Global ids are the store's opaque base64 node ids; databaseId is the plain
// integer. An unknown field is a 200 with an errors entry naming the field,
// an unknown repository is data.repository = null with no errors — the two
// failure shapes GitHub itself uses.

import { HttpError, type AppContext, type HandlerRequest, type Router } from '../app.ts';
import { VIEWER } from './identity.ts';
import { decodeGlobalId, encodeGlobalId, type IssueRecord, type PullRecord, type RepoRecord } from './store.ts';
import { createIssue, createPull, mergePull, pullFiles, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- values

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __enum: string }
  | { __var: string };

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (typeof value === 'object' && value !== null) {
    if ('__enum' in value) return (value as { __enum: string }).__enum;
    if ('__var' in value) return variables[(value as { __var: string }).__var];
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = resolveValue(inner, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- parser

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(document: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < document.length) {
    const c = document[i]!;
    if (c === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(c)) {
      i += 1;
      continue;
    }
    if (document.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (document.startsWith('"""', i)) {
        const end = document.indexOf('"""', i + 3);
        if (end < 0) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${document.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < document.length && document[j] !== '"') {
        if (document[j] === '\\') {
          const escaped = document[j + 1]!;
          text += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          text += document[j]!;
          j += 1;
        }
      }
      if (j >= document.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${text}"`);
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < document.length && isNameChar(document[j]!)) j += 1;
      tokens.push(document.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < document.length && /[0-9.eE+-]/.test(document[j]!)) j += 1;
      tokens.push(document.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private take(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const actual = this.take();
    if (actual !== token) throw new GqlSyntaxError(`expected ${token}, found ${actual}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.take() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.take();
        if (this.peek() === '(') this.skipBalanced('(', ')');
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        // Named fragments are parsed and registered nowhere: the documents
        // this surface serves use inline fragments only.
        this.take();
        this.take(); // fragment name
        this.take(); // 'on'
        this.take(); // type condition
        this.parseSelectionSet();
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return operations;
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.take();
      if (token === open) depth += 1;
      else if (token === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.take();
        const on = this.take();
        if (on !== 'on') throw new GqlSyntaxError('named fragment spreads are not supported');
        const typeCondition = this.take();
        selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      let name = this.take();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.take();
        alias = name;
        name = this.take();
      }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.take();
        while (this.peek() !== ')') {
          const argName = this.take();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.take();
      }
      if (this.peek() === '@') {
        // A directive: skip its name and any argument list.
        this.take();
        this.take();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.take();
    return selections;
  }

  private parseValue(): GqlValue {
    const token = this.take();
    if (token === '$') return { __var: this.take() };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.take();
      return items;
    }
    if (token === '{') {
      const object: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.take();
      return object;
    }
    if (token.startsWith('"')) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10);
    if (/^-?\d*\.\d/.test(token)) return Number.parseFloat(token);
    return { __enum: token };
  }
}

// ---------------------------------------------------------------- schema tables

/** Field name -> GraphQL return type, per object type. Drives execution and introspection. */
const TYPE_FIELDS: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    isPrivate: 'Boolean',
    description: 'String',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
  },
  Ref: { name: 'String', prefix: 'String' },
  Issue: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    createdAt: 'String',
    updatedAt: 'String',
    author: 'User',
    labels: 'LabelConnection',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    createdAt: 'String',
    files: 'PullRequestChangedFileConnection',
    author: 'User',
  },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  LabelConnection: { nodes: 'Label' },
  Label: { name: 'String', color: 'String' },
  IssueComment: { id: 'ID', body: 'String', createdAt: 'String', author: 'User' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', clientMutationId: 'String' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type' },
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

// ---------------------------------------------------------------- execution

interface ExecCtx {
  app: AppContext;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

interface Connection<T> {
  items: T[];
  first: number;
  afterIndex: number;
  cursorOf: (item: T) => string;
}

function cursorFor(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

function pageOf<T>(connection: Connection<T>): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const start = connection.afterIndex + 1;
  const nodes = connection.items.slice(start, start + connection.first);
  const last = nodes[nodes.length - 1];
  return {
    nodes,
    totalCount: connection.items.length,
    pageInfo: {
      hasNextPage: start + nodes.length < connection.items.length,
      hasPreviousPage: start > 0,
      endCursor: last === undefined ? null : connection.cursorOf(last),
      startCursor: nodes[0] === undefined ? null : connection.cursorOf(nodes[0]),
    },
  };
}

type Resolver = (source: never, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const repoGid = (repo: RepoRecord): string => encodeGlobalId('Repository', repo.id);
const issueGid = (repo: RepoRecord, issue: IssueRecord): string => encodeGlobalId('Issue', repo.id, issue.number);
const pullGid = (repo: RepoRecord, pull: PullRecord): string => encodeGlobalId('PullRequest', repo.id, pull.number);

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function findByGlobalId(ctx: ExecCtx, id: string): { type: string; repo?: RepoRecord; issue?: IssueRecord; pull?: PullRecord } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const forge = ctx.app.forge;
  if (decoded.type === 'Repository') {
    const repo = forge.repoById(Number.parseInt(decoded.parts[0]!, 10));
    return repo === undefined ? null : { type: 'Repository', repo };
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const repo = forge.repoById(Number.parseInt(decoded.parts[0]!, 10));
    if (repo === undefined) return null;
    const number = Number.parseInt(decoded.parts[1]!, 10);
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { type: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { type: 'PullRequest', repo, pull };
  }
  if (decoded.type === 'User') return { type: 'User' };
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => ({ __gqlType: 'User', login: VIEWER.login }),
    repository: (source, args, ctx) => {
      const repo = ctx.app.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repo;
    },
    node: (source, args, ctx) => {
      const found = findByGlobalId(ctx, String(args.id ?? ''));
      if (found === null) return null;
      if (found.type === 'Repository') return { __gqlType: 'Repository', value: found.repo };
      if (found.type === 'Issue') return { __gqlType: 'Issue', value: { repo: found.repo, issue: found.issue } };
      if (found.type === 'PullRequest') return { __gqlType: 'PullRequest', value: { repo: found.repo, pull: found.pull } };
      return { __gqlType: 'User', login: VIEWER.login };
    },
    __type: (source, args) => ({ __typeName: String(args.name ?? '') }),
    __schema: () => ({}),
  },
  Mutation: {
    createIssue: (source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (found === null || found.repo === undefined) throw new Error('repository not found');
      const issue = createIssue(ctx.app, found.repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { issue: { repo: found.repo, issue }, clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(ctx, String(input.issueId ?? ''));
      if (found === null || found.issue === undefined || found.repo === undefined) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedAt = ctx.app.clock.nowIso();
      return { issue: { repo: found.repo, issue: found.issue }, clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (found === null || found.repo === undefined) throw new Error('repository not found');
      const pull = createPull(ctx.app, found.repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      return { pullRequest: { repo: found.repo, pull }, clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (found === null || found.pull === undefined || found.repo === undefined) throw new Error('pull request not found');
      mergePull(ctx.app, found.repo, found.pull);
      return { pullRequest: { repo: found.repo, pull: found.pull }, clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (source, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findByGlobalId(ctx, String(input.subjectId ?? ''));
      if (found === null || found.repo === undefined || (found.issue === undefined && found.pull === undefined)) {
        throw new Error('subject not found');
      }
      const target = found.issue ?? found.pull!;
      const comment = { id: found.repo.nextCommentId(), body: String(input.body ?? ''), createdAt: ctx.app.clock.nowIso() };
      target.comments.push(comment);
      return {
        commentEdge: { node: { repo: found.repo, comment } },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  User: {
    id: () => encodeGlobalId('User', VIEWER.id),
    login: () => VIEWER.login,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
  },
  Repository: {
    id: (repo: RepoRecord) => repoGid(repo),
    databaseId: (repo: RepoRecord) => repo.id,
    name: (repo: RepoRecord) => repo.name,
    nameWithOwner: (repo: RepoRecord) => repo.fullName,
    owner: (repo: RepoRecord) => ({ __gqlType: 'User', login: repo.owner }),
    defaultBranchRef: (repo: RepoRecord) => {
      if (repo.headSha() === null) return null;
      return { name: repo.defaultBranch(), prefix: 'refs/heads/' };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (repo: RepoRecord) => repo.isPrivate,
    description: (repo: RepoRecord) => repo.description,
    issue: (repo: RepoRecord, args) => {
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : { repo, issue };
    },
    issues: (repo: RepoRecord, args) => {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let items = [...repo.issues.values()];
      if (states !== null) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        items = items.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      items.sort((a, b) => (a.seq - b.seq) * direction);
      const first = typeof args.first === 'number' ? args.first : 30;
      let afterIndex = -1;
      if (typeof args.after === 'string') {
        const decoded = Buffer.from(args.after, 'base64').toString('utf8');
        const seq = Number.parseInt(decoded.replace(/^cursor:/, ''), 10);
        afterIndex = items.findIndex((issue) => issue.seq === seq);
      }
      const connection: Connection<IssueRecord> = { items, first, afterIndex, cursorOf: (issue) => cursorFor(issue.seq) };
      return { __connection: pageOf(connection), repo };
    },
    pullRequest: (repo: RepoRecord, args) => {
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : { repo, pull };
    },
    pullRequests: (repo: RepoRecord, args) => {
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let items = [...repo.pulls.values()];
      if (states !== null) {
        const wanted = new Set(states);
        items = items.filter((pull) => wanted.has(pullState(pull)));
      }
      items.sort((a, b) => (b.seq - a.seq) * 1);
      const first = typeof args.first === 'number' ? args.first : 30;
      const connection: Connection<PullRecord> = { items, first, afterIndex: -1, cursorOf: (pull) => cursorFor(pull.seq) };
      return { __connection: pageOf(connection), repo };
    },
  },
  Issue: {
    id: (source: { repo: RepoRecord; issue: IssueRecord }) => issueGid(source.repo, source.issue),
    number: (source: { issue: IssueRecord }) => source.issue.number,
    title: (source: { issue: IssueRecord }) => source.issue.title,
    body: (source: { issue: IssueRecord }) => source.issue.body,
    state: (source: { issue: IssueRecord }) => source.issue.state.toUpperCase(),
    createdAt: (source: { issue: IssueRecord }) => source.issue.createdAt,
    updatedAt: (source: { issue: IssueRecord }) => source.issue.updatedAt,
    author: () => ({ __gqlType: 'User', login: VIEWER.login }),
    labels: (source: { repo: RepoRecord; issue: IssueRecord }) => ({
      nodes: source.issue.labels.map((name) => ({ name, color: source.repo.labels.get(name)?.color ?? '000000' })),
    }),
  },
  PullRequest: {
    id: (source: { repo: RepoRecord; pull: PullRecord }) => pullGid(source.repo, source.pull),
    number: (source: { pull: PullRecord }) => source.pull.number,
    title: (source: { pull: PullRecord }) => source.pull.title,
    body: (source: { pull: PullRecord }) => source.pull.body,
    state: (source: { pull: PullRecord }) => pullState(source.pull),
    merged: (source: { pull: PullRecord }) => source.pull.merged,
    mergeable: (source: { repo: RepoRecord; pull: PullRecord }) => pullMergeable(source.repo, source.pull),
    headRefName: (source: { pull: PullRecord }) => source.pull.headRef,
    baseRefName: (source: { pull: PullRecord }) => source.pull.baseRef,
    createdAt: (source: { pull: PullRecord }) => source.pull.createdAt,
    author: () => ({ __gqlType: 'User', login: VIEWER.login }),
    files: (source: { repo: RepoRecord; pull: PullRecord }, args) => {
      const all = pullFiles(source.repo, source.pull).map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      const first = typeof args.first === 'number' ? args.first : 30;
      return { nodes: all.slice(0, first), totalCount: all.length };
    },
  },
  IssueConnection: {
    nodes: (source: { __connection: ReturnType<typeof pageOf<IssueRecord>>; repo: RepoRecord }) =>
      source.__connection.nodes.map((issue) => ({ repo: source.repo, issue })),
    pageInfo: (source: { __connection: ReturnType<typeof pageOf<IssueRecord>> }) => source.__connection.pageInfo,
    totalCount: (source: { __connection: ReturnType<typeof pageOf<IssueRecord>> }) => source.__connection.totalCount,
  },
  PullRequestConnection: {
    nodes: (source: { __connection: ReturnType<typeof pageOf<PullRecord>>; repo: RepoRecord }) =>
      source.__connection.nodes.map((pull) => ({ repo: source.repo, pull })),
    pageInfo: (source: { __connection: ReturnType<typeof pageOf<PullRecord>> }) => source.__connection.pageInfo,
    totalCount: (source: { __connection: ReturnType<typeof pageOf<PullRecord>> }) => source.__connection.totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (source: { nodes: unknown[] }) => source.nodes,
    totalCount: (source: { totalCount: number }) => source.totalCount,
  },
  PageInfo: {
    hasNextPage: (source: Record<string, unknown>) => source.hasNextPage,
    hasPreviousPage: (source: Record<string, unknown>) => source.hasPreviousPage,
    endCursor: (source: Record<string, unknown>) => source.endCursor,
    startCursor: (source: Record<string, unknown>) => source.startCursor,
  },
  LabelConnection: {
    nodes: (source: { nodes: unknown[] }) => source.nodes,
  },
  Label: {
    name: (source: { name: string }) => source.name,
    color: (source: { color: string }) => source.color,
  },
  Ref: {
    name: (source: { name: string }) => source.name,
    prefix: (source: { prefix: string }) => source.prefix,
  },
  IssueComment: {
    id: (source: { repo: RepoRecord; comment: { id: number } }) => encodeGlobalId('IssueComment', source.repo.id, source.comment.id),
    body: (source: { comment: { body: string } }) => source.comment.body,
    createdAt: (source: { comment: { createdAt: string } }) => source.comment.createdAt,
    author: () => ({ __gqlType: 'User', login: VIEWER.login }),
  },
  CreateIssuePayload: {
    issue: (source: { issue: unknown }) => source.issue,
    clientMutationId: (source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (source: { issue: unknown }) => source.issue,
    clientMutationId: (source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (source: { pullRequest: unknown }) => source.pullRequest,
    clientMutationId: (source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (source: { pullRequest: unknown }) => source.pullRequest,
    clientMutationId: (source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (source: { commentEdge: unknown }) => source.commentEdge,
    clientMutationId: (source: { clientMutationId: unknown }) => source.clientMutationId,
  },
  CommentEdge: {
    node: (source: { node: unknown }) => source.node,
  },
  __Type: {
    name: (source: { __typeName: string }) => (TYPE_FIELDS[source.__typeName] !== undefined || ENUM_VALUES[source.__typeName] !== undefined ? source.__typeName : null),
    kind: (source: { __typeName: string }) => (ENUM_VALUES[source.__typeName] !== undefined ? 'ENUM' : 'OBJECT'),
    fields: (source: { __typeName: string }) => {
      const fields = TYPE_FIELDS[source.__typeName];
      if (fields === undefined) return null;
      return Object.keys(fields).map((name) => ({ name }));
    },
    enumValues: (source: { __typeName: string }) => {
      const values = ENUM_VALUES[source.__typeName];
      if (values === undefined) return null;
      return values.map((name) => ({ name }));
    },
  },
  __Field: { name: (source: { name: string }) => source.name },
  __EnumValue: { name: (source: { name: string }) => source.name },
  __Schema: {
    queryType: () => ({ __typeName: 'Query' }),
    mutationType: () => ({ __typeName: 'Mutation' }),
  },
};

/** Unwrap a tagged source ({__gqlType, value}) into [typeName, source]. */
function unwrap(typeName: string, value: unknown): [string, unknown] {
  if (typeof value === 'object' && value !== null && '__gqlType' in value) {
    const tagged = value as { __gqlType: string; value?: unknown; login?: string };
    if (tagged.__gqlType === 'User') return ['User', { login: tagged.login ?? VIEWER.login }];
    return [tagged.__gqlType, tagged.value ?? tagged];
  }
  return [typeName, value];
}

function executeSelection(typeName: string, source: unknown, selection: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS[typeName];
  const resolvers = RESOLVERS[typeName] ?? {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition === typeName) Object.assign(out, executeSelection(typeName, source, node.selection, ctx));
      continue;
    }
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const declared = fields?.[node.name];
    const resolver = resolvers[node.name];
    if (declared === undefined) {
      ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(node.args)) args[argName] = resolveValue(argValue, ctx.variables);
    let value: unknown;
    try {
      if (resolver !== undefined) {
        value = (resolver as (s: never, a: Record<string, unknown>, c: ExecCtx) => unknown)(source as never, args, ctx);
      } else if (typeof source === 'object' && source !== null && node.name in source) {
        // Plain data records (changed files, page info) resolve by property.
        value = (source as Record<string, unknown>)[node.name];
      } else {
        ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    if (value === null || value === undefined || node.selection === null) {
      out[key] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const [itemType, itemSource] = unwrap(declared, item);
        return executeSelection(itemType, itemSource, node.selection!, ctx);
      });
      continue;
    }
    const [childType, childSource] = unwrap(declared, value);
    out[key] = executeSelection(childType, childSource, node.selection, ctx);
  }
  return out;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>, app: AppContext): Record<string, unknown> {
  const ctx: ExecCtx = { app, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, {}, operation.selection, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

// ---------------------------------------------------------------- route

export function registerGraphQlRoutes(router: Router): void {
  router.add('POST', '/api/graphql', (req: HandlerRequest) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Problems parsing JSON');
    }
    const runOne = (entry: unknown): Record<string, unknown> => {
      if (typeof entry !== 'object' || entry === null) return { errors: [{ message: 'Invalid operation' }] };
      const { query, variables, operationName } = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
      if (typeof query !== 'string') return { errors: [{ message: 'No query provided' }] };
      let operations: Operation[];
      try {
        operations = new Parser(tokenize(query)).parseDocument();
      } catch (error) {
        return { errors: [{ message: error instanceof Error ? error.message : 'Syntax error' }] };
      }
      const operation =
        typeof operationName === 'string' ? (operations.find((op) => op.name === operationName) ?? operations[0]) : operations[0];
      if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
      const vars = typeof variables === 'object' && variables !== null ? (variables as Record<string, unknown>) : {};
      return executeOperation(operation, vars, req.ctx);
    };
    if (Array.isArray(parsed)) return { status: 200, json: parsed.map(runOne) };
    return { status: 200, json: runOne(parsed) };
  });
}
