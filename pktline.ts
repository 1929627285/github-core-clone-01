/**
 * pktline.ts — git's pkt-line framing: a 4-hex-digit length (header included),
 * `0000` flush, `0001` delim, `0002` response-end, and sideband channels.
 * Packets larger than 65,520 bytes total are refused.
 */
export const PKT_LINE_MAX = 65_520;
export const FLUSH = '0000';
export const DELIM = '0001';

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const total = data.length + 4;
  if (total > PKT_LINE_MAX) throw new Error(`pkt-line of ${total} bytes exceeds the ${PKT_LINE_MAX} maximum`);
  const header = total.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export function pktFlush(): Buffer {
  return Buffer.from(FLUSH, 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from(DELIM, 'ascii');
}

export type PktItem =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export interface PktParse {
  items: PktItem[];
  /** Offset just past the last parsed packet (the start of any trailing bytes). */
  consumed: number;
}

/**
 * Parse pkt-lines from the start of `buffer` until the buffer ends or a flush is
 * hit (a flush ends the packet stream; `consumed` points past it). Throws on a
 * malformed length, an oversized packet, or a truncated packet.
 */
export function parsePktLines(buffer: Buffer, stopAtFlush = true): PktParse {
  const items: PktItem[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} out of range`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    items.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { items, consumed: offset };
}

/** The data payloads of a parsed stream, as UTF-8 strings, skipping controls. */
export function dataLines(items: readonly PktItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === 'data') out.push(item.payload.toString('utf8'));
  }
  return out;
}

/** One sideband packet: band byte + up to `chunkSize` bytes of data. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Pack data as sideband band-1 packets of at most `chunkSize` bytes each. */
export function sidebandChunked(data: Buffer, chunkSize = 32_768): Buffer[] {
  const packets: Buffer[] = [];
  if (data.length === 0) {
    packets.push(sidebandPacket(1, Buffer.alloc(0)));
    return packets;
  }
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    packets.push(sidebandPacket(1, data.subarray(offset, offset + chunkSize)));
  }
  return packets;
}
