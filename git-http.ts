/**
 * git-http.ts — git smart HTTP: protocol v2 and v0 advertisements, ls-refs,
 * fetch (with shallow/deepen negotiation) and receive-pack (push). All object
 * handling is in-memory; packs carry plain objects only, never deltas.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  closure,
  isAncestorOrEqual,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToNonTag,
  ZERO_OID,
  type GitObject,
  type ObjectStore,
} from './git-objects.ts';
import { emptyPack, readPack, writePack } from './pack.ts';
import {
  dataLines,
  parsePktLines,
  pktDelim,
  pktFlush,
  pktLine,
  sidebandChunked,
  sidebandPacket,
} from './pktline.ts';
import { readBody, sendBytes, sendError } from './httputil.ts';
import type { ForgeStore, Repo } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const V0_UPLOAD_CAPS = `symref=HEAD:refs/heads/main side-band-64k shallow thin-pack ofs-delta agent=${AGENT} object-format=sha1`;
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The v0 advertisement: preamble, flush, ref lines, caps on the first line. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? V0_UPLOAD_CAPS : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const names = sortedRefNames(repo);
  const tip = defaultTip(repo);
  const lines: string[] = [];
  if (tip !== undefined) lines.push(`${tip} HEAD`);
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    lines.push(`${oid} ${name}`);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      lines.push(`${peelToNonTag(repo.objects, oid)} ${name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return Buffer.concat(parts);
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  return Buffer.concat(parts);
}

/** The v2 advertisement: preamble, flush, `version 2`, capabilities, flush. */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

// ------------------------------------------------------------------ ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const tip = defaultTip(repo);
  if (matches('HEAD')) {
    if (tip !== undefined) {
      parts.push(pktLine(`${tip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        line += ` peeled:${peelToNonTag(repo.objects, oid)}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Commits within `depth` generations of the wants (null = no limit), plus the full tree closure. */
function depthLimitedClosure(store: ObjectStore, wants: readonly string[], depth: number | null): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
  let head = 0;
  while (head < queue.length) {
    const { oid, dist } = queue[head] as { oid: string; dist: number };
    head += 1;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      queue.push({ oid: parseCommit(object.data).tree, dist });
      if (depth === null || dist + 1 <= depth - 1) {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
      }
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag !== null) queue.push({ oid: tag.object, dist });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push({ oid: entry.oid, dist });
      }
    }
  }
  return seen;
}

interface FetchPlan {
  send: Map<string, GitObject>;
  acks: string[];
  nak: boolean;
  shallow: string[];
  unshallow: string[];
}

function planFetch(store: ObjectStore, args: FetchArgs): FetchPlan {
  const window = depthLimitedClosure(store, args.wants, args.depth);
  const boundary = new Set(args.shallow);
  const exclusion = args.haves.length === 0 ? new Set<string>() : closure(store, args.haves, { stopAt: boundary });
  const send = new Map<string, GitObject>();
  for (const oid of window) {
    if (exclusion.has(oid)) continue;
    const object = store.get(oid);
    if (object !== undefined) send.set(oid, object);
  }
  // Acknowledgments: a have the server holds that is a want or an ancestor of one.
  const acks: string[] = [];
  for (const have of args.haves) {
    if (!store.has(have)) continue;
    const common = args.wants.some((want) => isAncestorOrEqual(store, have, want));
    if (common) acks.push(have);
  }
  const nak = args.haves.length > 0 && acks.length === 0;
  // Shallow boundaries: window commits with a parent in store but outside the
  // window and the exclusion.
  const shallow: string[] = [];
  for (const oid of window) {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const cut = parents.some((p) => store.has(p) && !window.has(p) && !exclusion.has(p));
    if (cut) shallow.push(oid);
  }
  shallow.sort();
  // Unshallow: client boundaries now fully included (every parent in the
  // window or the exclusion).
  const unshallow: string[] = [];
  const included = new Set<string>([...window, ...exclusion]);
  for (const oid of args.shallow) {
    if (!included.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((p) => included.has(p))) unshallow.push(oid);
  }
  unshallow.sort();
  return { send, acks, nak, shallow, unshallow };
}

