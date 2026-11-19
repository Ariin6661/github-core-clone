// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0) at POST /mcp.
// Modern era 2026-07-28 via server/discover, with the initialize handshake as
// a fallback. Tools act on the same store as REST and GraphQL.
import { FIXED_ISO, Forge, Repo, squashMerge, type Issue, type PullRequest } from './store.ts';
import { repoJson } from './rest.ts';

export interface McpCtx {
  forge: Forge;
  viewer: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// One frozen serialization, so two tools/list calls are byte-identical.
const TOOLS_JSON = JSON.stringify({ tools: TOOLS });
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = repo.branchTip(pr.head) ?? pr.headSha;
  const baseSha = repo.branchTip(pr.base) ?? pr.baseSha;
  return {
    id: repo.id * 100000 + pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head, sha: headSha },
    base: { ref: pr.base, sha: baseSha },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
  };
}

// ---------------------------------------------------------------- tool calls

function callTool(name: string, args: Record<string, unknown>, ctx: McpCtx): Record<string, unknown> {
  const forge = ctx.forge;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const missing = (tool: ToolDef): string | null => {
    for (const required of tool.inputSchema.required) {
      const value = args[required];
      if (value === undefined || value === null || value === '') return required;
    }
    return null;
  };
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return toolResult({ error: `unknown tool: ${name}` }, true);
  const absent = missing(tool);
  if (absent !== null) return toolResult({ error: `missing required argument: ${absent}` }, true);

  if (name === 'create_repo') {
    const repoName = str(args.name);
    if (repoName === '') return toolResult({ error: 'missing required argument: name' }, true);
    const existing = forge.getRepo(ctx.viewer, repoName);
    if (existing) return toolResult(repoJson(existing));
    const repo = forge.createRepo(ctx.viewer, repoName, str(args.description), args.private === true);
    if (repo === null) return toolResult({ error: 'repository already exists' }, true);
    return toolResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const repo = forge.getRepo(str(args.owner), str(args.repo));
    if (repo === undefined) return toolResult({ error: 'repository not found' }, true);
    return toolResult(repoJson(repo));
  }

  const owner = str(args.owner);
  const repoName = str(args.repo);
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return toolResult({ error: 'repository not found' }, true);

  if (name === 'create_issue') {
    const issue: Issue = {
      number: repo.nextIssue,
      title: str(args.title),
      body: str(args.body),
      state: 'open',
      labels: [],
      seq: repo.seqCounter,
    };
    repo.nextIssue += 1;
    repo.seqCounter += 1;
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue));
  }

  if (name === 'list_issues') {
    const state = str(args.state, 'open');
    const list = repo.issues
      .filter((issue) => (state === 'all' ? true : issue.state === state))
      .map((issue) => issueJson(repo, issue));
    return toolResult(list);
  }

  if (name === 'create_pull_request') {
    const head = str(args.head);
    const base = str(args.base, repo.defaultBranch);
    const headTip = repo.branchTip(head);
    const baseTip = repo.branchTip(base);
    if (headTip === undefined || baseTip === undefined) {
      return toolResult({ error: 'head or base branch does not exist' }, true);
    }
    const existing = repo.pulls.find((pr) => pr.state === 'open' && pr.head === head && pr.base === base);
    if (existing) return toolResult(pullJson(repo, existing));
    const pr: PullRequest = {
      number: repo.nextPull,
      title: str(args.title),
      body: str(args.body),
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
    return toolResult(pullJson(repo, pr));
  }

  if (name === 'merge_pull_request') {
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
    const pr = repo.pulls.find((entry) => entry.number === number);
    if (pr === undefined) return toolResult({ error: 'pull request not found' }, true);
    if (pr.state !== 'open') return toolResult({ error: 'pull request is not open' }, true);
    const result = squashMerge(repo, pr);
    if (!result.ok) return toolResult({ error: result.conflict ? 'merge conflict' : result.reason }, true);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = result.sha;
    return toolResult({ merged: true, sha: result.sha, message: `Merge pull request #${pr.number} from ${pr.head}` });
  }

  return toolResult({ error: `unknown tool: ${name}` }, true);
}

// ---------------------------------------------------------------- JSON-RPC

export interface McpReply {
  status: number;
  json: unknown | null;
}

/** Handle one POST /mcp body. Auth has already been checked by the server. */
export function handleMcp(bodyText: string, ctx: McpCtx): McpReply {
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (!isRecord(body)) {
    return { status: 400, json: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id = 'id' in body ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = isRecord(body.params) ? body.params : {};
  const hasId = id !== undefined && id !== null;

  // Notifications (no id) are answered 202 with an empty body.
  if (!hasId) {
    if (method.startsWith('notifications/')) return { status: 202, json: null };
    return { status: 202, json: null };
  }

  const result = (value: unknown): McpReply => ({ status: 200, json: { jsonrpc: '2.0', id, result: value } });
  const failure = (code: number, message: string): McpReply => ({
    status: 200,
    json: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (requested !== '' && !SUPPORTED_VERSIONS.includes(requested)) {
      return failure(-32602, `unsupported protocol version: ${requested}`);
    }
    return result({
      protocolVersion: requested !== '' ? requested : '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }

  if (method === 'ping') return result({});

  if (method === 'tools/list') {
    return { status: 200, json: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_JSON) as unknown } };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') return failure(-32602, 'tools/call needs a tool name');
    if (!TOOLS.some((entry) => entry.name === toolName)) {
      return failure(-32602, `unknown tool: ${toolName}`);
    }
    return result(callTool(toolName, args, ctx));
  }

  return failure(-32601, `method not found: ${method}`);
}
