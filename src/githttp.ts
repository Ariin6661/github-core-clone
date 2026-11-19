// Git smart HTTP: info/refs, git-upload-pack (protocol v2 with a v0 fallback)
// and git-receive-pack (v0). Packfiles are parsed and generated here; the
// protocol is spoken in pkt-lines over plain HTTP. No auth on these routes:
// the suite's git client sends none.
import { Forge, Repo } from './store.ts';
import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
  type Pkt,
} from './gitcore.ts';

const AGENT = 'github-core-clone/1.0.0';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

function textReply(status: number, text: string): GitReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function peeledCommit(repo: Repo, oid: string): string | null {
  return peelToCommit(oid, (id) => repo.getObject(id));
}

function uploadCapsV0(): string {
  return `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
}

function receiveCapsV0(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** The v0 ref advertisement body (with the "# service=" preamble). */
function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCapsV0() : receiveCapsV0();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = sortedRefs(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  const lines: string[] = [];
  if (headTip !== undefined) lines.push(`${headTip} HEAD`);
  for (const ref of refs) lines.push(`${ref.oid} ${ref.name}`);
  if (lines.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  }
  // Peeled tag lines follow their tag line.
  const expanded: string[] = [];
  for (const line of lines) {
    expanded.push(line);
    const name = line.slice(41);
    if (name.startsWith('refs/tags/')) {
      const oid = line.slice(0, 40);
      const peeled = peeledCommit(repo, oid);
      const object = repo.getObject(oid);
      if (peeled !== null && object?.type === 'tag') expanded.push(`${peeled} ${name}^{}`);
    }
  }
  const encoded = expanded.map((line, index) => {
    const withCaps = index === 0 ? `${line}\0${caps}` : line;
    return pktLine(`${withCaps}\n`);
  });
  parts.push(...encoded, Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body for upload-pack. */
function advertisementV2(): Buffer {
  return pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  wantsV2: boolean,
): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return textReply(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0(repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0(repo, service) };
  }
  return textReply(400, 'unknown service');
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (headTip === undefined) {
    if (keep('HEAD')) lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}`);
  } else {
    if (keep('HEAD')) lines.push(`${headTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}`);
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.name.startsWith('refs/tags/')) {
        const object = repo.getObject(ref.oid);
        if (object?.type === 'tag') {
          const peeled = peeledCommit(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      lines.push(line);
    }
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), Buffer.from('0000', 'ascii')]);
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** Tolerant reachability: missing objects are leaves, never an error. */
function reachableTolerant(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.getObject(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const wantSet = new Set(request.wants.filter((oid) => repo.getObject(oid) !== undefined));
  const haveSet = new Set(request.haves);
  if (request.depth !== null && request.depth > 0) {
    // Depth-limited walk: wants are generation 1; parents add a generation.
    const depth = request.depth;
    const commits = new Map<string, number>(); // commit oid -> generation
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const oid of wantSet) queue.push({ oid, gen: 1 });
    const boundary = new Set<string>();
    while (queue.length) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      const object = repo.getObject(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        queue.push({ oid: target, gen });
        continue;
      }
      if (object.type !== 'commit') continue;
      if (commits.has(oid)) continue;
      commits.set(oid, gen);
      if (gen >= depth) {
        boundary.add(oid);
        continue;
      }
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
    }
    // Objects: the included commits plus their tree/blob closure, without
    // passing through a cut-off commit.
    const kept = new Set<string>();
    const walk = (oid: string): void => {
      const object = repo.getObject(oid);
      if (!object || kept.has(oid)) return;
      kept.add(oid);
      if (object.type === 'commit') {
        if (!commits.has(oid)) return;
        const commit = parseCommit(object.data);
        walk(commit.tree);
      } else if (object.type === 'tag') {
        walk(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') walk(entry.oid);
        }
      }
    };
    // Every commit inside the depth cut contributes its tree closure; the
    // walk never follows a parent, so cut-off commits stay out.
    for (const oid of commits.keys()) walk(oid);
    for (const oid of wantSet) walk(oid);
    const objects: GitObject[] = [];
    for (const oid of [...kept].sort()) {
      const object = repo.getObject(oid);
      if (object) objects.push(object);
    }
    const shallow = [...boundary].sort();
    const unshallow = request.shallow.filter((oid) => kept.has(oid) && !boundary.has(oid));
    const acks = request.haves.filter((oid) => kept.has(oid));
    return { objects, shallow, unshallow, acks };
  }

  // Full walk, minus what the client already holds.
  const wantClosure = reachableTolerant(repo, wantSet);
  const haveClosure = reachableTolerant(repo, haveSet);
  const send = new Set<string>();
  for (const oid of wantClosure) if (!haveClosure.has(oid)) send.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.getObject(oid);
    if (object) objects.push(object);
  }
  const acks = request.haves.filter((oid) => wantClosure.has(oid));
  return { objects, shallow: [], unshallow: [], acks };
}

