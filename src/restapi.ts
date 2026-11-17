// REST v3 surface: repositories, contents, branches, git refs, commits,
// labels, issues, comments and pull requests with squash merge — all over the
// same store the git protocol writes, so every surface agrees on every id.

import { Forge, ZERO_OID, globalId, nowIso } from './forge.ts';
import type { Repo, IssueRec, PullRec } from './forge.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });
export const notFound = (): RestResult => fail(404, 'Not Found');

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.owner();
  return {
    id: repo.dbId,
    node_id: globalId('Repository', repo.dbId),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner, id: 1000, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch(),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: nowIso(),
    html_url: '',
    url: '',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: label?.description ?? '', default: false };
}

function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.dbId}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: forge.owner(), id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: '',
    url: '',
  };
}

function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const owner = forge.owner();
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.dbId}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}`, repo: repoJson(forge, repo) },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}`, repo: repoJson(forge, repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? true : computeMergeable(repo, pull) !== 'conflict',
    user: { login: owner, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: '',
    url: '',
  };
}

/** Changed paths between two commits: path -> {status, oldOid, newOid}. */
export function diffTrees(repo: Repo, fromCommit: string | null, toCommit: string | null): Map<string, { status: string; oldOid: string | null; newOid: string | null }> {
  const flat = (commit: string | null): Map<string, string> => {
    const out = new Map<string, string>();
    if (!commit) return out;
    const info = repo.commitOf(commit);
    if (!info) return out;
    const walk = (treeOid: string, prefix: string): void => {
      for (const entry of repo.treeOf(treeOid) ?? []) {
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, entry.oid);
      }
    };
    walk(info.tree, '');
    return out;
  };
  const before = flat(fromCommit);
  const after = flat(toCommit);
  const result = new Map<string, { status: string; oldOid: string | null; newOid: string | null }>();
  for (const [path, oid] of after) {
    if (!before.has(path)) result.set(path, { status: 'added', oldOid: null, newOid: oid });
    else if (before.get(path) !== oid) result.set(path, { status: 'modified', oldOid: before.get(path)!, newOid: oid });
  }
  for (const [path, oid] of before) {
    if (!after.has(path)) result.set(path, { status: 'removed', oldOid: oid, newOid: null });
  }
  return result;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = repo.ancestorsOf(a);
  let best: string | null = null;
  let bestSeq = -1;
  for (const candidate of repo.ancestorsOf(b)) {
    if (ancestorsA.has(candidate)) {
      const seq = repo.commitSeq.get(candidate) ?? 0;
      if (seq > bestSeq) {
        bestSeq = seq;
        best = candidate;
      }
    }
  }
  return best;
}

export function computeMergeable(repo: Repo, pull: PullRec): 'clean' | 'conflict' {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return 'conflict';
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return 'conflict';
  const headChanges = diffTrees(repo, base, headTip);
  const baseChanges = diffTrees(repo, base, baseTip);
  for (const [path, change] of headChanges) {
    const other = baseChanges.get(path);
    if (other && other.newOid !== change.newOid) return 'conflict';
  }
  return 'clean';
}

