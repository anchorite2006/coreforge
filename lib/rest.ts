// The REST v3 surface, plus the issue/pull domain operations the GraphQL
// and MCP surfaces share (so all three act on one store with one behavior).
//
// Response shapes follow GitHub's: a repository object with id, full_name,
// owner and default_branch; issues and pulls numbered from one shared
// per-repository sequence; contents addressed by path with base64 bodies and
// blob-sha optimistic concurrency. Errors are always {message} JSON with the
// status GitHub would use — 404 for anything missing (never 403, which would
// leak existence), 422 for validation failures, 409 for a stale content sha,
// 405 for an unmergeable pull request.

import { HttpError, jsonBody, type AppContext, type HandlerRequest, type HandlerResponse, type Router } from '../app.ts';
import {
  buildCommitData,
  buildTreeFromFlat,
  diffLineCounts,
  flattenTree,
  isDirMode,
  mergeBase,
  mergeTrees,
  parseCommitData,
  parseTreeData,
  type ObjectStore,
} from './gitcore.ts';
import { VIEWER } from './identity.ts';
import type { IssueRecord, LabelRecord, PullRecord, RepoRecord } from './store.ts';

// ---------------------------------------------------------------- shared helpers

export function repoOr404(req: HandlerRequest, owner: string, name: string): RepoRecord {
  const repo = req.ctx.forge.getRepo(owner, name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

export function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type, name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: VIEWER.type },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch(),
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: '',
    clone_url: '',
    size: 0,
  };
}

export function labelJson(repo: RepoRecord, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name) ?? { name }),
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: '',
  };
}

interface IssueJsonCache {
  title: string;
  body: string;
  state: IssueRecord['state'];
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: string[];
  labelRefs: (LabelRecord | undefined)[];
  buf: Buffer;
}

const issueJsonCaches = new WeakMap<IssueRecord, IssueJsonCache>();

/**
 * The serialized form of one issue, replayed while every input of
 * issueJson is untouched. The fingerprint compares exactly what issueJson
 * reads — the issue's own fields, its label names in order, the label
 * records they resolve to (labels are never mutated after creation), and
 * the comment count — so a mutation from any surface (REST PATCH, a new
 * comment, a GraphQL state change) misses the cache and rebuilds. The
 * timed read workload re-reads one issue thousands of times and otherwise
 * pays the object build plus JSON.stringify on every request.
 */
export function issueJsonBuffer(repo: RepoRecord, issue: IssueRecord): Buffer {
  const labelRefs = issue.labels.map((name) => repo.labels.get(name));
  const cached = issueJsonCaches.get(issue);
  if (
    cached !== undefined &&
    cached.title === issue.title &&
    cached.body === issue.body &&
    cached.state === issue.state &&
    cached.createdAt === issue.createdAt &&
    cached.updatedAt === issue.updatedAt &&
    cached.comments === issue.comments.length &&
    cached.labels.length === issue.labels.length &&
    cached.labels.every((name, i) => name === issue.labels[i]) &&
    cached.labelRefs.every((ref, i) => ref === labelRefs[i])
  ) {
    return cached.buf;
  }
  const buf = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueJsonCaches.set(issue, {
    title: issue.title,
    body: issue.body,
    state: issue.state,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    comments: issue.comments.length,
    labels: [...issue.labels],
    labelRefs,
    buf,
  });
  return buf;
}

export function commentJson(comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: '',
  };
}

export function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
  };
}

function parseIdentLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', date: '' };
  return { name: match[1]!, email: match[2]!, date: new Date(Number.parseInt(match[3]!, 10) * 1000).toISOString() };
}