function handleFetchV2(store: ObjectStore, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) parts.push(pktLine('NAK\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktDelim());
  }
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  const pack = plan.send.size === 0 ? emptyPack() : writePack(plan.send);
  parts.push(...sidebandChunked(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(store: ObjectStore, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (args.haves.length > 0) {
    if (plan.nak) parts.push(pktLine('NAK\n'));
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const pack = plan.send.size === 0 ? emptyPack() : writePack(plan.send);
  parts.push(...sidebandChunked(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const text = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefVerdict {
  ref: string;
  ok: boolean;
  reason: string;
}

function applyPush(repo: Repo, commands: readonly PushCommand[], unpacked: ReadonlyMap<string, GitObject> | null): { unpackOk: boolean; unpackDetail: string; verdicts: RefVerdict[] } {
  if (unpacked !== null) {
    for (const [oid, object] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }
  const verdicts: RefVerdict[] = [];
  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    if (!ref.startsWith('refs/')) {
      verdicts.push({ ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        verdicts.push({ ref, ok: false, reason: 'remote ref does not exist' });
      } else if (oldOid !== ZERO_OID && oldOid !== current) {
        verdicts.push({ ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.delete(ref);
        verdicts.push({ ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(newOid);
    if (target === undefined) {
      verdicts.push({ ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        verdicts.push({ ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(ref, newOid);
        verdicts.push({ ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      verdicts.push({ ref, ok: false, reason: 'remote ref does not exist' });
      continue;
    }
    if (oldOid !== current) {
      verdicts.push({ ref, ok: false, reason: 'stale info' });
      continue;
    }
    const oldObject = repo.objects.get(oldOid);
    if (oldObject !== undefined && oldObject.type === 'commit' && target.type === 'commit') {
      if (!isAncestorOrEqual(repo.objects, oldOid, newOid)) {
        verdicts.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(ref, newOid);
    verdicts.push({ ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: '', verdicts };
}

function reportResponse(unpackOk: boolean, unpackDetail: string, verdicts: readonly RefVerdict[]): Buffer {
  const report: Buffer[] = [];
  report.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`));
  for (const verdict of verdicts) {
    report.push(pktLine(verdict.ok ? `ok ${verdict.ref}\n` : `ng ${verdict.ref} ${verdict.reason}\n`));
  }
  const parts: Buffer[] = [];
  for (const line of report) parts.push(sidebandPacket(1, line));
  parts.push(sidebandPacket(1, Buffer.from('0000', 'ascii')));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const parsed = parsePktLines(body, true);
  const lines = dataLines(parsed.items);
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const withoutCaps = line.includes('\0') ? line.slice(0, line.indexOf('\0')) : line;
    const parts = withoutCaps.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('receive-pack command names a bad object id');
    commands.push({ oldOid, newOid, ref });
  }
  const packBytes = body.subarray(parsed.consumed);
  let unpacked: Map<string, GitObject> | null = null;
  if (packBytes.length > 0) {
    try {
      unpacked = readPack(packBytes, (oid) => repo.objects.get(oid)).objects;
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unpack failed';
      return reportResponse(false, detail, []);
    }
  }
  const outcome = applyPush(repo, commands, unpacked);
  return reportResponse(outcome.unpackOk, outcome.unpackDetail, outcome.verdicts);
}

// ------------------------------------------------------------------ routing

export interface GitRoute {
  owner: string;
  repoName: string;
  action: 'info-refs' | 'git-upload-pack' | 'git-receive-pack';
}

/** Match `/{owner}/{repo}.git/<action>`; null when the path is not a git route. */
export function matchGitRoute(pathname: string): GitRoute | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return null;
  let owner: string;
  let repoName: string;
  try {
    owner = decodeURIComponent(match[1] as string);
    repoName = decodeURIComponent(match[2] as string);
  } catch {
    return null;
  }
  const action = match[3] === 'info/refs' ? 'info-refs' : (match[3] as 'git-upload-pack' | 'git-receive-pack');
  return { owner, repoName, action };
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  route: GitRoute,
  query: URLSearchParams,
  authorized: boolean,
): Promise<void> {
  if (!authorized) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const repo = store.getRepo(route.owner, route.repoName);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return;
  }
  try {
    if (route.action === 'info-refs') {
      if (req.method !== 'GET') {
        sendError(res, 405, 'Method Not Allowed');
        return;
      }
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        sendBytes(res, 200, v2 ? advertiseV2() : advertiseV0(repo, 'git-upload-pack'), UPLOAD_ADVERTISEMENT);
      } else if (service === 'git-receive-pack') {
        sendBytes(res, 200, advertiseV0(repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT);
      } else {
        sendError(res, 404, 'Not Found');
      }
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    const { buffer } = await readBody(req);
    if (route.action === 'git-upload-pack') {
      const parsed = parsePktLines(buffer, false);
      const lines = dataLines(parsed.items);
      const first = (lines[0] ?? '').replace(/\n$/, '');
      if (first === 'command=ls-refs') {
        sendBytes(res, 200, handleLsRefs(repo, lines.slice(1)), UPLOAD_RESULT);
      } else if (first === 'command=fetch') {
        sendBytes(res, 200, handleFetchV2(repo.objects, parseFetchArgs(lines.slice(1))), UPLOAD_RESULT);
      } else if (first.startsWith('want ') || lines.some((l) => l.startsWith('want '))) {
        sendBytes(res, 200, handleFetchV0(repo.objects, parseFetchArgs(lines)), UPLOAD_RESULT);
      } else {
        sendError(res, 400, 'unknown git-upload-pack request');
      }
      return;
    }
    sendBytes(res, 200, handleReceivePack(repo, buffer), RECEIVE_RESULT);
  } catch (err) {
    // A malformed git request must never take the server down.
    sendError(res, 400, err instanceof Error ? err.message : 'bad git request');
  }
}