/** Squash-merge: one commit on the base branch carrying the head's changes. Returns the merge sha or null on conflict. */
export function squashMerge(repo: Repo, pull: PullRec): string | null {
  if (computeMergeable(repo, pull) === 'conflict') return null;
  const headTip = repo.refs.get(`refs/heads/${pull.head}`)!;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`)!;
  const base = mergeBase(repo, headTip, baseTip)!;
  const changes = diffTrees(repo, base, headTip);
  let tree = repo.commitOf(baseTip)!.tree;
  for (const [path, change] of changes) {
    tree = repo.writePath(tree, path, change.newOid);
  }
  const sha = repo.makeCommit(tree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  repo.touch();
  return sha;
}

function parseBody(body: Buffer): { value: Record<string, unknown> } | { error: RestResult } {
  if (body.length === 0) return { value: {} };
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: fail(400, 'Problems parsing JSON') };
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { error: fail(400, 'Problems parsing JSON') };
  }
}

function paginate<T>(items: T[], query: URLSearchParams, baseUrl: string): { page: T[]; headers?: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  const pageNumber = Math.max(1, Number(query.get('page')) || 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const next = `${baseUrl}?per_page=${perPage}&page=${pageNumber + 1}`;
    const last = `${baseUrl}?per_page=${perPage}&page=${Math.ceil(items.length / perPage)}`;
    return { page, headers: { link: `<${next}>; rel="next", <${last}>; rel="last"` } };
  }
  return { page };
}

function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  forge.learnOwner(owner);
  if (forge.viewerLogin !== null && owner !== forge.viewerLogin) return null;
  return forge.repos.get(name) ?? null;
}

export function handleRest(forge: Forge, method: string, path: string, query: URLSearchParams, body: Buffer, origin: string): RestResult {
  const segments = path.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
  // segments[0] is 'api', segments[1] is 'v3' — stripped by the caller; see server.ts.
  const route = segments;

  if (route.length === 0) {
    if (method !== 'GET') return notFound();
    return ok(200, { current_user_url: `${origin}/api/v3/user`, repository_url: `${origin}/api/v3/repos/{owner}/{repo}` });
  }
  if (route[0] === 'meta' && route.length === 1 && method === 'GET') {
    return ok(200, { verifiable_password_authentication: false, installed_version: 'forge-1.0.0', github_services_sha: 'forge' });
  }
  if (route[0] === 'user' && route.length === 1 && method === 'GET') {
    if (forge.viewerLogin === null) return notFound();
    return ok(200, { login: forge.viewerLogin, id: 1000, type: 'User', name: forge.viewerLogin });
  }
  if (route[0] === 'user' && route[1] === 'repos') {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.dbId - b.dbId).map((repo) => repoJson(forge, repo));
      const { page, headers } = paginate(all, query, `${origin}/api/v3/user/repos`);
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const name = String(parsed.value.name ?? '');
      if (name === '') return fail(422, 'name is required');
      if (forge.repos.has(name)) return fail(422, `a repository named ${name} already exists`);
      const repo = forge.createRepo(name);
      repo.description = typeof parsed.value.description === 'string' ? parsed.value.description : '';
      repo.isPrivate = parsed.value.private !== false;
      return ok(201, repoJson(forge, repo));
    }
    return notFound();
  }
  if (route[0] !== 'repos' || route.length < 3) return notFound();
  const owner = route[1];
  const repo = resolveRepo(forge, owner, route[2]);
  if (!repo) return notFound();
  const rest = route.slice(3);
  return handleRepoRoute(forge, repo, method, rest, query, body, origin);
}

function handleRepoRoute(forge: Forge, repo: Repo, method: string, rest: string[], query: URLSearchParams, body: Buffer, origin: string): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      if (typeof parsed.value.name === 'string' && parsed.value.name !== repo.name) {
        forge.repos.delete(repo.name);
        (repo as { name: string }).name = parsed.value.name;
        forge.repos.set(repo.name, repo);
      }
      return ok(200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.repos.delete(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  const [head, ...tail] = rest;

  if (head === 'contents') return contentsRoute(forge, repo, method, tail.join('/'), query, body);
  if (head === 'branches') return branchesRoute(forge, repo, method, tail);
  if (head === 'commits' && method === 'GET') return commitsRoute(repo, query);
  if (head === 'git' && tail[0] === 'refs') return gitRefsRoute(repo, method, tail.slice(1), body);
  if (head === 'labels') return labelsRoute(forge, repo, method, tail, body);
  if (head === 'issues') return issuesRoute(forge, repo, method, tail, query, body);
  if (head === 'pulls') return pullsRoute(forge, repo, method, tail, query, body);
  return notFound();
}

function refTip(repo: Repo, ref: string | null): string | null {
  if (!ref) return repo.refs.get(repo.headRef()) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.objects.has(ref) && repo.objects.get(ref)!.type === 'commit') return ref;
  return null;
}

function contentsRoute(forge: Forge, repo: Repo, method: string, rawPath: string, query: URLSearchParams, body: Buffer): RestResult {
  const path = rawPath;
  if (method === 'GET') {
    const tip = refTip(repo, query.get('ref'));
    if (!tip) return notFound();
    if (path === '') {
      const treeOid = repo.treeAtPath(tip, '');
      return ok(200, listTree(repo, treeOid, ''));
    }
    const file = repo.blobAtPath(tip, path);
    if (file) {
      const object = repo.objects.get(file.oid)!;
      return ok(200, {
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: object.data.length,
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
      });
    }
    const dirOid = repo.treeAtPath(tip, path);
    if (dirOid) return ok(200, listTree(repo, dirOid, path));
    return notFound();
  }
  if (method === 'PUT') {
    const parsed = parseBody(body);
    if ('error' in parsed) return parsed.error;
    const message = String(parsed.value.message ?? 'commit');
    const content = Buffer.from(String(parsed.value.content ?? ''), 'base64');
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch();
    const ref = `refs/heads/${branch}`;
    const parentTip = repo.refs.get(ref) ?? repo.refs.get(repo.headRef()) ?? null;
    const parentTree = parentTip ? repo.commitOf(parentTip)!.tree : null;
    const existing = parentTip ? repo.blobAtPath(parentTip, path) : null;
    if (existing && typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.oid) {
      return fail(409, `${path} has changed since ${parsed.value.sha}`);
    }
    if (existing && parsed.value.sha === undefined) return fail(422, 'sha is required when updating a file');
    const blobOid = repo.store('blob', content);
    const newTree = repo.writePath(parentTree, path, blobOid);
    const commitSha = repo.makeCommit(newTree, parentTip ? [parentTip] : [], message);
    repo.refs.set(ref, commitSha);
    repo.touch();
    return ok(existing ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
      commit: { sha: commitSha, message },
    });
  }
  if (method === 'DELETE') {
    const parsed = parseBody(body);
    if ('error' in parsed) return parsed.error;
    const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : repo.defaultBranch();
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return notFound();
    const existing = repo.blobAtPath(tip, path);
    if (!existing) return notFound();
    if (typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.oid) return fail(409, 'sha does not match');
    const newTree = repo.writePath(repo.commitOf(tip)!.tree, path, null);
    const commitSha = repo.makeCommit(newTree, [tip], String(parsed.value.message ?? 'delete'));
    repo.refs.set(ref, commitSha);
    repo.touch();
    return ok(200, { content: null, commit: { sha: commitSha } });
  }
  return notFound();
}

function listTree(repo: Repo, treeOid: string | null, prefix: string): Record<string, unknown>[] {
  if (!treeOid) return [];
  return (repo.treeOf(treeOid) ?? []).map((entry) => ({
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
    type: entry.mode === '40000' ? 'dir' : 'file',
  }));
}

function branchesRoute(forge: Forge, repo: Repo, method: string, tail: string[]): RestResult {
  if (method !== 'GET') return notFound();
  if (tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return ok(200, branches);
  }
  const name = tail.join('/');
  const oid = repo.refs.get(`refs/heads/${name}`);
  if (!oid) return notFound();
  return ok(200, { name, commit: { sha: oid, url: '' }, protected: false });
}

function commitsRoute(repo: Repo, query: URLSearchParams): RestResult {
  const shaParam = query.get('sha');
  const tip = refTip(repo, shaParam);
  if (!tip) return ok(200, []);
  const all = [...repo.ancestorsOf(tip)]
    .map((oid) => ({ oid, info: repo.commitOf(oid)! }))
    .sort((a, b) => (repo.commitSeq.get(b.oid) ?? 0) - (repo.commitSeq.get(a.oid) ?? 0))
    .map(({ oid, info }) => ({
      sha: oid,
      commit: {
        message: info.message.replace(/\n$/, ''),
        tree: { sha: info.tree },
        author: { name: 'Forge Bot', email: 'forge@localhost', date: new Date(info.authorTime * 1000).toISOString() },
        committer: { name: 'Forge Bot', email: 'forge@localhost', date: new Date(info.committerTime * 1000).toISOString() },
      },
      parents: info.parents.map((parent) => ({ sha: parent })),
    }));
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
  const pageNumber = Math.max(1, Number(query.get('page')) || 1);
  return ok(200, all.slice((pageNumber - 1) * perPage, pageNumber * perPage));
}

function gitRefsRoute(repo: Repo, method: string, tail: string[], body: Buffer): RestResult {
  if (method === 'POST' && tail.length === 0) {
    const parsed = parseBody(body);
    if ('error' in parsed) return parsed.error;
    const ref = String(parsed.value.ref ?? '');
    const sha = String(parsed.value.sha ?? '');
    if (!ref.startsWith('refs/')) return fail(422, 'ref must start with refs/');
    if (!repo.objects.has(sha)) return fail(422, `object ${sha} does not exist`);
    if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    repo.touch();
    return ok(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
  }
  if (method === 'GET' && tail.length > 0) {
    const ref = `refs/${tail.join('/')}`;
    const oid = repo.refs.get(ref);
    if (!oid) return notFound();
    return ok(200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  }
  return notFound();
}

function labelsRoute(forge: Forge, repo: Repo, method: string, tail: string[], body: Buffer): RestResult {
  if (method === 'GET' && tail.length === 0) return ok(200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
  if (method === 'POST' && tail.length === 0) {
    const parsed = parseBody(body);
    if ('error' in parsed) return parsed.error;
    const name = String(parsed.value.name ?? '');
    if (name === '') return fail(422, 'name is required');
    if (repo.labels.has(name)) return fail(422, `label ${name} already exists`);
    repo.labels.set(name, {
      id: forge.nextLabelId(),
      name,
      color: typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed',
      description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
    });
    return ok(201, labelJson(repo, name));
  }
  return notFound();
}

export function createIssue(forge: Forge, repo: Repo, title: string, bodyText: string, labels: string[]): IssueRec {
  const issue: IssueRec = {
    number: repo.nextNumber++,
    id: forge.nextIssueId(),
    title,
    body: bodyText,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

function issuesRoute(forge: Forge, repo: Repo, method: string, tail: string[], query: URLSearchParams, body: Buffer): RestResult {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const labels = Array.isArray(parsed.value.labels) ? parsed.value.labels.map((label) => String(typeof label === 'object' && label !== null ? (label as { name?: unknown }).name ?? '' : label)) : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) return fail(422, `label ${name} does not exist`);
      }
      const issue = createIssue(forge, repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), labels);
      return ok(201, issueJson(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'asc');
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
      const pageNumber = Math.max(1, Number(query.get('page')) || 1);
      return ok(200, items.slice((pageNumber - 1) * perPage, pageNumber * perPage).map((issue) => issueJson(forge, repo, issue)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const issue = repo.issues.get(number);
  if (tail.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return ok(200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (Array.isArray(parsed.value.labels)) {
        const names = parsed.value.labels.map((label) => String(label));
        for (const name of names) if (!repo.labels.has(name)) return fail(422, `label ${name} does not exist`);
        issue.labels = names;
      }
      issue.updatedAt = nowIso();
      return ok(200, issueJson(forge, repo, issue));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: forge.owner(), id: 1000, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt })));
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const comment = { id: forge.nextCommentId(), body: String(parsed.value.body ?? ''), createdAt: nowIso() };
      issue.comments.push(comment);
      return ok(201, { id: comment.id, body: comment.body, user: { login: forge.owner(), id: 1000, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt });
    }
  }
  return notFound();
}

export function createPull(forge: Forge, repo: Repo, title: string, bodyText: string, head: string, base: string): PullRec {
  const pull: PullRec = {
    number: repo.nextNumber++,
    id: forge.nextIssueId(),
    title,
    body: bodyText,
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function mergePull(repo: Repo, pull: PullRec): string | null {
  const sha = squashMerge(repo, pull);
  if (sha === null) return null;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return sha;
}

function pullsRoute(forge: Forge, repo: Repo, method: string, tail: string[], query: URLSearchParams, body: Buffer): RestResult {
  if (tail.length === 0) {
    if (method === 'POST') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      const head = String(parsed.value.head ?? '');
      const base = String(parsed.value.base ?? repo.defaultBranch());
      if (!repo.refs.has(`refs/heads/${head}`)) return fail(422, `head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return fail(422, `base branch ${base} does not exist`);
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.head === head && pull.base === base);
      if (existing) return fail(422, `a pull request already exists for ${head} into ${base}`);
      const pull = createPull(forge, repo, String(parsed.value.title ?? ''), String(parsed.value.body ?? ''), head, base);
      return ok(201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page')) || 30));
      const pageNumber = Math.max(1, Number(query.get('page')) || 1);
      return ok(200, items.slice((pageNumber - 1) * perPage, pageNumber * perPage).map((pull) => pullJson(forge, repo, pull)));
    }
    return notFound();
  }
  const number = Number(tail[0]);
  const pull = repo.pulls.get(number);
  if (tail.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if ('error' in parsed) return parsed.error;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') pull.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') pull.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pull.body = parsed.value.body;
      pull.updatedAt = nowIso();
      return ok(200, pullJson(forge, repo, pull));
    }
    return notFound();
  }
  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
    const base = headTip && baseTip ? mergeBase(repo, headTip, baseTip) : null;
    const changes = diffTrees(repo, base, headTip);
    const files = [...changes.entries()].map(([path, change]) => {
      const newLines = change.newOid ? countLines(repo, change.newOid) : 0;
      const oldLines = change.oldOid ? countLines(repo, change.oldOid) : 0;
      const additions = change.status === 'removed' ? 0 : newLines;
      const deletions = change.status === 'added' ? 0 : oldLines;
      return { filename: path, status: change.status, additions, deletions, changes: additions + deletions, sha: change.newOid ?? change.oldOid ?? ZERO_OID, patch: '' };
    });
    return ok(200, files);
  }
  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    if (pull.merged || pull.state !== 'open') return fail(405, 'Pull Request is not mergeable');
    const sha = mergePull(repo, pull);
    if (sha === null) return fail(405, 'Pull Request is not mergeable: merge conflict');
    return ok(200, { sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}

function countLines(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
