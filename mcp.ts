/**
 * mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
 * Streamable HTTP, answered as plain JSON. Speaks the modern 2026-07-28
 * revision (server/discover, no handshake, no session) and the legacy
 * initialize handshake, and offers the six github-mcp-server tools over the
 * same store as REST and GraphQL.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord, readBody, sendError, sendJson } from './httputil.ts';
import type { ForgeStore, Issue, PullRequest } from './store.ts';
import { mergePullRequest } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

/** The six tools, in a fixed order, byte-identical on every tools/list call. */
const TOOLS: readonly ToolDef[] = Object.freeze([
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
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    required: ['owner', 'repo', 'pull_number'],
  },
]);

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

type RpcId = string | number | null;

function result(id: RpcId, value: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result: value };
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

function intArg(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    return rpcError(null, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
  }
  for (const required of tool.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return rpcError(null, INVALID_PARAMS, `Missing required argument: ${required}`);
    }
  }
  const owner = strArg(args, 'owner');
  const repoName = strArg(args, 'repo');

  if (name === 'create_repo') {
    const repoNameArg = strArg(args, 'name');
    if (repoNameArg === null) return rpcError(null, INVALID_PARAMS, 'Missing required argument: name');
    const created = store.createRepo(
      store.viewer.login,
      repoNameArg,
      args.private === true,
      typeof args.description === 'string' ? args.description : '',
    );
    if (created === null) return toolFailure(`Repository '${repoNameArg}' already exists`);
    return toolResult(store.repoJson(created));
  }

  if (owner === null || repoName === null) {
    return rpcError(null, INVALID_PARAMS, 'Missing required argument: owner or repo');
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return toolFailure(`Repository '${owner}/${repoName}' not found`);

  if (name === 'get_repo') {
    return toolResult(store.repoJson(repo));
  }
  if (name === 'create_issue') {
    const title = strArg(args, 'title');
    if (title === null) return rpcError(null, INVALID_PARAMS, 'Missing required argument: title');
    const now = store.isoNow();
    const issue: Issue = {
      id: store.nextRecordId(),
      number: repo.nextNumber,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      authorLogin: store.viewer.login,
      createdSeq: store.nextSeq(),
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return toolResult(store.issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.createdSeq - a.createdSeq);
    return toolResult(issues.map((issue) => store.issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const title = strArg(args, 'title');
    const head = strArg(args, 'head');
    const base = strArg(args, 'base');
    if (title === null || head === null || base === null) {
      return rpcError(null, INVALID_PARAMS, 'Missing required argument: title, head, or base');
    }
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return toolFailure('head or base branch does not exist');
    }
    const now = store.isoNow();
    const pull: PullRequest = {
      id: store.nextRecordId(),
      number: repo.nextNumber,
      title,
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolResult(store.pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = intArg(args, 'pull_number');
    if (number === null) return rpcError(null, INVALID_PARAMS, 'Missing required argument: pull_number');
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolFailure(`Pull request #${number} not found`);
    if (pull.merged || pull.state !== 'open') return toolFailure(`Pull request #${number} is already merged or closed`);
    const merged = mergePullRequest(store, repo, pull);
    if (merged.conflict) return toolFailure(`Pull request #${number} is not mergeable`);
    return toolResult({ sha: merged.sha, merged: true, message: 'Pull request successfully merged', number });
  }
  return rpcError(null, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
}

/**
 * Dispatch one JSON-RPC request object. Returns the response object, or null
 * for a notification (no reply). `id` is echoed exactly as received.
 */
function dispatch(store: ForgeStore, body: Record<string, unknown>): Record<string, unknown> | null {
  const hasId = 'id' in body;
  const id = (body.id as RpcId | undefined) ?? null;
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    if (!hasId) return null;
    return rpcError(id, INVALID_REQUEST, 'Invalid Request: method is required');
  }
  if (!hasId) {
    // A notification: no reply, whatever the method.
    return null;
  }
  const params = isRecord(body.params) ? body.params : {};

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return result(id, {
      supportedVersions: [REVISION],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : REVISION;
    return result(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result(id, {});
  }
  if (method === 'tools/list') {
    return result(id, { tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const outcome = callTool(store, toolName, args);
    if (outcome.error !== undefined) {
      const error = outcome.error as { code: number; message: string };
      return rpcError(id, error.code, error.message);
    }
    return result(id, outcome);
  }
  if (method.startsWith('notifications/')) {
    return result(id, {});
  }
  return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: ForgeStore, authorized: boolean): Promise<void> {
  if (!authorized) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return;
  }
  const { text } = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    return;
  }
  try {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        sendJson(res, 200, rpcError(null, INVALID_REQUEST, 'Invalid Request: empty batch'));
        return;
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const entry of parsed) {
        if (!isRecord(entry)) {
          responses.push(rpcError(null, INVALID_REQUEST, 'Invalid Request'));
          continue;
        }
        const response = dispatch(store, entry);
        if (response !== null) responses.push(response);
      }
      if (responses.length === 0) {
        res.writeHead(202, { 'content-length': '0' });
        res.end();
        return;
      }
      sendJson(res, 200, responses);
      return;
    }
    if (!isRecord(parsed)) {
      sendJson(res, 200, rpcError(null, INVALID_REQUEST, 'Invalid Request'));
      return;
    }
    const response = dispatch(store, parsed);
    if (response === null) {
      res.writeHead(202, { 'content-length': '0' });
      res.end();
      return;
    }
    sendJson(res, 200, response);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' } });
    }
  }
}
