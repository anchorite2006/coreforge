// The git smart-HTTP transport: ref advertisement, protocol v2 ls-refs and
// fetch, protocol v0 fetch, and receive-pack pushes.
//
// Implemented directly on the pkt-line framing: every message is a 4-hex
// length-prefixed packet, 0000 is flush, 0001 is the v2 delimiter. Fetch
// negotiation is set arithmetic over the object store — the pack a client
// receives is (objects reachable from its wants, depth-limited when asked)
// minus (objects reachable from its haves, where traversal stops below the
// commits the client already lists as shallow). All objects are sent whole;
// a pack with no deltas is always legal, and thin-pack permission never
// obliges the server to actually send a thin pack.

import { HttpError, type HandlerRequest, type HandlerResponse, type Router } from '../app.ts';
import {
  addObjectClosure,
  addTreeClosure,
  ancestorSet,
  generations,
  isAncestor,
  parseCommitData,
  parseTagData,
  peelToCommit,
  readPack,
  writePack,
  ZERO_OID,
  type ObjectStore,
} from './gitcore.ts';
import type { RepoRecord } from './store.ts';

const AGENT = 'forge/1.0';

// ---------------------------------------------------------------- pkt-lines

function pkt(payload: Buffer): Buffer {
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

function pktText(text: string): Buffer {
  return pkt(Buffer.from(text, 'utf8'));
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
  /** Offset just past this packet. */
  next: number;
}

function readPacket(buffer: Buffer, offset: number): Packet {
  if (offset + 4 > buffer.length) throw new Error('truncated pkt-line');
  const hex = buffer.toString('ascii', offset, offset + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
  const length = Number.parseInt(hex, 16);
  if (length === 0) return { kind: 'flush', payload: Buffer.alloc(0), next: offset + 4 };
  if (length === 1) return { kind: 'delim', payload: Buffer.alloc(0), next: offset + 4 };
  if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
  return { kind: 'data', payload: buffer.subarray(offset + 4, offset + length), next: offset + length };
}

/** Read data packets until a flush; returns the payloads and the offset past the flush. */
function readUntilFlush(buffer: Buffer, offset: number): { payloads: Buffer[]; next: number } {
  const payloads: Buffer[] = [];
  let cursor = offset;
  for (;;) {
    const packet = readPacket(buffer, cursor);
    cursor = packet.next;
    if (packet.kind === 'flush') return { payloads, next: cursor };
    if (packet.kind === 'data') payloads.push(packet.payload);
  }
}

function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  if (data.length === 0) {
    packets.push(pkt(Buffer.from([band])));
    return packets;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    packets.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

// ---------------------------------------------------------------- ref listing

interface RefLine {
  name: string;
  sha: string;
}

function sortedRefs(repo: RepoRecord): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, sha]) => ({ name, sha }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function uploadCaps(repo: RepoRecord): string {
  return ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', `agent=${AGENT}`, `symref=HEAD:${repo.headRef}`].join(' ');
}

function receiveCaps(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');
}

function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCaps(repo) : receiveCaps();
  const parts: Buffer[] = [pktText(`# service=${service}\n`), FLUSH];
  const headSha = repo.headSha();
  const refs = sortedRefs(repo);
  if (headSha === null && refs.length === 0) {
    parts.push(pkt(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}`, 'utf8')));
  } else {
    let first = true;
    const emit = (sha: string, name: string): void => {
      if (first) {
        parts.push(pkt(Buffer.from(`${sha} ${name}\0${caps}`, 'utf8')));
        first = false;
      } else {
        parts.push(pktText(`${sha} ${name}\n`));
      }
    };
    if (headSha !== null) emit(headSha, 'HEAD');
    for (const ref of refs) {
      emit(ref.sha, ref.name);
      const object = repo.store.get(ref.sha);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.store, ref.sha);
        if (peeled !== null) parts.push(pktText(`${peeled} ${ref.name}^{}\n`));
      }
    }
    if (first) {
      // Refs exist but HEAD is unborn (e.g. every ref is a tag): still lead with the caps line.
      parts.push(pkt(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}`, 'utf8')));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
  return Buffer.concat([...lines.map((line) => pktText(`${line}\n`)), FLUSH]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchPlan {
  packShas: string[];
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/** Everything reachable from the haves; traversal stops below client-shallow commits. */
function haveClosure(store: ObjectStore, haves: string[], clientShallow: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const seenCommits = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const sha = queue.pop()!;
    const object = store.get(sha);
    if (object === undefined) continue;
    if (object.type !== 'commit') {
      addObjectClosure(store, sha, out);
      continue;
    }
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    out.add(sha);
    addTreeClosure(store, parseCommitData(object.data).tree, out);
    if (clientShallow.has(sha)) continue;
    for (const parent of parseCommitData(object.data).parents) queue.push(parent);
  }
  return out;
}

function planFetch(store: ObjectStore, request: FetchRequest): FetchPlan {
  const clientShallow = new Set(request.shallow);
  const held = haveClosure(store, request.haves, clientShallow);
  const heldCommits = new Set<string>();
  for (const sha of held) {
    const object = store.get(sha);
    if (object !== undefined && object.type === 'commit') heldCommits.add(sha);
  }

  // Inclusion: commits reachable from the wants (depth-limited), each with
  // its full tree closure; tag wants contribute the tag and its chain.
  const includedCommits = new Set<string>();
  const included = new Set<string>();
  const includeCommitClosure = (commitSha: string): void => {
    included.add(commitSha);
    const object = store.get(commitSha);
    if (object !== undefined && object.type === 'commit') addTreeClosure(store, parseCommitData(object.data).tree, included);
  };
  for (const want of request.wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.add(want);
      const target = parseTagData(object.data).object;
      addObjectClosure(store, target, included);
      const commit = peelToCommit(store, want);
      if (commit !== null) {
        for (const sha of ancestorSet(store, commit)) includedCommits.add(sha);
      }
      continue;
    }
    if (object.type !== 'commit') {
      included.add(want);
      continue;
    }
    const gens = generations(store, want);
    for (const [sha, generation] of gens) {
      if (request.depth !== null && generation >= request.depth) continue;
      includedCommits.add(sha);
    }
  }
  for (const sha of includedCommits) includeCommitClosure(sha);

  const packShas = [...included].filter((sha) => !held.has(sha));

  const boundary: string[] = [];
  const unshallow: string[] = [];
  for (const sha of includedCommits) {
    const parents = parseCommitData(store.get(sha)!.data).parents;
    const isBoundary = parents.some((parent) => store.has(parent) && !includedCommits.has(parent) && !heldCommits.has(parent));
    if (isBoundary) boundary.push(sha);
    else if (clientShallow.has(sha)) unshallow.push(sha);
  }

  const commonHaves = request.haves.filter((have) => store.has(have));
  return { packShas, shallow: boundary, unshallow, commonHaves };
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(repo: RepoRecord, argLines: string[]): Buffer {
  const peel = argLines.includes('peel');
  const symrefs = argLines.includes('symrefs');
  const unborn = argLines.includes('unborn');
  const prefixes = argLines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const passes = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const lines: string[] = [];
  const headSha = repo.headSha();
  if (passes('HEAD')) {
    if (headSha !== null) {
      lines.push(`${headSha} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!passes(ref.name)) continue;
    let line = `${ref.sha} ${ref.name}`;
    if (peel) {
      const object = repo.store.get(ref.sha);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(repo.store, ref.sha);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktText(`${line}\n`)), FLUSH]);
}

// ---------------------------------------------------------------- fetch responses

function fetchSections(store: ObjectStore, request: FetchRequest): Buffer {
  const plan = planFetch(store, request);
  const parts: Buffer[] = [];

  if (!request.done) {
    // Negotiation round: acknowledge what we hold in common, send no pack.
    parts.push(pktText('acknowledgments\n'));
    if (plan.commonHaves.length === 0) {
      parts.push(pktText('NAK\n'));
    } else {
      for (const have of plan.commonHaves) parts.push(pktText(`ACK ${have}\n`));
      parts.push(pktText('ready\n'));
    }
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }

  if (request.haves.length > 0) {
    parts.push(pktText('acknowledgments\n'));
    if (plan.commonHaves.length === 0) parts.push(pktText('NAK\n'));
    else for (const have of plan.commonHaves) parts.push(pktText(`ACK ${have}\n`));
    parts.push(FLUSH);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktText('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pktText(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pktText(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktText('packfile\n'));
  const pack = writePack(store, plan.packShas);
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(store: ObjectStore, request: FetchRequest): Buffer {
  const plan = planFetch(store, request);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktText(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktText(`unshallow ${sha}\n`));
  if (plan.commonHaves.length > 0) parts.push(pktText(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  else parts.push(pktText('NAK\n'));
  if (request.done) {
    const pack = writePack(store, plan.packShas);
    for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request parsing

function parseV2Command(body: Buffer): { command: string; args: string[] } {
  const first = readUntilFlushOrDelim(body, 0);
  const commandLine = first.payloads.map((p) => p.toString('utf8').replace(/\n$/, '')).find((line) => line.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length);
  const args = first.rest.map((p) => p.toString('utf8').replace(/\n$/, ''));
  return { command, args };
}

/** Read packets until a delim (v2 command header), then until flush (the arguments). */
function readUntilFlushOrDelim(buffer: Buffer, offset: number): { payloads: Buffer[]; rest: Buffer[] } {
  const payloads: Buffer[] = [];
  let cursor = offset;
  for (;;) {
    const packet = readPacket(buffer, cursor);
    cursor = packet.next;
    if (packet.kind === 'delim') break;
    if (packet.kind === 'flush') return { payloads, rest: [] };
    payloads.push(packet.payload);
  }
  const rest: Buffer[] = [];
  for (;;) {
    const packet = readPacket(buffer, cursor);
    cursor = packet.next;
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') rest.push(packet.payload);
  }
  return { payloads, rest };
}

function fetchRequestFromArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of args) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') request.done = true;
  }
  return request;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: RepoRecord, body: Buffer): Buffer {
  let commands: PushCommand[] = [];
  let capabilities = '';
  let packOffset = 0;
  {
    const payloads: Buffer[] = [];
    let cursor = 0;
    for (;;) {
      const packet = readPacket(body, cursor);
      cursor = packet.next;
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') payloads.push(packet.payload);
    }
    packOffset = cursor;
    commands = payloads.map((payload, index) => {
      let text = payload.toString('utf8').replace(/\n$/, '');
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          capabilities = text.slice(nul + 1);
          text = text.slice(0, nul);
        }
      }
      const [oldOid = '', newOid = '', ref = ''] = text.split(' ');
      return { oldOid, newOid, ref };
    });
  }

  const packBytes = body.subarray(packOffset);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      readPack(repo.store, Buffer.from(packBytes));
    } catch {
      unpackOk = false;
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail(command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const object = repo.store.get(command.newOid);
    if (object === undefined) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('bad object');
        continue;
      }
      if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid && !isAncestor(repo.store, command.oldOid, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const inner: Buffer[] = [pktText(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const result of results) {
    inner.push(pktText(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(FLUSH);
  const innerStream = Buffer.concat(inner);

  if (capabilities.split(' ').includes('side-band-64k')) {
    const outer: Buffer[] = [];
    for (const packet of sidebandPackets(innerStream, 1)) outer.push(packet);
    outer.push(FLUSH);
    return Buffer.concat(outer);
  }
  return innerStream;
}

/** Answer one upload-pack POST: a v2 command (ls-refs / fetch) or a v0 fetch. */
function uploadPackBody(repo: RepoRecord, req: HandlerRequest, wantsV2: boolean): Buffer {
  if (wantsV2) {
    const { command, args } = parseV2Command(req.body);
    if (command === 'ls-refs') return handleLsRefs(repo, args);
    if (command === 'fetch') return fetchSections(repo.store, fetchRequestFromArgs(args));
    throw new HttpError(400, `Unknown command ${command}`);
  }
  // v0: wants section, flush, negotiation section, flush.
  const first = readUntilFlush(req.body, 0);
  const second = readUntilFlush(req.body, first.next);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const payload of first.payloads) {
    const line = payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  for (const payload of second.payloads) {
    const line = payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line === 'done') request.done = true;
  }
  return fetchV0Response(repo.store, request);
}

// ---------------------------------------------------------------- routes

export function registerGitHttpRoutes(router: Router): void {
  const repoFromParams = (req: HandlerRequest): RepoRecord => {
    const owner = req.params.owner!;
    const rawName = req.params.repo!;
    const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
    const repo = req.ctx.forge.getRepo(owner, name);
    if (repo === undefined) throw new HttpError(404, 'Not Found');
    return repo;
  };

  router.add('GET', '/:owner/:repo/info/refs', (req) => {
    const repo = repoFromParams(req);
    const service = req.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      throw new HttpError(400, 'Missing or unknown service');
    }
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    const body = service === 'git-upload-pack' && wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
    return { status: 200, raw: body, contentType: `application/x-${service}-advertisement` };
  });

  router.add('POST', '/:owner/:repo/git-upload-pack', (req) => {
    const repo = repoFromParams(req);
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    let body: Buffer;
    try {
      body = uploadPackBody(repo, req, wantsV2);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'Malformed upload-pack request');
    }
    return { status: 200, raw: body, contentType: 'application/x-git-upload-pack-result' };
  });
  router.add('POST', '/:owner/:repo/git-receive-pack', (req) => {
    const repo = repoFromParams(req);
    let body: Buffer;
    try {
      body = handleReceivePack(repo, req.body);
    } catch {
      throw new HttpError(400, 'Malformed receive-pack request');
    }
    return { status: 200, raw: body, contentType: 'application/x-git-receive-pack-result' };
  });
}
