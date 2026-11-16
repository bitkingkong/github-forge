// The git smart HTTP protocol (gitformat-protocol-common, gitformat-pack, git-remote-http):
// info/refs advertisements, upload-pack v2 (ls-refs, fetch) and v0 (fetch), and receive-pack
// v0 (push). The suite's client drives all of it, so this is the most exact surface in the
// forge: the advertisement capabilities, the ls-refs attributes, the fetch sections and the
// push report are all asserted byte-for-byte by the checks.
//
// Conventions the checks rely on:
//  - v2 advertisement: 'version 2' + agent + ls-refs=unborn + fetch=shallow wait-for-done +
//    object-format=sha1. The client sends agent=/object-format= arguments when those
//    capabilities are present, so unknown arguments are ignored.
//  - ls-refs: HEAD carries symref-target:refs/heads/<default>; annotated tags carry
//    peeled:<commit> when peel is requested; a ref-prefix filters server-side (HEAD is
//    excluded by any prefix); an empty repo answers `unborn HEAD symref-target:...`.
//  - fetch v2: sections acknowledgments / shallow-info / packfile, delimited, flushed. The
//    packfile section is omitted entirely when nothing is sent (an empty one throws the
//    client). Shallow boundaries are the included commits whose parents were not included;
//    a previously shallow boundary whose parent is now included is reported unshallow.
//  - push: the pack is unpacked and checksum-verified first; a bad pack reports
//    `unpack <detail>` and updates nothing. Ref updates are fast-forward only (create on
//    the zero id, delete on the zero new id); a refused update reports `ng <ref> <reason>`
//    and applies nothing for that ref, while the other refs in the same push still apply.

