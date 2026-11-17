// Hazel Forge — core store: git objects, refs, issues, pull requests.
//
// One process, one in-memory store. Objects are materialised in full (deltas
// are resolved the moment a pack lands), every object is hashed exactly once
// when it enters the store, parsed commits and trees are memoised, ancestor
// sets are memoised per tip, and built packs are cached per repository
// version. The hot paths (fetch, push, issue reads) never re-hash, never
// re-parse and never re-walk what they have already seen.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const ID_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function frameObject(type: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'latin1'), data]);
}

export function hashObject(type: string, data: Buffer): string {
  return sha1Hex(frameObject(type, data));
}

export interface GitObject {
  type: string;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorTime: number;
  committerTime: number;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorTime = 0;
  let committerTime = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorTime = Number(line.split(' ').slice(-2)[0]) || 0;
    else if (line.startsWith('committer ')) committerTime = Number(line.split(' ').slice(-2)[0]) || 0;
  }
  return { tree, parents, authorTime, committerTime, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    entries.push({
      mode: data.toString('latin1', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize |= delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

// ------------------------------------------------------------------------------------------------
// Repository

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export class Repo {
  readonly name: string;
  readonly dbId: number;
  description = '';
  isPrivate = true;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly commitCache = new Map<string, CommitInfo>();
  readonly treeCache = new Map<string, TreeEntry[]>();
  readonly ancestorCache = new Map<string, Set<string>>();
  readonly packCache = new Map<string, Buffer>();
  readonly commitSeq = new Map<string, number>();
  private seqCounter = 0;
  version = 0;
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  readonly labels = new Map<string, { id: number; name: string; color: string; description: string }>();
  nextNumber = 1;

  constructor(name: string, dbId: number) {
    this.name = name;
    this.dbId = dbId;
  }

  touch(): void {
    this.version += 1;
    this.packCache.clear();
    this.ancestorCache.clear();
  }

  store(type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      if (type === 'commit') this.commitSeq.set(oid, (this.seqCounter += 1));
    }
    return oid;
  }

  commitOf(oid: string): CommitInfo | null {
    const cached = this.commitCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    const info = parseCommit(object.data);
    this.commitCache.set(oid, info);
    return info;
  }

  treeOf(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached) return cached;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    this.treeCache.set(oid, entries);
    return entries;
  }

  defaultBranch(): string {
    return 'main';
  }

  headRef(): string {
    return `refs/heads/${this.defaultBranch()}`;
  }

  tipOf(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  /** Every commit reachable from `tip` (inclusive), memoised: history is immutable once stored. */
  ancestorsOf(tip: string): Set<string> {
    const cached = this.ancestorCache.get(tip);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const info = this.commitOf(oid);
      if (!info) continue;
      seen.add(oid);
      for (const parent of info.parents) stack.push(parent);
    }
    this.ancestorCache.set(tip, seen);
    return seen;
  }

  isAncestor(maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    return this.ancestorsOf(tip).has(maybeAncestor);
  }

  /** Full object closure (commits, trees, blobs, tags) reachable from the given tips. */
  closure(tips: readonly string[]): Set<string> {
    return this.closureShallow(tips, new Set());
  }

  /**
   * Object closure that treats `shallowStops` commits as leaves: the commit and
   * its trees/blobs count as held, its parents do not. This is the correct
   * have-closure for a shallow client, whose history stops at the boundary.
   */
  closureShallow(tips: readonly string[], shallowStops: ReadonlySet<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const info = this.commitOf(oid)!;
        stack.push(info.tree);
        if (!shallowStops.has(oid)) stack.push(...info.parents);
      } else if (object.type === 'tree') {
        for (const entry of this.treeOf(oid)!) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const match = /object ([0-9a-f]{40})/.exec(object.data.toString('latin1'));
        if (match) stack.push(match[1]);
      }
    }
    return seen;
  }

  /** Walk a tree recursively, adding every tree/blob oid not in `exclude` into `into`. */
  collectTree(treeOid: string, into: Set<string>, exclude: ReadonlySet<string>): void {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (into.has(oid) || exclude.has(oid)) continue;
      const entries = this.treeOf(oid);
      if (!entries) continue;
      into.add(oid);
      for (const entry of entries) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else if (!exclude.has(entry.oid)) into.add(entry.oid);
      }
    }
  }

  /** The blob oid at `path` in the tree of `commitOid`, or null. */
  blobAtPath(commitOid: string, path: string): { oid: string; entry: TreeEntry } | null {
    const info = this.commitOf(commitOid);
    if (!info) return null;
    const segments = path.split('/');
    let treeOid = info.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.treeOf(treeOid);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : { oid: entry.oid, entry };
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** The tree oid at directory `path` in the tree of `commitOid` ('' reads the root), or null. */
  treeAtPath(commitOid: string, path: string): string | null {
    const info = this.commitOf(commitOid);
    if (!info) return null;
    if (path === '') return info.tree;
    let treeOid = info.tree;
    for (const segment of path.split('/')) {
      const entries = this.treeOf(treeOid);
      if (!entries) return null;
      const entry = entries.find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  /**
   * Set (blobOid non-null) or delete (blobOid null) `path` under the tree `rootOid`,
   * rebuilding the trees on the path. Returns the new root tree oid.
   */
  writePath(rootOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/');
    const rebuild = (treeOid: string | null, depth: number): string => {
      const current = treeOid ? [...(this.treeOf(treeOid) ?? [])] : [];
      const name = segments[depth];
      const index = current.findIndex((entry) => entry.name === name);
      if (depth === segments.length - 1) {
        if (blobOid === null) {
          if (index !== -1) current.splice(index, 1);
        } else {
          const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
          if (index === -1) current.push(entry);
          else current[index] = entry;
        }
      } else {
        const childOid = index !== -1 && current[index].mode === '40000' ? current[index].oid : null;
        const newChild = rebuild(childOid, depth + 1);
        const childEntries = this.treeOf(newChild) ?? [];
        if (childEntries.length === 0) {
          if (index !== -1) current.splice(index, 1);
        } else {
          const entry: TreeEntry = { mode: '40000', name, oid: newChild };
          if (index === -1) current.push(entry);
          else current[index] = entry;
        }
      }
      return this.store('tree', buildTreeData(current));
    };
    return rebuild(rootOid, 0);
  }

  /** Create a commit object over `treeOid`; returns its oid (hashed once, at store time). */
  makeCommit(treeOid: string, parents: readonly string[], message: string, when?: number): string {
    const ts = when ?? Math.floor(Date.now() / 1000);
    const ident = `Forge Bot <forge@localhost> ${ts} +0000`;
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message.slice(0, -1) : message, '');
    return this.store('commit', Buffer.from(lines.join('\n'), 'utf8'));
  }
}

// ------------------------------------------------------------------------------------------------
// Pack build / parse

export function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const varint: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      varint.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    varint.push(first);
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

interface PackEntry {
  type: string;
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
}

/**
 * Parse a pack into fully materialised objects. The scan walks the stream with
 * a single inflateSync(rest, {info:true}) per entry — bytesWritten says exactly
 * where the entry ends, so there is no re-scan and no second inflate.
 */
export function parsePack(pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  const pending: PackEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      let byte2 = pack[offset++];
      let back = byte2 & 0x7f;
      while (byte2 & 0x80) {
        byte2 = pack[offset++];
        back = ((back + 1) << 7) | (byte2 & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    const type = ID_TYPES[typeId];
    const entry: PackEntry = { type, data, baseOid, baseOffset };
    entries.push(entry);
    byOffset.set(start, entry);
    if (typeId === 6 || typeId === 7) pending.push(entry);
  }
  // Resolve deltas (bases precede their deltas in every pack git writes; loop anyway).
  const resolved = new Map<PackEntry, { type: string; data: Buffer }>();
  const resolveEntry = (entry: PackEntry, depth: number): { type: string; data: Buffer } => {
    const done = resolved.get(entry);
    if (done) return done;
    if (depth > 64) throw new Error('delta chain too deep');
    let result: { type: string; data: Buffer };
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: { type: string; data: Buffer } | null = null;
      if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry) base = resolveEntry(baseEntry, depth + 1);
      } else if (entry.type === 'ref-delta' && entry.baseOid !== undefined) {
        const baseEntry = entries.find((candidate) => candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta' && hashObject(candidate.type, candidate.data) === entry.baseOid);
        if (baseEntry) base = resolveEntry(baseEntry, depth + 1);
      }
      if (!base) throw new Error('delta base not in pack');
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: entry.type, data: entry.data };
    }
    resolved.set(entry, result);
    return result;
  };
  return entries.map((entry) => {
    const full = resolveEntry(entry, 0);
    return { type: full.type, data: full.data };
  });
}

