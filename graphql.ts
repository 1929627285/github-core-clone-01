/**
 * graphql.ts — a small, dependency-free GraphQL executor for the v4 surface:
 * a lexer, a recursive-descent parser (operations, fragments, variables,
 * arguments, inline input objects) and resolvers over the shared store. It
 * speaks exactly the schema the suite drives; unknown fields answer a
 * GraphQL error naming the field, never a crash.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isRecord,
  parseJsonBody,
  readBody,
  sendError,
  sendJson,
} from './httputil.ts';
import {
  commentGlobalId,
  issueGlobalId,
  parseGlobalId,
  pullGlobalId,
  repoGlobalId,
  userGlobalId,
  type ForgeStore,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { mergePullRequest, pullFiles, pullMergeable } from './rest.ts';

// ------------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ':', '!', '$', '=', '@', '&', '|']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`GraphQL syntax error at ${i}: ${msg}`);
  };
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
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) fail('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= source.length) fail('unterminated string');
        const c = source[j] as string;
        if (c === '"') break;
        if (c === '\n' || c === '\r') fail('newline in string');
        if (c === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (map[esc] !== undefined) {
            out += map[esc];
            j += 2;
          } else {
            fail(`bad escape \\${esc}`);
          }
        } else {
          out += c;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      if (match === null) fail('bad number');
      const text = match[0];
      tokens.push({ kind: match[1] !== undefined || match[2] !== undefined ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private fail(msg: string): never {
    throw new Error(`GraphQL syntax error: ${msg}`);
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) this.fail(`expected '${value}', got '${token.value}'`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') this.fail(`expected a name, got '${token.value}'`);
    if (value !== undefined && token.value !== value) this.fail(`expected '${value}', got '${token.value}'`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    return this.fail(`unexpected token '${token.value}'`);
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; defaultValue: ValueNode | null }> = [];
    if (this.peek().kind !== 'punct' || this.peek().value !== '(') return defs;
    this.next();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') this.fail('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$' && !isConst) {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number.parseFloat(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    return this.fail(`unexpected value token '${token.value}'`);
  }
}

// ---------------------------------------------------------------- executor

type Obj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; userId: number; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] }
  | { __typename: 'ChangedFileConnection'; files: Array<{ path: string }> }
  | { __typename: 'ChangedFile'; path: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Comment'; id: string; body: string }
  | { __typename: 'CommentEdge'; node: Obj }
  | { __typename: 'CreateIssuePayload'; issue: Obj | null }
  | { __typename: 'CloseIssuePayload'; issue: Obj | null }
  | { __typename: 'CreatePullRequestPayload'; pull: Obj | null }
  | { __typename: 'MergePullRequestPayload'; pull: Obj | null }
  | { __typename: 'AddCommentPayload'; edge: Obj | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

interface Ctx {
  store: ForgeStore;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function valueOf(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable': {
      const found = ctx.variables[node.name];
      return found === undefined ? null : found;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx);
  return out;
}

function strArg(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' ? v : null;
}

function intArg(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

// ------------------------------------------------------------ introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'],
};

// ------------------------------------------------------------ connections

function issueCursor(repo: Repo, issue: Issue): string {
  return Buffer.from(`issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:\d+:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const statesRaw = args.states;
  const wanted = new Set<string>();
  if (Array.isArray(statesRaw)) {
    for (const s of statesRaw) if (typeof s === 'string') wanted.add(s);
  } else {
    wanted.add('OPEN');
  }
  let issues = [...repo.issues.values()].filter((i) => wanted.has(i.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  issues.sort((a, b) => {
    const bySeq = direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq;
    return bySeq !== 0 ? bySeq : direction === 'ASC' ? a.number - b.number : b.number - a.number;
  });
  const after = strArg(args, 'after');
  if (after !== null) {
    const n = cursorNumber(after);
    if (n !== null) {
      const at = issues.findIndex((i) => i.number === n);
      if (at !== -1) issues = issues.slice(at + 1);
    }
  }
  const first = intArg(args, 'first');
  const total = issues.length;
  const page = first === null ? issues : issues.slice(0, Math.max(0, first));
  const hasNextPage = first !== null && total > page.length;
  const last = page[page.length - 1];
  const firstItem = page[0];
  return {
    __typename: 'IssueConnection',
    repo,
    issues: page,
    hasNextPage,
    endCursor: last !== undefined ? issueCursor(repo, last) : null,
    startCursor: firstItem !== undefined ? issueCursor(repo, firstItem) : null,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const statesRaw = args.states;
  const wanted = new Set<string>();
  if (Array.isArray(statesRaw)) {
    for (const s of statesRaw) if (typeof s === 'string') wanted.add(s);
  } else {
    wanted.add('OPEN');
  }
  const stateOf = (p: PullRequest): string => (p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED');
  let pulls = [...repo.pulls.values()].filter((p) => wanted.has(stateOf(p)));
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const first = intArg(args, 'first');
  if (first !== null) pulls = pulls.slice(0, Math.max(0, first));
  return { __typename: 'PullRequestConnection', repo, pulls };
}

// ------------------------------------------------------------ field resolving

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: PullRequest): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

function userObj(store: ForgeStore): Obj {
  return { __typename: 'User', userId: store.viewer.id, login: store.viewer.login };
}

function resolveRepoByGlobalId(store: ForgeStore, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'repo') return null;
  const repoId = Number.parseInt(parsed.key, 10);
  if (!Number.isSafeInteger(repoId)) return null;
  return store.getRepoById(repoId) ?? null;
}

function resolveIssueByGlobalId(store: ForgeStore, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'issue') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  const repo = store.getRepoById(repoId);
  if (repo === undefined) return null;
  const issue = repo.issues.get(number);
  return issue === undefined ? null : { repo, issue };
}

function resolvePullByGlobalId(store: ForgeStore, id: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'pull') return null;
  const [repoIdText, numberText] = parsed.key.split(':');
  const repoId = Number.parseInt(repoIdText ?? '', 10);
  const number = Number.parseInt(numberText ?? '', 10);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  const repo = store.getRepoById(repoId);
  if (repo === undefined) return null;
  const pull = repo.pulls.get(number);
  return pull === undefined ? null : { repo, pull };
}

function resolveField(obj: Obj, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      if (field.name === 'viewer') return userObj(store);
      if (field.name === 'repository') {
        const owner = strArg(args, 'owner');
        const name = strArg(args, 'name');
        if (owner === null || name === null) return null;
        const repo = store.getRepo(owner, name);
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as Obj);
      }
      if (field.name === 'node') {
        const id = strArg(args, 'id');
        if (id === null) return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'repo') {
          const repo = resolveRepoByGlobalId(store, id);
          return repo === null ? null : ({ __typename: 'Repository', repo } as Obj);
        }
        if (parsed.kind === 'issue') {
          const found = resolveIssueByGlobalId(store, id);
          return found === null ? null : issueObj(found.repo, found.issue);
        }
        if (parsed.kind === 'pull') {
          const found = resolvePullByGlobalId(store, id);
          return found === null ? null : pullObj(found.repo, found.pull);
        }
        if (parsed.kind === 'user') return userObj(store);
        return null;
      }
      if (field.name === '__type') {
        const name = strArg(args, 'name');
        if (name === null) return null;
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', name } as Obj;
      }
      break;
    }
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      if (field.name === 'createIssue') {
        const repo = typeof input.repositoryId === 'string' ? resolveRepoByGlobalId(store, input.repositoryId) : null;
        if (repo === null) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
          return { __typename: 'CreateIssuePayload', issue: null } as Obj;
        }
        const now = store.isoNow();
        const issue: Issue = {
          id: store.nextRecordId(),
          number: repo.nextNumber,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
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
        return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) } as Obj;
      }
      if (field.name === 'closeIssue') {
        const found = typeof input.issueId === 'string' ? resolveIssueByGlobalId(store, input.issueId) : null;
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          return { __typename: 'CloseIssuePayload', issue: null } as Obj;
        }
        found.issue.state = 'closed';
        found.issue.updatedAt = store.isoNow();
        return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue) } as Obj;
      }
      if (field.name === 'createPullRequest') {
        const repo = typeof input.repositoryId === 'string' ? resolveRepoByGlobalId(store, input.repositoryId) : null;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const headSha = repo === null ? undefined : repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo === null ? undefined : repo.refs.get(`refs/heads/${base}`);
        if (repo === null || headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'Could not resolve the repository or branches for the pull request.' });
          return { __typename: 'CreatePullRequestPayload', pull: null } as Obj;
        }
        const now = store.isoNow();
        const pull: PullRequest = {
          id: store.nextRecordId(),
          number: repo.nextNumber,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
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
        return { __typename: 'CreatePullRequestPayload', pull: pullObj(repo, pull) } as Obj;
      }
      if (field.name === 'mergePullRequest') {
        const found = typeof input.pullRequestId === 'string' ? resolvePullByGlobalId(store, input.pullRequestId) : null;
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
          return { __typename: 'MergePullRequestPayload', pull: null } as Obj;
        }
        if (found.pull.merged || found.pull.state !== 'open') {
          ctx.errors.push({ message: 'Pull request is already merged or closed.' });
          return { __typename: 'MergePullRequestPayload', pull: pullObj(found.repo, found.pull) } as Obj;
        }
        const merged = mergePullRequest(store, found.repo, found.pull);
        if (merged.conflict) {
          ctx.errors.push({ message: 'Pull request is not mergeable.' });
          return { __typename: 'MergePullRequestPayload', pull: pullObj(found.repo, found.pull) } as Obj;
        }
        return { __typename: 'MergePullRequestPayload', pull: pullObj(found.repo, found.pull) } as Obj;
      }
      if (field.name === 'addComment') {
        const found = typeof input.subjectId === 'string' ? resolveIssueByGlobalId(store, input.subjectId) : null;
        if (found === null) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
          return { __typename: 'AddCommentPayload', edge: null } as Obj;
        }
        const comment = {
          id: store.nextRecordId(),
          body: typeof input.body === 'string' ? input.body : '',
          authorLogin: store.viewer.login,
          createdAt: store.isoNow(),
          createdSeq: store.nextSeq(),
        };
        found.issue.comments.push(comment);
        const node: Obj = { __typename: 'Comment', id: commentGlobalId(comment), body: comment.body };
        return { __typename: 'AddCommentPayload', edge: { __typename: 'CommentEdge', node } as Obj } as Obj;
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return obj.login;
      if (field.name === 'id') return userGlobalId(store.viewer);
      break;
    }
    case 'Repository': {
      const repo = obj.repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return userObj(store);
      if (field.name === 'defaultBranchRef') {
        const tip = store.defaultTip(repo);
        return tip === null ? null : ({ __typename: 'Ref', name: repo.defaultBranch } as Obj);
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = intArg(args, 'number');
        if (number === null) return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueObj(repo, issue);
      }
      if (field.name === 'issues') return issueConnection(repo, args);
      if (field.name === 'pullRequest') {
        const number = intArg(args, 'number');
        if (number === null) return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullObj(repo, pull);
      }
      if (field.name === 'pullRequests') return pullConnection(repo, args);
      break;
    }
    case 'Issue': {
      const issue = obj.issue;
      if (field.name === 'id') return issueGlobalId(obj.repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      break;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return obj.issues.map((issue) => issueObj(obj.repo, issue));
      if (field.name === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: obj.hasNextPage, endCursor: obj.endCursor, startCursor: obj.startCursor } as Obj;
      }
      break;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return obj.hasNextPage;
      if (field.name === 'endCursor') return obj.endCursor;
      if (field.name === 'startCursor') return obj.startCursor;
      break;
    }
    case 'PullRequest': {
      const pull = obj.pull;
      if (field.name === 'id') return pullGlobalId(obj.repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headBranch;
      if (field.name === 'baseRefName') return pull.baseBranch;
      if (field.name === 'mergeable') return pullMergeable(store, obj.repo, pull);
      if (field.name === 'files') {
        const first = intArg(args, 'first');
        let files = pullFiles(store, obj.repo, pull).map((f) => ({ path: String(f.filename) }));
        if (first !== null) files = files.slice(0, Math.max(0, first));
        return { __typename: 'ChangedFileConnection', files } as Obj;
      }
      break;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return obj.pulls.map((pull) => pullObj(obj.repo, pull));
      break;
    }
    case 'ChangedFileConnection': {
      if (field.name === 'nodes') return obj.files.map((f) => ({ __typename: 'ChangedFile', path: f.path }) as Obj);
      break;
    }
    case 'ChangedFile': {
      if (field.name === 'path') return obj.path;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return obj.name;
      break;
    }
    case 'Comment': {
      if (field.name === 'id') return obj.id;
      if (field.name === 'body') return obj.body;
      break;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return obj.node;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return obj.issue;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return obj.pull;
      break;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return obj.edge;
      break;
    }
    case '__Type': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[obj.name] ?? [];
        return names.map((name) => ({ __typename: '__Field', name }) as Obj);
      }
      if (field.name === 'enumValues') {
        const names = ENUM_VALUES[obj.name] ?? [];
        return names.map((name) => ({ __typename: '__EnumValue', name }) as Obj);
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return obj.name;
      if (field.name === 'description') return null;
      break;
    }
  }
  return undefined;
}

function isObj(value: unknown): value is Obj {
  return isRecord(value) && typeof value.__typename === 'string';
}

function executeSelections(obj: Obj, selections: readonly SelectionNode[], ctx: Ctx, fragmentStack: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      if (fragmentStack.has(selection.name)) continue;
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== obj.__typename) continue;
      const nested = executeSelections(obj, fragment.selections, ctx, new Set([...fragmentStack, selection.name]));
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__typename) continue;
      const nested = executeSelections(obj, selection.selections, ctx, fragmentStack);
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = obj.__typename;
      continue;
    }
    const args = argsOf(selection, ctx);
    const value = resolveField(obj, selection, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__typename}".` });
      out[key] = null;
      continue;
    }
    if (value === null || typeof value !== 'object') {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => {
        if (entry === null) return null;
        if (isObj(entry) && selection.selections !== null) return executeSelections(entry, selection.selections, ctx, fragmentStack);
        return entry;
      });
      continue;
    }
    if (isObj(value)) {
      out[key] = selection.selections === null ? null : executeSelections(value, selection.selections, ctx, fragmentStack);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOperation(operation: OperationNode, fragments: Map<string, FragmentNode>, store: ForgeStore, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, fragments, errors: [] };
  // Variable defaults for variables the request did not supply.
  for (const def of operation.variables) {
    if (ctx.variables[def.name] === undefined && def.defaultValue !== null) {
      ctx.variables[def.name] = valueOf(def.defaultValue, ctx);
    }
  }
  const root: Obj = operation.operation === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = executeSelections(root, operation.selections, ctx, new Set());
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function executeGraphQLRequest(
  store: ForgeStore,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): { data: unknown; errors?: Array<{ message: string }> } {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = operations.find((op) => op.name === operationName);
  } else if (operations.length === 1) {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Must provide an operation name when the document holds more than one operation.' }] };
  }
  return executeOperation(operation, fragments, store, variables);
}

// ------------------------------------------------------------------ HTTP

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: ForgeStore, authorized: boolean): Promise<void> {
  if (!authorized) {
    sendError(res, 401, 'Bad credentials');
    return;
  }
  if (req.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return;
  }
  const { text } = await readBody(req);
  const parsed = parseJsonBody(text);
  if (!parsed.ok) {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (!isRecord(entry)) return { data: null, errors: [{ message: 'Invalid request body.' }] };
    const query = entry.query;
    if (typeof query !== 'string' || query === '') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    return executeGraphQLRequest(store, query, variables, operationName);
  };
  try {
    if (Array.isArray(parsed.value)) {
      sendJson(res, 200, parsed.value.map(runOne));
    } else {
      sendJson(res, 200, runOne(parsed.value));
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 200, { data: null, errors: [{ message: err instanceof Error ? err.message : 'internal error' }] });
  }
}