import { collectReachable, hashObject, isObjectId, parseCommit, parseTag, parseTree, readPack, writePack, ZERO_OID } from './git-objects.ts';
import type { GitObject } from './git-objects.ts';
import { DELIM, encodePktLine, FLUSH, frameSideband, RECEIVE_PACK_CAPABILITIES, splitPktLinesAndRest, UPLOAD_PACK_CAPABILITIES, V2_CAPABILITIES } from './pkt.ts';
import type { RepoState, Store } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(message: string): GitResponse {
  return { status: 404, contentType: 'text/plain', body: Buffer.from(message, 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'text/plain', body: Buffer.from(message, 'utf8') };
}

/** The default branch's tip, or undefined when the repository has no commits yet. */
function headTip(repo: RepoState): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** The ref lines for a v0 advertisement: `<oid> <ref>` plus peeled lines for annotated tags. */
function v0RefLines(store: Store, repo: RepoState, capabilities: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = store.listRefs(repo);
  const tip = headTip(repo);
  if (refs.length === 0) {
    lines.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
    return lines;
  }
  const headLine = tip !== undefined ? `${tip} HEAD\u0000${capabilities}\n` : `${ZERO_OID} HEAD\u0000${capabilities}\n`;
  lines.push(encodePktLine(headLine));
  for (const ref of refs) {
    lines.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
    const object = repo.objects.get(ref.oid);
    if (object && object.type === 'tag') {
      const target = parseTag(object.data).object;
      lines.push(encodePktLine(`${target} ${ref.name}^{}\n`));
    }
  }
  return lines;
}

/** The full v0 advertisement: the `# service=...` preamble, a flush, the ref lines, a flush. */
function v0Advertisement(store: Store, repo: RepoState, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), FLUSH, ...v0RefLines(store, repo, capabilities), FLUSH];
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`repository ${owner}/${repoName} does not exist`);
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, 'git-receive-pack', RECEIVE_PACK_CAPABILITIES));
  }
  if (service !== 'git-upload-pack') return badRequest(`unknown service ${service}`);
  if (gitProtocol === 'version=2') {
    const lines: Buffer[] = [];
    for (const capability of V2_CAPABILITIES) lines.push(encodePktLine(`${capability}\n`));
    lines.push(FLUSH);
    return ok('application/x-git-upload-pack-advertisement', Buffer.concat(lines));
  }
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, 'git-upload-pack', UPLOAD_PACK_CAPABILITIES));
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly { payload: Buffer }[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    const text = line.payload.toString('utf8').trim();
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

/** POST git-upload-pack with Git-Protocol: version=2 — command=ls-refs or command=fetch. */
function handleUploadPackV2(store: Store, repo: RepoState, body: Buffer): GitResponse {
  const { lines } = splitPktLinesAndRest(body);
  const args = lines.map((line) => line.payload.toString('utf8').trim());
  const command = args.find((arg) => arg.startsWith('command='))?.slice('command='.length);
  if (command === 'ls-refs') return handleLsRefsV2(store, repo, parseLsRefsArgs(lines));
  if (command === 'fetch') return handleFetchV2(repo, lines);
  return badRequest(`unknown v2 command ${command ?? '(none)'}`);
}

function handleLsRefsV2(store: Store, repo: RepoState, args: LsRefsArgs): GitResponse {
  const out: Buffer[] = [];
  const tip = headTip(repo);
  const includeHead = args.prefixes.length === 0;
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (tip === undefined) {
    // The repository has no commits: HEAD is unborn.
    if (includeHead || args.unborn) {
      const attributes = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      out.push(encodePktLine(`unborn HEAD${attributes}\n`));
    }
  } else {
    if (includeHead) {
      const attributes = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      out.push(encodePktLine(`${tip} HEAD${attributes}\n`));
    }
    for (const ref of store.listRefs(repo)) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      const object = repo.objects.get(ref.oid);
      if (args.peel && object && object.type === 'tag') {
        line += ` peeled:${parseTag(object.data).object}`;
      }
      out.push(encodePktLine(`${line}\n`));
    }
  }
  out.push(FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(out));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: readonly { payload: Buffer }[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.payload.toString('utf8').trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number(text.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

/**
 * The objects a fetch must not re-send: the closure of the haves. A have that the client
 * holds shallowly (it is in the request's shallow list) contributes only itself and its
 * tree — the client does not have its parents, so they must not be excluded. A have the
 * client holds fully contributes its whole reachable closure. Without this distinction a
 * deepen would exclude the very parent it is supposed to deliver.
 */
function collectHaveClosure(repo: RepoState, args: FetchArgs): Set<string> {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const shallowSet = new Set(args.shallow);
  const excluded = new Set<string>();
  for (const have of args.haves) {
    const object = repo.objects.get(have);
    if (!object) continue;
    if (!shallowSet.has(have)) {
      for (const oid of collectReachable([have], lookup)) excluded.add(oid);
      continue;
    }
    // Shallow: the commit (or tag) and its tree, but not its parents.
    excluded.add(have);
    if (object.type === 'commit') {
      for (const oid of collectReachable([parseCommit(object.data).tree], lookup)) excluded.add(oid);
    } else if (object.type === 'tag') {
      const target = repo.objects.get(parseTag(object.data).object);
      if (target && target.type === 'commit') {
        for (const oid of collectReachable([parseCommit(target.data).tree], lookup)) excluded.add(oid);
      }
    } else if (object.type === 'tree') {
      for (const oid of collectReachable([have], lookup)) excluded.add(oid);
    }
  }
  return excluded;
}

/**
 * The object set a fetch sends, plus its shallow-info. With no depth the set is the full
 * closure of the wants minus the closure of the haves. With a depth the set is the closure
 * of the commits within `depth` generations of the wants (their trees and blobs, but not
 * their parents) minus the closure of the haves; the boundaries are the deepest included
 * commits that still have parents, and any previously shallow boundary whose parent is now
 * included is reported unshallow.
 */
function computeFetch(repo: RepoState, args: FetchArgs): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveClosure = args.haves.length > 0 ? collectHaveClosure(repo, args) : new Set<string>();
  if (args.depth === undefined) {
    const included = collectReachable(args.wants, lookup);
    const objects = new Map<string, GitObject>();
    for (const oid of included) {
      if (haveClosure.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.set(oid, object);
    }
    return { objects, shallow: [], unshallow: [] };
  }
  const depth = args.depth;
  const includedCommits = new Map<string, number>();
  const queue: { oid: string; generation: number }[] = args.wants.map((oid) => ({ oid, generation: 0 }));
  while (queue.length) {
    const { oid, generation } = queue.shift()!;
    if (generation >= depth) continue;
    if (includedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) throw new Error(`wanted object ${oid} does not exist`);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      queue.push({ oid: target, generation });
      continue;
    }
    if (object.type !== 'commit') continue;
    includedCommits.set(oid, generation);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  const included = new Set<string>();
  for (const oid of includedCommits.keys()) {
    const object = repo.objects.get(oid)!;
    const commit = parseCommit(object.data);
    included.add(oid);
    for (const reachable of collectReachable([commit.tree], lookup)) included.add(reachable);
  }
  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  }
  const shallow: string[] = [];
  for (const [oid, generation] of includedCommits) {
    if (generation !== depth - 1) continue;
    const object = repo.objects.get(oid)!;
    if (parseCommit(object.data).parents.length > 0) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    if (!includedCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent))) unshallow.push(oid);
  }
  return { objects, shallow, unshallow };
}

