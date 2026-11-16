// The forge's state: repositories and everything that lives inside them.
//
// State is plain in-memory records. A repository owns a git object store and
// a ref table; issues and pull requests share one per-repository number
// sequence, exactly like GitHub. Every record carries a per-repository
// creation sequence so list orderings (created ascending/descending) are
// total and deterministic.

import { ObjectStore } from './gitcore.ts';
import { DEFAULT_HEAD_REF } from './identity.ts';

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdAt: string;
}

export interface IssueRecord {
  /** Forge-wide record id (the REST `id`); distinct from the per-repo number. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  comments: CommentRecord[];
}

export class RepoRecord {
  readonly store = new ObjectStore();
  /** Full ref name (refs/heads/..., refs/tags/...) -> object sha. */
  readonly refs = new Map<string, string>();
  /** The ref HEAD points at; the repository is "unborn" while it has no target sha. */
  headRef: string = DEFAULT_HEAD_REF;
  /** Bumped at every refs mutation; caches keyed on refs content check it. */
  refsVersion = 0;
  readonly labels = new Map<string, LabelRecord>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  private numberSeq = 0;
  private commentSeq = 0;
  private seqCounter = 0;
  private readonly forge: Forge;
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  public description: string;
  public isPrivate: boolean;
  readonly createdAt: string;

  constructor(forge: Forge, id: number, owner: string, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.forge = forge;
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = createdAt;
  }

  /** A forge-wide unique id for a new issue/pull/label record. */
  nextRecordId(): number {
    return this.forge.nextRecordId();
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The sha HEAD currently resolves to, or null for an empty repository. */
  headSha(): string | null {
    return this.refs.get(this.headRef) ?? null;
  }

  /** The default branch's short name (the branch HEAD points at). */
  defaultBranch(): string {
    return this.headRef.replace(/^refs\/heads\//, '');
  }

  nextNumber(): number {
    this.numberSeq += 1;
    return this.numberSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }
}

export class Forge {
  private readonly repos = new Map<string, RepoRecord>();
  private repoIdSeq = 0;
  private recordIdSeq = 0;

  nextRecordId(): number {
    this.recordIdSeq += 1;
    return this.recordIdSeq;
  }

  private static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, createdAt: string): RepoRecord | null {
    const key = Forge.key(owner, name);
    if (this.repos.has(key)) return null;
    this.repoIdSeq += 1;
    const repo = new RepoRecord(this, this.repoIdSeq, owner, name, description, isPrivate, createdAt);
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    return this.repos.get(Forge.key(owner, name));
  }

  /** Re-register a record under its current owner/name (after a rename). */
  adopt(repo: RepoRecord): void {
    this.repos.set(Forge.key(repo.owner, repo.name), repo);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.key(owner, name));
  }

  /** Every repository owned by `owner`, in creation order. */
  reposOf(owner: string): RepoRecord[] {
    const owned: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) owned.push(repo);
    }
    return owned.sort((a, b) => a.id - b.id);
  }

  repoById(id: number): RepoRecord | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}

// ---------------------------------------------------------------- global node ids
//
// GraphQL's global ids are opaque to clients but must be stable and must
// round-trip through node(id:). They are base64 of a self-describing string
// ("v1:<Type>:<parts>") — opaque in practice, and never the plain numeric id,
// which the suite explicitly rejects.

export function encodeGlobalId(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(`v1:${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^v1:([A-Za-z]+):(.*)$/.exec(text);
  if (match === null) return null;
  return { type: match[1]!, parts: match[2]!.split(':') };
}
