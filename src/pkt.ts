// pkt-line framing, the wire format of the git smart HTTP protocol (gitformat-protocol-common):
// each packet is a 4-hex-digit length (including the 4 length bytes) followed by the payload.
// '0000' is a flush, '0001' is a delim. Payloads are at most 65520 bytes, so sideband
// packets carry at most 65516 bytes of pack data after the 1 band byte.

export type PktKind = 'flush' | 'delim' | 'data';

export interface PktLine {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** Encode one data packet: the payload as a string or bytes, length-prefixed. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length > 65516) throw new Error(`pkt-line payload of ${data.length} bytes exceeds 65516`);
  const length = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([header, data]);
}

/** A flush packet ('0000'). */
export const FLUSH: Buffer = Buffer.from('0000', 'ascii');

/** A delim packet ('0001'). */
export const DELIM: Buffer = Buffer.from('0001', 'ascii');

/**
 * Decode a whole buffer of pkt-lines. Throws on a bad length, a truncated packet, or trailing
 * bytes that are not a complete packet.
 */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`pkt-line length ${lengthText} is not hex`);
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`pkt-line length ${length} is out of range`);
    if (offset + length > buffer.length) throw new Error('pkt-line payload is truncated');
    lines.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return lines;
}

/**
 * Split a request body into its pkt-line section and the bytes after it: the pkt-lines end at
 * the first flush, and the remainder is the packfile (receive-pack) or empty (upload-pack v2
 * has no trailing pack; its arguments are all pkt-lines).
 */
export function splitPktLinesAndRest(buffer: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lengthText = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) break;
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      // A flush ends the pkt-line section; it is not a line, and the bytes after it are the
      // packfile (receive-pack) or empty (upload-pack).
      offset += 4;
      break;
    }
    if (length === 1) {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > buffer.length) break;
    lines.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { lines, rest: buffer.subarray(offset) };
}

/**
 * Frame pack bytes as sideband packets (band 1): each pkt-line is the band byte plus up to
 * 65515 bytes of pack data, so the payload (band byte + data) stays within the 65516-byte
 * pkt-line payload limit.
 */
export function frameSideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

/** Frame a progress (band 2) or error (band 3) sideband line. */
export function frameSidebandText(band: 2 | 3, text: string): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([band]), Buffer.from(text, 'utf8')]));
}

/** The standard v2 advertisement capability block, one pkt-line per line. */
export const V2_CAPABILITIES: readonly string[] = [
  'version 2',
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'object-format=sha1',
];

/** The standard v0 receive-pack capabilities, advertised on the first ref line. */
export const RECEIVE_PACK_CAPABILITIES = 'side-band-64k report-status delete-refs ofs-delta agent=forge/1.0';

/** The standard v0 upload-pack capabilities, advertised on the first ref line. */
export const UPLOAD_PACK_CAPABILITIES = 'side-band-64k ofs-delta agent=forge/1.0';
