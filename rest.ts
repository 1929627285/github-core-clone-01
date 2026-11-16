/**
 * rest.ts — the REST v3 surface under /api/v3: repositories, branches, commits,
 * contents, labels, issues, comments and pull requests, over the shared store.
 * Every reply is JSON with a request id; unknown routes are JSON 404s and
 * malformed bodies are JSON 400s.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildTreeFromFlat,
  commitHistory,
  diffFlat,
  flattenTree,
  isOid,
  lookupPath,
  mergeBase,
  mergeFlat,
  parseCommit,
  parseTree,
  ZERO_OID,
  type FlatEntry,
} from './git-objects.ts';
import {
  isRecord,
  nextRequestId,
  parseJsonBody,
  readBody,
  requestOrigin,
  sendError,
  sendJson,
} from './httputil.ts';
import type { ForgeStore, Issue, PullRequest, Repo } from './store.ts';

// ---------------------------------------------------------------- utilities

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

function parsePageParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  totalPages: number;
}

function paginate<T>(all: readonly T[], query: URLSearchParams): Page<T> {
  const perPage = Math.min(100, parsePageParam(query.get('per_page'), 30));
  const page = parsePageParam(query.get('page'), 1);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const start = (page - 1) * perPage;
  return { items: all.slice(start, start + perPage), page, perPage, totalPages };
}

function linkHeader(req: IncomingMessage, query: URLSearchParams, page: Page<unknown>): string | null {
  if (page.totalPages <= 1) return null;
  const origin = requestOrigin(req);
  const url = new URL(req.url ?? '/', origin);
  const build = (p: number): string => {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(p));
    next.searchParams.set('per_page', String(page.perPage));
    return next.toString();
  };
  const links: string[] = [];
  if (page.page < page.totalPages) links.push(`<${build(page.page + 1)}>; rel="next"`);
  links.push(`<${build(page.totalPages)}>; rel="last"`);
  if (page.page > 1) {
    links.push(`<${build(1)}>; rel="first"`);
    links.push(`<${build(page.page - 1)}>; rel="prev"`);
  }
  return links.join(', ');
}

function sendPage<T>(req: IncomingMessage, res: ServerResponse, query: URLSearchParams, all: readonly T[], view: (item: T) => unknown): void {
  const page = paginate(all, query);
  const headers: Record<string, string> = {};
  const link = linkHeader(req, query, page);
  if (link !== null) headers.link = link;
  sendJson(res, 200, page.items.map(view), headers);
}

interface IdentityLineView {
  name: string;
  email: string;
  date: string;
}

function parseIdentityLine(line: string): IdentityLineView | null {
  const match = /^(.+) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return null;
  const ts = Number.parseInt(match[3] as string, 10);
  return { name: match[1] as string, email: match[2] as string, date: new Date(ts * 1000).toISOString() };
}

function commitView(repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const parsed = object !== undefined ? parseCommit(object.data) : { tree: '', parents: [], message: '' };
  let author: IdentityLineView | null = null;
  let committer: IdentityLineView | null = null;
  if (object !== undefined) {
    const head = object.data.toString('utf8').split('\n\n')[0] ?? '';
    for (const line of head.split('\n')) {
      if (line.startsWith('author ')) author = parseIdentityLine(line.slice(7));
      else if (line.startsWith('committer ')) committer = parseIdentityLine(line.slice(10));
    }
  }
  return {
    sha,
    node_id: '',
    commit: {
      message: parsed.message,
      author: author ?? { name: '', email: '', date: '' },
      committer: committer ?? { name: '', email: '', date: '' },
      tree: { sha: parsed.tree },
    },
    author: null,
    committer: null,
    parents: parsed.parents.map((p) => ({ sha: p })),
  };
}

function notFound(res: ServerResponse, what = 'Not Found'): void {
  sendError(res, 404, what);
}

// ------------------------------------------------------------------ handler

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  authorized: boolean,
): Promise<void> {
  if (!authorized) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://forge');
  const segments = decodeSegments(url.pathname);
  if (segments === null || segments[0] !== 'api' || segments[1] !== 'v3') {
    notFound(res);
    return;
  }
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const query = url.searchParams;

  const readJson = async (): Promise<Record<string, unknown> | null> => {
    const { text } = await readBody(req);
    const parsed = parseJsonBody(text);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return null;
    }
    if (!isRecord(parsed.value)) {
      sendError(res, 400, 'Problems parsing JSON');
      return null;
    }
    return parsed.value;
  };

  try {
    // Root and meta.
    if (rest.length === 0) {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    if (rest.length === 1 && rest[0] === 'meta') {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return;
    }
    if (rest.length === 1 && rest[0] === 'user') {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, store.userJson(store.viewer));
      return;
    }

    // POST /user/repos, GET /user/repos.
    if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        sendPage(req, res, query, store.listRepos(store.viewer.login), (repo) => store.repoJson(repo));
        return;
      }
      if (method === 'POST') {
        const body = await readJson();
        if (body === null) return;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          sendError(res, 422, 'name is required');
          return;
        }
        const created = store.createRepo(
          store.viewer.login,
          name,
          body.private === true,
          typeof body.description === 'string' ? body.description : '',
        );
        if (created === null) {
          sendError(res, 422, `Repository '${name}' already exists`);
          return;
        }
        sendJson(res, 201, store.repoJson(created));
        return;
      }
      return notFound(res);
    }

    // /repos/{owner}/{repo}[...]
    if (rest.length >= 3 && rest[0] === 'repos') {
      const owner = rest[1] as string;
      const repoName = rest[2] as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return notFound(res);
      const tail = rest.slice(3);
      await handleRepoRoute(req, res, store, repo, tail, method, query, readJson);
      return;
    }

    return notFound(res);
  } catch (err) {
    if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
  }
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  readJson: () => Promise<Record<string, unknown> | null>,
): Promise<void> {
  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, store.repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson();
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.updatedAt = store.isoNow();
      sendJson(res, 200, store.repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    return notFound(res);
  }

  const head = tail[0] as string;

  // Branches.
  if (head === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/heads/')).sort();
      sendJson(res, 200, names.map((n) => ({
        name: n.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(n) as string },
        protected: false,
      })));
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return notFound(res);
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    return notFound(res);
  }

  // Commits.
  if (head === 'commits' && tail.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveToCommit(repo, ref);
    if (tip === null) return notFound(res);
    const history = commitHistory(repo.objects, tip);
    sendJson(res, 200, history.map((sha) => commitView(repo, sha)));
    return;
  }

  // Git Data: refs.
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = await readJson();
      if (body === null) return;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        sendError(res, 422, 'Invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      const object = repo.objects.get(sha) as { type: string };
      sendJson(res, 201, { ref, object: { sha, type: object.type } });
      return;
    }
    if (method === 'GET') {
      const wanted = tail.length === 2 ? '' : `refs/${tail.slice(2).join('/')}`;
      if (wanted !== '' && repo.refs.has(wanted)) {
        const sha = repo.refs.get(wanted) as string;
        const object = repo.objects.get(sha) as { type: string };
        sendJson(res, 200, { ref: wanted, object: { sha, type: object.type } });
        return;
      }
      const prefix = wanted === '' ? 'refs/' : wanted;
      const matches = [...repo.refs.keys()].filter((n) => n.startsWith(prefix)).sort();
      if (matches.length === 0) return notFound(res);
      sendJson(res, 200, matches.map((n) => {
        const sha = repo.refs.get(n) as string;
        const object = repo.objects.get(sha) as { type: string };
        return { ref: n, object: { sha, type: object.type } };
      }));
      return;
    }
    return notFound(res);
  }

  // Contents.
  if (head === 'contents') {
    const path = tail.slice(1).join('/');
    await handleContents(req, res, store, repo, path, method, query, readJson);
    return;
  }

  // Labels.
  if (head === 'labels') {
    if (tail.length !== 1) return notFound(res);
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, labels.map((l) => store.labelJson(l)));
      return;
    }
    if (method === 'POST') {
      const body = await readJson();
      if (body === null) return;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      if (repo.labels.has(name.toLowerCase())) {
        sendError(res, 422, `Label '${name}' already exists`);
        return;
      }
      const label = { id: store.nextRecordId(), name, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(name.toLowerCase(), label);
      sendJson(res, 201, store.labelJson(label));
      return;
    }
    return notFound(res);
  }

  // Issues.
  if (head === 'issues') {
    await handleIssues(req, res, store, repo, tail.slice(1), method, query, readJson);
    return;
  }

  // Pull requests.
  if (head === 'pulls') {
    await handlePulls(req, res, store, repo, tail.slice(1), method, query, readJson);
    return;
  }

  return notFound(res);
}

// ---------------------------------------------------------------- contents

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repo,
  path: string,
  method: string,
  query: URLSearchParams,
  readJson: () => Promise<Record<string, unknown> | null>,
): Promise<void> {
  const segments = path === '' ? [] : path.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return notFound(res);
  const cleanPath = segments.join('/');

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = store.resolveToCommit(repo, ref);
    if (tip === null) return notFound(res);
    const commit = parseCommit((repo.objects.get(tip) as { data: Buffer }).data);
    if (segments.length === 0) {
      sendJson(res, 200, dirListing(store, repo, commit.tree, ''));
      return;
    }
    const found = lookupPath(repo.objects, commit.tree, segments);
    if (found === null) return notFound(res);
    if (found.mode === '40000') {
      sendJson(res, 200, dirListing(store, repo, found.oid, cleanPath));
      return;
    }
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return notFound(res);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      sha: found.oid,
      size: blob.data.length,
      name: segments[segments.length - 1] as string,
      path: cleanPath,
    });
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = await readJson();
    if (body === null) return;
    if (segments.length === 0) {
      sendError(res, 422, 'path is required');
      return;
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined) {
      // A write to a missing branch creates it from the default tip (the MCP
      // setup's fallback relies on this); on an unborn repository the write
      // itself is the first commit.
      tip = store.defaultTip(repo) ?? undefined;
      if (tip !== undefined) repo.refs.set(refName, tip);
    }
    const baseFlat = new Map<string, FlatEntry>();
    let parent: string | null = null;
    if (tip !== undefined) {
      parent = tip;
      const commit = parseCommit((repo.objects.get(tip) as { data: Buffer }).data);
      for (const [p, entry] of flattenTree(repo.objects, commit.tree)) baseFlat.set(p, entry);
    }
    const current = baseFlat.get(cleanPath);

    if (method === 'DELETE') {
      if (current === undefined) return notFound(res);
      baseFlat.delete(cleanPath);
      const tree = buildTreeFromFlat(repo.objects, baseFlat);
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${cleanPath}`;
      const commitSha = store.createCommit(repo, tree, parent === null ? [] : [parent], message);
      repo.refs.set(refName, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return;
    }

    // PUT: create or update.
    if (typeof body.sha === 'string' && body.sha !== '' && current !== undefined && body.sha !== current.oid) {
      sendError(res, 409, 'sha does not match the current blob');
      return;
    }
    const raw = typeof body.content === 'string' ? body.content.replace(/[\r\n\t ]+/g, '') : '';
    const bytes = Buffer.from(raw, 'base64');
    const blobOid = store.putObject(repo, 'blob', bytes);
    const isCreate = current === undefined;
    baseFlat.set(cleanPath, { oid: blobOid, mode: current?.mode ?? '100644' });
    const tree = buildTreeFromFlat(repo.objects, baseFlat);
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `${isCreate ? 'Create' : 'Update'} ${cleanPath}`;
    const commitSha = store.createCommit(repo, tree, parent === null ? [] : [parent], message);
    repo.refs.set(refName, commitSha);
    sendJson(res, isCreate ? 201 : 200, {
      content: {
        name: segments[segments.length - 1] as string,
        path: cleanPath,
        sha: blobOid,
        size: bytes.length,
        encoding: 'base64',
        type: 'file',
      },
      commit: { sha: commitSha, message },
    });
    return;
  }

  return notFound(res);
}

function dirListing(store: ForgeStore, repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return out;
}

// ------------------------------------------------------------------ issues

function resolveLabels(repo: Repo, raw: unknown): { names: string[]; bad: string | null } {
  if (raw === undefined) return { names: [], bad: null };
  if (!Array.isArray(raw)) return { names: [], bad: null };
  const names: string[] = [];
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : '';
    if (name === '') continue;
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return { names: [], bad: name };
    names.push(label.name);
  }
  return { names, bad: null };
}

async function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  readJson: () => Promise<Record<string, unknown> | null>,
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJson();
      if (body === null) return;
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') {
        sendError(res, 422, 'title is required');
        return;
      }
      const labels = resolveLabels(repo, body.labels);
      if (labels.bad !== null) {
        sendError(res, 422, `Label '${labels.bad}' does not exist`);
        return;
      }
      const now = store.isoNow();
      const issue: Issue = {
        id: store.nextRecordId(),
        number: repo.nextNumber,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labels.names,
        authorLogin: store.viewer.login,
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      sendJson(res, 201, store.issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      sendPage(req, res, query, issues, (issue) => store.issueJson(repo, issue));
      return;
    }
    return notFound(res);
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number)) return notFound(res);
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound(res);

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, store.issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readJson();
      if (body === null) return;
      let labels: { names: string[]; bad: string | null } | null = null;
      if (body.labels !== undefined) {
        labels = resolveLabels(repo, body.labels);
        if (labels.bad !== null) {
          sendError(res, 422, `Label '${labels.bad}' does not exist`);
          return;
        }
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (labels !== null) issue.labels = labels.names;
      issue.updatedAt = store.isoNow();
      sendJson(res, 200, store.issueJson(repo, issue));
      return;
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      sendPage(req, res, query, issue.comments, (c) => store.commentJson(repo, c));
      return;
    }
    if (method === 'POST') {
      const body = await readJson();
      if (body === null) return;
      const comment = {
        id: store.nextRecordId(),
        body: typeof body.body === 'string' ? body.body : '',
        authorLogin: store.viewer.login,
        createdAt: store.isoNow(),
        createdSeq: store.nextSeq(),
      };
      issue.comments.push(comment);
      sendJson(res, 201, store.commentJson(repo, comment));
      return;
    }
    return notFound(res);
  }

  return notFound(res);
}

// ------------------------------------------------------------------- pulls

function branchNameOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const name = value.includes(':') ? (value.split(':').pop() as string) : value;
    return name === '' ? null : name;
  }
  if (isRecord(value) && typeof value.ref === 'string') return value.ref;
  return null;
}

async function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  repo: Repo,
  tail: string[],
  method: string,
  query: URLSearchParams,
  readJson: () => Promise<Record<string, unknown> | null>,
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readJson();
      if (body === null) return;
      const head = branchNameOf(body.head);
      const base = branchNameOf(body.base);
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '' || head === null || base === null) {
        sendError(res, 422, 'head, base and title are required');
        return;
      }
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        sendError(res, 422, 'head or base branch does not exist');
        return;
      }
      const now = store.isoNow();
      const pull: PullRequest = {
        id: store.nextRecordId(),
        number: repo.nextNumber,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        headBranch: head,
        baseBranch: base,
        headShaAtCreate: headSha,
        baseShaAtCreate: baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        authorLogin: store.viewer.login,
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      sendJson(res, 201, store.pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      sendPage(req, res, query, pulls, (pull) => store.pullJson(repo, pull));
      return;
    }
    return notFound(res);
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isSafeInteger(number)) return notFound(res);
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound(res);

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, store.pullJson(repo, pull));
      return;
    }
    return notFound(res);
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(store, repo, pull);
    sendJson(res, 200, files);
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const body = await readJson();
    if (body === null) return;
    if (pull.merged || pull.state !== 'open') {
      sendError(res, 405, 'Pull request is already merged or closed');
      return;
    }
    const merged = mergePullRequest(store, repo, pull);
    if (merged.conflict) {
      sendError(res, 405, 'Pull request is not mergeable');
      return;
    }
    sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
    return;
  }

  return notFound(res);
}

/** A pull request's live tips (falling back to the creation-time shas). */
export function pullTips(repo: Repo, pull: PullRequest): { head: string | null; base: string | null } {
  return {
    head: repo.refs.get(`refs/heads/${pull.headBranch}`) ?? pull.headShaAtCreate ?? null,
    base: repo.refs.get(`refs/heads/${pull.baseBranch}`) ?? pull.baseShaAtCreate ?? null,
  };
}

