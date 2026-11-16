// MCP (Model Context Protocol, Streamable HTTP, JSON-RPC 2.0): the suite's client speaks the
// modern 2026-07-28 discovery first (server/discover) and falls back to the legacy initialize
// handshake. The surface is a fixed tool set — at least the six the checks name — and every
// tool result carries both structuredContent and a text JSON rendering, so a client that only
// reads text still sees the number, the title and the repository name.
//
//  - server/discover answers supportedVersions (YYYY-MM-DD), capabilities and serverInfo.
//  - initialize echoes a known protocolVersion (or 2025-11-25) with capabilities and
//    serverInfo; notifications/initialized is a notification and answers 202 with no body.
//  - tools/list returns the same static array on every call (the checks compare bytes).
//  - An unknown tool answers JSON-RPC -32602 (or -32601), never HTTP 500; a non-JSON body
//    answers HTTP 400 with -32700; missing required arguments answer isError:true.
//  - A tool result is {content:[{type:'text', text}], structuredContent, isError}.
//  - Tools mutate the same store the REST and GraphQL layers read (rest-parity).

import { parseCommit } from './git-objects.ts';
import { issueView, mergeableStatus, pullView, repoView } from './rest.ts';
import type { Store } from './store.ts';
import { VIEWER } from './viewer.ts';

export interface McpResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Pull request state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const KNOWN_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function jsonRpc(id: unknown, result: unknown): McpResponse {
  return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }), 'utf8') };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), 'utf8') };
}

function toolResult(id: unknown, structuredContent: unknown, isError = false): McpResponse {
  const text = JSON.stringify(structuredContent);
  return jsonRpc(id, { content: [{ type: 'text', text }], structuredContent, isError });
}

function toolError(id: unknown, message: string): McpResponse {
  return toolResult(id, { error: message }, true);
}

function missingArg(id: unknown, tool: string, arg: string): McpResponse {
  return toolError(id, `tool ${tool} requires argument ${arg}`);
}

/** POST /mcp — one JSON-RPC 2.0 message. The raw body is passed so a parse error can answer -32700. */
export function handleMcp(store: Store, rawBody: Buffer): McpResponse {
  let request: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  try {
    request = JSON.parse(rawBody.toString('utf8')) as typeof request;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return jsonRpc(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return jsonRpc(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    return { status: 202, contentType: 'application/json', body: Buffer.alloc(0) };
  }
  if (method === 'tools/list') {
    return jsonRpc(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    return callTool(store, id, name, args);
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, id: unknown, name: string, args: Record<string, unknown>): McpResponse {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return missingArg(id, name, required);
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  if (name === 'create_repo') {
    const repoNameArg = String(args.name);
    if (store.getRepo(VIEWER.login, repoNameArg)) return toolError(id, `Repository ${VIEWER.login}/${repoNameArg} already exists`);
    const repo = store.createRepo(VIEWER.login, repoNameArg, {
      private: args.private === true,
      description: typeof args.description === 'string' ? args.description : '',
    });
    return toolResult(id, repoView(repo));
  }

  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolError(id, `Repository ${owner}/${repoName} does not exist`);

  if (name === 'get_repo') return toolResult(id, repoView(repo));

  if (name === 'create_issue') {
    const issue = {
      number: repo.nextNumber++,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [] as string[],
      createdAt: store.nextSequence(),
      comments: [],
    };
    repo.issues.push(issue);
    return toolResult(id, issueView(repo, issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
    const views = issues.map((issue) => issueView(repo, issue));
    return toolResult(id, { issues: views });
  }
  if (name === 'get_issue') {
    const issue = repo.issues.find((candidate) => candidate.number === Number(args.issue_number));
    if (!issue) return toolError(id, `Issue ${args.issue_number} does not exist`);
    return toolResult(id, issueView(repo, issue));
  }
  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = store.branchTip(repo, head);
    const baseSha = store.branchTip(repo, base);
    if (!headSha || !baseSha) return toolError(id, 'head or base branch does not exist');
    const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
    if (existing) return toolError(id, 'A pull request already exists for this head and base');
    const pull = {
      number: repo.nextNumber++,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      headRef: head,
      headSha,
      baseRef: base,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: store.nextSequence(),
    };
    repo.pulls.push(pull);
    return toolResult(id, pullView(repo, pull));
  }
  if (name === 'list_pull_requests') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const pulls = state === 'all' ? repo.pulls : repo.pulls.filter((pull) => pull.state === state);
    return toolResult(id, { pull_requests: pulls.map((pull) => pullView(repo, pull)) });
  }
  if (name === 'merge_pull_request') {
    const pull = repo.pulls.find((candidate) => candidate.number === Number(args.pull_number));
    if (!pull) return toolError(id, `Pull request ${args.pull_number} does not exist`);
    if (pull.state !== 'open' || pull.merged) return toolError(id, 'Pull request is not open');
    if (mergeableStatus(store, repo, pull) !== 'MERGEABLE') return toolError(id, 'Merge conflict');
    const baseTip = store.branchTip(repo, pull.baseRef)!;
    const headTip = store.branchTip(repo, pull.headRef)!;
    const mergeBase = store.mergeBase(repo, baseTip, headTip)!;
    const baseCommit = store.getObject(repo, baseTip)!;
    const headCommit = store.getObject(repo, headTip)!;
    const mergeBaseCommit = store.getObject(repo, mergeBase)!;
    const { treeOid } = store.threeWayMerge(
      repo,
      parseCommit(baseCommit.data).tree,
      parseCommit(headCommit.data).tree,
      parseCommit(mergeBaseCommit.data).tree,
    );
    const mergeCommit = store.commitOnBranch(repo, pull.baseRef, treeOid, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = mergeCommit;
    pull.baseSha = mergeCommit;
    return toolResult(id, { merged: true, sha: mergeCommit, number: pull.number, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
  }
  return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
}
