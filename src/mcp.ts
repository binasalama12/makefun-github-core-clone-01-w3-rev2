// MCP surface (Streamable HTTP, JSON answers): the modern server/discover era
// (2026-07-28) with the legacy initialize handshake answered too. The tools
// are thin wrappers over the same store the REST and git surfaces use, so an
// object created here reads back identically everywhere else.

import { Forge } from './forge.ts';
import { createIssue, createPull, mergePull } from './restapi.ts';

const SERVER_INFO = { name: 'hazel-forge', version: '1.0.0' };
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISION = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => unknown;
}

function text(value: string): string {
  return value;
}

function repoSummary(forge: Forge, name: string): Record<string, unknown> | null {
  const repo = forge.repos.get(name);
  if (!repo) return null;
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${forge.owner()}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch(),
    owner: { login: forge.owner() },
  };
}

function issueSummary(repo: { dbId: number }, issue: { number: number; id: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  void repo;
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map((name) => ({ name })) };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      if (forge.repos.has(name)) throw new Error(`a repository named ${name} already exists`);
      const repo = forge.createRepo(name);
      repo.description = typeof args.description === 'string' ? args.description : '';
      repo.isPrivate = args.private !== false;
      return repoSummary(forge, name);
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const summary = repoSummary(forge, String(args.repo ?? ''));
      if (!summary) throw new Error('repository not found');
      return summary;
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The owner login (informational).' },
    },
    required: [],
    run: (forge) => [...forge.repos.values()].map((repo) => repoSummary(forge, repo.name)),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = forge.repos.get(String(args.repo ?? ''));
      if (!repo) throw new Error('repository not found');
      const issue = createIssue(forge, repo, String(args.title ?? ''), String(args.body ?? ''), []);
      return issueSummary(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = forge.repos.get(String(args.repo ?? ''));
      if (!repo) throw new Error('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueSummary(repo, issue));
    },
  },
  {
    name: 'get_file_contents',
    description: 'Read a file from a repository at a branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      path: { type: 'string', description: 'The file path inside the repository.' },
      branch: { type: 'string', description: 'The branch name (default: the default branch).' },
    },
    required: ['owner', 'repo', 'path'],
    run: (forge, args) => {
      const repo = forge.repos.get(String(args.repo ?? ''));
      if (!repo) throw new Error('repository not found');
      const branch = typeof args.branch === 'string' ? args.branch : repo.defaultBranch();
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) throw new Error('branch not found');
      const found = repo.blobAtPath(tip, String(args.path ?? ''));
      if (!found) throw new Error('file not found');
      const object = repo.objects.get(found.oid)!;
      return { path: String(args.path), sha: found.oid, size: object.data.length, content: object.data.toString('utf8'), encoding: 'utf-8' };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = forge.repos.get(String(args.repo ?? ''));
      if (!repo) throw new Error('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`base branch ${base} does not exist`);
      const pull = createPull(forge, repo, String(args.title ?? ''), String(args.body ?? ''), head, base);
      return { id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state, merged: pull.merged, head: { ref: pull.head }, base: { ref: pull.base } };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge an open pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = forge.repos.get(String(args.repo ?? ''));
      if (!repo) throw new Error('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new Error('pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull);
        if (sha === null) throw new Error('pull request is not mergeable');
      }
      return { id: pull.id, number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, merge_commit_sha: pull.mergeCommitSha, head: { ref: pull.head }, base: { ref: pull.base } };
    },
  },
];

function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
    })),
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? text(value) : JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export interface McpOutcome {
  status: number;
  body?: unknown;
  sessionId?: string;
}

/** Handle one JSON-RPC message. `rawBody` parse errors are the caller's job (they map to -32700). */
export function handleMcp(forge: Forge, message: Record<string, unknown>): McpOutcome {
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  const params = (message.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const rpcError = (code: number, errorMessage: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message: errorMessage } } });

  switch (method) {
    case 'server/discover':
      return reply({
        supportedVersions: [MODERN_REVISION, LEGACY_REVISION],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : LEGACY_REVISION;
      const negotiated = requested === MODERN_REVISION ? MODERN_REVISION : LEGACY_REVISION;
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
        },
        sessionId: `forge-${Date.now().toString(36)}`,
      };
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply(toolsList());
    case 'tools/call': {
      const name = String(params.name ?? '');
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(-32602, `unknown tool: ${name}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length) return { status: 200, body: { jsonrpc: '2.0', id, result: toolError(`missing required argument(s): ${missing.join(', ')}`) } };
      try {
        return reply(toolResult(tool.run(forge, args)));
      } catch (error) {
        return { status: 200, body: { jsonrpc: '2.0', id, result: toolError(error instanceof Error ? error.message : String(error)) } };
      }
    }
    default:
      if (method.startsWith('notifications/')) return { status: 202 };
      return rpcError(-32601, `method not found: ${method}`);
  }
}

export function mcpParseErrorBody(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
}