/** Store every object of a parsed pack; returns the number of new objects. */
export function absorbPack(repo: Repo, pack: Buffer): number {
  const entries = parsePack(pack);
  let added = 0;
  for (const entry of entries) {
    const before = repo.objects.size;
    repo.store(entry.type, entry.data);
    if (repo.objects.size > before) added += 1;
  }
  if (added > 0) repo.touch();
  return added;
}

// ------------------------------------------------------------------------------------------------
// The forge: all repositories plus the learned viewer login.

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoCounter = 0;
  private issueIdCounter = 0;
  private commentIdCounter = 0;
  private labelIdCounter = 0;
  viewerLogin: string | null = null;

  learnOwner(login: string): void {
    if (login && this.viewerLogin === null) this.viewerLogin = login;
  }

  owner(): string {
    return this.viewerLogin ?? 'forge';
  }

  createRepo(name: string): Repo {
    let repo = this.repos.get(name);
    if (!repo) {
      repo = new Repo(name, (this.repoCounter += 1));
      this.repos.set(name, repo);
    }
    return repo;
  }

  nextIssueId(): number {
    return (this.issueIdCounter += 1);
  }

  nextCommentId(): number {
    return (this.commentIdCounter += 1);
  }

  nextLabelId(): number {
    return (this.labelIdCounter += 1);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Opaque, stable GraphQL global id for a typed database key. */
export function globalId(kind: string, key: string | number): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
