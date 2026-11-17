// GraphQL surface: a small parser and executor for exactly the documents the
// GitHub API answers — viewer, repository reads, Relay node(id:), __type
// introspection for Issue / PullRequest / Repository / SearchType, issue and
// pull-request connections with cursor pagination, and the create / close /
// merge / comment mutations. One store underneath: ids minted here are the
// REST surface's ids, so the two views never disagree.

import { globalId, parseGlobalId } from './forge.ts';
import type { Forge, Repo, IssueRec, PullRec } from './forge.ts';
import { createIssue, createPull, mergePull, computeMergeable, diffTrees, mergeBase } from './restapi.ts';

// ------------------------------------------------------------------------------------------------
// Lexer / parser for the GraphQL subset the documents use.

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (/\s|,/.test(ch)) {
      i += 1;
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
    } else if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
      } else {
        let j = i + 1;
        let text = '';
        while (j < source.length && source[j] !== '"') {
          if (source[j] === '\\' && j + 1 < source.length) {
            text += source[j + 1];
            j += 2;
          } else {
            text += source[j];
            j += 1;
          }
        }
        tokens.push(`"${text}"`);
        i = j + 1;
      }
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
    } else {
      i += 1;
    }
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;
  readonly fragments = new Map<string, SelectionNode[]>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation') {
        const operation = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.skipVariableDefinitions();
        operations.push({ operation, name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next(); // type condition
        this.fragments.set(name, this.parseSelectionSet());
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'fragmentSpread', name: this.next() });
        }
      } else {
        selections.push(this.parseField());
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, ValueNode>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek() === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Schema tables (what __type reports, and what validation accepts).

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['id', 'login', 'name', 'email'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isArchived', 'description',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'createdAt', 'updatedAt', 'author',
    'labels', 'comments', 'repository', 'url', 'assignees', 'participants', 'reactions',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'comments', 'author',
    'repository', 'createdAt', 'updatedAt', 'url', 'mergeCommit', 'additions', 'deletions', 'changedFiles',
  ],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileChange: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ------------------------------------------------------------------------------------------------
// Execution.

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

type Node = Record<string, unknown> & { __type: string };

function viewerNode(forge: Forge): Node {
  return { __type: 'Viewer', login: forge.owner() };
}

function repoNode(repo: Repo): Node {
  return { __type: 'Repository', repo };
}

function issueNode(repo: Repo, issue: IssueRec): Node {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRec): Node {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function paginateConnection<T extends { number: number }>(items: T[], args: Map<string, unknown>, ctx: Ctx, wrap: (item: T) => Node): Node {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const after = typeof args.get('after') === 'string' ? (args.get('after') as string) : null;
  let startIndex = 0;
  if (after !== null) {
    const afterNumber = numberFromCursor(after);
    const found = afterNumber === null ? -1 : items.findIndex((item) => item.number === afterNumber);
    startIndex = found === -1 ? items.length : found + 1;
  }
  const slice = items.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + slice.length < items.length;
  void ctx;
  return {
    __type: 'Connection',
    nodes: slice.map(wrap),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: slice.length ? cursorFor(slice[0].number) : null,
      endCursor: slice.length ? cursorFor(slice[slice.length - 1].number) : after,
    },
    totalCount: items.length,
  };
}

function findRepoByDbId(forge: Forge, dbId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function decodeTypedId(forge: Forge, id: unknown): { repo: Repo; number?: number } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  const [dbIdPart, numberPart] = parsed.key.split(':');
  const repo = findRepoByDbId(forge, Number(dbIdPart));
  if (!repo) return null;
  return { repo, number: numberPart === undefined ? undefined : Number(numberPart) };
}

const RESOLVERS: Record<string, Record<string, (source: Node, args: Map<string, unknown>, ctx: Ctx) => unknown>> = {
  Query: {
    viewer: (_source, _args, ctx) => viewerNode(ctx.forge),
    repository: (_source, args, ctx) => {
      const owner = String(args.get('owner') ?? '');
      const name = String(args.get('name') ?? '');
      ctx.forge.learnOwner(owner);
      if (ctx.forge.viewerLogin !== null && owner !== ctx.forge.viewerLogin) return null;
      const repo = ctx.forge.repos.get(name);
      return repo ? repoNode(repo) : null;
    },
    node: (_source, args, ctx) => {
      const parsed = typeof args.get('id') === 'string' ? parseGlobalId(args.get('id') as string) : null;
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoByDbId(ctx.forge, Number(parsed.key));
        return repo ? repoNode(repo) : null;
      }
      const decoded = decodeTypedId(ctx.forge, args.get('id'));
      if (!decoded || decoded.number === undefined) return null;
      if (parsed.kind === 'Issue') {
        const issue = decoded.repo.issues.get(decoded.number);
        return issue ? issueNode(decoded.repo, issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const pull = decoded.repo.pulls.get(decoded.number);
        return pull ? pullNode(decoded.repo, pull) : null;
      }
      return null;
    },
    __type: (_source, args) => {
      const name = String(args.get('name') ?? '');
      if (TYPE_FIELDS[name]) return { __type: '__Type', name, kind: 'OBJECT', fieldNames: TYPE_FIELDS[name], enumNames: [] as string[] };
      if (ENUM_VALUES[name]) return { __type: '__Type', name, kind: 'ENUM', fieldNames: [] as string[], enumNames: ENUM_VALUES[name] };
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const decoded = decodeTypedId(ctx.forge, input.repositoryId);
      if (!decoded) throw new Error('repository not found');
      const issue = createIssue(ctx.forge, decoded.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __type: 'CreateIssuePayload', issue: issueNode(decoded.repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_source, args, ctx) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const decoded = decodeTypedId(ctx.forge, input.issueId);
      if (!decoded || decoded.number === undefined) throw new Error('issue not found');
      const issue = decoded.repo.issues.get(decoded.number);
      if (!issue) throw new Error('issue not found');
      issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueNode(decoded.repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const decoded = decodeTypedId(ctx.forge, input.repositoryId);
      if (!decoded) throw new Error('repository not found');
      const repo = decoded.repo;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? repo.defaultBranch());
      if (!repo.refs.has(`refs/heads/${head}`)) throw new Error(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new Error(`base branch ${base} does not exist`);
      const pull = createPull(ctx.forge, repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const decoded = decodeTypedId(ctx.forge, input.pullRequestId);
      if (!decoded || decoded.number === undefined) throw new Error('pull request not found');
      const pull = decoded.repo.pulls.get(decoded.number);
      if (!pull) throw new Error('pull request not found');
      if (!pull.merged) {
        const sha = mergePull(decoded.repo, pull);
        if (sha === null) throw new Error('pull request is not mergeable');
      }
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(decoded.repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_source, args, ctx) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const decoded = decodeTypedId(ctx.forge, input.subjectId);
      if (!decoded || decoded.number === undefined) throw new Error('subject not found');
      const issue = decoded.repo.issues.get(decoded.number);
      if (!issue) throw new Error('subject not found');
      const comment = { id: ctx.forge.nextCommentId(), body: String(input.body ?? ''), createdAt: new Date().toISOString() };
      issue.comments.push(comment);
      const node: Node = { __type: 'IssueComment', id: globalId('IssueComment', `${decoded.repo.dbId}:${issue.number}:${comment.id}`), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.createdAt };
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node, cursor: cursorFor(issue.number) }, subject: issueNode(decoded.repo, issue), clientMutationId: input.clientMutationId ?? null };
    },
  },
  Viewer: {
    id: (_source, _args, ctx) => globalId('User', 1000),
    login: (source) => source.login,
    name: (source) => source.login,
  },
  Repository: {
    id: (source) => globalId('Repository', (source.repo as Repo).dbId),
    databaseId: (source) => (source.repo as Repo).dbId,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source, _args, ctx) => `${ctx.forge.owner()}/${(source.repo as Repo).name}`,
    owner: (_source, _args, ctx) => viewerNode(ctx.forge),
    defaultBranchRef: (source) => ({ __type: 'Ref', name: (source.repo as Repo).defaultBranch(), prefix: 'refs/heads/' }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    isPrivate: (source) => (source.repo as Repo).isPrivate,
    isArchived: () => false,
    description: (source) => (source.repo as Repo).description,
    createdAt: () => '2026-01-01T00:00:00Z',
    updatedAt: () => new Date().toISOString(),
    url: () => '',
    stargazerCount: () => 0,
    forkCount: () => 0,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = repo.issues.get(Number(args.get('number')));
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (source, args, ctx) => {
      const repo = source.repo as Repo;
      let items = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toLowerCase());
        items = items.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const descending = orderBy?.direction !== 'ASC';
      items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const connection = paginateConnection(items, args, ctx, (issue) => issueNode(repo, issue));
      connection.__type = 'IssueConnection';
      return connection;
    },
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pull = repo.pulls.get(Number(args.get('number')));
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (source, args, ctx) => {
      const repo = source.repo as Repo;
      let items = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states)) {
        const wanted = states.map((state) => String(state).toUpperCase());
        items = items.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        items = items.filter((pull) => pull.state === 'open');
      }
      items.sort((a, b) => b.number - a.number);
      const connection = paginateConnection(items, args, ctx, (pull) => pullNode(repo, pull));
      connection.__type = 'PullRequestConnection';
      return connection;
    },
  },
  Issue: {
    id: (source) => globalId('Issue', `${(source.repo as Repo).dbId}:${(source.issue as IssueRec).number}`),
    databaseId: (source) => (source.issue as IssueRec).id,
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => ((source.issue as IssueRec).state === 'open' ? 'OPEN' : 'CLOSED'),
    closed: (source) => (source.issue as IssueRec).state === 'closed',
    createdAt: (source) => (source.issue as IssueRec).createdAt,
    updatedAt: (source) => (source.issue as IssueRec).updatedAt,
    author: (_source, _args, ctx) => viewerNode(ctx.forge),
    repository: (source) => repoNode(source.repo as Repo),
    url: () => '',
    labels: (source, args, ctx) => {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      const nodes = issue.labels.map((name) => ({ __type: 'Label', id: globalId('Label', `${repo.dbId}:${name}`), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? '' }));
      const connection = paginateConnection(nodes.map((node, index) => ({ number: index + 1, node })), args, ctx, (entry) => (entry as unknown as { node: Node }).node);
      connection.__type = 'LabelConnection';
      return connection;
    },
    comments: (source, args, ctx) => {
      const repo = source.repo as Repo;
      const issue = source.issue as IssueRec;
      const nodes = issue.comments.map((comment) => ({
        __type: 'IssueComment',
        id: globalId('IssueComment', `${repo.dbId}:${issue.number}:${comment.id}`),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.createdAt,
      }));
      const connection = paginateConnection(nodes.map((node, index) => ({ number: index + 1, node })), args, ctx, (entry) => (entry as unknown as { node: Node }).node);
      connection.__type = 'IssueCommentConnection';
      return connection;
    },
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', `${(source.repo as Repo).dbId}:${(source.pull as PullRec).number}`),
    databaseId: (source) => (source.pull as PullRec).id,
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    closed: (source) => (source.pull as PullRec).state === 'closed',
    merged: (source) => (source.pull as PullRec).merged,
    mergedAt: (source) => (source.pull as PullRec).mergedAt,
    mergeable: (source) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      if (pull.merged) return 'MERGEABLE';
      return computeMergeable(repo, pull) === 'conflict' ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (source) => (source.pull as PullRec).head,
    baseRefName: (source) => (source.pull as PullRec).base,
    headRef: (source) => ({ __type: 'Ref', name: (source.pull as PullRec).head, prefix: 'refs/heads/' }),
    baseRef: (source) => ({ __type: 'Ref', name: (source.pull as PullRec).base, prefix: 'refs/heads/' }),
    createdAt: (source) => (source.pull as PullRec).createdAt,
    updatedAt: (source) => (source.pull as PullRec).updatedAt,
    author: (_source, _args, ctx) => viewerNode(ctx.forge),
    repository: (source) => repoNode(source.repo as Repo),
    url: () => '',
    mergeCommit: (source) => {
      const pull = source.pull as PullRec;
      return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
    },
    additions: () => 0,
    deletions: () => 0,
    changedFiles: (source) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
      const base = headTip && baseTip ? mergeBase(repo, headTip, baseTip) : null;
      return diffTrees(repo, base, headTip).size;
    },
    files: (source, args, ctx) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRec;
      const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? null;
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? null;
      const base = headTip && baseTip ? mergeBase(repo, headTip, baseTip) : null;
      const changes = diffTrees(repo, base, headTip);
      const nodes = [...changes.entries()].map(([path, change], index) => ({
        __type: 'FileChange',
        number: index + 1,
        path,
        additions: 0,
        deletions: 0,
        changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      const connection = paginateConnection(nodes, args, ctx, (entry) => entry as unknown as Node);
      connection.__type = 'PullRequestFileConnection';
      return connection;
    },
  },
  __Type: {
    name: (source) => source.name,
    kind: (source) => source.kind,
    description: () => null,
    fields: (source) => ((source.fieldNames as string[]) ?? []).map((name) => ({ __type: '__Field', name })),
    enumValues: (source) => ((source.enumNames as string[]) ?? []).map((name) => ({ __type: '__EnumValue', name })),
  },
  __Field: {
    name: (source) => source.name,
    description: () => null,
    isDeprecated: () => false,
  },
  __EnumValue: {
    name: (source) => source.name,
    description: () => null,
    isDeprecated: () => false,
  },
};

