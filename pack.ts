/**
 * pack.ts — git packfile reading and writing (version 2). Writing emits plain
 * objects only, no deltas, in oid order. Reading handles OFS_DELTA and REF_DELTA
 * (thin-pack bases resolve through a caller-supplied lookup), verifies the
 * trailer checksum and the inflated sizes, and re-derives every object's id
 * from its type and bytes.
 */
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type ObjectType } from './git-objects.ts';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OFS_DELTA = 6;
const REF_DELTA = 7;

function encodeTypeSize(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  let first = (typeCode << 4) | (rest & 0x0f);
  rest >>= 4;
  if (rest > 0) first |= 0x80;
  bytes.push(first);
  while (rest > 0) {
    let next = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/**
 * Serialize objects as a version-2 pack: `PACK`, version, count, one
 * type/size + deflate entry per object in oid order, SHA-1 trailer.
 */
export function writePack(objects: ReadonlyMap<string, GitObject> | readonly GitObject[]): Buffer {
  const list: Array<{ oid: string; object: GitObject }> = [];
  if (objects instanceof Map) {
    for (const [oid, object] of objects) list.push({ oid, object });
  } else {
    for (const object of objects) list.push({ oid: hashObject(object.type, object.data), object });
  }
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { object } of list) {
    parts.push(encodeTypeSize(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The empty pack: 12-byte header, 0 entries, trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

interface RawEntry {
  typeCode: number;
  size: number;
  /** The entry's offset in the pack body (start of its header). */
  start: number;
  /** For OFS_DELTA: the base entry's offset. For REF_DELTA: the base oid. */
  baseOffset: number;
  baseOid: string;
  /** The inflated payload (plain object bytes, or delta instructions). */
  data: Buffer;
  /** Offset just past the entry's deflated stream. */
  endOffset: number;
}

function readOfsBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  if (offset >= buffer.length) throw new Error('pack OFS_DELTA runs past the pack');
  let byte = buffer[offset] as number;
  let at = offset + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (at >= buffer.length) throw new Error('pack OFS_DELTA runs past the pack');
    byte = buffer[at] as number;
    at += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: offset - value, next: at };
}

/**
 * Inflate the deflate stream starting at `offset`, whose output must be exactly
 * `expectedSize` bytes. Node's inflateSync ignores trailing bytes, so the
 * stream's end is found by walking the deflate block structure (see
 * findZlibStreamEnd) and verified with a single inflate; when that walk
 * cannot settle the end, the end is the smallest end offset whose slice
 * inflates cleanly to the expected size — found by bisection (a shorter slice
 * throws Z_BUF_ERROR, a longer one returns the same output). Returns the bytes
 * and the end offset.
 */
function inflateEntry(buffer: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  // A deflate stream's bytes never exceed its output plus stored-block overhead
  // (5 bytes per 64 KiB block, a 2-byte header, a 4-byte checksum), plus slack.
  const bound = offset + expectedSize + 1024 + 5 * Math.ceil(expectedSize / 65535);
  const hi0 = Math.min(buffer.length, bound);
  const fastEnd = findZlibStreamEnd(buffer, offset, hi0);
  if (fastEnd !== null) {
    try {
      const out = inflateSync(buffer.subarray(offset, fastEnd));
      if (out.length === expectedSize) return { data: out, next: fastEnd };
    } catch {
      // The walk settled on a wrong end: fall through to bisection.
    }
  }
  const attempt = (end: number): Buffer | null => {
    try {
      const out = inflateSync(buffer.subarray(offset, end));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  if (attempt(hi0) === null) throw new Error('pack entry does not inflate to its declared size');
  // Bisect for the smallest end that yields the expected output.
  let lo = offset + 2;
  let hi = hi0;
  let found = hi0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (attempt(mid) !== null) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const data = attempt(found);
  if (data === null) throw new Error('pack entry does not inflate to its declared size');
  return { data, next: found };
}

// ---------------------------------------------------------------------------
// Deflate end-finding: walk the block structure of a zlib stream without
// decompressing it, to learn where the stream ends. Any doubt returns null
// and the caller falls back to bisection; a settled end is always verified
// with a real inflate before it is trusted.
// ---------------------------------------------------------------------------

/** Reads deflate's LSB-first bit packing, bounded by `limit`. */
/**
 * Bit-level state for the deflate walk. Bits are consumed LSB-first: the next
 * bit to read is the lowest set bit of bitBuf. bytePos is the next unread
 * byte; bitCnt (never above 22) counts the buffered, unconsumed bits.
 */
interface BitState {
  bytePos: number;
  bitBuf: number;
  bitCnt: number;
}

/** Buffer at least `count` bits (count <= 15), or as many as remain. */
function fillBits(buffer: Buffer, limit: number, state: BitState, count: number): boolean {
  while (state.bitCnt < count && state.bytePos < limit) {
    state.bitBuf |= (buffer[state.bytePos] as number) << state.bitCnt;
    state.bytePos += 1;
    state.bitCnt += 8;
  }
  return state.bitCnt >= count;
}

/** Take `count` buffered bits, first-consumed bit as bit 0. */
function takeBits(state: BitState, count: number): number {
  const value = state.bitBuf & ((1 << count) - 1);
  state.bitBuf >>= count;
  state.bitCnt -= count;
  return value;
}

/** Read `count` bits, or null when fewer remain before the limit. */
function readBits(buffer: Buffer, limit: number, state: BitState, count: number): number | null {
  if (!fillBits(buffer, limit, state, count)) return null;
  return takeBits(state, count);
}

/**
 * Skip to the next byte boundary and unread whole buffered bytes, so bytePos
 * is the next byte to read. Returns false when the boundary passes the limit.
 */
function alignBits(limit: number, state: BitState): boolean {
  takeBits(state, state.bitCnt & 7);
  state.bytePos -= state.bitCnt >> 3;
  state.bitBuf = 0;
  state.bitCnt = 0;
  return state.bytePos <= limit;
}

/** A canonical Huffman table, decoded by peeking up to 15 bits at a time. */
interface HuffmanTable {
  /** counts[len] = how many codes have that length (indices 1..15). */
  counts: number[];
  /** The first code value of each length. */
  firstCode: number[];
  /** Symbols grouped by length, ascending code order within each group. */
  symbols: number[];
  /** The symbols index where each length's group starts. */
  firstIndex: number[];
}

function buildHuffman(lengths: readonly number[]): HuffmanTable | null {
  const counts = new Array<number>(16).fill(0);
  for (const length of lengths) {
    if (length < 0 || length > 15) return null;
    counts[length] += 1;
  }
  counts[0] = 0;
  const firstCode = new Array<number>(16).fill(0);
  const firstIndex = new Array<number>(16).fill(0);
  let code = 0;
  let index = 0;
  for (let len = 1; len <= 15; len += 1) {
    code = (code + counts[len - 1]) << 1;
    firstCode[len] = code;
    firstIndex[len] = index;
    index += counts[len];
    if (code + counts[len] > 1 << len) return null; // over-subscribed codes
  }
  const symbols = new Array<number>(index);
  const next = [...firstIndex];
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol] as number;
    if (length > 0) {
      symbols[next[length] as number] = symbol;
      next[length] = (next[length] as number) + 1;
    }
  }
  return { counts, firstCode, symbols, firstIndex };
}

function decodeSymbol(buffer: Buffer, limit: number, state: BitState, table: HuffmanTable): number | null {
  fillBits(buffer, limit, state, 15);
  const available = Math.min(15, state.bitCnt);
  if (available === 0) return null;
  // Reverse the window so the first-consumed bit is the most significant.
  let window = state.bitBuf & ((1 << available) - 1);
  let reversed = 0;
  for (let i = 0; i < available; i += 1) {
    reversed = (reversed << 1) | (window & 1);
    window >>= 1;
  }
  for (let len = 1; len <= available; len += 1) {
    const code = reversed >> (available - len);
    const count = table.counts[len] as number;
    if (count > 0) {
      const offset = code - (table.firstCode[len] as number);
      if (offset >= 0 && offset < count) {
        takeBits(state, len);
        return table.symbols[(table.firstIndex[len] as number) + offset] as number;
      }
    }
  }
  return null;
}

const FIXED_LITERAL_LENGTHS: readonly number[] = Array.from({ length: 288 }, (_, i) =>
  i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8,
);
const FIXED_LITERAL_TABLE = buildHuffman(FIXED_LITERAL_LENGTHS) as HuffmanTable;
const FIXED_DISTANCE_TABLE = buildHuffman(new Array<number>(32).fill(5)) as HuffmanTable;

/** Extra bits after length codes 257..285 (RFC 1951 §3.2.5). */
const LENGTH_EXTRA: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
/** Extra bits after distance codes 0..29 (RFC 1951 §3.2.5). */
const DISTANCE_EXTRA: readonly number[] = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
/** The order the code-length code lengths are stored in (RFC 1951 §3.2.7). */
const CODE_LENGTH_ORDER: readonly number[] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Parse a dynamic block's two Huffman tables. */
function readDynamicTables(
  buffer: Buffer,
  limit: number,
  state: BitState,
): { literal: HuffmanTable; distance: HuffmanTable } | null {
  const hlit = readBits(buffer, limit, state, 5);
  const hdist = readBits(buffer, limit, state, 5);
  const hclen = readBits(buffer, limit, state, 4);
  if (hlit === null || hdist === null || hclen === null) return null;
  const literalCount = hlit + 257;
  const distanceCount = hdist + 1;
  const codeLengthLengths = new Array<number>(19).fill(0);
  for (let i = 0; i < hclen + 4; i += 1) {
    const value = readBits(buffer, limit, state, 3);
    if (value === null) return null;
    codeLengthLengths[CODE_LENGTH_ORDER[i] as number] = value;
  }
  const codeLengthTable = buildHuffman(codeLengthLengths);
  if (codeLengthTable === null) return null;
  const total = literalCount + distanceCount;
  const lengths = new Array<number>(total).fill(0);
  let i = 0;
  while (i < total) {
    const symbol = decodeSymbol(buffer, limit, state, codeLengthTable);
    if (symbol === null) return null;
    if (symbol <= 15) {
      lengths[i] = symbol;
      i += 1;
    } else if (symbol === 16) {
      if (i === 0) return null;
      const repeat = readBits(buffer, limit, state, 2);
      if (repeat === null) return null;
      const count = 3 + repeat;
      if (i + count > total) return null;
      const previous = lengths[i - 1] as number;
      for (let k = 0; k < count; k += 1) {
        lengths[i] = previous;
        i += 1;
      }
    } else if (symbol === 17 || symbol === 18) {
      const repeat = readBits(buffer, limit, state, symbol === 17 ? 3 : 7);
      if (repeat === null) return null;
      const count = (symbol === 17 ? 3 : 11) + repeat;
      if (i + count > total) return null;
      i += count; // zeros are already in place
    } else {
      return null;
    }
  }
  const literal = buildHuffman(lengths.slice(0, literalCount));
  const distance = buildHuffman(lengths.slice(literalCount));
  if (literal === null || distance === null) return null;
  return { literal, distance };
}

/**
 * The end offset (just past the Adler-32) of the zlib stream starting at
 * `offset`, or null when the walk cannot settle it. Never reads past `limit`.
 */
function findZlibStreamEnd(buffer: Buffer, offset: number, limit: number): number | null {
  if (offset + 2 > limit) return null;
  const cmf = buffer[offset] as number;
  const flg = buffer[offset + 1] as number;
  if ((cmf & 0x0f) !== 8) return null; // not deflate
  if (((cmf << 8) | flg) % 31 !== 0) return null; // bad header checksum
  if ((flg & 0x20) !== 0) return null; // preset dictionary: git packs never use one
  if (cmf >> 4 > 7) return null; // window too large
  const state: BitState = { bytePos: offset + 2, bitBuf: 0, bitCnt: 0 };
  for (;;) {
    const bfinal = readBits(buffer, limit, state, 1);
    const btype = readBits(buffer, limit, state, 2);
    if (bfinal === null || btype === null) return null;
    if (btype === 0) {
      // Stored block: byte-aligned LEN/NLEN header, then LEN raw bytes.
      if (!alignBits(limit, state)) return null;
      if (state.bytePos + 4 > limit) return null;
      const length = buffer.readUInt16LE(state.bytePos);
      state.bytePos += 4 + length;
      if (state.bytePos > limit) return null;
    } else if (btype === 1 || btype === 2) {
      const tables =
        btype === 1
          ? { literal: FIXED_LITERAL_TABLE, distance: FIXED_DISTANCE_TABLE }
          : readDynamicTables(buffer, limit, state);
      if (tables === null) return null;
      for (;;) {
        const symbol = decodeSymbol(buffer, limit, state, tables.literal);
        if (symbol === null) return null;
        if (symbol === 256) break; // end of block
        if (symbol < 256) continue; // literal: nothing more to skip
        if (symbol > 285) return null;
        if (readBits(buffer, limit, state, LENGTH_EXTRA[symbol - 257] as number) === null) return null;
        const distance = decodeSymbol(buffer, limit, state, tables.distance);
        if (distance === null || distance > 29) return null;
        if (readBits(buffer, limit, state, DISTANCE_EXTRA[distance] as number) === null) return null;
      }
    } else {
      return null; // reserved block type
    }
    if (bfinal === 1) break;
  }
  if (!alignBits(limit, state)) return null;
  const end = state.bytePos + 4; // Adler-32
  if (end > limit) return null;
  return end;
}

/** Apply a git delta to `base`, verifying both sizes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= delta.length) throw new Error('delta size runs past the delta');
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy offset runs past the delta');
          copyOffset |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (at >= delta.length) throw new Error('delta copy size runs past the delta');
          copySize |= (delta[at] as number) << (8 * bit);
          at += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (at + op > delta.length) throw new Error('delta insert runs past the delta');
      parts.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  return Buffer.concat(parts);
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile. `resolveBase` supplies objects already in the store for
 * thin-pack REF_DELTA bases. Throws Error with a human detail on any
 * malformation; never returns a partial result.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack of ${pack.length} bytes is too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');

  const body = pack.subarray(0, pack.length - 20);
  const entries: RawEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    if (offset >= body.length) throw new Error('pack ends before its declared entry count');
    const first = body[offset] as number;
    offset += 1;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      if (offset >= body.length) throw new Error('pack entry size runs past the pack');
      byte = body[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeCode === OFS_DELTA) {
      const read = readOfsBase(body, offset);
      baseOffset = read.baseOffset;
      offset = read.next;
      if (baseOffset < 12 || baseOffset >= start) throw new Error('pack OFS_DELTA base offset is out of range');
    } else if (typeCode === REF_DELTA) {
      if (offset + 20 > body.length) throw new Error('pack REF_DELTA base runs past the pack');
      baseOid = body.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`unknown pack entry type ${typeCode}`);
    }
    const inflated = inflateEntry(body, offset, size);
    entries.push({ typeCode, size, start, baseOffset, baseOid, data: inflated.data, endOffset: inflated.next });
    offset = inflated.next;
  }
  if (offset !== body.length) throw new Error('pack has trailing bytes after its entries');

  const byOffset = new Map<number, RawEntry>();
  for (const entry of entries) byOffset.set(entry.start, entry);
  const resolved = new Map<number, GitObject>();
  const resolving = new Set<number>();

  const resolveEntry = (start: number): GitObject => {
    const cached = resolved.get(start);
    if (cached !== undefined) return cached;
    if (resolving.has(start)) throw new Error('pack delta cycle');
    const entry = byOffset.get(start);
    if (entry === undefined) throw new Error('pack delta base offset names no entry');
    resolving.add(start);
    try {
      let object: GitObject;
      if (entry.typeCode === OFS_DELTA) {
        const base = resolveEntry(entry.baseOffset);
        object = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else if (entry.typeCode === REF_DELTA) {
        let base: GitObject | undefined;
        for (const candidate of entries) {
          if (candidate.start >= start) break;
          const resolvedCandidate = resolveEntry(candidate.start);
          if (hashObject(resolvedCandidate.type, resolvedCandidate.data) === entry.baseOid) {
            base = resolvedCandidate;
            break;
          }
        }
        if (base === undefined) base = resolveBase?.(entry.baseOid);
        if (base === undefined) throw new Error(`pack REF_DELTA base ${entry.baseOid} is not available`);
        object = { type: base.type, data: applyDelta(base.data, entry.data) };
      } else {
        object = { type: CODE_TYPES[entry.typeCode] as ObjectType, data: entry.data };
      }
      resolved.set(start, object);
      return object;
    } finally {
      resolving.delete(start);
    }
  };

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  for (const entry of entries) {
    if (entry.typeCode === OFS_DELTA || entry.typeCode === REF_DELTA) deltaCount += 1;
    const object = resolveEntry(entry.start);
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}

