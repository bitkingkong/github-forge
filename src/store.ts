// The forge's in-memory model. One Store holds every repository; each repository owns its
// objects, refs, labels, issues and pull requests. Everything is a Map, so the read workload
// (2000 sequential issue GETs) and the write workload (200 issue POSTs) are lookups and
// appends. Issue and pull-request numbers share one counter per repository, as GitHub does.
//
// The viewer is fixed by the trial scenario (see src/viewer.ts): the entry cannot derive the
// viewer from the shop token, so the scenario's identity is baked in.

import { buildCommit, buildTree, collectReachable, hashObject, isObjectId, parseCommit, parseTree, ZERO_OID } from './git-objects.ts';
import type { GitObject, TreeEntry } from './git-objects.ts';
import { VIEWER } from './viewer.ts';

export interface CommentState {
  id: number;
  body: string;
}

export interface IssueState {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: number;
  comments: CommentState[];
}

export interface PullState {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: number;
}

export interface LabelState {
  name: string;
  color: string;
}

export interface RepoState {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, LabelState>;
  issues: IssueState[];
  pulls: PullState[];
  nextNumber: number;
  nextCommentId: number;
}

export class Store {
  readonly repos = new Map<string, RepoState>();
  private nextRepoId = 1;
  private sequence = 1;

