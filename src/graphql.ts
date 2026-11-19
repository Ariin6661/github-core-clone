// A small hand-rolled GraphQL executor for exactly the documents gh and
// github-mcp-server send: viewer/repository lookups, issue and pull-request
// reads and mutations, __type introspection, node(id:) and cursor paging.
// No GraphQL library; the parser below handles names, variables, aliases,
// arguments (scalars, enums, lists, input objects) and inline fragments.
import {
  Forge,
  Repo,
  decodeGlobalId,
  diffFlat,
  issueGlobalId,
  mergeBase,
  prMergeable,
  pullGlobalId,
  repoGlobalId,
  squashMerge,
  commentGlobalId,
  type Issue,
  type PullRequest,
} from './store.ts';
import { parseCommit } from './gitcore.ts';

export interface GqlCtx {
  forge: Forge;
  viewer: string;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface Selection {
  kind: 'field' | 'inline' | 'spread';
  name: string;
  alias: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
  typeCondition: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selections: Selection[];
}

interface FragmentDef {
  typeCondition: string;
  selections: Selection[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '=' || ch === '!' || ch === '$' || ch === '@') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
          continue;
        }
        out += source[j] as string;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly fragments: Map<string, FragmentDef>;
  constructor(tokens: Token[], fragments: Map<string, FragmentDef>) {
    this.tokens = tokens;
    this.fragments = fragments;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, FragmentDef> } {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments: this.fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName?.kind === 'name') name = this.next().value;
    }
    const variables: Record<string, ValueNode | undefined> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseTypeName();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseTypeName(): void {
    // A type reference: Name, [Name], Name!, [Name!]! — consume and discard.
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek() as Token;
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', name: '', alias: '', args: {}, selections: this.parseSelectionSet(), typeCondition });
        } else {
          const name = this.expectName();
          selections.push({ kind: 'spread', name, alias: '', args: {}, selections: [], typeCondition: null });
        }
        continue;
      }
      let name = this.expectName();
      let alias = name;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args: Record<string, ValueNode> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      let sub: Selection[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') sub = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selections: sub, typeCondition: null });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- values

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(selection.args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- schema

const SCHEMA_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  IssueComment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_FIELDS_LIST: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'url', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged',
    'files', 'author', 'createdAt', 'url', 'headRef', 'baseRef',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'url', 'createdAt',
  ],
  SearchType: [],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'CODE', 'WIKI'];

// ---------------------------------------------------------------- nodes

type GqlNode = Record<string, unknown> & { __type: string };

function nodeOf(type: string, data: Record<string, unknown>): GqlNode {
  return { __type: type, ...data };
}

function cursorEncode(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function cursorDecode(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match) return Number(match[1]);
  } catch {
    // fall through
  }
  return -1;
}

// ---------------------------------------------------------------- executor

interface ExecState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
  ctx: GqlCtx;
}

function fieldAllowed(type: string, field: string): boolean {
  if (field === '__typename') return true;
  const fields = SCHEMA_FIELDS[type];
  return fields !== undefined && fields.includes(field);
}

function validateSelections(type: string, selections: Selection[], state: ExecState): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (!fieldAllowed(type, selection.name)) {
        state.errors.push({ message: `Cannot query field "${selection.name}" on type "${type}".` });
        continue;
      }
      const childType = childTypeOf(type, selection.name);
      if (childType !== null && selection.selections.length > 0) {
        validateSelections(childType, selection.selections, state);
      }
    } else if (selection.kind === 'inline') {
      const condition = selection.typeCondition ?? type;
      validateSelections(condition, selection.selections, state);
    } else if (selection.kind === 'spread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment) validateSelections(fragment.typeCondition, fragment.selections, state);
    }
  }
}

function childTypeOf(parentType: string, field: string): string | null {
  const map: Record<string, Record<string, string>> = {
    Query: { viewer: 'User', repository: 'Repository', node: 'Repository', __type: '__Type' },
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
      pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
    },
    IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
    PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
    PullRequest: { files: 'PullRequestFileConnection' },
    PullRequestFileConnection: { nodes: 'PullRequestFile' },
    CommentEdge: { node: 'IssueComment' },
    __Type: { fields: '__Field', enumValues: '__EnumValue' },
    Mutation: {
      createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload',
    },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'CommentEdge' },
  };
  return map[parentType]?.[field] ?? null;
}

