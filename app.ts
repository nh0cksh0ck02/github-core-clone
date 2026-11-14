// The GitHub core clone server implementation
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

function requestId(): string {
  return 'req_' + Math.random().toString(36).substring(2, 12);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}'
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    if (method === 'GET' && path === '/api/v3/user') {
      sendJson(res, 200, {
        login: 'octocat',
        id: 1,
        node_id: 'MDQ6VXNlcjE=',
        type: 'User',
        site_admin: false
      });
      return;
    }

    if (method === 'GET' && path === '/api/v3/rate_limit') {
      sendJson(res, 200, {
        resources: {
          core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
          graphql: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 }
        }
      });
      return;
    }

    if (method === 'GET' && path === '/api/v3/octocat') {
      const text = '               MMM.           .MMM\n               MMMMMMMMMMMMMMMMMMM\n               MMMMMMMMMMMMMMMMMMM\n              MMMMMMMMMMMMMMMMMMMMM\n             MMMMMMMMMMMMMMMMMMMMMMM\n            MMMMMMMMMMMMMMMMMMMMMMMMM\n            MMMM\'  \'MMMMM\'  \'MMMMMMMM\n            MMMM    MMMM    MMMMMMMMM\n            MMMMMMMMMMMMMMMMMMMMMMMMM\n            MMMMMMMMMMMMMMMMMMMMMMMMM\n            MMMMMMMMMMMMMMMMMMMMMMMMM\n            MMMMMMMMMMMMMMMMMMMMMMMMM\n             MMMMMMMMMMMMMMMMMMMMMMM\n              MMMMMMMMMMMMMMMMMMMMM\n                MMMMMMMMMMMMMMMMM\n                  \'MMMMMMMMMMM\'\n';
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-github-request-id': requestId()
      });
      res.end(text);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  });
}