function handleFetchV2(repo: RepoState, lines: readonly { payload: Buffer }[]): GitResponse {
  const args = parseFetchArgs(lines);
  let result: { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] };
  try {
    result = computeFetch(repo, args);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'fetch failed');
  }
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(DELIM);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (result.objects.size > 0) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(frameSideband(writePack(result.objects.values())));
  }
  parts.push(FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------------------------

/** POST git-upload-pack without the v2 header: wants, haves, shallow/deepen, done. */
function handleUploadPackV0(repo: RepoState, body: Buffer): GitResponse {
  const { lines } = splitPktLinesAndRest(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.payload.toString('utf8').trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number(text.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  let result: { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] };
  try {
    result = computeFetch(repo, args);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : 'fetch failed');
  }
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of result.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  if (result.objects.size > 0) parts.push(frameSideband(writePack(result.objects.values())));
  parts.push(FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, gitProtocol: string | undefined): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`repository ${owner}/${repoName} does not exist`);
  if (gitProtocol === 'version=2') return handleUploadPackV2(store, repo, body);
  return handleUploadPackV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0 (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo) return notFound(`repository ${owner}/${repoName} does not exist`);
  const { lines, rest } = splitPktLinesAndRest(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const text = line.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const commandText = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = commandText.split(' ');
    if (parts.length !== 3) return badRequest(`malformed push command ${JSON.stringify(commandText)}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return badRequest('push command has a bad object id');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return badRequest('push has no commands');
  // Unpack first: a bad pack fails the whole push and updates nothing.
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  let unpacked: { objects: Map<string, GitObject> } | null = null;
  if (hasPack) {
    if (rest.length === 0) {
      // The client sent no pack bytes: it believes the server already has every object.
      unpacked = { objects: new Map() };
    } else {
      try {
        unpacked = readPack(rest, (oid) => repo.objects.get(oid));
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'pack is malformed';
      }
    }
  }
  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
    const response = Buffer.concat([frameSideband(Buffer.from(report.join(''), 'utf8')), FLUSH]);
    return ok('application/x-git-receive-pack-result', response);
  }
  if (unpacked) store.putObjects(repo, unpacked.objects.values());
  report.push('unpack ok\n');
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === undefined) {
        report.push(`ng ${command.ref} no such ref\n`);
      } else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // A create: the ref must not exist.
      if (current !== undefined) {
        report.push(`ng ${command.ref} already exists\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} object ${command.newOid} is missing\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
      continue;
    }
    // An update: the old id must match, and the new id must descend from the old.
    if (current === undefined) {
      report.push(`ng ${command.ref} no such ref\n`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} old object id does not match\n`);
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} object ${command.newOid} is missing\n`);
      continue;
    }
    if (!store.isFastForward(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}\n`);
  }
  const response = Buffer.concat([frameSideband(Buffer.from(report.join(''), 'utf8')), FLUSH]);
  return ok('application/x-git-receive-pack-result', response);
}

/** The object id a ref points at, following annotated tags to their target commit. */
export function resolveRefToCommit(repo: RepoState, ref: string): string | undefined {
  const oid = repo.refs.get(ref);
  if (!oid) return undefined;
  const object = repo.objects.get(oid);
  if (!object) return undefined;
  if (object.type === 'tag') return parseTag(object.data).object;
  if (object.type === 'commit') return oid;
  return undefined;
}

/** The commit id a branch tip points at (following an annotated tag is not applicable). */
export function branchTipCommit(repo: RepoState, branch: string): string | undefined {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return undefined;
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return undefined;
  return oid;
}

export { hashObject };
