// The git object model, implemented from the protocol's own rules.
//
// Everything the forge stores is a content-addressed object in an in-memory
// store: commits, trees, blobs and annotated tags, hashed exactly the way
// git hashes them (sha1 of "<type> <length>\0" + payload). On top of the
// store sit the pack reader/writer the smart-HTTP transport needs, tree
// flatten/rebuild helpers for the contents API, ancestry walks for fetch
// negotiation and merge-base, a path-level three-way merge for pull
// requests, and a line diff for pull-request file statistics.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** An in-memory, content-addressed object database for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  put(type: ObjectType, data: Buffer): string {
    const sha = hashObject(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  add(sha: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }

  get(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** Numeric mode: 0o40000 for a subtree, 0o100644/0o100755/0o120000 for leaves. */
  mode: number;
  name: string;
  sha: string;
}

const DIR_MODE = 0o40000;

export function isDirMode(mode: number): boolean {
  return (mode & 0o170000) === DIR_MODE;
}

/** Git's tree sort: entries compare by name, directories as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode.toString(8)} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();

export function parseTreeData(data: Buffer): TreeEntry[] {
  // Object payloads are immutable once stored, so a parse keyed by the
  // payload buffer itself stays valid for the buffer's lifetime. Callers
  // treat the result as read-only.
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree: missing mode separator');
    const mode = Number.parseInt(data.toString('ascii', offset, space), 8);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree: truncated entry');
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  treeParseCache.set(data, entries);
  return entries;
}

export interface FlatEntry {
  mode: number;
  sha: string;
}

/** Every leaf (blob/symlink) under a tree, keyed by its slash-joined path. */
export function flattenTree(store: ObjectStore, treeSha: string, into = new Map<string, FlatEntry>(), prefix = ''): Map<string, FlatEntry> {
  const tree = store.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return into;
  for (const entry of parseTreeData(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (isDirMode(entry.mode)) flattenTree(store, entry.sha, into, path);
    else into.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return into;
}

/** Rebuild nested trees from a flat path map; returns the root tree's sha. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      let next = node.dirs.get(segments[i]!);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(segments[i]!, next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, sha: entry.sha });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: DIR_MODE, name, sha: emit(child) });
    return store.put('tree', buildTreeData(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- commits and tags

export interface Ident {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  timestamp: number;
}

export function formatIdent(ident: Ident): string {
  return `${ident.name} <${ident.email}> ${ident.timestamp} +0000`;
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: Ident;
  committer: Ident;
  message: string;
}

export function buildCommitData(parts: CommitParts): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdent(parts.author)}`);
  lines.push(`committer ${formatIdent(parts.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  /** Committer timestamp in seconds, 0 when unparseable. */
  time: number;
  message: string;
}

function parseIdentTime(line: string): number {
  const match = /> (\d+) [+-]\d{4}$/.exec(line);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

const commitParseCache = new WeakMap<Buffer, ParsedCommit>();

export function parseCommitData(data: Buffer): ParsedCommit {
  // Memoized on the payload buffer (see parseTreeData): ancestry walks and
  // fetch planning re-parse the same commits on every request otherwise.
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseCommitDataFresh(data);
  commitParseCache.set(data, parsed);
  return parsed;
}

function parseCommitDataFresh(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, time: parseIdentTime(committerLine), message };
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

const tagParseCache = new WeakMap<Buffer, ParsedTag>();

export function parseTagData(data: Buffer): ParsedTag {
  const cached = tagParseCache.get(data);
  if (cached !== undefined) return cached;
  const parsed = parseTagDataFresh(data);
  tagParseCache.set(data, parsed);
  return parsed;
}

function parseTagDataFresh(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

/** Follow tag objects until a non-tag object; returns that object's sha. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTagData(object.data).object;
  }
  return null;
}

// ---------------------------------------------------------------- ancestry

export function commitParents(store: ObjectStore, sha: string): string[] {
  const object = store.get(sha);
  if (object === undefined || object.type !== 'commit') return [];
  return parseCommitData(object.data).parents;
}

/** All commits reachable from `tip`, including `tip` itself. */
export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    const object = store.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(current);
    for (const parent of parseCommitData(object.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Walk from the descendant and stop the moment the ancestor turns up:
  // the common case (a fast-forward push) finds it one parent hop away,
  // so there is no need to build the descendant's whole ancestor set.
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of commitParents(store, current)) queue.push(parent);
  }
  return false;
}

/** A best common ancestor of two commits, or null when they share no history. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfA.has(current)) return current;
    for (const parent of commitParents(store, current)) queue.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, grouped by generation (tip = generation 0). */
export function generations(store: ObjectStore, tip: string): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = [tip];
  let level = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sha of frontier) {
      if (depth.has(sha)) continue;
      const object = store.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      depth.set(sha, level);
      for (const parent of parseCommitData(object.data).parents) next.push(parent);
    }
    frontier = next;
    level += 1;
  }
  return depth;
}

