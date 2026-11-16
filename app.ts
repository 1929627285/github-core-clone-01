/**
 * app.ts — the forge's HTTP server: one router over the four surfaces plus
 * /healthz. Auth is decided once per request and passed down; /healthz is
 * public. A handler failure answers 500 JSON and never takes the server down.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, matchGitRoute } from './git-http.ts';
import { handleGraphQL } from './graphql.ts';
import { authorized, sendError, sendJson } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { ForgeStore } from './store.ts';

async function route(req: IncomingMessage, res: ServerResponse, store: ForgeStore): Promise<void> {
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    sendError(res, 400, 'Bad Request');
    return;
  }

  if (pathname === '/healthz' || pathname === '/healthz/') {
    if (req.method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  const authed = authorized(store, req);

  if (pathname === '/mcp' || pathname === '/mcp/') {
    await handleMcp(req, res, store, authed);
    return;
  }
  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    await handleGraphQL(req, res, store, authed);
    return;
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    await handleRest(req, res, store, authed);
    return;
  }
  const gitRoute = matchGitRoute(pathname);
  if (gitRoute !== null) {
    await handleGit(req, res, store, gitRoute, query, authed);
    return;
  }
  sendError(res, 404, 'Not Found');
}

export function createApp(env: Record<string, string | undefined> = process.env): Server {
  const store = new ForgeStore(env);
  const server = createServer((req, res) => {
    void route(req, res, store).catch((err: unknown) => {
      try {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        else res.destroy();
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('error', (err: Error) => {
    process.stderr.write(`[forge] server error: ${err.message}\n`);
  });
  return server;
}