/** Split pack bytes into sideband band-1 pkt-lines (<= 65515 data bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------- upload-pack

function parseV2Lines(packets: Pkt[]): { command: string; args: FetchRequest; lsRefs: LsRefsArgs | null } {
  let command = '';
  const args: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  const lsRefs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === '') {
      const match = /^command=(.+)$/.exec(line);
      if (match) {
        command = match[1] as string;
        continue;
      }
      // A v0 body has no command line.
      command = 'v0';
    }
    if (command === 'ls-refs') {
      if (line === 'peel') lsRefs.peel = true;
      else if (line === 'symrefs') lsRefs.symrefs = true;
      else if (line === 'unborn') lsRefs.unborn = true;
      else if (line.startsWith('ref-prefix ')) lsRefs.prefixes.push(line.slice('ref-prefix '.length));
      continue;
    }
    if (command === 'fetch') {
      if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
      else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
      continue;
    }
    if (command === 'v0') {
      // Re-parse as a v0 request below; mark it by returning early.
      break;
    }
  }
  void seenDelim;
  return { command, args, lsRefs: command === 'ls-refs' ? lsRefs : null };
}

function parseV0Fetch(packets: Pkt[]): FetchRequest {
  const args: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    void section;
  }
  return args;
}

function fetchResponseV2(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function fetchResponseV0(repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPack(pack));
  }
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(forge: Forge, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return textReply(404, 'Not Found');
  let packets: Pkt[];
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return textReply(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const firstData = packets.find((p) => p.kind === 'data');
  const firstLine = firstData ? firstData.payload.toString('utf8') : '';
  if (firstLine.startsWith('command=')) {
    const parsed = parseV2Lines(packets);
    if (parsed.command === 'ls-refs' && parsed.lsRefs !== null) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, parsed.lsRefs) };
    }
    if (parsed.command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(repo, parsed.args) };
    }
    return textReply(400, `unknown command ${parsed.command}`);
  }
  // Protocol v0 fetch.
  const request = parseV0Fetch(packets);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, request) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(forge: Forge, owner: string, repoName: string, body: Buffer): GitReply {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return textReply(404, 'Not Found');
  // Split the command list (pkt-lines up to the first flush) from the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let caps = '';
  let sawFlush = false;
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      const length = parseInt(lenText, 16);
      if (Number.isNaN(length) || length > 65520) throw new Error('bad pkt-line length');
      if (length === 0) {
        sawFlush = true;
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error('truncated pkt-line payload');
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const head = nul < 0 ? line : line.slice(0, nul);
      if (nul >= 0 && caps === '') caps = line.slice(nul + 1);
      const parts = head.split(' ');
      if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(head.slice(0, 60))}`);
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('push command has a bad object id');
      commands.push({ oldOid, newOid, ref });
    }
  } catch (err) {
    return textReply(400, `malformed push: ${(err as Error).message}`);
  }
  if (!sawFlush) return textReply(400, 'push command list has no flush');
  if (commands.length === 0) return textReply(400, 'push needs at least one command');

  const packBytes = body.subarray(offset);
  const wantsPack = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackDetail = 'ok';
  if (wantsPack) {
    if (packBytes.length === 0) {
      unpackDetail = 'unpacker error: missing packfile';
    } else {
      try {
        const read = readPack(packBytes, (oid) => repo.getObject(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
        if (!read.checksumOk) unpackDetail = 'pack trailer checksum mismatch';
      } catch (err) {
        unpackDetail = `unpacker error: ${(err as Error).message}`;
      }
    }
  }

  const reportLines: string[] = [];
  if (unpackDetail === 'ok') {
    reportLines.push('unpack ok');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let ok = false;
      if (command.newOid === ZERO_OID) {
        // Delete: ok when the ref exists at the given old value (or is already gone with a zero old).
        ok = (current === undefined && command.oldOid === ZERO_OID) || current === command.oldOid;
        if (ok && current !== undefined) repo.refs.delete(command.ref);
      } else if (command.oldOid === ZERO_OID) {
        // Create: ok only when the ref does not exist yet and the object is known.
        ok = current === undefined && repo.objects.has(command.newOid);
        if (ok) repo.refs.set(command.ref, command.newOid);
      } else {
        // Update: fast-forward only, from the advertised old value.
        ok =
          current === command.oldOid &&
          repo.objects.has(command.newOid) &&
          isAncestor(current, command.newOid, (oid) => repo.getObject(oid));
        if (ok) repo.refs.set(command.ref, command.newOid);
      }
      reportLines.push(ok ? `ok ${command.ref}` : `ng ${command.ref} non-fast-forward`);
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }

  const report = pktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  let responseBody: Buffer;
  if (caps.split(' ').includes('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < report.length; at += CHUNK) {
      const chunk = report.subarray(at, Math.min(report.length, at + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

// Re-exported for the server's routing table.
export { collectReachable, hashObject };