/** Add a tree and everything under it (subtrees, blobs) to `out`. */
export function addTreeClosure(store: ObjectStore, treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const tree = store.get(treeSha);
  if (tree === undefined || tree.type !== 'tree') return;
  out.add(treeSha);
  for (const entry of parseTreeData(tree.data)) {
    if (isDirMode(entry.mode)) addTreeClosure(store, entry.sha, out);
    else out.add(entry.sha);
  }
}

/** Add a commit, its tree closure, and (for a tag) the tagged object chain. */
export function addObjectClosure(store: ObjectStore, sha: string, out: Set<string>): void {
  const object = store.get(sha);
  if (object === undefined || out.has(sha)) return;
  out.add(sha);
  if (object.type === 'commit') {
    addTreeClosure(store, parseCommitData(object.data).tree, out);
  } else if (object.type === 'tag') {
    addObjectClosure(store, parseTagData(object.data).object, out);
  } else if (object.type === 'tree') {
    addTreeClosure(store, sha, out);
  }
}

// ---------------------------------------------------------------- three-way merge

export type MergeOutcome = { ok: true; tree: string } | { ok: false; path: string };

/**
 * Merge two tips' trees against their merge-base tree, one path at a time:
 * a path changed on only one side takes that side; changed identically on
 * both sides takes the shared value; changed differently is a conflict.
 */
export function mergeTrees(store: ObjectStore, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(store, baseTree);
  const ours = flattenTree(store, ourTree);
  const theirs = flattenTree(store, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result = new Map<string, FlatEntry>();
  const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
    x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.sha === y.sha && x.mode === y.mode;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o !== undefined) result.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) result.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) result.set(path, o);
    } else {
      return { ok: false, path };
    }
  }
  return { ok: true, tree: buildTreeFromFlat(store, result) };
}

// ---------------------------------------------------------------- line diff

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Addition/deletion counts between two texts, via a longest-common-subsequence walk. */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // One DP row at a time; the files a forge diffs here are small.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      curr[j] = oldLines[i] === newLines[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[0]!;
  return { additions: m - lcs, deletions: n - lcs };
}

// ---------------------------------------------------------------- packs

const PACK_TYPE_IDS: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function readPackVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = buffer[offset]! & 0x0f;
  let shift = 4;
  let cursor = offset;
  while ((buffer[cursor]! & 0x80) !== 0) {
    cursor += 1;
    value |= (buffer[cursor]! & 0x7f) << shift;
    shift += 7;
  }
  return { value, next: cursor + 1 };
}

/**
 * Inflate the deflate stream starting at `offset`. zlib tolerates bytes past
 * the stream's end, so the stream's exact length is the smallest prefix that
 * inflates — found by binary search instead of a streaming decoder. The
 * search starts under a cap derived from the entry's declared inflated size
 * (no zlib stream for n bytes runs much past deflateBound(n)); if the cap
 * does not inflate, the search falls back to the whole remainder, exactly
 * as before. `exactLength`, when the caller knows it (the pack's last entry
 * ends at the trailer), skips the search after one verifying attempt.
 */