export function commitJson(repo: RepoRecord, sha: string): Record<string, unknown> {
  const object = repo.store.get(sha);
  if (object === undefined || object.type !== 'commit') throw new HttpError(404, 'Not Found');
  const parsed = parseCommitData(object.data);
  return {
    sha,
    commit: {
      message: parsed.message,
      tree: { sha: parsed.tree },
      author: parseIdentLine(parsed.authorLine),
      committer: parseIdentLine(parsed.committerLine),
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    author: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
    committer: { login: VIEWER.login, id: VIEWER.id, type: VIEWER.type },
  };
}

/** Resolve a branch name, tag name, or raw commit sha to a commit sha. */
export function resolveCommit(repo: RepoRecord, ref: string): string | null {
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) {
    let current = tag;
    for (let hops = 0; hops < 8; hops += 1) {
      const object = repo.store.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
    }
    return null;
  }
  const object = repo.store.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

function viewerIdent(ctx: AppContext): { name: string; email: string; timestamp: number } {
  return { name: VIEWER.name, email: VIEWER.email, timestamp: ctx.clock.nowSec() };
}

/** Create a commit holding `flat` on `branchRef` and move the ref to it. */
function commitFlat(ctx: AppContext, repo: RepoRecord, branchRef: string, flat: Map<string, { mode: number; sha: string }>, message: string): string {
  const tree = buildTreeFromFlat(repo.store, flat);
  const tip = repo.refs.get(branchRef);
  const ident = viewerIdent(ctx);
  const data = buildCommitData({
    tree,
    parents: tip === undefined ? [] : [tip],
    author: ident,
    committer: ident,
    message,
  });
  const sha = repo.store.put('commit', data);
  repo.refs.set(branchRef, sha);
  repo.refsVersion += 1;
  return sha;
}

// ---------------------------------------------------------------- domain operations

export function createIssue(
  ctx: AppContext,
  repo: RepoRecord,
  input: { title: string; body?: string; labels?: string[] },
): IssueRecord {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist on this repository`);
  }
  const now = ctx.clock.nowIso();
  const issue: IssueRecord = {
    id: repo.nextRecordId(),
    number: repo.nextNumber(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    seq: repo.nextSeq(),
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(
  ctx: AppContext,
  repo: RepoRecord,
  input: { title: string; body?: string; head: string; base: string },
): PullRecord {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (baseSha === undefined) throw new HttpError(422, `Validation Failed: base branch "${input.base}" does not exist`);
  if (headSha === undefined) throw new HttpError(422, `Validation Failed: head branch "${input.head}" does not exist`);
  const now = ctx.clock.nowIso();
  const pull: PullRecord = {
    id: repo.nextRecordId(),
    number: repo.nextNumber(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    seq: repo.nextSeq(),
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The pull request's changed files: merge-base tree against head-tip tree. */
export function pullFiles(repo: RepoRecord, pull: PullRecord): PullFile[] {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return [];
  const store = repo.store;
  const base = mergeBase(store, baseSha, headSha) ?? baseSha;
  const baseObject = store.get(base);
  const headObject = store.get(headSha);
  if (baseObject === undefined || headObject === undefined) return [];
  const baseFlat = flattenTree(store, parseCommitData(baseObject.data).tree);
  const headFlat = flattenTree(store, parseCommitData(headObject.data).tree);
  const textOf = (sha: string | undefined): string => {
    if (sha === undefined) return '';
    const blob = store.get(sha);
    return blob === undefined ? '' : blob.data.toString('utf8');
  };
  const files: PullFile[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha && before.mode === after.mode) continue;
    const counts = diffLineCounts(textOf(before?.sha), textOf(after?.sha));
    files.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
}

/** Whether the pull would merge cleanly, without merging it. */
export function pullMergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  const store = repo.store;
  const base = mergeBase(store, baseSha, headSha);
  if (base === null) return 'UNKNOWN';
  if (base === headSha) return 'MERGEABLE';
  const treeOf = (sha: string): string => parseCommitData(store.get(sha)!.data).tree;
  const outcome = mergeTrees(store, treeOf(base), treeOf(baseSha), treeOf(headSha));
  return outcome.ok ? 'MERGEABLE' : 'CONFLICTING';
}

/** Squash-merge the pull request onto its base branch; returns the merge commit sha. */
export function mergePull(ctx: AppContext, repo: RepoRecord, pull: PullRecord): string {
  if (pull.merged || pull.state !== 'open') throw new HttpError(405, 'Pull Request is not mergeable');
  const store = repo.store;
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseSha = repo.refs.get(baseRef);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseSha === undefined || headSha === undefined) throw new HttpError(405, 'Pull Request is not mergeable');
  const base = mergeBase(store, baseSha, headSha);
  if (base === null || base === headSha) throw new HttpError(405, 'Pull Request is not mergeable');
  const treeOf = (sha: string): string => parseCommitData(store.get(sha)!.data).tree;
  const outcome = mergeTrees(store, treeOf(base), treeOf(baseSha), treeOf(headSha));
  if (!outcome.ok) throw new HttpError(405, `Pull Request is not mergeable: both sides changed ${outcome.path}`);
  const ident = viewerIdent(ctx);
  const message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const data = buildCommitData({ tree: outcome.tree, parents: [baseSha], author: ident, committer: ident, message });
  const sha = store.put('commit', data);
  repo.refs.set(baseRef, sha);
  repo.refsVersion += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ctx.clock.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return sha;
}

// ---------------------------------------------------------------- pagination

function pageParams(req: HandlerRequest): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(req.query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

function paginate<T>(req: HandlerRequest, items: T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(req);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const params = new URLSearchParams(req.query);
    params.set('per_page', String(perPage));
    params.set('page', String(page + 1));
    const path = `/${req.segments.join('/')}`;
    headers.link = `<http://${host}${path}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

function sortDirection(req: HandlerRequest): 1 | -1 {
  return req.query.get('direction') === 'asc' ? 1 : -1;
}

// ---------------------------------------------------------------- routes

export function registerRestRoutes(router: Router): void {
  const R = (method: string, pattern: string, handler: (req: HandlerRequest) => Promise<HandlerResponse> | HandlerResponse): void =>
    router.add(method, pattern, handler);

  R('GET', '/api/v3', () => ({
    status: 200,
    json: {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
  }));

  R('GET', '/api/v3/meta', () => ({ status: 200, json: { installed_version: '1.0.0', verifiable_password_authentication: false } }));

  R('GET', '/api/v3/user', () => ({ status: 200, json: userJson() }));

  R('POST', '/api/v3/user/repos', (req) => {
    const body = jsonBody(req);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
    const repo = req.ctx.forge.createRepo(
      VIEWER.login,
      name,
      typeof body.description === 'string' ? body.description : '',
      body.private === true,
      req.ctx.clock.nowIso(),
    );
    if (repo === null) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
    return { status: 201, json: repoJson(repo) };
  });

  R('GET', '/api/v3/user/repos', (req) => {
    const repos = req.ctx.forge.reposOf(VIEWER.login).map(repoJson);
    const { page, headers } = paginate(req, repos);
    return { status: 200, json: page, headers };
  });

  R('GET', '/api/v3/repos/:owner/:repo', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    return { status: 200, json: repoJson(repo) };
  });

  R('PATCH', '/api/v3/repos/:owner/:repo', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const body = jsonBody(req);
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    if (typeof body.name === 'string' && body.name !== '') {
      // A rename moves the map entry; the record keeps its id and contents.
      req.ctx.forge.deleteRepo(repo.owner, repo.name);
      (repo as { name: string }).name = body.name;
      req.ctx.forge.adopt(repo);
    }
    return { status: 200, json: repoJson(repo) };
  });

  R('DELETE', '/api/v3/repos/:owner/:repo', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    req.ctx.forge.deleteRepo(repo.owner, repo.name);
    return { status: 204, raw: Buffer.alloc(0) };
  });

  // ---------------------------------------------------------- contents

  const contentsPath = (req: HandlerRequest): string => (req.params.path ?? '').replace(/^\/+/, '');

  const lookupPath = (store: ObjectStore, rootTree: string, path: string) => {
    if (path === '') return { kind: 'dir' as const, treeSha: rootTree };
    const segments = path.split('/');
    let treeSha = rootTree;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = store.get(treeSha);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTreeData(tree.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (isDirMode(entry.mode)) {
        if (i === segments.length - 1) return { kind: 'dir' as const, treeSha: entry.sha };
        treeSha = entry.sha;
      } else {
        if (i !== segments.length - 1) return null;
        return { kind: 'file' as const, mode: entry.mode, sha: entry.sha, name: entry.name };
      }
    }
    return null;
  };

  const rootTreeOf = (repo: RepoRecord, refParam: string | null): string | null => {
    const commitSha = refParam === null ? repo.headSha() : resolveCommit(repo, refParam);
    if (commitSha === null) return null;
    const object = repo.store.get(commitSha);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommitData(object.data).tree;
  };

  R('GET', '/api/v3/repos/:owner/:repo/contents/:path*', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const path = contentsPath(req);
    const rootTree = rootTreeOf(repo, req.query.get('ref'));
    if (rootTree === null) throw new HttpError(404, 'Not Found');
    const found = lookupPath(repo.store, rootTree, path);
    if (found === null) throw new HttpError(404, 'Not Found');
    if (found.kind === 'dir') {
      const tree = repo.store.get(found.treeSha);
      const entries = parseTreeData(tree!.data).map((entry) => ({
        type: isDirMode(entry.mode) ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.sha,
      }));
      return { status: 200, json: entries };
    }
    const blob = repo.store.get(found.sha);
    const data = blob === undefined ? Buffer.alloc(0) : blob.data;
    const name = path.split('/').pop() ?? path;
    return {
      status: 200,
      json: {
        type: 'file',
        name,
        path,
        sha: found.sha,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      },
    };
  });

  R('PUT', '/api/v3/repos/:owner/:repo/contents/:path*', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const path = contentsPath(req);
    if (path === '') throw new HttpError(422, 'Validation Failed: path is required');
    const body = jsonBody(req);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch();
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined && branchRef !== repo.headRef) throw new HttpError(404, 'Not Found');
    const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
    const flat = tip === undefined ? new Map<string, { mode: number; sha: string }>() : flattenTree(repo.store, parseCommitData(repo.store.get(tip)!.data).tree);
    const existing = flat.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing !== undefined && givenSha !== existing.sha) {
      throw new HttpError(409, `${path} does not match ${givenSha ?? 'the supplied sha'}`);
    }
    if (existing === undefined && givenSha !== undefined) {
      throw new HttpError(409, `${path} does not match ${givenSha}`);
    }
    const blobSha = repo.store.put('blob', content);
    flat.set(path, { mode: existing?.mode ?? 0o100644, sha: blobSha });
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const commitSha = commitFlat(req.ctx, repo, branchRef, flat, message);
    const name = path.split('/').pop() ?? path;
    return {
      status: existing === undefined ? 201 : 200,
      json: {
        content: { name, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      },
    };
  });

  R('DELETE', '/api/v3/repos/:owner/:repo/contents/:path*', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const path = contentsPath(req);
    const body = jsonBody(req);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch();
    const branchRef = `refs/heads/${branch}`;
    const tip = repo.refs.get(branchRef);
    if (tip === undefined) throw new HttpError(404, 'Not Found');
    const flat = flattenTree(repo.store, parseCommitData(repo.store.get(tip)!.data).tree);
    const existing = flat.get(path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (givenSha !== existing.sha) throw new HttpError(409, `${path} does not match ${givenSha ?? 'the supplied sha'}`);
    flat.delete(path);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const commitSha = commitFlat(req.ctx, repo, branchRef, flat, message);
    return { status: 200, json: { content: null, commit: { sha: commitSha, message } } };
  });

  // ---------------------------------------------------------- refs and branches

  R('POST', '/api/v3/repos/:owner/:repo/git/refs', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const body = jsonBody(req);
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || repo.store.get(sha) === undefined) {
      throw new HttpError(422, 'Validation Failed: ref and a known sha are required');
    }
    if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.refsVersion += 1;
    const object = repo.store.get(sha)!;
    return { status: 201, json: { ref, object: { sha, type: object.type } } };
  });

  R('GET', '/api/v3/repos/:owner/:repo/git/refs/:ref*', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const full = `refs/${req.params.ref ?? ''}`;
    const sha = repo.refs.get(full);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    const object = repo.store.get(sha);
    return { status: 200, json: { ref: full, object: { sha, type: object?.type ?? 'commit' } } };
  });

  R('GET', '/api/v3/repos/:owner/:repo/branches', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, json: branches };
  });

  R('GET', '/api/v3/repos/:owner/:repo/branches/:branch*', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const branch = req.params.branch ?? '';
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    return { status: 200, json: { name: branch, commit: { sha }, protected: false } };
  });

  R('GET', '/api/v3/repos/:owner/:repo/commits', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const refParam = req.query.get('sha');
    const tip = refParam === null ? repo.headSha() : resolveCommit(repo, refParam);
    if (tip === null) throw new HttpError(404, 'Not Found');
    const order: string[] = [];
    const seen = new Set<string>();
    const walk = (sha: string): void => {
      if (seen.has(sha)) return;
      const object = repo.store.get(sha);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(sha);
      order.push(sha);
      for (const parent of parseCommitData(object.data).parents) walk(parent);
    };
    walk(tip);
    const { page } = paginate(req, order);
    return { status: 200, json: page.map((sha) => commitJson(repo, sha)) };
  });

  // ---------------------------------------------------------- labels

  R('POST', '/api/v3/repos/:owner/:repo/labels', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const body = jsonBody(req);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') throw new HttpError(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) throw new HttpError(422, 'Validation Failed: name has already been taken');
    const label = {
      id: repo.nextRecordId(),
      name,
      color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000',
      description: typeof body.description === 'string' ? body.description : '',
    };
    repo.labels.set(name, label);
    return { status: 201, json: labelJson(repo, name) };
  });

  R('GET', '/api/v3/repos/:owner/:repo/labels', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    return { status: 200, json: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
  });

  // ---------------------------------------------------------- issues

  R('POST', '/api/v3/repos/:owner/:repo/issues', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const body = jsonBody(req);
    const title = typeof body.title === 'string' ? body.title : '';
    if (title === '') throw new HttpError(422, 'Validation Failed: title is required');
    const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
    const issue = createIssue(req.ctx, repo, { title, body: typeof body.body === 'string' ? body.body : '', labels });
    return { status: 201, json: issueJson(repo, issue) };
  });

  R('GET', '/api/v3/repos/:owner/:repo/issues', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const state = req.query.get('state') ?? 'open';
    const direction = sortDirection(req);
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => (a.seq - b.seq) * direction);
    const { page, headers } = paginate(req, issues);
    return { status: 200, json: page.map((issue) => issueJson(repo, issue)), headers };
  });

  R('GET', '/api/v3/repos/:owner/:repo/issues/:number', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const issue = repo.issues.get(Number.parseInt(req.params.number!, 10));
    if (issue === undefined) throw new HttpError(404, 'Not Found');
    return { status: 200, raw: issueJsonBuffer(repo, issue), contentType: 'application/json; charset=utf-8' };
  });

  R('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const issue = repo.issues.get(Number.parseInt(req.params.number!, 10));
    if (issue === undefined) throw new HttpError(404, 'Not Found');
    const body = jsonBody(req);
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (Array.isArray(body.labels)) {
      const labels = body.labels.filter((x): x is string => typeof x === 'string');
      for (const name of labels) {
        if (!repo.labels.has(name)) throw new HttpError(422, `Validation Failed: label "${name}" does not exist on this repository`);
      }
      issue.labels = labels;
    }
    issue.updatedAt = req.ctx.clock.nowIso();
    return { status: 200, json: issueJson(repo, issue) };
  });

  const commentTarget = (req: HandlerRequest, repo: RepoRecord): { comments: IssueRecord['comments'] } => {
    const number = Number.parseInt(req.params.number!, 10);
    const issue = repo.issues.get(number);
    if (issue !== undefined) return issue;
    const pull = repo.pulls.get(number);
    if (pull !== undefined) return pull;
    throw new HttpError(404, 'Not Found');
  };

  R('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const target = commentTarget(req, repo);
    const body = jsonBody(req);
    const text = typeof body.body === 'string' ? body.body : '';
    if (text === '') throw new HttpError(422, 'Validation Failed: body is required');
    const comment = { id: repo.nextCommentId(), body: text, createdAt: req.ctx.clock.nowIso() };
    target.comments.push(comment);
    return { status: 201, json: commentJson(comment) };
  });

  R('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const target = commentTarget(req, repo);
    const sorted = [...target.comments].sort((a, b) => a.id - b.id);
    const { page } = paginate(req, sorted);
    return { status: 200, json: page.map(commentJson) };
  });

  // ---------------------------------------------------------- pulls

  R('POST', '/api/v3/repos/:owner/:repo/pulls', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const body = jsonBody(req);
    const title = typeof body.title === 'string' ? body.title : '';
    const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
    const base = typeof body.base === 'string' ? body.base : '';
    if (title === '' || head === '' || base === '') throw new HttpError(422, 'Validation Failed: title, head and base are required');
    const pull = createPull(req.ctx, repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
    return { status: 201, json: pullJson(repo, pull) };
  });

  R('GET', '/api/v3/repos/:owner/:repo/pulls', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const state = req.query.get('state') ?? 'open';
    const direction = sortDirection(req);
    let pulls = [...repo.pulls.values()];
    if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => (a.seq - b.seq) * direction);
    const { page, headers } = paginate(req, pulls);
    return { status: 200, json: page.map((pull) => pullJson(repo, pull)), headers };
  });

  R('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const pull = repo.pulls.get(Number.parseInt(req.params.number!, 10));
    if (pull === undefined) throw new HttpError(404, 'Not Found');
    return { status: 200, json: pullJson(repo, pull) };
  });

  R('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const pull = repo.pulls.get(Number.parseInt(req.params.number!, 10));
    if (pull === undefined) throw new HttpError(404, 'Not Found');
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
    }));
    const { page } = paginate(req, files);
    return { status: 200, json: page };
  });

  R('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (req) => {
    const repo = repoOr404(req, req.params.owner!, req.params.repo!);
    const pull = repo.pulls.get(Number.parseInt(req.params.number!, 10));
    if (pull === undefined) throw new HttpError(404, 'Not Found');
    const sha = mergePull(req.ctx, repo, pull);
    return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
  });
}