// ---------------------------------------------------------------- execution

function executeSelections(node: GqlNode, selections: Selection[], state: ExecState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.alias] = executeField(node, selection, state);
    } else if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition === null || condition === node.__type) {
        Object.assign(out, executeSelections(node, selection.selections, state));
      }
    } else if (selection.kind === 'spread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === node.__type) {
        Object.assign(out, executeSelections(node, fragment.selections, state));
      }
    }
  }
  return out;
}

function executeField(node: GqlNode, selection: Selection, state: ExecState): unknown {
  if (selection.name === '__typename') return node.__type;
  const value = resolveField(node, selection, state);
  if (value === null || value === undefined) return null;
  if (selection.selections.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry !== null && typeof entry === 'object' && '__type' in entry
        ? executeSelections(entry as GqlNode, selection.selections, state)
        : entry,
    );
  }
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    return executeSelections(value as GqlNode, selection.selections, state);
  }
  return value;
}

function repoNode(repo: Repo): GqlNode {
  return nodeOf('Repository', {
    _repo: repo,
    id: repoGlobalId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  });
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return nodeOf('Issue', {
    _repo: repo,
    _issue: issue,
    id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  });
}

function pullNode(repo: Repo, pr: PullRequest): GqlNode {
  return nodeOf('PullRequest', {
    _repo: repo,
    _pr: pr,
    id: pullGlobalId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable: prMergeable(repo, pr),
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
  });
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = cursorDecode(typeof args.after === 'string' ? args.after : null);
  let list = [...repo.issues];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.seq - b.seq));
  const start = after + 1;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return nodeOf('IssueConnection', {
    _nodes: page.map((issue) => issueNode(repo, issue)),
    _pageInfo: nodeOf('PageInfo', {
      hasNextPage: start + first < list.length,
      endCursor: page.length === 0 ? null : cursorEncode(endIndex),
    }),
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 100;
  const after = cursorDecode(typeof args.after === 'string' ? args.after : null);
  const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
  const start = after + 1;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return nodeOf('PullRequestConnection', {
    _nodes: page.map((pr) => pullNode(repo, pr)),
    _pageInfo: nodeOf('PageInfo', {
      hasNextPage: start + first < list.length,
      endCursor: page.length === 0 ? null : cursorEncode(endIndex),
    }),
  });
}

function prFilesConnection(repo: Repo, pr: PullRequest, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 100;
  const headTip = repo.branchTip(pr.head);
  const baseTip = repo.branchTip(pr.base);
  let nodes: GqlNode[] = [];
  if (headTip !== undefined && baseTip !== undefined) {
    const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
    const baseObj = repo.getObject(base);
    const headObj = repo.getObject(headTip);
    if (baseObj && headObj) {
      const baseFlat = repo.flattenTree(parseCommit(baseObj.data).tree);
      const headFlat = repo.flattenTree(parseCommit(headObj.data).tree);
      nodes = diffFlat(repo, baseFlat, headFlat)
        .slice(0, first)
        .map((change) =>
          nodeOf('PullRequestFile', { path: change.filename, additions: change.additions, deletions: change.deletions }),
        );
    }
  }
  return nodeOf('PullRequestFileConnection', {
    _nodes: nodes,
    _pageInfo: nodeOf('PageInfo', { hasNextPage: false, endCursor: null }),
  });
}

// ---------------------------------------------------------------- field resolution

function resolveField(node: GqlNode, selection: Selection, state: ExecState): unknown {
  const args = resolveArgs(selection, state.variables);
  const type = node.__type;
  const name = selection.name;

  if (type === 'Query') {
    if (name === 'viewer') return nodeOf('User', { login: state.ctx.viewer, id: 1000 });
    if (name === 'repository') {
      const repo = state.ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoNode(repo);
    }
    if (name === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = state.ctx.forge.getRepo(decoded.owner, decoded.repo);
        return repo === undefined ? null : repoNode(repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = state.ctx.forge.getRepo(decoded.owner, decoded.repo);
        const issue = repo?.issues.find((entry) => entry.number === decoded.number);
        return repo && issue ? issueNode(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = state.ctx.forge.getRepo(decoded.owner, decoded.repo);
        const pr = repo?.pulls.find((entry) => entry.number === decoded.number);
        return repo && pr ? pullNode(repo, pr) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (typeName === 'SearchType') {
        return nodeOf('__Type', {
          name: 'SearchType',
          kind: 'ENUM',
          _fields: [],
          _enumValues: SEARCH_TYPE_VALUES.map((v) => nodeOf('__EnumValue', { name: v })),
        });
      }
      const fields = TYPE_FIELDS_LIST[typeName];
      if (fields === undefined) return null;
      return nodeOf('__Type', {
        name: typeName,
        kind: 'OBJECT',
        _fields: fields.map((f) => nodeOf('__Field', { name: f })),
        _enumValues: [],
      });
    }
    return null;
  }

  if (type === 'Mutation') return resolveMutation(node, name, args, state);

  if (type === 'Repository') {
    const repo = node._repo as Repo;
    if (name === 'owner') return nodeOf('User', { login: repo.owner, id: 1000 });
    if (name === 'defaultBranchRef') {
      const tip = repo.branchTip(repo.defaultBranch);
      return tip === undefined ? null : nodeOf('Ref', { name: repo.defaultBranch });
    }
    if (name === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequests') return pullsConnection(repo, args);
    if (name === 'pullRequest') {
      const pr = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pr === undefined ? null : pullNode(repo, pr);
    }
    return node[name] ?? null;
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestFileConnection') {
    if (name === 'nodes') return (node._nodes as GqlNode[]) ?? [];
    if (name === 'pageInfo') return node._pageInfo ?? null;
    if (name === 'totalCount') return (node._nodes as GqlNode[] | undefined)?.length ?? 0;
    return null;
  }

  if (type === 'PullRequest') {
    if (name === 'files') return prFilesConnection(node._repo as Repo, node._pr as PullRequest, args);
    return node[name] ?? null;
  }

  if (type === '__Type') {
    if (name === 'fields') return (node._fields as GqlNode[]) ?? [];
    if (name === 'enumValues') return (node._enumValues as GqlNode[]) ?? [];
    return node[name] ?? null;
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') return node.issue ?? null;
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') return node.pullRequest ?? null;
  if (type === 'AddCommentPayload') return node.commentEdge ?? null;
  if (type === 'CommentEdge') return node.node ?? null;

  return node[name] ?? null;
}

function resolveMutation(node: GqlNode, name: string, args: Record<string, unknown>, state: ExecState): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const forge = state.ctx.forge;

  if (name === 'createIssue') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') return nodeOf('CreateIssuePayload', { issue: null });
    const repo = forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return nodeOf('CreateIssuePayload', { issue: null });
    const issue: Issue = {
      number: repo.nextIssue,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open',
      labels: [],
      seq: repo.seqCounter,
    };
    repo.nextIssue += 1;
    repo.seqCounter += 1;
    repo.issues.push(issue);
    return nodeOf('CreateIssuePayload', { issue: issueNode(repo, issue) });
  }

  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') return nodeOf('CloseIssuePayload', { issue: null });
    const repo = forge.getRepo(decoded.owner, decoded.repo);
    const issue = repo?.issues.find((entry) => entry.number === decoded.number);
    if (!repo || !issue) return nodeOf('CloseIssuePayload', { issue: null });
    issue.state = 'closed';
    return nodeOf('CloseIssuePayload', { issue: issueNode(repo, issue) });
  }

  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (decoded === null || decoded.kind !== 'Repository') return nodeOf('CreatePullRequestPayload', { pullRequest: null });
    const repo = forge.getRepo(decoded.owner, decoded.repo);
    if (repo === undefined) return nodeOf('CreatePullRequestPayload', { pullRequest: null });
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? repo.defaultBranch);
    const headTip = repo.branchTip(head);
    const baseTip = repo.branchTip(base);
    if (headTip === undefined || baseTip === undefined) return nodeOf('CreatePullRequestPayload', { pullRequest: null });
    const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.head === head && pr.base === base);
    if (existing) return nodeOf('CreatePullRequestPayload', { pullRequest: pullNode(repo, existing) });
    const pr: PullRequest = {
      number: repo.nextPull,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      head,
      base,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: headTip,
      baseSha: baseTip,
      seq: repo.seqCounter,
    };
    repo.nextPull += 1;
    repo.seqCounter += 1;
    repo.pulls.push(pr);
    return nodeOf('CreatePullRequestPayload', { pullRequest: pullNode(repo, pr) });
  }

  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (decoded === null || decoded.kind !== 'PullRequest') return nodeOf('MergePullRequestPayload', { pullRequest: null });
    const repo = forge.getRepo(decoded.owner, decoded.repo);
    const pr = repo?.pulls.find((entry) => entry.number === decoded.number);
    if (!repo || !pr) return nodeOf('MergePullRequestPayload', { pullRequest: null });
    if (pr.state === 'open') {
      const result = squashMerge(repo, pr);
      if (result.ok) {
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = '2025-01-01T00:00:00Z';
        pr.mergeCommitSha = result.sha;
      }
    }
    return nodeOf('MergePullRequestPayload', { pullRequest: pullNode(repo, pr) });
  }

  if (name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (decoded === null || decoded.kind !== 'Issue') return nodeOf('AddCommentPayload', { commentEdge: null });
    const repo = forge.getRepo(decoded.owner, decoded.repo);
    const issue = repo?.issues.find((entry) => entry.number === decoded.number);
    if (!repo || !issue) return nodeOf('AddCommentPayload', { commentEdge: null });
    const comment = { id: repo.nextCommentId, body: String(input.body ?? '') };
    repo.nextCommentId += 1;
    const list = repo.comments.get(issue.number) ?? [];
    list.push(comment);
    repo.comments.set(issue.number, list);
    const commentNode = nodeOf('IssueComment', {
      id: commentGlobalId(repo.owner, repo.name, issue.number, comment.id),
      body: comment.body,
    });
    return nodeOf('AddCommentPayload', { commentEdge: nodeOf('CommentEdge', { node: commentNode }) });
  }

  return null;
}