  /** A monotonic sequence for creation order (pagination and list order). */
  nextSequence(): number {
    return this.sequence++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** A repository by its numeric id (GraphQL global ids encode it). */
  getRepoById(id: number): RepoState | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string; defaultBranch?: string }): RepoState {
    const repo: RepoState = {
      id: this.nextRepoId++,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
      createdAt: this.nextSequence(),
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository owned by `owner`, in creation order. */
  listRepos(owner: string): RepoState[] {
    const out: RepoState[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // objects
  // -------------------------------------------------------------------------------------------

  getObject(repo: RepoState, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: RepoState, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Store objects from a pack, keyed by their recomputed id. */
  putObjects(repo: RepoState, objects: Iterable<GitObject>): void {
    for (const object of objects) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
    }
  }

  // -------------------------------------------------------------------------------------------
  // refs
  // -------------------------------------------------------------------------------------------

  getRef(repo: RepoState, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: RepoState, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: RepoState, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** All refs sorted by name (HEAD excluded; it is not a ref). */
  listRefs(repo: RepoState): { name: string; oid: string }[] {
    const out: { name: string; oid: string }[] = [];
    for (const [name, oid] of repo.refs) out.push({ name, oid });
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** The tip of `branch`, or undefined when the branch does not exist. */
  branchTip(repo: RepoState, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** True when `newOid` descends from `oldOid` (or oldOid is the zero id: a create). */
  isFastForward(repo: RepoState, oldOid: string, newOid: string): boolean {
    if (oldOid === ZERO_OID) return true;
    if (newOid === ZERO_OID) return true;
    if (oldOid === newOid) return true;
    const seen = new Set<string>();
    const queue: string[] = [newOid];
    while (queue.length) {
      const oid = queue.pop()!;
      if (oid === oldOid) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** The best common ancestor of two commits (the deepest shared one), or undefined. */
  mergeBase(repo: RepoState, a: string, b: string): string | undefined {
    const generations = new Map<string, number>();
    const queue: { oid: string; depth: number }[] = [{ oid: a, depth: 0 }];
    for (let head = 0; head < queue.length; head += 1) {
      const { oid, depth } = queue[head]!;
      if (generations.has(oid)) continue;
      generations.set(oid, depth);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    let best: string | undefined;
    let bestDepth = -1;
    const bQueue: { oid: string; depth: number }[] = [{ oid: b, depth: 0 }];
    const seenB = new Set<string>();
    for (let head = 0; head < bQueue.length; head += 1) {
      const { oid, depth } = bQueue[head]!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const aDepth = generations.get(oid);
      if (aDepth !== undefined) {
        const score = aDepth + depth;
        if (best === undefined || score > bestDepth) {
          best = oid;
          bestDepth = score;
        }
      }
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) bQueue.push({ oid: parent, depth: depth + 1 });
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------
  // trees: path lookup, path set/delete, flatten, diff, three-way merge
  // -------------------------------------------------------------------------------------------

  /** The blob id at `path` in the tree `treeOid`, or undefined. */
  getBlobAtPath(repo: RepoState, treeOid: string, path: string): string | undefined {
    const parts = path.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry.mode === '40000' ? undefined : entry.oid;
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** The entries directly under `path` in the tree `treeOid` ('' is the root). */
  listDir(repo: RepoState, treeOid: string, path: string): TreeEntry[] | undefined {
    const parts = path.split('/').filter((part) => part.length > 0);
    let current = treeOid;
    for (const part of parts) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return undefined;
      const entry = parseTree(object.data).find((candidate) => candidate.name === part);
      if (!entry || entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return undefined;
    return parseTree(object.data);
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when blobOid is null), built on
   * `baseTreeOid` (null for an empty tree). Intermediate directories are created as needed;
   * directories left empty by a removal are pruned.
   */
  setPathInTree(repo: RepoState, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) throw new Error('path is empty');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
      const name = parts[depth]!;
      const isLeaf = depth === parts.length - 1;
      const existing = entries.findIndex((entry) => entry.name === name);
      if (isLeaf) {
        if (blobOid === null) {
          if (existing < 0) return treeOid;
          const next = entries.filter((entry) => entry.name !== name);
          if (next.length === 0) return null;
          return this.putObject(repo, 'tree', buildTree(next));
        }
        const next = [...entries];
        const entry: TreeEntry = { mode: '100644', name, oid: blobOid };
        if (existing >= 0) next[existing] = entry;
        else next.push(entry);
        return this.putObject(repo, 'tree', buildTree(next));
      }
      const childOid = existing >= 0 && entries[existing]!.mode === '40000' ? entries[existing]!.oid : null;
      const nextChild = build(childOid, depth + 1);
      const next = [...entries];
      if (nextChild === null) {
        if (existing >= 0) next.splice(existing, 1);
        if (next.length === 0) return null;
      } else {
        const entry: TreeEntry = { mode: '40000', name, oid: nextChild };
        if (existing >= 0) next[existing] = entry;
        else next.push(entry);
      }
      return this.putObject(repo, 'tree', buildTree(next));
    };
    const root = build(baseTreeOid, 0);
    if (root === null) return this.putObject(repo, 'tree', buildTree([]));
    return root;
  }

  /** A flat path -> {oid, mode} map of a tree, recursing into subdirectories. */
  flattenTree(repo: RepoState, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build a root tree from a flat path map. */
  buildTreeFromFlat(repo: RepoState, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const children = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          const dir = rest.slice(0, slash);
          let child = children.get(dir);
          if (!child) {
            child = new Map();
            children.set(dir, child);
          }
          child.set(path, value);
        }
      }
      for (const [dir, childFlat] of children) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  /** Line counts for a blob: additions and deletions between two blobs. */
  lineDiff(repo: RepoState, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const linesOf = (oid: string | null): string[] => {
      if (oid === null) return [];
      const object = repo.objects.get(oid);
      if (!object) return [];
      const text = object.data.toString('utf8');
      if (text.length === 0) return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const oldLines = linesOf(oldOid);
    const newLines = linesOf(newOid);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    const newCounts = new Map<string, number>();
    for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) {
      const oldCount = oldCounts.get(line) ?? 0;
      if (count > oldCount) additions += count - oldCount;
    }
    for (const [line, count] of oldCounts) {
      const newCount = newCounts.get(line) ?? 0;
      if (count > newCount) deletions += count - newCount;
    }
    return { additions, deletions };
  }

  /** The file diff between two trees: added, modified and removed paths with line counts. */
  diffTrees(
    repo: RepoState,
    baseTreeOid: string,
    headTreeOid: string,
  ): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const baseEntry = base.get(path);
      const headEntry = head.get(path);
      if (!baseEntry && headEntry) {
        const { additions, deletions } = this.lineDiff(repo, null, headEntry.oid);
        out.push({ filename: path, status: 'added', additions, deletions, changes: additions + deletions });
      } else if (baseEntry && !headEntry) {
        const { additions, deletions } = this.lineDiff(repo, baseEntry.oid, null);
        out.push({ filename: path, status: 'removed', additions, deletions, changes: additions + deletions });
      } else if (baseEntry && headEntry && baseEntry.oid !== headEntry.oid) {
        const { additions, deletions } = this.lineDiff(repo, baseEntry.oid, headEntry.oid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /**
   * A three-way merge of base and head trees against their merge-base tree. Returns the merged
   * tree id and the paths where both sides changed the same file differently (conflicts).
   */
  threeWayMerge(
    repo: RepoState,
    baseTreeOid: string,
    headTreeOid: string,
    mergeBaseTreeOid: string,
  ): { treeOid: string; conflicts: string[] } {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const ancestor = this.flattenTree(repo, mergeBaseTreeOid);
    const merged = new Map<string, { oid: string; mode: string }>();
    const conflicts: string[] = [];
    const paths = new Set([...base.keys(), ...head.keys(), ...ancestor.keys()]);
    for (const path of paths) {
      const baseEntry = base.get(path);
      const headEntry = head.get(path);
      const ancestorEntry = ancestor.get(path);
      const same = (a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean =>
        (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
      if (same(baseEntry, headEntry)) {
        if (baseEntry) merged.set(path, baseEntry);
      } else if (same(baseEntry, ancestorEntry)) {
        if (headEntry) merged.set(path, headEntry);
      } else if (same(headEntry, ancestorEntry)) {
        if (baseEntry) merged.set(path, baseEntry);
      } else {
        conflicts.push(path);
        if (baseEntry) merged.set(path, baseEntry);
      }
    }
    return { treeOid: this.buildTreeFromFlat(repo, merged), conflicts };
  }

  /** Create a commit on `branch` (creating the branch from its parent tip when needed). */
  commitOnBranch(
    repo: RepoState,
    branch: string,
    treeOid: string,
    message: string,
    parents?: readonly string[],
  ): string {
    const tip = this.branchTip(repo, branch);
    const effectiveParents = parents ?? (tip ? [tip] : []);
    const timestamp = Math.floor(Date.now() / 1000);
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const commitData = buildCommit({ tree: treeOid, parents: effectiveParents, message, author, committer: author, timestamp });
    const oid = this.putObject(repo, 'commit', commitData);
    this.setRef(repo, `refs/heads/${branch}`, oid);
    return oid;
  }

  /** Every commit reachable from `tip`, newest first (depth-first from the tip). */
  listCommits(repo: RepoState, tip: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    for (let head = 0; head < queue.length; head += 1) {
      const oid = queue[head]!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** Every object reachable from `roots` in this repository. */
  reachable(repo: RepoState, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }
}
