/**
 * store.ts — the forge's in-memory state: repositories, git objects, refs,
 * issues, pull requests, labels and comments, plus the deterministic clock and
 * the opaque global ids the GraphQL surface trades in. One trial is one
 * process, so nothing here is persisted; everything is derived from the
 * request stream and the fixed scenario identity.
 */
import {
  buildCommit,
  hashObject,
  isOid,
  peelToNonTag,
  type GitObject,
  type ObjectStore,
} from './git-objects.ts';
import { buildIdentity, type Identity, type ScenarioUser } from './identity.ts';

export const DEFAULT_BRANCH = 'main';
const EPOCH_FALLBACK_SEC = 1_735_689_600;

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  authorLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headBranch: string;
  baseBranch: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  authorLogin: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
}

/** Opaque, stable GraphQL ids: base64 over a versioned, typed key. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`v1:${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    if (!text.startsWith('v1:')) return null;
    const rest = text.slice(3);
    const colon = rest.indexOf(':');
    if (colon === -1) return null;
    return { kind: rest.slice(0, colon), key: rest.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('repo', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('pull', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(comment: Comment): string {
  return globalId('comment', String(comment.id));
}

export function userGlobalId(user: ScenarioUser): string {
  return globalId('user', String(user.id));
}

/**
 * Parse the trial clock (MAKEFUN_TRIAL_NOW, RFC 3339 UTC, identical on a live
 * run and its replay) into epoch seconds, falling back to the scenario epoch.
 */
export function trialEpochSeconds(env: Record<string, string | undefined>): number {
  const raw = env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return EPOCH_FALLBACK_SEC;
}

export class ForgeStore {
  readonly identity: Identity;
  readonly token: string;
  private readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private repoIdCounter = 1;
  private recordIdCounter = 1;
  private seqCounter = 0;
  private clockBase: number;

  constructor(env: Record<string, string | undefined>) {
    this.identity = buildIdentity();
    this.token = env.MAKEFUN_SHOP_TOKEN ?? '';
    this.clockBase = trialEpochSeconds(env);
  }

  get viewer(): ScenarioUser {
    return this.identity.viewer;
  }

  /** The next deterministic timestamp (seconds): base + a monotonic counter. */
  tick(): number {
    const ts = this.clockBase + this.seqCounter;
    this.seqCounter += 1;
    return ts;
  }

  /** The next creation-order sequence number (sorts issues by creation). */
  nextSeq(): number {
    const seq = this.seqCounter;
    this.seqCounter += 1;
    return seq;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  nextRecordId(): number {
    const id = this.recordIdCounter;
    this.recordIdCounter += 1;
    return id;
  }

  // ---------------------------------------------------------- repositories

  private key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const now = this.isoNow();
    const repo: Repo = {
      id: this.repoIdCounter,
      owner,
      name,
      fullName: `${owner}/${name}`,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, PullRequest>(),
      nextNumber: 1,
    };
    this.repoIdCounter += 1;
    this.repos.set(this.key(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  /** The owner's repositories in creation order. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // ---------------------------------------------------------- git helpers

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Build and store a server-authored commit (contents writes, merges). */
  createCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const ts = this.tick();
    const who = { name: this.viewer.name, email: this.viewer.email, timestamp: ts };
    const data = buildCommit(tree, parents, message, who, who);
    return this.putObject(repo, 'commit', data);
  }

  /**
   * Resolve a ref-ish to a commit oid: a full oid, `refs/heads/<branch>`,
   * `refs/tags/<tag>` (peeled), a branch name, or a tag name. Null when the
   * ref does not exist or does not resolve to a commit.
   */
  resolveToCommit(repo: Repo, ref: string): string | null {
    const trimmed = ref.trim();
    if (trimmed === '') return null;
    if (isOid(trimmed)) {
      const object = repo.objects.get(trimmed);
      if (object === undefined) return null;
      if (object.type === 'commit') return trimmed;
      if (object.type === 'tag') {
        const peeled = peelToNonTag(repo.objects, trimmed);
        return repo.objects.get(peeled)?.type === 'commit' ? peeled : null;
      }
      return null;
    }
    const candidates = [trimmed];
    if (!trimmed.startsWith('refs/')) {
      candidates.push(`refs/heads/${trimmed}`, `refs/tags/${trimmed}`);
    }
    for (const name of candidates) {
      const oid = repo.refs.get(name);
      if (oid === undefined) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') return oid;
      if (object.type === 'tag') {
        const peeled = peelToNonTag(repo.objects, oid);
        return repo.objects.get(peeled)?.type === 'commit' ? peeled : null;
      }
    }
    return null;
  }

  /** The default branch's tip, or null when the repository is unborn. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  // ---------------------------------------------------------- REST views

  userJson(user: ScenarioUser): Record<string, unknown> {
    return {
      login: user.login,
      id: user.id,
      node_id: userGlobalId(user),
      avatar_url: '',
      type: 'User',
      site_admin: false,
      name: user.name,
      email: user.email,
    };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: repoGlobalId(repo),
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: this.viewer.id, node_id: userGlobalId(this.viewer), type: 'User', site_admin: false },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  labelJson(label: Label): Record<string, unknown> {
    return { id: label.id, node_id: globalId('label', String(label.id)), name: label.name, color: label.color, description: '' };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name.toLowerCase());
        return label !== undefined ? this.labelJson(label) : { name, color: 'ededed' };
      }),
      user: this.userJson(this.viewer),
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      comments: issue.comments.length,
      locked: false,
    };
  }

  commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: commentGlobalId(comment),
      body: comment.body,
      user: this.userJson(this.viewer),
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
    };
  }

  private liveRefSha(repo: Repo, branch: string, fallback: string): string {
    return repo.refs.get(`refs/heads/${branch}`) ?? fallback;
  }

  pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
    const headSha = this.liveRefSha(repo, pull.headBranch, pull.headShaAtCreate);
    const baseSha = this.liveRefSha(repo, pull.baseBranch, pull.baseShaAtCreate);
    return {
      id: pull.id,
      node_id: pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headBranch, sha: headSha, label: `${repo.owner}:${pull.headBranch}` },
      base: { ref: pull.baseBranch, sha: baseSha, label: `${repo.owner}:${pull.baseBranch}` },
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: null,
      user: this.userJson(this.viewer),
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      locked: false,
    };
  }
}