// ---------------------------------------------------------------- entry point

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(operation: Operation, fragments: Map<string, FragmentDef>, ctx: GqlCtx): GqlResult {
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    variables[name] = defaultValue === undefined ? undefined : resolveValue(defaultValue, {});
  }
  return executeWithVariables(operation, fragments, ctx, variables);
}

function executeWithVariables(
  operation: Operation,
  fragments: Map<string, FragmentDef>,
  ctx: GqlCtx,
  variables: Record<string, unknown>,
): GqlResult {
  const state: ExecState = { errors: [], fragments, variables, ctx };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlNode = nodeOf(rootType, {});
  validateSelections(rootType, operation.selections, state);
  if (state.errors.length > 0) return { data: null, errors: state.errors };
  const data = executeSelections(root, operation.selections, state);
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

/**
 * Execute one GraphQL request body (a single operation object or a batch array).
 * Returns the response body object (or array for a batch).
 */
export function executeGraphQL(body: unknown, variables: Record<string, unknown>, ctx: GqlCtx): unknown {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(entry, ctx));
  }
  return executeOne(body, ctx);
}

function executeOne(entry: unknown, ctx: GqlCtx): GqlResult {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'request body must be a JSON object with a query string' }] };
  }
  const record = entry as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'request body must carry a query string' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let parsed: { operations: Operation[]; fragments: Map<string, FragmentDef> };
  try {
    parsed = new Parser(tokenize(query), new Map()).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'the document carries no operation' }] };
  }
  let operation = parsed.operations[0] as Operation;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  if (operationName !== null) {
    const named = parsed.operations.find((op) => op.name === operationName);
    if (named) operation = named;
  }
  const opVariables: Record<string, unknown> = {};
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (name in variables) opVariables[name] = variables[name];
    else if (defaultValue !== undefined) opVariables[name] = resolveValue(defaultValue, {});
    else opVariables[name] = undefined;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in opVariables)) opVariables[name] = value;
  }
  return executeWithVariables(operation, parsed.fragments, ctx, opVariables);
}