function expandSelections(selections: SelectionNode[], fragments: Map<string, SelectionNode[]>): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const selection of selections) {
    if (selection.kind === 'field') fields.push(selection);
    else if (selection.kind === 'inlineFragment') fields.push(...expandSelections(selection.selectionSet, fragments));
    else {
      const fragment = fragments.get(selection.name);
      if (fragment) fields.push(...expandSelections(fragment, fragments));
    }
  }
  return fields;
}

function resolveObject(typeName: string, source: Node, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = TYPE_FIELDS[typeName] ?? Object.keys(RESOLVERS[typeName] ?? {});
  for (const field of expandSelections(selections, ctx.fragments)) {
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args = new Map<string, unknown>();
    for (const [argName, valueNode] of field.args) args.set(argName, evalValue(valueNode, ctx.variables));
    const resolver = RESOLVERS[typeName]?.[field.name];
    let value: unknown;
    try {
      value = resolver ? resolver(source, args, ctx) : (source as Record<string, unknown>)[field.name];
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, ctx));
  if (typeof value === 'object' && field.selectionSet) {
    const node = value as Node;
    return resolveObject(node.__type, node, field.selectionSet, ctx);
  }
  return value;
}

export function executeGraphQL(forge: Forge, queryText: string, variables: Record<string, unknown>): { data?: unknown; errors?: { message: string }[] } {
  const parser = new Parser(queryText);
  let operations: OperationNode[];
  try {
    operations = parser.parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = operations[0];
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const ctx: Ctx = { forge, variables, fragments: parser.fragments, errors: [] };
  const data = resolveObject(rootType, { __type: rootType }, operation.selectionSet, ctx);
  const result: { data?: unknown; errors?: { message: string }[] } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
