// REST v3 (api.github.com): repositories, branches, commits, contents, refs, labels, issues,
// pull requests. The suite's client drives this surface with the same expectations as the
// real API, so the shapes and status codes follow GitHub:
//
//  - A repository under a login that does not own it is a 404, never a 403.
//  - POST /user/repos returns 422 when the name already exists.
//  - PUT /contents returns 201 on create and 200 on update, and 409 when the supplied sha
//    does not match the current blob sha. A write to a branch that does not exist creates
//    that branch from the default branch's tip first.
//  - POST /issues returns 422 when a label does not exist in the repository.
//  - PUT /pulls/{n}/merge returns 200 {merged:true, sha, message} on a clean squash, 404
//    for an unknown pull request, and 405 when the merge conflicts (or the request is
//    already merged). A merged pull request is closed, merged, has a non-empty merged_at,
//    and its merge commit is on the base branch with the merged content.
//  - Lists are paginated with per_page/page and a Link header carrying rel="next" as an
//    absolute same-origin URL. Issue and pull-request numbers share one counter per
//    repository, as GitHub does.

import { hashObject, isObjectId, parseCommit, parseTree } from './git-objects.ts';
import type { IssueState, PullState, RepoState, Store } from './store.ts';
import { VIEWER } from './viewer.ts';

export interface RestResponse {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): RestResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify(value), 'utf8'), headers };
}

export function jsonError(status: number, message: string): RestResponse {
  return jsonResponse(status, { message });
}

export function noContent(): RestResponse {
  return { status: 204, contentType: 'application/json', body: Buffer.alloc(0) };
}

// ---------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------

export function repoView(repo: RepoState): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date(1700000000000 + repo.createdAt * 1000).toISOString(),
    updated_at: new Date(1700000000000 + repo.createdAt * 1000).toISOString(),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    has_issues: true,
  };
}

export function issueView(repo: RepoState, issue: IssueState): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    created_at: new Date(1700000000000 + issue.createdAt * 1000).toISOString(),
    updated_at: new Date(1700000000000 + issue.createdAt * 1000).toISOString(),
    comments: issue.comments.length,
  };
}

export function pullView(repo: RepoState, pull: PullState): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pull.number,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: new Date(1700000000000 + pull.createdAt * 1000).toISOString(),
    updated_at: new Date(1700000000000 + pull.createdAt * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

export interface PageParams {
  perPage: number;
  page: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const perPage = Number(query.get('per_page') ?? '30');
  const page = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPage) && perPage > 0 ? Math.min(perPage, 100) : 30,
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
  };
}

/** Slice `items` to the page and build a Link header with rel="next" when more remain. */
export function paginate<T>(items: readonly T[], params: PageParams, baseUrl: string, query: URLSearchParams): { page: T[]; headers: Record<string, string> } {
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / params.perPage));
  if (params.page < totalPages) {
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('page', String(params.page + 1));
    nextQuery.set('per_page', String(params.perPage));
    const lastQuery = new URLSearchParams(query);
    lastQuery.set('page', String(totalPages));
    lastQuery.set('per_page', String(params.perPage));
    const firstQuery = new URLSearchParams(query);
    firstQuery.set('page', '1');
    firstQuery.set('per_page', String(params.perPage));
    headers.link =
      `<${baseUrl}?${nextQuery.toString()}>; rel="next", ` +
      `<${baseUrl}?${lastQuery.toString()}>; rel="last", ` +
      `<${baseUrl}?${firstQuery.toString()}>; rel="first"`;
  }
  return { page, headers };
}

// ---------------------------------------------------------------------------------------------
// mergeability (shared with GraphQL)
// ---------------------------------------------------------------------------------------------

/** 'MERGEABLE' when the three-way merge of head onto base is clean, else 'CONFLICTING'. */
export function mergeableStatus(store: Store, repo: RepoState, pull: PullState): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = store.branchTip(repo, pull.baseRef);
  const headTip = store.branchTip(repo, pull.headRef);
  if (!baseTip || !headTip) return 'CONFLICTING';
  const baseCommit = store.getObject(repo, baseTip);
  const headCommit = store.getObject(repo, headTip);
  if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return 'CONFLICTING';
  const mergeBase = store.mergeBase(repo, baseTip, headTip);
  if (!mergeBase) return 'CONFLICTING';
  const mergeBaseCommit = store.getObject(repo, mergeBase);
  if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return 'CONFLICTING';
  const { conflicts } = store.threeWayMerge(
    repo,
    parseCommit(baseCommit.data).tree,
    parseCommit(headCommit.data).tree,
    parseCommit(mergeBaseCommit.data).tree,
  );
  return conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  /** The absolute origin the client dialled (for Link headers), e.g. http://127.0.0.1:1234. */
  origin: string;
}

