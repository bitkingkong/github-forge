// GraphQL v4 (docs.github.com/en/graphql): a small parser and executor for the fixed set of
// documents the suite sends. The surface is deliberately narrow — the checks use 18 documents
// (viewer, repository, node, __type, issue/pull-request connections and the five mutations) —
// so this is a focused executor, not a general GraphQL engine. It still follows the real
// rules that matter here:
//
//  - POST /api/graphql accepts one operation {query, variables} or a batch (an array of
//    operations) and answers an array in order. Unauthenticated requests are 401.
//  - An unknown repository answers data.repository = null with no errors; an unknown field
//    answers HTTP 200 with an errors array naming the field (Cannot query field ...).
//  - Global ids are opaque base64 (Repository:<id>, Issue:<repoId>:<number>,
//    PullRequest:<repoId>:<number>), never a bare database id or number, and stable.
//  - issues(first, states, orderBy, after) paginates with pageInfo {hasNextPage, endCursor};
//    the cursor is opaque base64 and the next page continues after it.
//  - Mutations cross-check against the REST view: a createIssue/createPullRequest/closeIssue/
//    mergePullRequest/addComment mutates the same store the REST layer reads.

import { parseCommit } from './git-objects.ts';
import { mergeableStatus } from './rest.ts';
import type { IssueState, PullState, RepoState, Store } from './store.ts';
import { VIEWER } from './viewer.ts';

// ---------------------------------------------------------------------------------------------
// parser (the GraphQL subset the suite sends)
// ---------------------------------------------------------------------------------------------

