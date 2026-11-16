// Git's object model: SHA-1 ids, tree/commit/tag parse and build, packfile read and write
// (plain objects plus OFS/REF delta resolution), and reachability. No dependency beyond
// node:crypto and node:zlib. Objects are stored and compared byte-exactly: a clone must
// round-trip every object the suite pushed, so nothing here re-encodes an object.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const HEX40 = /^[0-9a-f]{40}$/;

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): { object: string; type: GitObjectType; tag: string; tagger: string; message: string } {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag has bad type');
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? 'Forge <forge@example.invalid>'} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? 'Forge <forge@example.invalid>'} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** A lookup from object id to object. */
export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries (gitlinks
 * skipped), tag -> its target, blob -> nothing. Throws on a missing object.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly checksumOk: boolean;
  readonly deltaCount: number;
}

/** Read one size varint (the pack entry header's size field): returns [value, bytesRead]. */
function readSizeVarint(pack: Buffer, offset: number): [number, number] {
  let value = pack[offset]! & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  let first = pack[offset]!;
  while (first & 0x80) {
    const byte = pack[pos]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
    first = byte;
  }
  return [value, pos - offset];
}

/** Read one offset varint (OFS_DELTA base offset): returns [value, bytesRead]. */
function readOffsetVarint(pack: Buffer, offset: number): [number, number] {
  let value = pack[offset]! & 0x7f;
  let pos = offset + 1;
  while (pack[pos - 1]! & 0x80) {
    value = ((value + 1) << 7) | (pack[pos]! & 0x7f);
    pos += 1;
  }
  return [value, pos - offset];
}

/**
 * Inflate the deflate stream starting at `offset`, returning [data, bytesConsumed].
 * inflateSync stops at the stream end and ignores trailing bytes, and throws on a truncated
 * stream, so the consumed length is the smallest slice length that inflates without error —
 * found by binary search. Each probe is cheap because inflateSync stops at the stream end.
 */
function inflateAt(pack: Buffer, offset: number, end: number, expectedSize: number): [Buffer, number] {
  let low = 1;
  let high = end - offset;
  while (low < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  if (low > end - offset) throw new Error('deflate stream runs past the pack');
  const data = inflateSync(pack.subarray(offset, offset + low));
  if (data.length !== expectedSize) throw new Error(`inflated object is ${data.length} bytes, expected ${expectedSize}`);
  return [data, low];
}

/** Apply a git binary delta to `base`, returning the result bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const opcode = delta[pos]!;
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          offset |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          size |= delta[pos]! << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base object');
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (opcode !== 0) {
      if (pos + opcode > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      total += opcode;
    } else {
      throw new Error('delta has a zero opcode');
    }
  }
  if (total !== resultSize) throw new Error(`delta result size ${total} does not match ${resultSize}`);
  return Buffer.concat(out);
}

/**
 * Read a packfile: version 2 or 3, plain objects and OFS/REF deltas. Verifies the trailer
 * SHA-1. `lookup` resolves a REF_DELTA base that is not in the pack (the store's objects).
 * Throws on a malformed pack; the caller turns that into an unpack failure.
 */
export function readPack(pack: Buffer, lookup?: ObjectLookup): PackReadResult {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not 2 or 3`);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (computed !== trailer) throw new Error('pack trailer checksum does not match its bytes');
  const objects = new Map<string, GitObject>();
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const pendingDeltas: { entryOffset: number; baseOid: string | null; baseOffset: number | null; delta: Buffer; size: number }[] = [];
  let deltaCount = 0;
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= end) throw new Error('pack ends before its declared object count');
    const entryOffset = offset;
    const firstByte = pack[offset]!;
    const typeCode = (firstByte >> 4) & 0x07;
    const [size, headerBytes] = readSizeVarint(pack, offset);
    offset += headerBytes;
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      const [baseOff, read] = readOffsetVarint(pack, offset);
      offset += read;
      baseOffset = entryOffset - baseOff;
      deltaCount += 1;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      deltaCount += 1;
    }
    const [inflated, consumed] = inflateAt(pack, offset, end, size);
    offset += consumed;
    if (typeCode === 6 || typeCode === 7) {
      pendingDeltas.push({ entryOffset, baseOid, baseOffset, delta: inflated, size });
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`pack entry has unknown type code ${typeCode}`);
    const oid = hashObject(type, inflated);
    const object: GitObject = { type, data: inflated };
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
    byOid.set(oid, object);
    entries.push({ offset: entryOffset, type, size, data: inflated, oid });
  }
  // Resolve deltas. A delta's base may itself be a delta, so resolve in dependency order:
  // repeat passes until every delta is resolved or no progress is made.
  const resolved = new Map<number, GitObject>();
  let progress = true;
  while (pendingDeltas.length > 0 && progress) {
    progress = false;
    for (let i = pendingDeltas.length - 1; i >= 0; i -= 1) {
      const pending = pendingDeltas[i]!;
      const base =
        pending.baseOffset !== null
          ? byOffset.get(pending.baseOffset) ?? resolved.get(pending.baseOffset)
          : pending.baseOid !== null
            ? byOid.get(pending.baseOid) ?? lookup?.(pending.baseOid)
            : undefined;
      if (!base) continue;
      const data = applyDelta(base.data, pending.delta);
      const object: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      objects.set(oid, object);
      byOffset.set(pending.entryOffset, object);
      byOid.set(oid, object);
      resolved.set(pending.entryOffset, object);
      entries.push({ offset: pending.entryOffset, type: base.type, size: data.length, data, oid });
      pendingDeltas.splice(i, 1);
      progress = true;
    }
  }
  if (pendingDeltas.length > 0) throw new Error('pack delta base is missing');
  entries.sort((a, b) => a.offset - b.offset);
  return { version, declaredCount, objects, entries, checksumOk: true, deltaCount };
}

/**
 * Write a packfile (version 2, plain objects, no deltas) for `objects`. Objects are sorted
 * by type then oid for a stable byte output.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].map((object) => ({ object, oid: hashObject(object.type, object.data) }));
  list.sort((a, b) => {
    const typeOrder = TYPE_CODE[a.object.type] - TYPE_CODE[b.object.type];
    if (typeOrder !== 0) return typeOrder;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const { object } of list) {
    const typeCode = TYPE_CODE[object.type];
    const size = object.data.length;
    const headerBytes: number[] = [];
    let first = (size & 0x0f) | (typeCode << 4);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
