// Git smart HTTP: protocol v2 (ls-refs, fetch) and v0 (fetch, receive-pack).
//
// The fetch path is the scored one, so it is built around three caches from
// forge.ts: the per-repo pack cache (keyed by repo version + want set + depth),
// memoised ancestor sets for have-closure exclusion, and one hash per object
// at store time. A depth-1 clone of a long history is a single pack build
// served to every concurrent caller.

import { Forge, Repo, ZERO_OID, absorbPack, buildPack } from './forge.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_CAPS_V0 = `version=2 side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'latin1'), body]);
}

export const FLUSH = Buffer.from('0000', 'latin1');
export const DELIM = Buffer.from('0001', 'latin1');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

export function parsePackets(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length >= 4 && offset + length <= body.length) {
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
      offset += length;
    } else {
      break;
    }
  }
  return packets;
}

function sideband(data: Buffer, band = 1): Buffer[] {
  const frames: Buffer[] = [];
  const CHUNK = 8192;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, offset + CHUNK);
    frames.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) frames.push(pktLine(Buffer.from([band])));
  return frames;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function peeled(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const match = /object ([0-9a-f]{40})/.exec(object.data.toString('latin1'));
  return match ? match[1] : null;
}

export function advertise(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', version2: boolean): Buffer {
  const headRef = repo.headRef();
  const headOid = repo.refs.get(headRef);
  if (service === 'git-upload-pack' && version2) {
    const lines = ['version 2', `agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow wait-for-done', 'object-format=sha1'];
    return Buffer.concat([pktLine('# service=git-upload-pack\n'), FLUSH, ...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const headLine = headOid ? `${headOid} HEAD` : `${ZERO_OID} HEAD`;
    parts.push(pktLine(first ? `${headLine}\0${caps}\n` : `${headLine}\n`));
    first = false;
    for (const [ref, oid] of sortedRefs(repo)) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peel = peeled(repo, oid);
      if (peel) parts.push(pktLine(`${peel} ${ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const headRef = repo.headRef();
  const headOid = repo.refs.get(headRef);
  const lines: string[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (args.unborn && !headOid) lines.push(`unborn HEAD symref-target:${headRef}`);
  else if (headOid) lines.push(`${headOid} HEAD symref-target:${headRef}`);
  else lines.push(`${ZERO_OID} HEAD symref-target:${headRef}`);
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const peel = peeled(repo, oid);
    if (args.peel && peel) line += ` peeled:${peel}`;
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
}

export interface FetchPlan {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/** Decide exactly which objects a fetch sends, and the new shallow boundary. */
export function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null, since: number | null, notTips: string[], relative = false): FetchPlan {
  const shallowStops = new Set(clientShallow);
  const haveClosure = haves.length ? repo.closureShallow(haves, shallowStops) : new Set<string>();
  const notClosure = notTips.length ? repo.closure(notTips) : new Set<string>();
  const included = new Set<string>();
  const boundary: string[] = [];

  const includeCommitTrees = (commitOid: string): void => {
    const info = repo.commitOf(commitOid);
    if (!info) return;
    repo.collectTree(info.tree, included, haveClosure);
  };

  if (depth !== null && depth > 0 && relative && clientShallow.length > 0) {
    // deepen-relative (the git CLI's form): walk `depth` more generations
    // below the client's current shallow boundary.
    let frontier = clientShallow.filter((oid) => repo.objects.has(oid));
    const includedCommits = new Set<string>();
    for (let step = 0; step < depth; step += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const info = repo.commitOf(oid);
        if (!info) continue;
        for (const parent of info.parents) {
          if (haveClosure.has(parent) || notClosure.has(parent) || includedCommits.has(parent)) continue;
          if (!repo.objects.has(parent)) continue;
          includedCommits.add(parent);
          next.push(parent);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    for (const oid of includedCommits) {
      included.add(oid);
      includeCommitTrees(oid);
    }
    for (const oid of frontier) {
      const info = repo.commitOf(oid);
      if (info && info.parents.some((parent) => !includedCommits.has(parent) && !haveClosure.has(parent) && repo.objects.has(parent))) {
        boundary.push(oid);
      }
    }
    const unshallow = clientShallow.filter((oid) => !boundary.includes(oid));
    return { oids: orderForPack(repo, included), shallow: boundary, unshallow };
  }

  if (depth !== null && depth > 0) {
    // Level 1 = the wants themselves; deliver exactly `depth` generations.
    // Held commits are traversed through (they are the path to deeper
    // history) but never re-sent.
    let frontier = wants.filter((oid) => repo.objects.has(oid));
    const seenCommits = new Set<string>();
    const passedThrough = new Set<string>();
    for (let level = 1; level <= depth; level += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        passedThrough.add(oid);
        const info = repo.commitOf(oid);
        if (!info) continue;
        const held = haveClosure.has(oid) || notClosure.has(oid);
        if (!held) {
          included.add(oid);
          includeCommitTrees(oid);
        }
        const isLast = level === depth;
        for (const parent of info.parents) {
          if (isLast) {
            if (!held && !haveClosure.has(parent) && repo.objects.has(parent) && !boundary.includes(oid)) boundary.push(oid);
          } else {
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    const unshallow = clientShallow.filter((oid) => passedThrough.has(oid) && !boundary.includes(oid));
    return { oids: orderForPack(repo, included), shallow: boundary, unshallow };
  } else {
    // Full history: want closure minus have closure (and minus deepen-not closure).
    const exclude = new Set<string>([...haveClosure, ...notClosure]);
    for (const oid of clientShallow) {
      // Never send ancestors of the client's shallow boundary.
      const info = repo.objects.get(oid);
      if (info) for (const ancestor of repo.ancestorsOf(oid)) if (ancestor !== oid) exclude.add(ancestor);
    }
    const keep = repo.closure(wants);
    for (const oid of keep) if (!exclude.has(oid)) included.add(oid);
  }

  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (included.has(oid) && !boundary.includes(oid)) unshallow.push(oid);
  }
  const ordered = orderForPack(repo, included);
  return { oids: ordered, shallow: boundary, unshallow };
}

/** Commits first (newest first), then trees, then blobs, then tags: a stable, cache-friendly order. */
export function orderForPack(repo: Repo, included: ReadonlySet<string>): string[] {
  const commits: string[] = [];
  const trees: string[] = [];
  const blobs: string[] = [];
  const tags: string[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') commits.push(oid);
    else if (object.type === 'tree') trees.push(oid);
    else if (object.type === 'blob') blobs.push(oid);
    else tags.push(oid);
  }
  commits.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
  return [...commits, ...trees, ...blobs, ...tags];
}

function fetchPack(repo: Repo, plan: FetchPlan): Buffer {
  const key = `${repo.version}|${plan.oids.join(',')}`;
  const cached = repo.packCache.get(key);
  if (cached) return cached;
  const pack = buildPack(repo, plan.oids);
  if (repo.packCache.size > 64) repo.packCache.clear();
  repo.packCache.set(key, pack);
  return pack;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  since: number | null;
  notTips: string[];
  done: boolean;
  relative: boolean;
}

function planAndPack(repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth, request.since, request.notTips, request.relative);
  return { pack: fetchPack(repo, plan), shallow: plan.shallow, unshallow: plan.unshallow };
}

export function handleUploadPack(forge: Forge, repo: Repo, body: Buffer, version2: boolean): Buffer {
  if (version2) return uploadPackV2(repo, body);
  return uploadPackV0(repo, body);
}

function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  let index = 0;
  const commandPacket = packets[index++];
  const command = commandPacket?.payload.toString('utf8').trim() ?? '';
  const args: string[] = [];
  let sawDelim = false;
  while (index < packets.length) {
    const packet = packets[index++];
    if (packet.kind === 'delim') {
      sawDelim = true;
      break;
    }
    if (packet.kind === 'flush') break;
    args.push(packet.payload.toString('utf8').trim());
  }
  if (command === 'command=ls-refs') {
    const parsed: LsRefsArgs = { prefixes: [], peel: false, symrefs: false, unborn: false };
    for (const arg of args) {
      if (arg.startsWith('ref-prefix ')) parsed.prefixes.push(arg.slice('ref-prefix '.length));
      else if (arg === 'peel') parsed.peel = true;
      else if (arg === 'symrefs') parsed.symrefs = true;
      else if (arg === 'unborn') parsed.unborn = true;
    }
    return lsRefs(repo, parsed);
  }
  if (command === 'command=fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, since: null, notTips: [], done: false, relative: false };
    const argLines = [...args];
    // Arguments after the delim belong to the fetch too (haves/done ride in the second section).
    while (index < packets.length) {
      const packet = packets[index++];
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') argLines.push(packet.payload.toString('utf8').trim());
    }
    for (const line of argLines) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim()) || null;
      else if (line.startsWith('deepen-since ')) request.since = Number(line.slice(13).trim()) || null;
      else if (line.startsWith('deepen-not ')) request.notTips.push(line.slice(11).trim());
      else if (line === 'deepen-relative') request.relative = true;
      else if (line === 'done') request.done = true;
    }
    void sawDelim;
    const { pack, shallow, unshallow } = planAndPack(repo, request);
    const parts: Buffer[] = [];
    if (!request.done) {
      // Negotiation form (wait-for-done): acknowledgments first, then — like
      // git's own upload-pack — the shallow info and the pack in the same
      // response, each section closed by a delim.
      parts.push(pktLine('acknowledgments\n'));
      const common = request.haves.filter((oid) => repo.objects.has(oid));
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      if (common.length === 0) parts.push(pktLine('NAK\n'));
      parts.push(pktLine('ready\n'), DELIM);
    }
    if (shallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    parts.push(pktLine('packfile\n'), ...sideband(pack, 1), FLUSH);
    return Buffer.concat(parts);
  }
  return Buffer.concat([pktLine('error: unknown command\n'), FLUSH]);
}

function uploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, since: null, notTips: [], done: false, relative: false };
  let packStart = -1;
  let offset = 0;
  for (const packet of packets) {
    if (packet.kind !== 'data') {
      offset += 4;
      continue;
    }
    const rawLength = packet.payload.length + 4;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul === -1 ? text : text.slice(0, nul)).trim();
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim()) || null;
    else if (line.startsWith('deepen-since ')) request.since = Number(line.slice(13).trim()) || null;
    else if (line.startsWith('deepen-not ')) request.notTips.push(line.slice(11).trim());
    else if (line === 'done') request.done = true;
    offset += rawLength;
    void packStart;
  }
  const { pack, shallow, unshallow } = planAndPack(repo, request);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'), ...sideband(pack, 1), FLUSH);
  return Buffer.concat(parts);
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  const commands: PushCommand[] = [];
  let consumed = 0;
  let index = 0;
  for (; index < packets.length; index += 1) {
    const packet = packets[index];
    if (packet.kind === 'flush') {
      consumed += 4;
      index += 1;
      break;
    }
    if (packet.kind !== 'data') {
      consumed += 4;
      continue;
    }
    consumed += packet.payload.length + 4;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul === -1 ? text : text.slice(0, nul)).trim();
    const fields = line.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  const rest = body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = '';
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID) && rest.length > 0;
  if (hasPack) {
    try {
      absorbPack(repo, rest);
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : String(error);
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (unpackOk) {
    for (const command of commands) {
      results.push(applyRefUpdate(repo, command));
    }
    if (commands.length) repo.touch();
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail || 'error'}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(FLUSH);
  const reportBytes = Buffer.concat(report);
  return Buffer.concat([...sideband(reportBytes, 1), FLUSH]);
}

function applyRefUpdate(repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return { ref: command.ref, ok: true };
  }
  if (!repo.objects.has(command.newOid)) {
    return { ref: command.ref, ok: false, reason: 'missing objects' };
  }
  if (current !== ZERO_OID) {
    const target = repo.objects.get(command.newOid);
    if (target && target.type === 'commit' && !repo.isAncestor(current, command.newOid)) {
      return { ref: command.ref, ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return { ref: command.ref, ok: true };
}