type Value = string | number | boolean | null | Value[] | { [key: string]: Value } | { __variable: string } | { __enum: string };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  selections: FieldNode[];
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  selections: FieldNode[];
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ':' || ch === '!' || ch === '$' || ch === '=') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const escaped = input[j + 1]!;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    // Any other character (e.g. @ for a directive) is skipped with its name.
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token!;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got ?? '(end)'}`);
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      // An optional operation name.
      if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') this.next();
    }
    // Optional variable definitions: ($name: Type = default, ...).
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const token = this.next();
        if (token === '(') depth += 1;
        else if (token === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, selections };
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const selections: FieldNode[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // A named fragment spread: not used by the suite; skip its name.
        this.next();
      }
      const selections = this.parseSelectionSet();
      return { name: '', alias: null, args: {}, selections, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, Value> = {};
    if (this.peek() === '(') args = this.parseArguments();
    let selections: FieldNode[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections, fragmentType: null };
  }

  private parseArguments(): Record<string, Value> {
    this.expect('(');
    const args: Record<string, Value> = {};
    while (this.peek() !== ')' && this.peek() !== undefined) {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { __variable: this.next() };
    if (token === '[') {
      const list: Value[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, Value> = {};
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^-?\d+\.\d+([eE][+-]?\d+)?$/.test(token)) return Number(token);
    return { __enum: token };
  }
}

// ---------------------------------------------------------------------------------------------
// values and global ids
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, repoId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${number}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number | null } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    if (!Number.isFinite(repoId)) return null;
    const number = parts.length >= 3 ? Number(parts[2]) : null;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    if (!raw.startsWith('cursor:')) return null;
    const number = Number(raw.slice('cursor:'.length));
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GraphQLContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

type ResolverValue = unknown;

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in value) return variables[(value as { __variable: string }).__variable];
    if ('__enum' in value) return (value as { __enum: string }).__enum;
    if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, Value>)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, Value>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

interface TypedObject {
  __typename: string;
  [key: string]: unknown;
}

function issueObject(repo: RepoState, issue: IssueState): TypedObject {
  return {
    __typename: 'Issue',
    id: globalId('Issue', repo.id, issue.number),
    databaseId: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: RepoState, pull: PullState, store: Store): TypedObject {
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', repo.id, pull.number),
    databaseId: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.state === 'open' ? mergeableStatus(store, repo, pull) : 'UNKNOWN',
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    _files: pullFiles(store, repo, pull),
  };
}

function userObject(login: string, id: number, name?: string): TypedObject {
  return { __typename: 'User', login, id, name: name ?? login, databaseId: id };
}

function repoObject(repo: RepoState, store: Store): TypedObject {
  const defaultTip = store.branchTip(repo, repo.defaultBranch);
  return {
    __typename: 'Repository',
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    owner: userObject(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0),
    defaultBranchRef: defaultTip ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    _repo: repo,
  };
}

/** The fields each introspected type exposes (the suite asserts these are present). */
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'databaseId'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'url', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description'],
  User: ['id', 'login', 'name', 'databaseId'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'MILESTONE', 'ORGANIZATION'];

function executeSelections(parent: TypedObject | null, selections: FieldNode[], ctx: GraphQLContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (parent !== null && parent.__typename === selection.fragmentType) {
        Object.assign(out, executeSelections(parent, selection.selections, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = executeField(parent, selection, ctx);
    out[key] = value;
  }
  return out;
}

function executeField(parent: TypedObject | null, field: FieldNode, ctx: GraphQLContext): unknown {
  const args = resolveArgs(field.args, ctx.variables);
  const store = ctx.store;

  // Top-level fields (parent is null: the Query or Mutation root).
  if (parent === null) {
    if (field.name === 'viewer') {
      return executeSelections(userObject(VIEWER.login, VIEWER.id, VIEWER.name), field.selections, ctx);
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return executeSelections(repoObject(repo, store), field.selections, ctx);
    }
    if (field.name === 'node') {
      const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
      if (!decoded) return null;
      const repo = store.getRepoById(decoded.repoId);
      if (!repo) return null;
      let object: TypedObject | null = null;
      if (decoded.kind === 'Repository') object = repoObject(repo, store);
      else if (decoded.kind === 'Issue' && decoded.number !== null) {
        const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
        if (issue) object = issueObject(repo, issue);
      } else if (decoded.kind === 'PullRequest' && decoded.number !== null) {
        const pull = repo.pulls.find((candidate) => candidate.number === decoded.number);
        if (pull) object = pullObject(repo, pull, store);
      }
      if (!object) return null;
      return executeSelections(object, field.selections, ctx);
    }
    if (field.name === '__type') {
      const typeName = String(args.name ?? '');
      const fields = TYPE_FIELDS[typeName];
      const enumValues = typeName === 'SearchType' ? SEARCH_TYPE_VALUES : null;
      const typeObject: TypedObject = {
        __typename: '__Type',
        name: typeName,
        fields: fields ? fields.map((name) => ({ __typename: '__Field', name })) : null,
        enumValues: enumValues ? enumValues.map((name) => ({ __typename: '__EnumValue', name })) : null,
      };
      return executeSelections(typeObject, field.selections, ctx);
    }
    if (field.name === 'createIssue') return mutateCreateIssue(args, field, ctx);
    if (field.name === 'closeIssue') return mutateCloseIssue(args, field, ctx);
    if (field.name === 'createPullRequest') return mutateCreatePullRequest(args, field, ctx);
    if (field.name === 'mergePullRequest') return mutateMergePullRequest(args, field, ctx);
    if (field.name === 'addComment') return mutateAddComment(args, field, ctx);
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
    return null;
  }

  // Fields on a Repository.
  if (parent.__typename === 'Repository') {
    const repo = parent._repo as RepoState;
    if (field.name === 'issue') {
      const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
      if (!issue) return null;
      return executeSelections(issueObject(repo, issue), field.selections, ctx);
    }
    if (field.name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      let issues = [...repo.issues];
      if (states) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      if (orderBy.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
      }
      if (after !== null) issues = issues.filter((issue) => issue.number > after);
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
      const connection: TypedObject = {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObject(repo, issue)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
        totalCount: issues.length,
      };
      return executeSelections(connection, field.selections, ctx);
    }
    if (field.name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 30;
      const page = repo.pulls.slice(0, first);
      const connection: TypedObject = {
        __typename: 'PullRequestConnection',
        nodes: page.map((pull) => pullObject(repo, pull, store)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: repo.pulls.length > first, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null },
        totalCount: repo.pulls.length,
      };
      return executeSelections(connection, field.selections, ctx);
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
      if (!pull) return null;
      return executeSelections(pullObject(repo, pull, store), field.selections, ctx);
    }
    if (field.name === 'owner' && field.selections.length > 0) {
      return executeSelections(userObject(repo.owner, repo.owner === VIEWER.login ? VIEWER.id : 0), field.selections, ctx);
    }
    if (field.name === 'defaultBranchRef' && field.selections.length > 0) {
      const ref = parent.defaultBranchRef as TypedObject | null;
      if (!ref) return null;
      return executeSelections(ref, field.selections, ctx);
    }
    if (field.name in parent) return parent[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
    return null;
  }

  // Fields on a PullRequest.
  if (parent.__typename === 'PullRequest') {
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 30;
      // The file list is the real tree diff between the base and head tips, attached by
      // pullObject when the pull request was built.
      const files = (parent as unknown as { _files?: TypedObject[] })._files ?? [];
      const connection: TypedObject = {
        __typename: 'PullRequestFileConnection',
        nodes: files.slice(0, first),
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, endCursor: null },
        totalCount: files.length,
      };
      return executeSelections(connection, field.selections, ctx);
    }
    if (field.name in parent) return parent[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
    return null;
  }

  // Fields on a connection or page info: resolve sub-selections, or return the scalar.
  if (parent.__typename === 'IssueConnection' || parent.__typename === 'PullRequestConnection' || parent.__typename === 'PullRequestFileConnection') {
    if (field.name === 'nodes') {
      const nodes = (parent.nodes as TypedObject[]).map((node) => executeSelections(node, field.selections, ctx));
      return nodes;
    }
    if (field.name === 'pageInfo') {
      return executeSelections(parent.pageInfo as TypedObject, field.selections, ctx);
    }
    if (field.name in parent) return parent[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
    return null;
  }
  if (parent.__typename === 'PageInfo' || parent.__typename === '__Type' || parent.__typename === '__Field' || parent.__typename === '__EnumValue' || parent.__typename === 'Ref') {
    if (field.name === 'fields' && Array.isArray(parent.fields)) {
      return (parent.fields as TypedObject[]).map((entry) => executeSelections(entry, field.selections, ctx));
    }
    if (field.name === 'enumValues' && Array.isArray(parent.enumValues)) {
      return (parent.enumValues as TypedObject[]).map((entry) => executeSelections(entry, field.selections, ctx));
    }
    if (field.name in parent) return parent[field.name];
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
    return null;
  }

  // Any other object type: return the stored scalar, or an error for an unknown field.
  if (field.name in parent) {
    const value = parent[field.name];
    if (field.selections.length > 0 && value !== null && typeof value === 'object') {
      return executeSelections(value as TypedObject, field.selections, ctx);
    }
    return value;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------------------------

function mutationResult(payload: Record<string, unknown>, selections: FieldNode[], ctx: GraphQLContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    const key = selection.alias ?? selection.name;
    const value = payload[selection.name];
    if (value !== null && typeof value === 'object' && selection.selections.length > 0) {
      out[key] = executeSelections(value as TypedObject, selection.selections, ctx);
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

function mutateCreateIssue(args: Record<string, unknown>, field: FieldNode, ctx: GraphQLContext): Record<string, unknown> {
  const input = (args.input ?? {}) as { repositoryId?: string; title?: string; body?: string };
  const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  const repo = decoded && decoded.kind === 'Repository' ? ctx.store.getRepoById(decoded.repoId) : undefined;
  if (!repo || typeof input.title !== 'string') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
    return mutationResult({ issue: null }, field.selections, ctx);
  }
  const issue: IssueState = {
    number: repo.nextNumber++,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    createdAt: ctx.store.nextSequence(),
    comments: [],
  };
  repo.issues.push(issue);
  return mutationResult({ issue: issueObject(repo, issue) }, field.selections, ctx);
}

function mutateCloseIssue(args: Record<string, unknown>, field: FieldNode, ctx: GraphQLContext): Record<string, unknown> {
  const input = (args.input ?? {}) as { issueId?: string };
  const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
  const repo = decoded && decoded.kind === 'Issue' ? ctx.store.getRepoById(decoded.repoId) : undefined;
  const issue = repo && decoded?.number !== null ? repo.issues.find((candidate) => candidate.number === decoded?.number) : undefined;
  if (!issue) {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return mutationResult({ issue: null }, field.selections, ctx);
  }
  issue.state = 'closed';
  return mutationResult({ issue: issueObject(repo!, issue) }, field.selections, ctx);
}

function mutateCreatePullRequest(args: Record<string, unknown>, field: FieldNode, ctx: GraphQLContext): Record<string, unknown> {
  const input = (args.input ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
  const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  const repo = decoded && decoded.kind === 'Repository' ? ctx.store.getRepoById(decoded.repoId) : undefined;
  if (!repo || typeof input.title !== 'string' || typeof input.headRefName !== 'string' || typeof input.baseRefName !== 'string') {
    ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
    return mutationResult({ pullRequest: null }, field.selections, ctx);
  }
  const headSha = ctx.store.branchTip(repo, input.headRefName);
  const baseSha = ctx.store.branchTip(repo, input.baseRefName);
  if (!headSha || !baseSha) {
    ctx.errors.push({ message: 'Head or base ref does not exist.' });
    return mutationResult({ pullRequest: null }, field.selections, ctx);
  }
  const existing = repo.pulls.find((pull) => pull.headRef === input.headRefName && pull.baseRef === input.baseRefName && pull.state === 'open');
  if (existing) {
    ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
    return mutationResult({ pullRequest: null }, field.selections, ctx);
  }
  const pull: PullState = {
    number: repo.nextNumber++,
    title: input.title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    headRef: input.headRefName,
    headSha,
    baseRef: input.baseRefName,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: ctx.store.nextSequence(),
  };
  repo.pulls.push(pull);
  return mutationResult({ pullRequest: pullObject(repo, pull, ctx.store) }, field.selections, ctx);
}

function mutateMergePullRequest(args: Record<string, unknown>, field: FieldNode, ctx: GraphQLContext): Record<string, unknown> {
  const input = (args.input ?? {}) as { pullRequestId?: string; mergeMethod?: string };
  const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
  const repo = decoded && decoded.kind === 'PullRequest' ? ctx.store.getRepoById(decoded.repoId) : undefined;
  const pull = repo && decoded?.number !== null ? repo.pulls.find((candidate) => candidate.number === decoded?.number) : undefined;
  if (!pull || !repo) {
    ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
    return mutationResult({ pullRequest: null }, field.selections, ctx);
  }
  if (pull.state !== 'open' || pull.merged) {
    ctx.errors.push({ message: 'Pull request is not open.' });
    return mutationResult({ pullRequest: pullObject(repo, pull, ctx.store) }, field.selections, ctx);
  }
  if (mergeableStatus(ctx.store, repo, pull) !== 'MERGEABLE') {
    ctx.errors.push({ message: 'Merge conflict.' });
    return mutationResult({ pullRequest: pullObject(repo, pull, ctx.store) }, field.selections, ctx);
  }
  const baseTip = ctx.store.branchTip(repo, pull.baseRef)!;
  const headTip = ctx.store.branchTip(repo, pull.headRef)!;
  const mergeBase = ctx.store.mergeBase(repo, baseTip, headTip)!;
  const baseCommit = ctx.store.getObject(repo, baseTip)!;
  const headCommit = ctx.store.getObject(repo, headTip)!;
  const mergeBaseCommit = ctx.store.getObject(repo, mergeBase)!;
  const { treeOid } = ctx.store.threeWayMerge(
    repo,
    parseCommit(baseCommit.data).tree,
    parseCommit(headCommit.data).tree,
    parseCommit(mergeBaseCommit.data).tree,
  );
  const mergeCommit = ctx.store.commitOnBranch(repo, pull.baseRef, treeOid, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseTip]);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = mergeCommit;
  pull.baseSha = mergeCommit;
  return mutationResult({ pullRequest: pullObject(repo, pull, ctx.store) }, field.selections, ctx);
}

function mutateAddComment(args: Record<string, unknown>, field: FieldNode, ctx: GraphQLContext): Record<string, unknown> {
  const input = (args.input ?? {}) as { subjectId?: string; body?: string };
  const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
  const repo = decoded ? ctx.store.getRepoById(decoded.repoId) : undefined;
  const issue = repo && decoded?.kind === 'Issue' && decoded.number !== null ? repo.issues.find((candidate) => candidate.number === decoded.number) : undefined;
  if (!issue || !repo || typeof input.body !== 'string') {
    ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
    return mutationResult({ commentEdge: null }, field.selections, ctx);
  }
  const comment = { id: repo.nextCommentId++, body: input.body };
  issue.comments.push(comment);
  const node: TypedObject = {
    __typename: 'IssueComment',
    id: globalId('IssueComment', repo.id, comment.id),
    databaseId: comment.id,
    body: comment.body,
  };
  const edge: TypedObject = { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(comment.id) };
  return mutationResult({ commentEdge: edge }, field.selections, ctx);
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/**
 * Execute one GraphQL operation. Returns {data, errors?}; errors is omitted when empty.
 * A malformed document is a 400 with an errors array (the suite never sends one).
 */
export function executeGraphQL(store: Store, operation: { query?: unknown; variables?: unknown }): GraphQLResponse {
  if (typeof operation.query !== 'string') {
    return { status: 400, body: { errors: [{ message: 'query must be a string' }] } };
  }
  const variables = (operation.variables ?? {}) as Record<string, unknown>;
  let parsed: Operation;
  try {
    parsed = new Parser(tokenize(operation.query)).parseOperation();
  } catch (err) {
    return { status: 400, body: { errors: [{ message: err instanceof Error ? err.message : 'query could not be parsed' }] } };
  }
  const ctx: GraphQLContext = { store, variables, errors: [] };
  const data = executeSelections(null, parsed.selections, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return { status: 200, body };
}

/**
 * Attach the file list to a pull-request object so the `files(first: N) { nodes { path } }`
 * selection resolves against the real tree diff. Called by the executor's caller when a
 * pull request is returned; the files are computed lazily here to keep pullObject cheap.
 */
export function pullFiles(store: Store, repo: RepoState, pull: PullState): TypedObject[] {
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return [];
  const baseCommit = store.getObject(repo, baseTip);
  const headCommit = store.getObject(repo, headTip);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return [];
  const files = store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
  return files.map((file) => ({ __typename: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }));
}