function treeOf(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
  if (commitOid === null) return new Map();
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(repo.objects, parseCommit(object.data).tree);
}

/** The changed files of a pull request: merge-base tree -> head tree. */
export function pullFiles(store: ForgeStore, repo: Repo, pull: PullRequest): Array<Record<string, unknown>> {
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) return [];
  const baseCommit = mergeBase(repo.objects, base, head);
  const baseFlat = treeOf(repo, baseCommit);
  const headFlat = treeOf(repo, head);
  return diffFlat(repo.objects, baseFlat, headFlat).map((entry) => ({
    filename: entry.path,
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    changes: entry.additions + entry.deletions,
    sha: (headFlat.get(entry.path) ?? baseFlat.get(entry.path))?.oid ?? ZERO_OID,
  }));
}

/** Whether a pull request merges cleanly (the GraphQL `mergeable` field). */
export function pullMergeable(store: ForgeStore, repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) return 'UNKNOWN';
  const baseCommit = mergeBase(repo.objects, base, head);
  const outcome = mergeFlat(treeOf(repo, baseCommit), treeOf(repo, base), treeOf(repo, head));
  return outcome.tree === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. */
export function mergePullRequest(
  store: ForgeStore,
  repo: Repo,
  pull: PullRequest,
): { conflict: true } | { conflict: false; sha: string } {
  const { head, base } = pullTips(repo, pull);
  if (head === null || base === null) return { conflict: true };
  const baseCommit = mergeBase(repo.objects, base, head);
  const outcome = mergeFlat(treeOf(repo, baseCommit), treeOf(repo, base), treeOf(repo, head));
  if (outcome.tree === null) return { conflict: true };
  const tree = buildTreeFromFlat(repo.objects, outcome.tree);
  const sha = store.createCommit(repo, tree, [base], pull.title);
  repo.refs.set(`refs/heads/${pull.baseBranch}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = store.isoNow();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { conflict: false, sha };
}