function inflateAt(buffer: Buffer, offset: number, inflatedSize: number, exactLength?: number): { data: Buffer; length: number } {
  const attempt = (length: number): Buffer | null => {
    try {
      return inflateSync(buffer.subarray(offset, offset + length));
    } catch {
      return null;
    }
  };
  if (exactLength !== undefined) {
    const data = attempt(exactLength);
    if (data !== null && data.length === inflatedSize) return { data, length: exactLength };
  }
  // Fast path: one inflate of the whole remainder. With { info: true } zlib
  // reports how many input bytes the stream actually consumed, which is the
  // exact stream length — no binary search over throwing truncated attempts.
  // Any implausible report falls through to the search below.
  try {
    const remainder = buffer.subarray(offset);
    const result = inflateSync(remainder, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = result.engine.bytesWritten;
    if (consumed > 0 && consumed <= remainder.length && result.buffer.length === inflatedSize) {
      return { data: result.buffer, length: consumed };
    }
  } catch {
    // Fall through to the binary search, which throws for corrupt entries.
  }
  let lo = 1;
  let hi = buffer.length - offset;
  const cap = inflatedSize + (inflatedSize >> 12) + (inflatedSize >> 14) + (inflatedSize >> 25) + 64;
  if (cap < hi && attempt(cap) !== null) hi = cap;
  if (attempt(hi) === null) throw new Error('corrupt pack: entry does not inflate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (attempt(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = attempt(lo);
  if (data === null) throw new Error('corrupt pack: entry does not inflate');
  return { data, length: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let cursor = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[cursor]!;
      cursor += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readSize();
  const out: Buffer[] = [];
  let produced = 0;
  while (cursor < delta.length) {
    const op = delta[cursor]!;
    cursor += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= delta[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= delta[cursor]! << (8 * bit);
          cursor += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(cursor, cursor + op));
      produced += op;
      cursor += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PendingEntry {
  offset: number;
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  payload: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

/**
 * Read a pack into the store, resolving delta chains against bases that are
 * either earlier in the same pack or already in the store. Returns the shas
 * of every object the pack carried.
 */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack file');
  const count = pack.readUInt32BE(8);
  const entries: PendingEntry[] = [];
  const byOffset = new Map<number, PendingEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const firstByte = pack[offset]!;
    const typeId = (firstByte >> 4) & 0x07;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    let baseOffset: number | undefined;
    let baseSha: string | undefined;
    if (typeId === OFS_DELTA) {
      let byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === REF_DELTA) {
      baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const isLast = i === count - 1;
    const inflated = inflateAt(pack, offset, header.value, isLast ? pack.length - 20 - offset : undefined);
    offset += inflated.length;
    const entry: PendingEntry = {
      offset: start,
      type: typeId === OFS_DELTA ? 'ofs-delta' : typeId === REF_DELTA ? 'ref-delta' : PACK_TYPE_IDS[typeId]!,
      payload: inflated.data,
      baseOffset,
      baseSha,
    };
    entries.push(entry);
    byOffset.set(start, entry);
  }

  const resolved = new Map<number, { sha: string; type: ObjectType; data: Buffer }>();
  const resolve = (entry: PendingEntry): { sha: string; type: ObjectType; data: Buffer } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let result: { sha: string; type: ObjectType; data: Buffer };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: { type: ObjectType; data: Buffer };
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else {
        const inPack = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type as ObjectType, candidate.payload) === entry.baseSha);
        if (inPack !== undefined) {
          base = resolve(inPack);
        } else {
          const stored = store.get(entry.baseSha!);
          if (stored === undefined) throw new Error('ref-delta base is unknown');
          base = stored;
        }
      }
      const data = applyDelta(base.data, entry.payload);
      result = { sha: hashObject(base.type, data), type: base.type, data };
    } else {
      result = { sha: hashObject(entry.type, entry.payload), type: entry.type, data: entry.payload };
    }
    resolved.set(entry.offset, result);
    return result;
  };

  const shas: string[] = [];
  for (const entry of entries) {
    const object = resolve(entry);
    store.add(object.sha, object.type, object.data);
    shas.push(object.sha);
  }
  return shas;
}

interface PackCaches {
  /** sha -> the object's whole pack entry (varint header + deflated payload). */
  entries: Map<string, Buffer>;
  /** sha list -> a complete pack previously built for exactly that list. */
  packs: Map<string, Buffer>;
}

const packCaches = new WeakMap<ObjectStore, PackCaches>();

function cachesFor(store: ObjectStore): PackCaches {
  let caches = packCaches.get(store);
  if (caches === undefined) {
    caches = { entries: new Map(), packs: new Map() };
    packCaches.set(store, caches);
  }
  return caches;
}

/** One object's pack entry; deflating the same object twice is pure waste. */
function packEntry(caches: PackCaches, sha: string, object: StoredObject): Buffer {
  const cached = caches.entries.get(sha);
  if (cached !== undefined) return cached;
  const typeId = PACK_TYPE_NUMBERS[object.type];
  let size = object.data.length;
  const first = (typeId << 4) | (size & 0x0f);
  size >>= 4;
  const headBytes: number[] = [];
  if (size === 0) {
    headBytes.push(first);
  } else {
    headBytes.push(first | 0x80);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
  }
  const entry = Buffer.concat([Buffer.from(headBytes), deflateSync(object.data)]);
  if (caches.entries.size >= 16384) caches.entries.clear();
  caches.entries.set(sha, entry);
  return entry;
}

/** Serialize the given objects as a complete pack (full objects, no deltas). */
export function writePack(store: ObjectStore, shas: readonly string[]): Buffer {
  // Objects are content-addressed and immutable, so a pack built for a sha
  // list — and each object's deflated entry inside it — can be replayed
  // verbatim for every later fetch that asks for the same objects.
  const caches = cachesFor(store);
  const key = shas.join(',');
  const cachedPack = caches.packs.get(key);
  if (cachedPack !== undefined) return cachedPack;
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const parts: Buffer[] = [header];
  for (const sha of shas) {
    const object = store.get(sha);
    if (object === undefined) throw new Error(`cannot pack missing object ${sha}`);
    parts.push(packEntry(caches, sha, object));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (caches.packs.size >= 64) caches.packs.clear();
  caches.packs.set(key, pack);
  return pack;
}
