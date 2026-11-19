// GitHub REST v3 under /api/v3. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry {message}. Auth is enforced by the server
// before this router runs (root and meta stay public).
import { FIXED_ISO, Forge, Repo, diffFlat, mergeBase, squashMerge, type Issue, type PullRequest } from './store.ts';
import { isObjectId, parseCommit } from './gitcore.ts';

export interface RestCtx {
  forge: Forge;
  viewer: string;
  origin: string;
}

export interface RestReply {
  status: number;
  headers?: Record<string, string>;
  json: unknown;
}

function ok(status: number, json: unknown, headers?: Record<string, string>): RestReply {
  return { status, headers, json };
}

function err(status: number, message: string): RestReply {
  return { status, json: { message } };
}

export function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false; reply: RestReply } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reply: err(400, 'malformed JSON body') };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pageOf(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { items: T[]; next: boolean } {
  const { page, perPage } = pageOf(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), next: start + perPage < items.length };
}

function linkHeader(base: string, query: URLSearchParams, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const { page, perPage } = pageOf(query);
  const url = new URL(base);
  url.searchParams.set('page', String(page + 1));
  url.searchParams.set('per_page', String(perPage));
  return `<${url.toString()}>; rel="next"`;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    git_url: `git://github.com/${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    comments: (repo.comments.get(issue.number) ?? []).length,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
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
    head: { ref: pr.head, sha: headSha, label: `${repo.owner}:${pr.head}`, user: { login: repo.owner } },
    base: { ref: pr.base, sha: baseSha, label: `${repo.owner}:${pr.base}`, user: { login: repo.owner } },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open',
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pr.number}`,
  };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** GET /api/v3/user/repos with Link pagination; POST /api/v3/user/repos. */
function userRepos(method: string, query: URLSearchParams, body: unknown, ctx: RestCtx): RestReply {
  if (method === 'GET') {
    const repos = ctx.forge.listReposByOwner(ctx.viewer);
    const { items, next } = paginate(repos, query);
    const headers: Record<string, string> = {};
    const base = `${ctx.origin}/api/v3/user/repos`;
    const link = linkHeader(base, query, next);
    if (link !== null) headers.link = link;
    return ok(200, items.map(repoJson), headers);
  }
  if (method === 'POST') {
    if (!isRecord(body)) return err(422, 'invalid repository body');
    const name = str(body.name);
    if (name === '' || /[/\s]/.test(name)) return err(422, 'name is required');
    const repo = ctx.forge.createRepo(ctx.viewer, name, str(body.description), bool(body.private));
    if (repo === null) return err(422, 'Repository already exists');
    return ok(201, repoJson(repo));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- repos

function repoRoute(
  method: string,
  owner: string,
  name: string,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
  ctx: RestCtx,
): RestReply {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  if (tail.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.default_branch === 'string' && repo.branchTip(body.default_branch) !== undefined) {
          repo.defaultBranch = body.default_branch;
        }
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      ctx.forge.deleteRepo(owner, name);
      return { status: 204, json: '' };
    }
    return err(404, 'Not Found');
  }
  const head = tail[0] as string;
  if (head === 'branches') return branchesRoute(method, repo, tail.slice(1));
  if (head === 'commits') return commitsRoute(method, repo, query);
  if (head === 'contents') return contentsRoute(method, repo, tail.slice(1), query, body, ctx);
  if (head === 'git') return gitRefsRoute(method, repo, tail.slice(1), body);
  if (head === 'labels') return labelsRoute(method, repo, body);
  if (head === 'issues') return issuesRoute(method, repo, tail.slice(1), query, body);
  if (head === 'pulls') return pullsRoute(method, repo, tail.slice(1), query, body);
  return err(404, 'Not Found');
}

function branchesRoute(method: string, repo: Repo, tail: string[]): RestReply {
  if (method === 'GET' && tail.length === 0) {
    const list = repo.branchNames().map((name) => ({
      name,
      commit: { sha: repo.branchTip(name) ?? '' },
      protected: false,
    }));
    return ok(200, list);
  }
  if (method === 'GET' && tail.length >= 1) {
    const branch = tail.map(decodeSegment).join('/');
    const tip = repo.branchTip(branch);
    if (tip === undefined) return err(404, 'Not Found');
    return ok(200, { name: branch, commit: { sha: tip }, sha: tip, protected: false });
  }
  return err(404, 'Not Found');
}

