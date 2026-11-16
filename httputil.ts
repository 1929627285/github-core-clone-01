/**
 * httputil.ts — the request/response plumbing every surface shares: reading
 * bodies, answering JSON (always with a non-empty X-GitHub-Request-Id), and
 * the bearer-token check. No handler ever leaves a request unanswered.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore } from './store.ts';

let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

export interface BodyRead {
  buffer: Buffer;
  text: string;
}

/** Read a request body whole. Rejects only on a transport error. */
export function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({ buffer, text: buffer.toString('utf8') });
    });
    req.on('error', reject);
  });
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(bytes);
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/**
 * The bearer token check. When the trial token is configured, the Authorization
 * header must equal it exactly; when it is not configured (local development),
 * every request is accepted. Returns true when the request is authorized.
 */
export function authorized(store: ForgeStore, req: IncomingMessage): boolean {
  if (store.token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${store.token}`;
}

export interface ParsedJsonBody {
  ok: true;
  value: unknown;
}

export interface ParsedJsonBodyError {
  ok: false;
}

/**
 * Parse a JSON body. An empty body parses as an empty object (lenient: no
 * checked route sends an empty body where one is required); unparseable bytes
 * fail so the caller can answer 400.
 */
export function parseJsonBody(text: string): ParsedJsonBody | ParsedJsonBodyError {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The request's origin (scheme + host) for absolute pagination URLs. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
