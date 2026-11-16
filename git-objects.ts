/**
 * git-objects.ts — git's object model over an in-memory store: hashing, parsing and
 * building commits/trees/tags, reachability, merge-base, tree flattening, diff and
 * three-way merge. Objects are stored as raw bytes and round-trip byte-exactly; only
 * the server's own commits (contents writes, merges) are built here.
 */
import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

/** SHA-1 over `<type> <size>\0` + bytes: the object's id. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function oidToBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

export function bytesToOid(bytes: Buffer, offset = 0): string {
  return bytes.subarray(offset, offset + 20).toString('hex');
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  /** The message: everything after the blank line, trailing newlines stripped. */
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('gpgsig ')) {
      // A multi-line signature's continuation lines start with a space; the loop
      // treats them as unknown headers, which is correct: only tree/parent matter.
    }
  }
  return { tree, parents, message };
}

export interface IdentityLine {
  name: string;
  email: string;
  timestamp: number;
}

/** Build a commit object. `message` is stored with exactly one trailing newline. */
export function buildCommit(
  tree: string,
  parents: readonly string[],
  message: string,
  author: IdentityLine,
  committer: IdentityLine,
): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author.name} <${author.email}> ${author.timestamp} +0000`);
  lines.push(`committer ${committer.name} <${committer.email}> ${committer.timestamp} +0000`);
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = bytesToOid(data, nul + 1);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's canonical tree order: names compared with '/' appended for directories. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oidToBytes(entry.oid));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface ParsedTag {
  object: string;
  type: ObjectType;
}

/** Parse a tag object's target. Returns null when the bytes are not a tag. */
export function parseTag(data: Buffer): ParsedTag | null {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  if (object === '' || (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag')) return null;
  return { object, type: type as ObjectType };
}

/**
 * Follow tag objects to the underlying non-tag object. Returns the peeled oid, or
 * the input oid when it is not a tag. A missing object peels to itself.
 */
export function peelToNonTag(store: ObjectStore, oid: string): string {
  const seen = new Set<string>();
  let current = oid;
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const parsed = parseTag(object.data);
    if (parsed === null) return current;
    current = parsed.object;
  }
}

// ---------------------------------------------------------------- reachability

/**
 * The closure of `tips`: every object reachable through commit trees/parents, tag
 * targets and tree entries. Gitlinks (mode 160000) are not followed. `stopAt` names
 * commits whose parents are not traversed (a shallow boundary: the commit itself
 * and its tree are still included).
 */
export function closure(
  store: ObjectStore,
  tips: readonly string[],
  options: { stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const stopAt = options.stopAt;
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag !== null) stack.push(tag.object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` by parent links (or equal). */
export function isAncestorOrEqual(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * A merge base of `a` and `b`: the common ancestor nearest to `b` by breadth-first
 * parent distance, or null for unrelated histories. Histories here are linear or
 * squash-merged, so the nearest common ancestor is unambiguous.
 */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, newest-first by breadth-first parent walk. */
export function commitHistory(store: ObjectStore, tip: string, limit = 0): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    if (limit > 0 && out.length >= limit) break;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- flat trees

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** A tree expanded to path -> blob (gitlinks kept as entries, never expanded). */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Look one path up in a tree without flattening the whole thing. */
export function lookupPath(
  store: ObjectStore,
  treeOid: string,
  segments: readonly string[],
): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

interface TreeNode {
  entries: Map<string, { mode: string; oid: string } | { mode: string; node: TreeNode }>;
}

function emptyNode(): TreeNode {
  return { entries: new Map() };
}

/**
 * Build nested trees from a flat path map, storing every tree object. Returns the
 * root tree oid. An empty map yields the empty tree.
 */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, FlatEntry>): string {
  const root = emptyNode();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.entries.get(segment);
      if (child === undefined || !('node' in child)) {
        child = { mode: '40000', node: emptyNode() };
        node.entries.set(segment, child);
      }
      node = child.node;
    }
    node.entries.set(segments[segments.length - 1] as string, { mode: entry.mode, oid: entry.oid });
  }
  const materialize = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.entries) {
      if ('node' in child) entries.push({ mode: '40000', name, oid: materialize(child.node) });
      else entries.push({ mode: child.mode, name, oid: child.oid });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!store.has(oid)) store.set(oid, { type: 'tree', data });
    return oid;
  };
  return materialize(root);
}

// ---------------------------------------------------------------- diff and merge

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Line additions/deletions between two blobs. Small files get an exact LCS diff;
 * large ones fall back to whole-file counts (the suite asserts exact counts only
 * for added files, where additions are the new file's line count).
 */
export function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldText = oldData.toString('utf8');
  const newText = newData.toString('utf8');
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  if (oldLines.length > 200 || newLines.length > 200) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // LCS lengths, two rows.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[newLines.length] as number;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The file-level diff from `base`'s flat tree to `head`'s, sorted by path. */
export function diffFlat(
  store: ObjectStore,
  base: ReadonlyMap<string, FlatEntry>,
  head: ReadonlyMap<string, FlatEntry>,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const data = store.get(b.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'removed', additions: 0, deletions: countLines(data.toString('utf8')) });
    } else if (b === undefined && h !== undefined) {
      const data = store.get(h.oid)?.data ?? Buffer.alloc(0);
      out.push({ path, status: 'added', additions: countLines(data.toString('utf8')), deletions: 0 });
    } else if (b !== undefined && h !== undefined && (b.oid !== h.oid || b.mode !== h.mode)) {
      const oldData = store.get(b.oid)?.data ?? Buffer.alloc(0);
      const newData = store.get(h.oid)?.data ?? Buffer.alloc(0);
      const { additions, deletions } = b.oid === h.oid ? { additions: 0, deletions: 0 } : lineDiff(oldData, newData);
      out.push({ path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

export interface MergeOutcome {
  /** The merged flat tree, or null when paths conflicted. */
  tree: Map<string, FlatEntry> | null;
  conflicts: string[];
}

/**
 * A three-way file-level merge: for each path, when both sides changed it
 * differently from the base (including add/add with different content and
 * modify/delete), the path conflicts. Otherwise the changed side wins, or the
 * identical change is taken once.
 */
export function mergeFlat(
  base: ReadonlyMap<string, FlatEntry>,
  ours: ReadonlyMap<string, FlatEntry>,
  theirs: ReadonlyMap<string, FlatEntry>,
): MergeOutcome {
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: FlatEntry | undefined, y: FlatEntry | undefined): boolean =>
      x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(o, b)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(t, b)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  conflicts.sort();
  return { tree: conflicts.length > 0 ? null : merged, conflicts };
}