function commitsRoute(method: string, repo: Repo, query: URLSearchParams): RestReply {
  if (method !== 'GET') return err(404, 'Not Found');
  const refish = query.get('sha') ?? repo.defaultBranch;
  const tip = repo.resolveRef(refish);
  if (tip === undefined) {
    // An unborn repo lists no commits; an unknown ref is a 404.
    if (repo.refs.size === 0) return ok(200, []);
    return err(404, 'Not Found');
  }
  const commits = repo.listCommits(tip).map((sha) => {
    const object = repo.getObject(sha);
    const commit = object ? parseCommit(object.data) : null;
    const message = commit?.message ?? '';
    return {
      sha,
      commit: {
        message,
        author: { name: 'Forge', email: 'forge@make.fun', date: FIXED_ISO },
        committer: { name: 'Forge', email: 'forge@make.fun', date: FIXED_ISO },
      },
      author: { login: repo.owner },
      committer: { login: repo.owner },
      parents: (commit?.parents ?? []).map((p) => ({ sha: p })),
    };
  });
  const { items } = paginate(commits, query);
  return ok(200, items);
}

function gitRefsRoute(method: string, repo: Repo, tail: string[], body: unknown): RestReply {
  if (tail[0] !== 'refs') return err(404, 'Not Found');
  if (method === 'POST' && tail.length === 1) {
    if (!isRecord(body)) return err(422, 'invalid ref body');
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'invalid ref or sha');
    if (!repo.getObject(sha)) return err(422, 'object does not exist');
    if (repo.refs.has(ref)) return err(422, 'reference already exists');
    repo.refs.set(ref, sha);
    return ok(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${sha}` } });
  }
  if (method === 'GET' && tail.length >= 2) {
    const ref = tail.map(decodeSegment).join('/');
    const tip = repo.refs.get(ref);
    if (tip === undefined) return err(404, 'Not Found');
    return ok(200, { ref, object: { sha: tip, type: 'commit' } });
  }
  if (method === 'DELETE' && tail.length >= 2) {
    const ref = tail.map(decodeSegment).join('/');
    if (!repo.refs.has(ref)) return err(404, 'Not Found');
    repo.refs.delete(ref);
    return { status: 204, json: '' };
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function contentsRoute(
  method: string,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
  ctx: RestCtx,
): RestReply {
  const path = tail.map(decodeSegment).join('/');
  const refish = query.get('ref') ?? undefined;
  if (method === 'GET') return contentsGet(repo, path, refish);
  if (method === 'PUT') return contentsPut(repo, path, body, ctx);
  if (method === 'DELETE') return contentsDelete(repo, path, body);
  return err(404, 'Not Found');
}

function contentsGet(repo: Repo, path: string, refish: string | undefined): RestReply {
  let tip: string | undefined;
  if (refish !== undefined) tip = repo.resolveRef(refish);
  else tip = repo.branchTip(repo.defaultBranch);
  if (tip === undefined) return err(404, 'Not Found');
  const object = repo.getObject(tip);
  if (!object || object.type !== 'commit') return err(404, 'Not Found');
  const flat = repo.flattenTree(parseCommit(object.data).tree);
  if (path === '') {
    // Root listing: immediate children.
    const entries = rootEntries(repo, flat);
    return ok(200, entries);
  }
  const file = flat.get(path);
  if (file !== undefined) {
    const data = repo.getObject(file.oid)?.data ?? Buffer.alloc(0);
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: data.toString('base64'),
      sha: file.oid,
    });
  }
  // Directory listing: immediate children under path/.
  const prefix = `${path}/`;
  const names = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [p, entry] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) names.set(rest, { type: 'file', sha: entry.oid });
    else {
      const dir = rest.slice(0, slash);
      if (!names.has(dir)) {
        // Find the subtree oid for the directory.
        const dirFlat = new Map<string, import('./gitcore.ts').TreeEntry>();
        for (const [p2, e2] of flat) if (p2.startsWith(`${prefix}${dir}/`)) dirFlat.set(p2.slice(prefix.length + dir.length + 1), e2);
        names.set(dir, { type: 'dir', sha: repo.buildTreeFromFlat(dirFlat) });
      }
    }
  }
  if (names.size === 0) return err(404, 'Not Found');
  const entries = [...names.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({ type: entry.type, name, path: `${path}/${name}`, sha: entry.sha }));
  return ok(200, entries);
}

function rootEntries(repo: Repo, flat: Map<string, import('./gitcore.ts').TreeEntry>): Record<string, unknown>[] {
  const names = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [p, entry] of flat) {
    const slash = p.indexOf('/');
    if (slash < 0) names.set(p, { type: 'file', sha: entry.oid });
    else {
      const dir = p.slice(0, slash);
      if (!names.has(dir)) {
        const dirFlat = new Map<string, import('./gitcore.ts').TreeEntry>();
        for (const [p2, e2] of flat) if (p2.startsWith(`${dir}/`)) dirFlat.set(p2.slice(dir.length + 1), e2);
        names.set(dir, { type: 'dir', sha: repo.buildTreeFromFlat(dirFlat) });
      }
    }
  }
  return [...names.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({ type: entry.type, name, path: name, sha: entry.sha }));
}

function contentsPut(repo: Repo, path: string, body: unknown, ctx: RestCtx): RestReply {
  if (!isRecord(body)) return err(422, 'invalid contents body');
  const message = str(body.message);
  const contentB64 = str(body.content);
  if (message === '' || contentB64 === '') return err(422, 'message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = repo.branchTip(branch);
  if (tip === undefined) {
    // A contents write on a missing branch starts it from the default branch.
    const baseTip = repo.branchTip(repo.defaultBranch);
    if (baseTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      tip = baseTip;
    }
  }
  const existing = (() => {
    if (tip === undefined) return undefined;
    const tipObj = repo.getObject(tip);
    if (!tipObj || tipObj.type !== 'commit') return undefined;
    return repo.flattenTree(parseCommit(tipObj.data).tree).get(path);
  })();
  const isUpdate = existing !== undefined;
  if (isUpdate && typeof body.sha === 'string' && body.sha !== existing.oid) {
    return err(409, 'sha does not match the current file');
  }
  if (isUpdate && body.sha === undefined) return err(422, 'sha is required to update a file');
  const commitSha = repo.commitFile(branch, path, content, message);
  const newObj = repo.getObject(commitSha);
  const blobOid = newObj ? repo.flattenTree(parseCommit(newObj.data).tree).get(path)?.oid ?? '' : '';
  return ok(isUpdate ? 200 : 201, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: content.length,
      encoding: 'base64',
      type: 'file',
    },
    commit: { sha: commitSha, message },
  });
}

function contentsDelete(repo: Repo, path: string, body: unknown): RestReply {
  const branch = isRecord(body) && typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = isRecord(body) ? str(body.message, `Delete ${path}`) : `Delete ${path}`;
  const commitSha = repo.deleteFile(branch, path, message);
  if (commitSha === null) return err(404, 'Not Found');
  return ok(200, { commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------- labels

function labelsRoute(method: string, repo: Repo, body: unknown): RestReply {
  if (method === 'GET') {
    return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
  }
  if (method === 'POST') {
    if (!isRecord(body)) return err(422, 'invalid label body');
    const name = str(body.name);
    if (name === '') return err(422, 'name is required');
    const color = str(body.color, 'ededed').replace(/^#/, '');
    const existing = repo.labels.get(name);
    if (existing) return ok(201, { name: existing.name, color: existing.color, description: '' });
    const label = { name, color };
    repo.labels.set(name, label);
    return ok(201, { name, color, description: '' });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function issuesRoute(
  method: string,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
): RestReply {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let list = repo.issues.filter((issue) => {
        if (state === 'all') return true;
        return issue.state === state;
      });
      list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { items } = paginate(list, query);
      return ok(200, items.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'invalid issue body');
      const title = str(body.title);
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels : [];
      const names: string[] = [];
      for (const label of labels) {
        const name = typeof label === 'string' ? label : isRecord(label) ? str(label.name) : '';
        if (name === '') continue;
        if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
        names.push(name);
      }
      const issue: Issue = {
        number: repo.nextIssue,
        title,
        body: str(body.body),
        state: 'open',
        labels: names,
        seq: repo.seqCounter,
      };
      repo.nextIssue += 1;
      repo.seqCounter += 1;
      repo.issues.push(issue);
      return ok(201, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (isRecord(body)) {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
      }
      return ok(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (tail[1] === 'comments') {
    if (method === 'GET') {
      const list = repo.comments.get(number) ?? [];
      return ok(
        200,
        list.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: repo.owner },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        })),
      );
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'invalid comment body');
      const text = str(body.body);
      if (text === '') return err(422, 'body is required');
      const comment = { id: repo.nextCommentId, body: text };
      repo.nextCommentId += 1;
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return ok(201, { id: comment.id, body: comment.body, user: { login: repo.owner }, created_at: FIXED_ISO });
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function pullsRoute(
  method: string,
  repo: Repo,
  tail: string[],
  query: URLSearchParams,
  body: unknown,
): RestReply {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = repo.pulls.filter((pr) => {
        if (state === 'all') return true;
        return pr.state === state;
      });
      list = [...list].sort((a, b) => b.seq - a.seq);
      const { items } = paginate(list, query);
      return ok(200, items.map((pr) => pullJson(repo, pr)));
    }
    if (method === 'POST') {
      if (!isRecord(body)) return err(422, 'invalid pull request body');
      const head = str(body.head);
      const base = str(body.base, repo.defaultBranch);
      const title = str(body.title);
      if (head === '' || title === '') return err(422, 'head and title are required');
      const headTip = repo.branchTip(head);
      const baseTip = repo.branchTip(base);
      if (headTip === undefined || baseTip === undefined) return err(422, 'head or base branch does not exist');
      const duplicate = repo.pulls.find((pr) => pr.state === 'open' && pr.head === head && pr.base === base);
      if (duplicate) return err(422, 'a pull request is already open for this head and base');
      const pr: PullRequest = {
        number: repo.nextPull,
        title,
        body: str(body.body),
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
      return ok(201, pullJson(repo, pr));
    }
    return err(404, 'Not Found');
  }
  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number) || number < 1) return err(404, 'Not Found');
  const pr = repo.pulls.find((entry) => entry.number === number);
  if (pr === undefined) return err(404, 'Not Found');
  if (tail.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pr));
    return err(404, 'Not Found');
  }
  if (tail[1] === 'files') {
    if (method !== 'GET') return err(404, 'Not Found');
    const headTip = repo.branchTip(pr.head);
    const baseTip = repo.branchTip(pr.base);
    if (headTip === undefined || baseTip === undefined) return err(404, 'Not Found');
    const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
    const baseObj = repo.getObject(base);
    const headObj = repo.getObject(headTip);
    if (!baseObj || !headObj) return err(404, 'Not Found');
    const baseFlat = repo.flattenTree(parseCommit(baseObj.data).tree);
    const headFlat = repo.flattenTree(parseCommit(headObj.data).tree);
    const files = diffFlat(repo, baseFlat, headFlat).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    }));
    return ok(200, files);
  }
  if (tail[1] === 'merge') {
    if (method !== 'PUT') return err(404, 'Not Found');
    if (pr.state !== 'open') return err(405, pr.merged ? 'pull request is already merged' : 'pull request is closed');
    const result = squashMerge(repo, pr);
    if (!result.ok) {
      if (result.conflict) return err(405, 'merge conflict');
      return err(422, result.reason);
    }
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeCommitSha = result.sha;
    return ok(200, { merged: true, sha: result.sha, message: `Merge pull request #${pr.number} from ${pr.head}` });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- dispatcher

/** Route one /api/v3 request. `segments` are the path parts after /api/v3. */
export function handleRest(
  method: string,
  segments: string[],
  query: URLSearchParams,
  bodyText: string,
  ctx: RestCtx,
): RestReply {
  // API root and meta are public.
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          user_repositories_url: '/api/v3/user/repos',
          meta: { installed_version: '1.0.0' },
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return err(404, 'Not Found');
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  const needsBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let body: unknown = {};
  if (needsBody) {
    const parsed = parseJsonBody(bodyText);
    if (!parsed.ok) return parsed.reply;
    body = parsed.value;
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method === 'GET') return ok(200, { login: ctx.viewer, id: 1000, type: 'User' });
      return err(404, 'Not Found');
    }
    if (segments[1] === 'repos' && segments.length === 2) return userRepos(method, query, body, ctx);
    return err(404, 'Not Found');
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1] as string);
    const name = decodeSegment(segments[2] as string);
    return repoRoute(method, owner, name, segments.slice(3), query, body, ctx);
  }
  return err(404, 'Not Found');
}
