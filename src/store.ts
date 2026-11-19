// The forge's in-memory store: repositories, git objects, refs, issues, pull
// requests, labels and comments. Trial-scoped and deterministic: no wall-clock
// time anywhere in state (fixed timestamps only), so repeated runs agree.
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitcore.ts';

export const FIXED_ISO = '2025-01-01T00:00:00Z';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues: Issue[] = [];
  comments = new Map<number, Comment[]>();
  pulls: PullRequest[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  seqCounter = 1;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObject['type'], data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, object);
    return oid;
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** Resolve a ref-ish: branch name, full ref, or raw oid. */
  resolveRef(refish: string): string | undefined {
    if (isObjectId(refish) && this.objects.has(refish)) return refish;
    if (refish.startsWith('refs/')) return this.refs.get(refish);
    const branch = this.refs.get(`refs/heads/${refish}`);
    if (branch !== undefined) return branch;
    const tag = this.refs.get(`refs/tags/${refish}`);
    if (tag !== undefined) return tag;
    if (refish === 'HEAD') return this.branchTip(this.defaultBranch);
    return undefined;
  }

  /** Branch names, sorted. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Commits reachable from `tip`, tip first, parents after, no repeats. */
  listCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(object.data);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  /** Flatten a tree into path -> entry, recursing into subtrees. */
  flattenTree(treeOid: string): Map<string, TreeEntry> {
    const flat = new Map<string, TreeEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, entry);
      }
    };
    walk(treeOid, '');
    return flat;
  }

  /** Build a tree object from a flattened path map. */
  buildTreeFromFlat(flat: Map<string, TreeEntry>): string {
    // Group by directory, bottom-up: collect every directory path first.
    const dirs = new Set<string>(['']);
    for (const path of flat.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
    }
    const byDir = new Map<string, TreeEntry[]>();
    for (const dir of dirs) byDir.set(dir, []);
    for (const [path, entry] of flat) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      (byDir.get(dir) as TreeEntry[]).push({ mode: entry.mode, name, oid: entry.oid });
    }
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const ordered = [...dirs].sort((a, b) => depthOf(b) - depthOf(a));
    const treeOids = new Map<string, string>();
    for (const dir of ordered) {
      const entries = [...(byDir.get(dir) as TreeEntry[])];
      for (const sub of dirs) {
        if (sub === dir) continue;
        const slash = sub.lastIndexOf('/');
        const parent = slash < 0 ? '' : sub.slice(0, slash);
        if (parent !== dir) continue;
        const name = slash < 0 ? sub : sub.slice(slash + 1);
        const oid = treeOids.get(sub);
        if (oid !== undefined) entries.push({ mode: '40000', name, oid });
      }
      const data = buildTree(entries);
      treeOids.set(dir, this.putObject('tree', data));
    }
    return treeOids.get('') as string;
  }

  /** Commit one file change on a branch: returns the new commit oid. */
  commitFile(branch: string, path: string, content: Buffer, message: string): string {
    const tip = this.branchTip(branch);
    let flat = new Map<string, TreeEntry>();
    if (tip !== undefined) {
      const object = this.objects.get(tip);
      if (object && object.type === 'commit') flat = this.flattenTree(parseCommit(object.data).tree);
    }
    const blobOid = this.putObject('blob', content);
    flat.set(path, { mode: '100644', name: path.split('/').pop() as string, oid: blobOid });
    const treeOid = this.buildTreeFromFlat(flat);
    const commitData = buildCommit({ tree: treeOid, parents: tip === undefined ? [] : [tip], message });
    const commitOid = this.putObject('commit', commitData);
    this.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  /** Delete one file on a branch: returns the new commit oid, or null when absent. */
  deleteFile(branch: string, path: string, message: string): string | null {
    const tip = this.branchTip(branch);
    if (tip === undefined) return null;
    const object = this.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const flat = this.flattenTree(parseCommit(object.data).tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTreeFromFlat(flat);
    const commitData = buildCommit({ tree: treeOid, parents: [tip], message });
    const commitOid = this.putObject('commit', commitData);
    this.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }
}

// ---------------------------------------------------------------- forge

export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Diff two flattened trees (base -> head). */
export function diffFlat(
  repo: Repo,
  baseFlat: Map<string, TreeEntry>,
  headFlat: Map<string, TreeEntry>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    if (base === undefined && head !== undefined) {
      const data = repo.getObject(head.oid)?.data ?? Buffer.alloc(0);
      changes.push({ filename: path, status: 'added', additions: lineCount(data), deletions: 0 });
    } else if (base !== undefined && head === undefined) {
      const data = repo.getObject(base.oid)?.data ?? Buffer.alloc(0);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(data) });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldData = repo.getObject(base.oid)?.data ?? Buffer.alloc(0);
      const newData = repo.getObject(head.oid)?.data ?? Buffer.alloc(0);
      changes.push({
        filename: path,
        status: 'modified',
        additions: Math.max(1, lineCount(newData)),
        deletions: lineCount(oldData),
      });
    }
  }
  changes.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return changes;
}