type Handler = (ctx: RestContext, params: Record<string, string>, query: URLSearchParams, body: unknown) => RestResponse;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  /** The static path prefix before the first :param or * — a cheap pre-filter for routing. */
  prefix: string;
  handler: Handler;
}

function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const segments = pattern.split('/');
  const prefixParts: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':') || segment === '*') break;
    prefixParts.push(segment);
  }
  const prefix = prefixParts.join('/');
  const regex = new RegExp(
    '^' +
      segments
        .map((segment) => {
          if (segment.startsWith(':')) {
            keys.push(segment.slice(1));
            return '([^/]+)';
          }
          if (segment === '*') {
            keys.push('path');
            return '(.+)';
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/') +
      '$',
  );
  return { method, pattern: regex, keys, prefix, handler };
}

function repoOr404(ctx: RestContext, owner: string, name: string): RepoState | RestResponse {
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return jsonError(404, 'Not Found');
  return repo;
}

function requireRepo(ctx: RestContext, owner: string, name: string): RepoState | null {
  const result = repoOr404(ctx, owner, name);
  return result instanceof Object && 'status' in result ? null : (result as RepoState);
}

const ROUTES: Route[] = [
  route('GET', '/api/v3', (_ctx) =>
    jsonResponse(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo' }),
  ),
  route('GET', '/api/v3/', (_ctx) =>
    jsonResponse(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo' }),
  ),
  route('GET', '/api/v3/meta', (_ctx) => jsonResponse(200, { installed_version: '1.0.0' })),
  route('GET', '/api/v3/user', (_ctx) =>
    jsonResponse(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: VIEWER.type }),
  ),
  route('GET', '/api/v3/user/repos', (ctx, _params, query) => {
    const params = pageParams(query);
    const repos = ctx.store.listRepos(VIEWER.login);
    const { page, headers } = paginate(repos, params, `${ctx.origin}/api/v3/user/repos`, query);
    return jsonResponse(200, page.map(repoView), headers);
  }),
  route('POST', '/api/v3/user/repos', (ctx, _params, _query, body) => {
    const data = (body ?? {}) as { name?: unknown; private?: unknown; description?: unknown; default_branch?: unknown };
    if (typeof data.name !== 'string' || data.name.length === 0) return jsonError(422, 'name is required');
    if (ctx.store.getRepo(VIEWER.login, data.name)) return jsonError(422, 'name already exists on this account');
    const repo = ctx.store.createRepo(VIEWER.login, data.name, {
      private: data.private === true,
      description: typeof data.description === 'string' ? data.description : '',
      defaultBranch: typeof data.default_branch === 'string' ? data.default_branch : 'main',
    });
    // Labels start empty: the caller creates them with POST /labels (which must answer 201).
    return jsonResponse(201, repoView(repo));
  }),
  route('GET', '/api/v3/repos/:owner/:repo', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    return jsonResponse(200, repoView(repo));
  }),
  route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { description?: unknown; default_branch?: unknown };
    if (typeof data.description === 'string') repo.description = data.description;
    if (typeof data.default_branch === 'string') repo.defaultBranch = data.default_branch;
    return jsonResponse(200, repoView(repo));
  }),
  route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    ctx.store.deleteRepo(params.owner!, params.repo!);
    return noContent();
  }),
  route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const branches = ctx.store
      .listRefs(repo)
      .filter((ref) => ref.name.startsWith('refs/heads/'))
      .map((ref) => ({ name: ref.name.slice('refs/heads/'.length), commit: { sha: ref.oid } }));
    return jsonResponse(200, branches);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/branches/:branch', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const tip = ctx.store.branchTip(repo, params.branch!);
    if (!tip) return jsonError(404, 'Branch not found');
    return jsonResponse(200, { name: params.branch, commit: { sha: tip } });
  }),
  route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, params, query) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = ctx.store.branchTip(repo, ref) ?? ctx.store.getRef(repo, ref);
    if (!tip) return jsonError(404, 'No commits');
    const commits = ctx.store.listCommits(repo, tip).map((commit) => ({ sha: commit.sha, commit: { message: commit.message } }));
    return jsonResponse(200, commits);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/contents', (ctx, params, query) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = ctx.store.branchTip(repo, ref) ?? ctx.store.getRef(repo, ref);
    if (!tip) return jsonError(404, 'No commits');
    const commit = ctx.store.getObject(repo, tip);
    if (!commit || commit.type !== 'commit') return jsonError(404, 'No commits');
    const treeOid = parseCommit(commit.data).tree;
    const entries = ctx.store.listDir(repo, treeOid, '') ?? [];
    return jsonResponse(200, entries.map((entry) => dirEntryView(repo, treeOid, '', entry)));
  }),
  route('GET', '/api/v3/repos/:owner/:repo/contents/*', (ctx, params, query) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const path = params.path ?? '';
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = ctx.store.branchTip(repo, ref) ?? ctx.store.getRef(repo, ref);
    if (!tip) return jsonError(404, 'No commits');
    const commit = ctx.store.getObject(repo, tip);
    if (!commit || commit.type !== 'commit') return jsonError(404, 'No commits');
    const treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      const entries = ctx.store.listDir(repo, treeOid, '') ?? [];
      return jsonResponse(200, entries.map((entry) => dirEntryView(repo, treeOid, '', entry)));
    }
    const blobOid = ctx.store.getBlobAtPath(repo, treeOid, path);
    if (blobOid) {
      const object = ctx.store.getObject(repo, blobOid)!;
      const name = path.split('/').pop()!;
      return jsonResponse(200, {
        type: 'file',
        encoding: 'base64',
        size: object.data.length,
        name,
        path,
        sha: blobOid,
        content: object.data.toString('base64'),
      });
    }
    const entries = ctx.store.listDir(repo, treeOid, path);
    if (!entries) return jsonError(404, 'Not Found');
    return jsonResponse(200, entries.map((entry) => dirEntryView(repo, treeOid, path, entry)));
  }),
  route('PUT', '/api/v3/repos/:owner/:repo/contents/*', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const path = params.path ?? '';
    const data = (body ?? {}) as { message?: unknown; content?: unknown; sha?: unknown; branch?: unknown };
    if (typeof data.message !== 'string' || typeof data.content !== 'string') return jsonError(422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(data.content, 'base64');
    } catch {
      return jsonError(422, 'content is not valid base64');
    }
    const branch = typeof data.branch === 'string' && data.branch.length > 0 ? data.branch : repo.defaultBranch;
    // A write to a branch that does not exist creates it from the default branch's tip.
    if (ctx.store.branchTip(repo, branch) === undefined) {
      const defaultTip = ctx.store.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== undefined) ctx.store.setRef(repo, `refs/heads/${branch}`, defaultTip);
    }
    const tip = ctx.store.branchTip(repo, branch);
    const parentTree = tip ? parseCommit(ctx.store.getObject(repo, tip)!.data).tree : null;
    const existingBlob = parentTree ? ctx.store.getBlobAtPath(repo, parentTree, path) : undefined;
    if (existingBlob !== undefined) {
      if (typeof data.sha !== 'string' || data.sha !== existingBlob) {
        return jsonError(409, 'sha does not match the current blob');
      }
    }
    const blobOid = ctx.store.putObject(repo, 'blob', content);
    const treeOid = ctx.store.setPathInTree(repo, parentTree, path, blobOid);
    const commitOid = ctx.store.commitOnBranch(repo, branch, treeOid, data.message);
    const isCreate = existingBlob === undefined;
    return jsonResponse(isCreate ? 201 : 200, {
      content: { name: path.split('/').pop()!, path, sha: blobOid, size: content.length, encoding: 'base64' },
      commit: { sha: commitOid },
    });
  }),
  route('DELETE', '/api/v3/repos/:owner/:repo/contents/*', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const path = params.path ?? '';
    const data = (body ?? {}) as { message?: unknown; sha?: unknown; branch?: unknown };
    if (typeof data.message !== 'string') return jsonError(422, 'message is required');
    const branch = typeof data.branch === 'string' && data.branch.length > 0 ? data.branch : repo.defaultBranch;
    const tip = ctx.store.branchTip(repo, branch);
    if (!tip) return jsonError(404, 'No commits');
    const parentTree = parseCommit(ctx.store.getObject(repo, tip)!.data).tree;
    const existingBlob = ctx.store.getBlobAtPath(repo, parentTree, path);
    if (existingBlob === undefined) return jsonError(404, 'Not Found');
    if (typeof data.sha === 'string' && data.sha !== existingBlob) return jsonError(409, 'sha does not match the current blob');
    const treeOid = ctx.store.setPathInTree(repo, parentTree, path, null);
    const commitOid = ctx.store.commitOnBranch(repo, branch, treeOid, data.message);
    return jsonResponse(200, { commit: { sha: commitOid } });
  }),
  route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { ref?: unknown; sha?: unknown };
    if (typeof data.ref !== 'string' || typeof data.sha !== 'string') return jsonError(422, 'ref and sha are required');
    if (!data.ref.startsWith('refs/')) return jsonError(422, 'ref must start with refs/');
    if (ctx.store.getRef(repo, data.ref) !== undefined) return jsonError(422, 'Reference already exists');
    const object = ctx.store.getObject(repo, data.sha);
    if (!object || object.type !== 'commit') return jsonError(422, 'sha is not a commit');
    ctx.store.setRef(repo, data.ref, data.sha);
    return jsonResponse(201, { ref: data.ref, object: { sha: data.sha, type: 'commit' } });
  }),
  route('GET', '/api/v3/repos/:owner/:repo/git/refs/heads/:branch', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const ref = `refs/heads/${params.branch!}`;
    const oid = ctx.store.getRef(repo, ref);
    if (!oid) return jsonError(404, 'Not Found');
    return jsonResponse(200, { ref, object: { sha: oid, type: 'commit' } });
  }),
  route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    return jsonResponse(200, [...repo.labels.values()]);
  }),
  route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { name?: unknown; color?: unknown };
    if (typeof data.name !== 'string' || data.name.length === 0) return jsonError(422, 'name is required');
    if (repo.labels.has(data.name)) return jsonError(422, 'Label already exists');
    const label = { name: data.name, color: typeof data.color === 'string' ? data.color : '000000' };
    repo.labels.set(label.name, label);
    return jsonResponse(201, label);
  }),
  route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { title?: unknown; body?: unknown; labels?: unknown };
    if (typeof data.title !== 'string' || data.title.length === 0) return jsonError(422, 'title is required');
    const labels: string[] = [];
    if (Array.isArray(data.labels)) {
      for (const label of data.labels) {
        const name = typeof label === 'string' ? label : (label as { name?: unknown })?.name;
        if (typeof name !== 'string') continue;
        if (!repo.labels.has(name)) return jsonError(422, `Label ${name} does not exist`);
        labels.push(name);
      }
    }
    const issue: IssueState = {
      number: repo.nextNumber++,
      title: data.title,
      body: typeof data.body === 'string' ? data.body : '',
      state: 'open',
      labels,
      createdAt: ctx.store.nextSequence(),
      comments: [],
    };
    repo.issues.push(issue);
    return jsonResponse(201, issueView(repo, issue));
  }),
  route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, params, query) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const state = query.get('state') ?? 'open';
    const sort = query.get('sort') ?? 'created';
    const direction = query.get('direction') ?? 'desc';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    if (sort === 'created') {
      issues.sort((a, b) => (direction === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    }
    const pageParamsValue = pageParams(query);
    const { page, headers } = paginate(issues, pageParamsValue, `${ctx.origin}/api/v3/repos/${params.owner}/${params.repo}/issues`, query);
    return jsonResponse(200, page.map((issue) => issueView(repo, issue)), headers);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
    if (!issue) return jsonError(404, 'Not Found');
    return jsonResponse(200, issueView(repo, issue));
  }),
  route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
    if (!issue) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { state?: unknown; title?: unknown; body?: unknown };
    if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
    if (typeof data.title === 'string') issue.title = data.title;
    if (typeof data.body === 'string') issue.body = data.body;
    return jsonResponse(200, issueView(repo, issue));
  }),
  route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
    if (!issue) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { body?: unknown };
    if (typeof data.body !== 'string' || data.body.length === 0) return jsonError(422, 'body is required');
    const comment = { id: repo.nextCommentId++, body: data.body };
    issue.comments.push(comment);
    return jsonResponse(201, comment);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const issue = repo.issues.find((candidate) => candidate.number === Number(params.number));
    if (!issue) return jsonError(404, 'Not Found');
    return jsonResponse(200, issue.comments);
  }),
  route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const data = (body ?? {}) as { title?: unknown; body?: unknown; head?: unknown; base?: unknown };
    if (typeof data.title !== 'string' || data.title.length === 0) return jsonError(422, 'title is required');
    if (typeof data.head !== 'string' || typeof data.base !== 'string') return jsonError(422, 'head and base are required');
    const headSha = ctx.store.branchTip(repo, data.head);
    const baseSha = ctx.store.branchTip(repo, data.base);
    if (!headSha || !baseSha) return jsonError(422, 'head or base branch does not exist');
    const existing = repo.pulls.find((pull) => pull.headRef === data.head && pull.baseRef === data.base && pull.state === 'open');
    if (existing) return jsonError(422, 'A pull request already exists for this head and base');
    const pull: PullState = {
      number: repo.nextNumber++,
      title: data.title,
      body: typeof data.body === 'string' ? data.body : '',
      state: 'open',
      headRef: data.head,
      headSha,
      baseRef: data.base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: ctx.store.nextSequence(),
    };
    repo.pulls.push(pull);
    return jsonResponse(201, pullView(repo, pull));
  }),
  route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, params, query) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const state = query.get('state') ?? 'open';
    let pulls = [...repo.pulls];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    pulls.sort((a, b) => b.createdAt - a.createdAt);
    const pageParamsValue = pageParams(query);
    const { page, headers } = paginate(pulls, pageParamsValue, `${ctx.origin}/api/v3/repos/${params.owner}/${params.repo}/pulls`, query);
    return jsonResponse(200, page.map((pull) => pullView(repo, pull)), headers);
  }),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
    if (!pull) return jsonError(404, 'Not Found');
    return jsonResponse(200, pullView(repo, pull));
  }),
  route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, params) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
    if (!pull) return jsonError(404, 'Not Found');
    const baseTip = ctx.store.branchTip(repo, pull.baseRef);
    const headTip = ctx.store.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return jsonError(404, 'No commits');
    const baseCommit = ctx.store.getObject(repo, baseTip);
    const headCommit = ctx.store.getObject(repo, headTip);
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return jsonError(404, 'No commits');
    const files = ctx.store.diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree);
    return jsonResponse(200, files);
  }),
  route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, params, _query, body) => {
    const repo = requireRepo(ctx, params.owner!, params.repo!);
    if (!repo) return jsonError(404, 'Not Found');
    const pull = repo.pulls.find((candidate) => candidate.number === Number(params.number));
    if (!pull) return jsonError(404, 'Not Found');
    if (pull.state !== 'open' || pull.merged) return jsonError(405, 'Pull request is not open');
    const data = (body ?? {}) as { merge_method?: unknown };
    const method = typeof data.merge_method === 'string' ? data.merge_method : 'squash';
    if (method !== 'squash' && method !== 'merge' && method !== 'rebase') return jsonError(422, 'merge_method must be squash, merge or rebase');
    const baseTip = ctx.store.branchTip(repo, pull.baseRef);
    const headTip = ctx.store.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return jsonError(405, 'Merge conflict');
    const baseCommit = ctx.store.getObject(repo, baseTip);
    const headCommit = ctx.store.getObject(repo, headTip);
    if (!baseCommit || !headCommit || baseCommit.type !== 'commit' || headCommit.type !== 'commit') return jsonError(405, 'Merge conflict');
    const mergeBase = ctx.store.mergeBase(repo, baseTip, headTip);
    if (!mergeBase) return jsonError(405, 'Merge conflict');
    const mergeBaseCommit = ctx.store.getObject(repo, mergeBase);
    if (!mergeBaseCommit || mergeBaseCommit.type !== 'commit') return jsonError(405, 'Merge conflict');
    const { treeOid, conflicts } = ctx.store.threeWayMerge(
      repo,
      parseCommit(baseCommit.data).tree,
      parseCommit(headCommit.data).tree,
      parseCommit(mergeBaseCommit.data).tree,
    );
    if (conflicts.length > 0) return jsonError(405, 'Merge conflict');
    const message = `Merge pull request #${pull.number} from ${pull.headRef}`;
    const mergeCommit = ctx.store.commitOnBranch(repo, pull.baseRef, treeOid, message, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeCommit;
    pull.baseSha = mergeCommit;
    return jsonResponse(200, { merged: true, sha: mergeCommit, message });
  }),
];

/** A directory entry for a contents listing: file entries carry their blob id, dirs their tree id. */
function dirEntryView(repo: RepoState, _treeOid: string, path: string, entry: { mode: string; name: string; oid: string }): Record<string, unknown> {
  const fullPath = path ? `${path}/${entry.name}` : entry.name;
  if (entry.mode === '40000') {
    return { type: 'dir', name: entry.name, path: fullPath, sha: entry.oid };
  }
  const object = repo.objects.get(entry.oid);
  return { type: 'file', name: entry.name, path: fullPath, sha: entry.oid, size: object?.data.length ?? 0 };
}

/** Route a REST request. Returns null when no route matches (the caller answers 404). */
export function handleRest(ctx: RestContext, method: string, pathname: string, query: URLSearchParams, body: unknown): RestResponse | null {
  for (const routeDef of ROUTES) {
    if (routeDef.method !== method) continue;
    if (!pathname.startsWith(routeDef.prefix)) continue;
    const match = routeDef.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    routeDef.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]!);
    });
    return routeDef.handler(ctx, params, query, body);
  }
  return null;
}

export { hashObject, isObjectId, parseTree };