/** The merge-base: the first commit reachable from both tips (BFS by generation). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.pop() as string;
    if (fromA.has(oid)) continue;
    fromA.add(oid);
    const object = repo.getObject(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueA.push(p);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.getObject(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueB.push(p);
  }
  return null;
}

export interface MergeResult {
  ok: boolean;
  conflict: boolean;
  sha: string | null;
  reason: string;
}

/**
 * Squash-merge a pull request onto its base branch: the merged tree is the head's
 * diff (against the merge-base) applied over the current base tip. A path the head
 * changed that the base tip also changed differently is a conflict.
 */
export function squashMerge(repo: Repo, pr: PullRequest): MergeResult {
  const headTip = repo.branchTip(pr.head);
  const baseTip = repo.branchTip(pr.base);
  if (headTip === undefined || baseTip === undefined) return { ok: false, conflict: false, sha: null, reason: 'missing branch' };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { ok: false, conflict: false, sha: null, reason: 'no merge base' };
  const baseCommit = repo.getObject(base);
  const headCommit = repo.getObject(headTip);
  const tipCommit = repo.getObject(baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return { ok: false, conflict: false, sha: null, reason: 'missing commit' };
  const baseFlat = repo.flattenTree(parseCommit(baseCommit.data).tree);
  const headFlat = repo.flattenTree(parseCommit(headCommit.data).tree);
  const tipFlat = repo.flattenTree(parseCommit(tipCommit.data).tree);
  // Conflict: a path changed base->head that also changed base->tip to different bytes.
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    const tipEntry = tipFlat.get(path);
    const headChanged = baseEntry?.oid !== headEntry.oid;
    const tipChanged = baseEntry?.oid !== tipEntry?.oid;
    if (headChanged && tipChanged && headEntry.oid !== tipEntry?.oid) {
      return { ok: false, conflict: true, sha: null, reason: 'merge conflict' };
    }
  }
  for (const [path, baseEntry] of baseFlat) {
    if (headFlat.has(path)) continue;
    const tipEntry = tipFlat.get(path);
    if (tipEntry?.oid !== baseEntry.oid) {
      return { ok: false, conflict: true, sha: null, reason: 'merge conflict' };
    }
  }
  // Apply the head's diff over the current tip tree.
  const merged = new Map(tipFlat);
  for (const [path, headEntry] of headFlat) merged.set(path, headEntry);
  for (const path of baseFlat.keys()) if (!headFlat.has(path)) merged.delete(path);
  const treeOid = repo.buildTreeFromFlat(merged);
  const message = `Merge pull request #${pr.number} from ${pr.head}`;
  const commitOid = repo.putObject('commit', buildCommit({ tree: treeOid, parents: [baseTip], message }));
  repo.refs.set(`refs/heads/${pr.base}`, commitOid);
  return { ok: true, conflict: false, sha: commitOid, reason: '' };
}

/** Mergeable state of a pull request, from the same conflict rule. */
export function prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.state !== 'open') return 'UNKNOWN';
  const headTip = repo.branchTip(pr.head);
  const baseTip = repo.branchTip(pr.base);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseCommit = repo.getObject(base);
  const headCommit = repo.getObject(headTip);
  const tipCommit = repo.getObject(baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return 'UNKNOWN';
  const baseFlat = repo.flattenTree(parseCommit(baseCommit.data).tree);
  const headFlat = repo.flattenTree(parseCommit(headCommit.data).tree);
  const tipFlat = repo.flattenTree(parseCommit(tipCommit.data).tree);
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    const tipEntry = tipFlat.get(path);
    if (baseEntry?.oid !== headEntry.oid && baseEntry?.oid !== tipEntry?.oid && headEntry.oid !== tipEntry?.oid) {
      return 'CONFLICTING';
    }
  }
  for (const [path, baseEntry] of baseFlat) {
    if (headFlat.has(path)) continue;
    const tipEntry = tipFlat.get(path);
    if (tipEntry?.oid !== baseEntry.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------- global ids

function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(owner: string, name: string): string {
  return b64urlEncode(`Repository:${owner}/${name}`);
}

export function issueGlobalId(owner: string, repo: string, number: number): string {
  return b64urlEncode(`Issue:${owner}/${repo}:${number}`);
}

export function pullGlobalId(owner: string, repo: string, number: number): string {
  return b64urlEncode(`PullRequest:${owner}/${repo}:${number}`);
}

export function commentGlobalId(owner: string, repo: string, issueNumber: number, commentId: number): string {
  return b64urlEncode(`IssueComment:${owner}/${repo}:${issueNumber}:${commentId}`);
}

export interface DecodedGlobalId {
  kind: string;
  owner: string;
  repo: string;
  number: number;
  commentId: number;
}

export function decodeGlobalId(id: string): DecodedGlobalId | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const match = /^(Repository|Issue|PullRequest|IssueComment):([^/:]+)\/([^:]+)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (!match) return null;
  return {
    kind: match[1] as string,
    owner: match[2] as string,
    repo: match[3] as string,
    number: match[4] === undefined ? 0 : Number(match[4]),
    commentId: match[5] === undefined ? 0 : Number(match[5]),
  };
}

export { ZERO_OID, collectReachable, isAncestor, peelToCommit, parseTag, hashObject };
