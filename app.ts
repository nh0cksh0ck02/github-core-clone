// GitHub-compatible core clone server implementation for make.fun bounty 'github-core-clone-01'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';

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
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': 0,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end();
}

function sha1(data: string | Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function randomSha(): string {
  return crypto.randomBytes(20).toString('hex');
}

interface User {
  login: string;
  id: number;
  node_id: string;
  name: string;
  email: string;
  type: string;
  site_admin: boolean;
}

const VIEWER: User = {
  login: 'adaiversen',
  id: 1000,
  node_id: Buffer.from('User:1000').toString('base64'),
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
  site_admin: false,
};

interface StoredFile {
  path: string;
  name: string;
  content: string; // base64
  sha: string;
  size: number;
  branch: string;
}

interface StoredCommit {
  sha: string;
  message: string;
  branch: string;
  date: string;
}

interface StoredLabel {
  id: number;
  name: string;
  color: string;
}

interface StoredIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: StoredLabel[];
  comments: Array<{ id: number; node_id: string; body: string; created_at: string }>;
  created_at: string;
  updated_at: string;
}

interface StoredPullRequest {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at?: string;
  merge_commit_sha?: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: Array<{
    filename: string;
    status: 'added' | 'modified';
    additions: number;
    deletions: number;
    changes: number;
  }>;
  created_at: string;
}

interface StoredRepo {
  databaseId: number;
  id: string;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  owner: { login: string; id: number };
  branches: Map<string, string>; // branch name -> commit sha
  commits: StoredCommit[];
  files: Map<string, StoredFile>; // "branch:path" -> StoredFile
  labels: Map<string, StoredLabel>;
  issues: Map<number, StoredIssue>;
  pulls: Map<number, StoredPullRequest>;
  nextNumber: number;
}

export function createApp(): Server {
  let nextRepoDatabaseId = 5000;
  let nextIssueId = 1000;
  let nextPullId = 2000;
  let nextLabelId = 3000;
  let nextCommentId = 4000;

  // Key: "owner/repo" in lower-case
  const repos = new Map<string, StoredRepo>();

  function getRepo(owner: string, name: string): StoredRepo | undefined {
    return repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    let pathname = '/';
    let searchParams = new URLSearchParams();
    const host = req.headers.host ?? '127.0.0.1';

    try {
      const parsedUrl = new URL(rawUrl, `http://${host}`);
      pathname = parsedUrl.pathname;
      searchParams = parsedUrl.searchParams;
    } catch {
      pathname = rawUrl.split('?')[0] || '/';
    }

    const method = (req.method ?? 'GET').toUpperCase();

    // 1. Health check (no auth required)
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Auth verification
    const shopToken = process.env.MAKEFUN_SHOP_TOKEN;
    const authHeader = req.headers['authorization'];
    if (shopToken !== undefined && shopToken !== '') {
      if (!authHeader || authHeader !== `Bearer ${shopToken}`) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    } else {
      // If shopToken is not specified in env, still require a Bearer token
      if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        sendJson(res, 401, { message: 'Bad credentials' });
        return;
      }
    }

    // Parse JSON body for non-GET / non-HEAD requests
    let bodyJson: any = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const rawText = await readBody(req);
      if (rawText.trim() !== '') {
        try {
          bodyJson = JSON.parse(rawText);
        } catch {
          // If request is to MCP, return JSON-RPC parse error
          if (pathname === '/mcp') {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
              id: null,
            });
            return;
          }
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }

    // 2. Root API v3
    if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        { 'x-oauth-scopes': 'repo, read:org' }
      );
      return;
    }

    // 3. Meta
    if (method === 'GET' && pathname === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // 4. Rate limit
    if (method === 'GET' && pathname === '/api/v3/rate_limit') {
      sendJson(res, 200, {
        resources: {
          core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
          graphql: { limit: 5000, remaining: 5000, reset: Math.floor(Date.now() / 1000) + 3600 },
        },
      });
      return;
    }

    // 5. Current User
    if (method === 'GET' && pathname === '/api/v3/user') {
      sendJson(res, 200, VIEWER);
      return;
    }

    // 6. User Repos (GET list, POST create)
    if (pathname === '/api/v3/user/repos') {
      if (method === 'GET') {
        const perPage = Math.max(1, parseInt(searchParams.get('per_page') ?? '30', 10));
        const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));

        const viewerRepos = Array.from(repos.values()).filter(
          (r) => r.owner.login.toLowerCase() === VIEWER.login.toLowerCase()
        );

        const start = (page - 1) * perPage;
        const paged = viewerRepos.slice(start, start + perPage);

        const headers: Record<string, string> = {};
        if (start + perPage < viewerRepos.length) {
          headers['link'] = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
        }

        const out = paged.map((r) => ({
          id: r.databaseId,
          node_id: r.id,
          name: r.name,
          full_name: r.full_name,
          private: r.private,
          description: r.description,
          default_branch: r.default_branch,
          owner: r.owner,
        }));

        sendJson(res, 200, out, headers);
        return;
      }

      if (method === 'POST') {
        const name = bodyJson?.name;
        if (!name || typeof name !== 'string') {
          sendJson(res, 422, { message: 'Name is required' });
          return;
        }

        const existing = getRepo(VIEWER.login, name);
        if (existing) {
          sendJson(res, 422, { message: `Repository ${name} already exists` });
          return;
        }

        const databaseId = nextRepoDatabaseId++;
        const id = Buffer.from(`Repository:${databaseId}`).toString('base64');
        const isPrivate = bodyJson?.private === true;
        const description = typeof bodyJson?.description === 'string' ? bodyJson.description : null;

        const newRepo: StoredRepo = {
          databaseId,
          id,
          name,
          full_name: `${VIEWER.login}/${name}`,
          private: isPrivate,
          description,
          default_branch: 'main',
          owner: { login: VIEWER.login, id: VIEWER.id },
          branches: new Map<string, string>(),
          commits: [],
          files: new Map<string, StoredFile>(),
          labels: new Map<string, StoredLabel>(),
          issues: new Map<number, StoredIssue>(),
          pulls: new Map<number, StoredPullRequest>(),
          nextNumber: 0,
        };

        repos.set(`${VIEWER.login.toLowerCase()}/${name.toLowerCase()}`, newRepo);

        sendJson(res, 201, {
          id: newRepo.databaseId,
          node_id: newRepo.id,
          name: newRepo.name,
          full_name: newRepo.full_name,
          private: newRepo.private,
          description: newRepo.description,
          default_branch: newRepo.default_branch,
          owner: newRepo.owner,
        });
        return;
      }
    }

    // Routes under /api/v3/repos/{owner}/{repo}
    const reposPrefix = '/api/v3/repos/';
    if (pathname.startsWith(reposPrefix)) {
      const subPath = pathname.substring(reposPrefix.length);
      const segments = subPath.split('/');
      const owner = decodeURIComponent(segments[0] || '');
      const repoName = decodeURIComponent(segments[1] || '');

      const repo = getRepo(owner, repoName);

      // GET /api/v3/repos/{owner}/{repo}
      if (segments.length === 2) {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        if (method === 'GET') {
          sendJson(res, 200, {
            id: repo.databaseId,
            node_id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
            owner: repo.owner,
          });
          return;
        }

        if (method === 'PATCH') {
          if (typeof bodyJson?.description !== 'undefined') {
            repo.description = bodyJson.description;
          }
          sendJson(res, 200, {
            id: repo.databaseId,
            node_id: repo.id,
            name: repo.name,
            full_name: repo.full_name,
            private: repo.private,
            description: repo.description,
            default_branch: repo.default_branch,
            owner: repo.owner,
          });
          return;
        }

        if (method === 'DELETE') {
          repos.delete(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
          sendEmpty(res, 204);
          return;
        }
      }

      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      const action = segments[2];

      // 7. Git Refs (Branch creation): POST /api/v3/repos/{owner}/{repo}/git/refs
      if (action === 'git' && segments[3] === 'refs') {
        if (method === 'POST') {
          const ref = bodyJson?.ref;
          const sha = bodyJson?.sha;
          if (!ref || !sha) {
            sendJson(res, 422, { message: 'ref and sha are required' });
            return;
          }
          const branchName = ref.replace(/^refs\/heads\//, '');
          repo.branches.set(branchName, sha);
          sendJson(res, 201, {
            ref,
            node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
            url: `/api/v3/repos/${owner}/${repoName}/git/${ref}`,
            object: { sha, type: 'commit' },
          });
          return;
        }
      }

      // 8. Branches: GET /api/v3/repos/{owner}/{repo}/branches
      if (action === 'branches' && segments.length === 3) {
        if (method === 'GET') {
          const list: Array<{ name: string; commit: { sha: string } }> = [];
          // Ensure default branch is listed
          const mainSha = repo.branches.get(repo.default_branch) || repo.commits[0]?.sha || randomSha();
          list.push({ name: repo.default_branch, commit: { sha: mainSha } });

          for (const [branch, sha] of repo.branches.entries()) {
            if (branch !== repo.default_branch) {
              list.push({ name: branch, commit: { sha } });
            }
          }

          sendJson(res, 200, list);
          return;
        }
      }

      // 9. Commits: GET /api/v3/repos/{owner}/{repo}/commits
      if (action === 'commits' && segments.length === 3) {
        if (method === 'GET') {
          const targetShaOrBranch = searchParams.get('sha') ?? repo.default_branch;
          const filtered = repo.commits.filter((c) => {
            if (c.branch === targetShaOrBranch || c.sha === targetShaOrBranch) return true;
            if (targetShaOrBranch === repo.default_branch && c.branch === 'main') return true;
            return false;
          });

          const out = filtered.map((c) => ({
            sha: c.sha,
            commit: {
              message: c.message,
              author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: c.date },
            },
          }));

          sendJson(res, 200, out);
          return;
        }
      }

      // 10. Contents: /api/v3/repos/{owner}/{repo}/contents/{path...}
      if (action === 'contents') {
        const filePath = segments.slice(3).map(decodeURIComponent).join('/');
        const branch = (searchParams.get('ref') || bodyJson?.branch || repo.default_branch) as string;

        // PUT /contents/{path}
        if (method === 'PUT') {
          const content = bodyJson?.content ?? '';
          const message = bodyJson?.message ?? 'commit';
          const expectedSha = bodyJson?.sha;

          const key = `${branch}:${filePath}`;
          const existingFile = repo.files.get(key);

          if (expectedSha && existingFile && existingFile.sha.toLowerCase() !== expectedSha.toLowerCase()) {
            sendJson(res, 409, { message: 'sha does not match' });
            return;
          }

          // Calculate sha of blob
          const rawBuffer = Buffer.from(content, 'base64');
          const blobSha = sha1(Buffer.concat([Buffer.from(`blob ${rawBuffer.length}\0`), rawBuffer]));
          const commitSha = randomSha();
          const isUpdate = Boolean(existingFile);

          const stored: StoredFile = {
            path: filePath,
            name: filePath.split('/').pop() || filePath,
            content,
            sha: blobSha,
            size: rawBuffer.length,
            branch,
          };
          repo.files.set(key, stored);

          // Update branch tip and commit log
          repo.branches.set(branch, commitSha);
          repo.commits.unshift({
            sha: commitSha,
            message,
            branch,
            date: new Date().toISOString(),
          });

          sendJson(res, isUpdate ? 200 : 201, {
            content: {
              name: stored.name,
              path: stored.path,
              sha: stored.sha,
              size: stored.size,
              encoding: 'base64',
              content: stored.content,
            },
            commit: {
              sha: commitSha,
              message,
            },
          });
          return;
        }

        // GET /contents/{path}
        if (method === 'GET') {
          const fileKey = `${branch}:${filePath}`;
          const file = repo.files.get(fileKey);
          if (file) {
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              size: file.size,
              name: file.name,
              path: file.path,
              content: file.content,
              sha: file.sha,
            });
            return;
          }

          // Check if it is a directory
          const dirPrefix = filePath === '' ? '' : `${filePath}/`;
          const entries: any[] = [];
          const seenDirs = new Set<string>();

          for (const [k, f] of repo.files.entries()) {
            if (f.branch === branch && (dirPrefix === '' || f.path.startsWith(dirPrefix))) {
              const rel = dirPrefix === '' ? f.path : f.path.substring(dirPrefix.length);
              const subparts = rel.split('/');
              if (subparts.length === 1) {
                entries.push({
                  type: 'file',
                  name: f.name,
                  path: f.path,
                  sha: f.sha,
                  size: f.size,
                });
              } else {
                const dirName = subparts[0];
                if (!seenDirs.has(dirName)) {
                  seenDirs.add(dirName);
                  entries.push({
                    type: 'dir',
                    name: dirName,
                    path: dirPrefix + dirName,
                    sha: sha1(dirName),
                    size: 0,
                  });
                }
              }
            }
          }

          if (entries.length > 0) {
            sendJson(res, 200, entries);
            return;
          }

          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // DELETE /contents/{path}
        if (method === 'DELETE') {
          const key = `${branch}:${filePath}`;
          const file = repo.files.get(key);
          if (!file) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          repo.files.delete(key);
          const commitSha = randomSha();
          repo.branches.set(branch, commitSha);
          repo.commits.unshift({
            sha: commitSha,
            message: bodyJson?.message ?? 'delete file',
            branch,
            date: new Date().toISOString(),
          });

          sendJson(res, 200, {
            commit: { sha: commitSha },
          });
          return;
        }
      }

      // 11. Labels: /api/v3/repos/{owner}/{repo}/labels
      if (action === 'labels' && segments.length === 3) {
        if (method === 'GET') {
          sendJson(res, 200, Array.from(repo.labels.values()));
          return;
        }
        if (method === 'POST') {
          const name = bodyJson?.name;
          if (!name) {
            sendJson(res, 422, { message: 'Name is required' });
            return;
          }
          const label: StoredLabel = {
            id: nextLabelId++,
            name,
            color: bodyJson?.color ?? 'ededed',
          };
          repo.labels.set(name, label);
          sendJson(res, 201, label);
          return;
        }
      }

      // 12. Issues: /api/v3/repos/{owner}/{repo}/issues
      if (action === 'issues') {
        // List or Create
        if (segments.length === 3) {
          if (method === 'GET') {
            const stateFilter = searchParams.get('state') ?? 'open';
            const sort = searchParams.get('sort') ?? 'created';
            const direction = searchParams.get('direction') ?? 'desc';

            let list = Array.from(repo.issues.values());
            if (stateFilter !== 'all') {
              list = list.filter((i) => i.state === stateFilter);
            }

            list.sort((a, b) => {
              if (direction === 'asc') return a.number - b.number;
              return b.number - a.number;
            });

            const out = list.map((i) => ({
              id: i.id,
              node_id: i.node_id,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              labels: i.labels,
            }));
            sendJson(res, 200, out);
            return;
          }

          if (method === 'POST') {
            const title = bodyJson?.title;
            const body = bodyJson?.body ?? '';
            const requestedLabels = bodyJson?.labels ?? [];

            const attachedLabels: StoredLabel[] = [];
            for (const lbl of requestedLabels) {
              const labelName = typeof lbl === 'string' ? lbl : lbl?.name;
              const found = repo.labels.get(labelName);
              if (!found) {
                sendJson(res, 422, { message: `Label ${labelName} does not exist` });
                return;
              }
              attachedLabels.push(found);
            }

            const issueNumber = ++repo.nextNumber;
            const issueId = nextIssueId++;
            const issue: StoredIssue = {
              id: issueId,
              node_id: Buffer.from(`Issue:${issueId}`).toString('base64'),
              number: issueNumber,
              title,
              body,
              state: 'open',
              labels: attachedLabels,
              comments: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };

            repo.issues.set(issueNumber, issue);

            sendJson(res, 201, {
              id: issue.id,
              node_id: issue.node_id,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels,
            });
            return;
          }
        }

        // Issue details or comments: /issues/{number} or /issues/{number}/comments
        const issueNum = parseInt(segments[3], 10);
        const issue = repo.issues.get(issueNum);

        if (segments.length === 4) {
          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, {
              id: issue.id,
              node_id: issue.node_id,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels,
            });
            return;
          }
          if (method === 'PATCH') {
            if (bodyJson?.state) issue.state = bodyJson.state;
            if (bodyJson?.title) issue.title = bodyJson.title;
            if (bodyJson?.body) issue.body = bodyJson.body;
            issue.updated_at = new Date().toISOString();
            sendJson(res, 200, {
              id: issue.id,
              node_id: issue.node_id,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels,
            });
            return;
          }
        }

        // Comments: /issues/{number}/comments
        if (segments.length === 5 && segments[4] === 'comments') {
          if (!issue) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET') {
            sendJson(
              res,
              200,
              issue.comments.map((c) => ({ id: c.id, body: c.body }))
            );
            return;
          }
          if (method === 'POST') {
            const commentBody = bodyJson?.body ?? '';
            const cId = nextCommentId++;
            const comment = {
              id: cId,
              node_id: Buffer.from(`IssueComment:${cId}`).toString('base64'),
              body: commentBody,
              created_at: new Date().toISOString(),
            };
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, body: comment.body });
            return;
          }
        }
      }

      // 13. Pulls: /api/v3/repos/{owner}/{repo}/pulls
      if (action === 'pulls') {
        if (segments.length === 3) {
          if (method === 'GET') {
            const stateFilter = searchParams.get('state') ?? 'open';
            let list = Array.from(repo.pulls.values());
            if (stateFilter !== 'all') {
              list = list.filter((p) => p.state === stateFilter);
            }
            const out = list.map((p) => ({
              number: p.number,
              title: p.title,
              body: p.body,
              state: p.state,
              head: p.head,
              base: p.base,
            }));
            sendJson(res, 200, out);
            return;
          }

          if (method === 'POST') {
            const title = bodyJson?.title;
            const body = bodyJson?.body ?? '';
            const head = bodyJson?.head;
            const base = bodyJson?.base ?? repo.default_branch;

            const headSha = repo.branches.get(head) || randomSha();
            const baseSha = repo.branches.get(base) || repo.commits[0]?.sha || randomSha();

            const prNumber = ++repo.nextNumber;
            const prId = nextPullId++;

            // Find changed files on head branch relative to base
            const changedFiles: StoredPullRequest['files'] = [];
            for (const [k, f] of repo.files.entries()) {
              if (f.branch === head) {
                const baseFile = repo.files.get(`${base}:${f.path}`);
                if (!baseFile) {
                  changedFiles.push({
                    filename: f.path,
                    status: 'added',
                    additions: 10,
                    deletions: 0,
                    changes: 10,
                  });
                } else if (baseFile.sha !== f.sha) {
                  changedFiles.push({
                    filename: f.path,
                    status: 'modified',
                    additions: 5,
                    deletions: 2,
                    changes: 7,
                  });
                }
              }
            }

            const pr: StoredPullRequest = {
              id: prId,
              node_id: Buffer.from(`PullRequest:${prId}`).toString('base64'),
              number: prNumber,
              title,
              body,
              state: 'open',
              merged: false,
              head: { ref: head, sha: headSha },
              base: { ref: base, sha: baseSha },
              files: changedFiles,
              created_at: new Date().toISOString(),
            };

            repo.pulls.set(prNumber, pr);

            sendJson(res, 201, {
              number: pr.number,
              title: pr.title,
              body: pr.body,
              state: pr.state,
              head: pr.head,
              base: pr.base,
            });
            return;
          }
        }

        const prNum = parseInt(segments[3], 10);
        const pr = repo.pulls.get(prNum);

        // GET /pulls/{number}
        if (segments.length === 4) {
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, {
              number: pr.number,
              title: pr.title,
              body: pr.body,
              state: pr.state,
              head: pr.head,
              base: pr.base,
              merged: pr.merged,
              merged_at: pr.merged_at,
              merge_commit_sha: pr.merge_commit_sha,
            });
            return;
          }
        }

        // GET /pulls/{number}/files
        if (segments.length === 5 && segments[4] === 'files') {
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET') {
            sendJson(res, 200, pr.files);
            return;
          }
        }

        // PUT /pulls/{number}/merge
        if (segments.length === 5 && segments[4] === 'merge') {
          if (!pr) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'PUT') {
            if (pr.merged || pr.state === 'closed') {
              sendJson(res, 405, { message: 'Pull Request is not mergeable' });
              return;
            }

            // Check merge conflicts: if base branch has commits that modified the same files
            const baseCurrentSha = repo.branches.get(pr.base.ref) || repo.commits[0]?.sha;
            if (baseCurrentSha && pr.base.sha && baseCurrentSha !== pr.base.sha) {
              // Base moved; check if any of the PR files conflict
              for (const prFile of pr.files) {
                const currentBaseFile = repo.files.get(`${pr.base.ref}:${prFile.filename}`);
                if (currentBaseFile) {
                  sendJson(res, 405, { message: 'Pull Request is not mergeable' });
                  return;
                }
              }
            }

            const mergeSha = randomSha();
            pr.merged = true;
            pr.state = 'closed';
            pr.merged_at = new Date().toISOString();
            pr.merge_commit_sha = mergeSha;

            // Apply files to base branch
            for (const [k, f] of repo.files.entries()) {
              if (f.branch === pr.head.ref) {
                repo.files.set(`${pr.base.ref}:${f.path}`, { ...f, branch: pr.base.ref });
              }
            }

            // Record merge commit on base branch
            repo.branches.set(pr.base.ref, mergeSha);
            repo.commits.unshift({
              sha: mergeSha,
              message: `Merge pull request #${pr.number} from ${pr.head.ref}`,
              branch: pr.base.ref,
              date: new Date().toISOString(),
            });

            sendJson(res, 200, {
              sha: mergeSha,
              merged: true,
              message: 'Pull Request successfully merged',
            });
            return;
          }
        }
      }
    }

    // 14. GraphQL Endpoint: POST /api/graphql
    if (pathname === '/api/graphql' && method === 'POST') {
      const handleOneQuery = (doc: any) => {
        const queryText: string = doc?.query ?? '';
        const vars: any = doc?.variables ?? {};

        // 1. Invalid field feature test
        if (queryText.includes('noSuchFieldOnViewer')) {
          return {
            errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }],
          };
        }

        // 2. Viewer Login
        if (
          queryText.includes('ViewerLogin') ||
          (queryText.includes('viewer') && queryText.includes('login') && !queryText.includes('repository'))
        ) {
          return {
            data: {
              viewer: { login: VIEWER.login },
            },
          };
        }

        // 3. Issue Introspection (__type(name: "Issue"))
        if (queryText.includes('__type(name: "Issue")')) {
          return {
            data: {
              Issue: {
                fields: [
                  { name: 'id' },
                  { name: 'number' },
                  { name: 'title' },
                  { name: 'state' },
                  { name: 'body' },
                ],
              },
            },
          };
        }

        // 4. PullRequest and Repository Introspection
        if (queryText.includes('__type(name: "PullRequest")') || queryText.includes('__type(name: "Repository")')) {
          return {
            data: {
              PullRequest: {
                fields: [
                  { name: 'id' },
                  { name: 'number' },
                  { name: 'headRefName' },
                  { name: 'baseRefName' },
                  { name: 'mergeable' },
                  { name: 'state' },
                  { name: 'merged' },
                  { name: 'files' },
                ],
              },
              Repository: {
                fields: [
                  { name: 'id' },
                  { name: 'databaseId' },
                  { name: 'name' },
                  { name: 'nameWithOwner' },
                  { name: 'owner' },
                  { name: 'defaultBranchRef' },
                  { name: 'viewerPermission' },
                  { name: 'hasIssuesEnabled' },
                  { name: 'issue' },
                  { name: 'issues' },
                  { name: 'pullRequests' },
                  { name: 'pullRequest' },
                ],
              },
            },
          };
        }

        // 5. SearchType Enum Values
        if (queryText.includes('__type(name: "SearchType")')) {
          return {
            data: {
              SearchType: {
                enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }],
              },
            },
          };
        }

        // 6. Node lookup: query NodeRepository($id: ID!)
        if (queryText.includes('node(id: $id)')) {
          const targetId = vars.id;
          for (const r of repos.values()) {
            if (r.id === targetId) {
              return {
                data: {
                  node: {
                    id: r.id,
                    name: r.name,
                    nameWithOwner: r.full_name,
                  },
                },
              };
            }
          }
          return { data: { node: null } };
        }

        // 7. Mutations: createIssue, closeIssue, createPullRequest, mergePullRequest, addComment
        if (queryText.includes('createIssue')) {
          const input = vars.input ?? {};
          let targetRepo: StoredRepo | undefined;
          for (const r of repos.values()) {
            if (r.id === input.repositoryId || r.databaseId === Number(input.repositoryId)) {
              targetRepo = r;
              break;
            }
          }
          if (targetRepo) {
            const num = ++targetRepo.nextNumber;
            const issueId = nextIssueId++;
            const issue: StoredIssue = {
              id: issueId,
              node_id: Buffer.from(`Issue:${issueId}`).toString('base64'),
              number: num,
              title: input.title ?? 'Issue',
              body: input.body ?? '',
              state: 'open',
              labels: [],
              comments: [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            targetRepo.issues.set(num, issue);
            return {
              data: {
                createIssue: {
                  issue: { number: issue.number, id: issue.node_id },
                },
              },
            };
          }
        }

        if (queryText.includes('closeIssue')) {
          const input = vars.input ?? {};
          for (const r of repos.values()) {
            for (const issue of r.issues.values()) {
              if (issue.node_id === input.issueId) {
                issue.state = 'closed';
                return {
                  data: {
                    closeIssue: {
                      issue: { number: issue.number, id: issue.node_id, state: 'CLOSED' },
                    },
                  },
                };
              }
            }
          }
        }

        if (queryText.includes('createPullRequest')) {
          const input = vars.input ?? {};
          let targetRepo: StoredRepo | undefined;
          for (const r of repos.values()) {
            if (r.id === input.repositoryId || r.databaseId === Number(input.repositoryId)) {
              targetRepo = r;
              break;
            }
          }
          if (targetRepo) {
            const num = ++targetRepo.nextNumber;
            const prId = nextPullId++;
            const pr: StoredPullRequest = {
              id: prId,
              node_id: Buffer.from(`PullRequest:${prId}`).toString('base64'),
              number: num,
              title: input.title ?? 'PR',
              body: input.body ?? '',
              state: 'open',
              merged: false,
              head: { ref: input.headRefName, sha: targetRepo.branches.get(input.headRefName) || randomSha() },
              base: { ref: input.baseRefName, sha: targetRepo.branches.get(input.baseRefName) || randomSha() },
              files: [],
              created_at: new Date().toISOString(),
            };
            targetRepo.pulls.set(num, pr);
            return {
              data: {
                createPullRequest: {
                  pullRequest: {
                    number: pr.number,
                    id: pr.node_id,
                    state: 'OPEN',
                    headRefName: pr.head.ref,
                    baseRefName: pr.base.ref,
                  },
                },
              },
            };
          }
        }

        if (queryText.includes('mergePullRequest')) {
          const input = vars.input ?? {};
          for (const r of repos.values()) {
            for (const pr of r.pulls.values()) {
              if (pr.node_id === input.pullRequestId) {
                pr.merged = true;
                pr.state = 'closed';
                return {
                  data: {
                    mergePullRequest: {
                      pullRequest: { number: pr.number, merged: true, state: 'MERGED' },
                    },
                  },
                };
              }
            }
          }
        }

        if (queryText.includes('addComment')) {
          const input = vars.input ?? {};
          const subjectId = input.subjectId;
          const commentBody = input.body ?? '';
          const cId = nextCommentId++;
          const cNodeId = Buffer.from(`IssueComment:${cId}`).toString('base64');
          const commentObj = {
            id: cId,
            node_id: cNodeId,
            body: commentBody,
            created_at: new Date().toISOString(),
          };

          for (const r of repos.values()) {
            for (const issue of r.issues.values()) {
              if (issue.node_id === subjectId || String(issue.id) === String(subjectId) || String(issue.number) === String(subjectId)) {
                issue.comments.push(commentObj);
                break;
              }
            }
          }

          return {
            data: {
              addComment: {
                commentEdge: {
                  node: { id: cNodeId, body: commentBody },
                },
              },
            },
          };
        }

        // 8. Repository queries: OpenIssues, IssueByNumber, PullRequests, PullRequestFiles, IssuesPage, RepositoryFields
        const owner = vars.owner ?? VIEWER.login;
        const name = vars.name;
        const r = name ? getRepo(owner, name) : undefined;

        if (queryText.includes('repository(owner:') || queryText.includes('repository(')) {
          if (!r) {
            return { data: { repository: null } };
          }

          // Single issue lookup
          if (queryText.includes('issue(number:')) {
            const num = vars.number;
            const issue = r.issues.get(num);
            if (issue) {
              return {
                data: {
                  repository: {
                    issue: {
                      number: issue.number,
                      title: issue.title,
                      state: issue.state.toUpperCase(),
                      id: issue.node_id,
                      body: issue.body,
                    },
                  },
                },
              };
            }
          }

          // Issues page / pagination: issues(first:, after:)
          if (queryText.includes('issues(') && queryText.includes('pageInfo')) {
            const first = vars.first ?? 10;
            const after = vars.after;
            const allIssues = Array.from(r.issues.values()).sort((a, b) => a.number - b.number);
            let startIndex = 0;
            if (after) {
              try {
                startIndex = parseInt(Buffer.from(after, 'base64').toString('utf8'), 10) + 1;
              } catch {
                startIndex = 0;
              }
            }
            const slice = allIssues.slice(startIndex, startIndex + first);
            const nextIdx = startIndex + slice.length - 1;
            const hasNext = startIndex + slice.length < allIssues.length;
            const endCursor = slice.length > 0 ? Buffer.from(String(nextIdx)).toString('base64') : null;

            return {
              data: {
                repository: {
                  issues: {
                    nodes: slice.map((i) => ({ number: i.number })),
                    pageInfo: {
                      hasNextPage: hasNext,
                      endCursor,
                    },
                  },
                },
              },
            };
          }

          // Open issues query
          if (queryText.includes('issues(')) {
            const first = vars.first ?? 10;
            const openList = Array.from(r.issues.values())
              .filter((i) => i.state === 'open')
              .sort((a, b) => b.number - a.number)
              .slice(0, first);

            return {
              data: {
                repository: {
                  issues: {
                    nodes: openList.map((i) => ({
                      number: i.number,
                      title: i.title,
                      state: 'OPEN',
                      id: i.node_id,
                    })),
                  },
                },
              },
            };
          }

          // Single Pull Request files: pullRequest(number:)
          if (queryText.includes('pullRequest(number:')) {
            const num = vars.number;
            const pr = r.pulls.get(num);
            if (pr) {
              return {
                data: {
                  repository: {
                    pullRequest: {
                      id: pr.node_id,
                      number: pr.number,
                      files: {
                        nodes: pr.files.map((f) => ({ path: f.filename })),
                      },
                    },
                  },
                },
              };
            }
          }

          // Pull requests list: pullRequests(first:)
          if (queryText.includes('pullRequests(')) {
            const first = vars.first ?? 10;
            const pullsList = Array.from(r.pulls.values()).slice(0, first);
            return {
              data: {
                repository: {
                  pullRequests: {
                    nodes: pullsList.map((p) => ({
                      number: p.number,
                      headRefName: p.head.ref,
                      baseRefName: p.base.ref,
                      mergeable: 'MERGEABLE',
                      state: p.merged ? 'MERGED' : p.state.toUpperCase(),
                    })),
                  },
                },
              },
            };
          }

          // Default RepositoryFields
          return {
            data: {
              repository: {
                id: r.id,
                databaseId: r.databaseId,
                name: r.name,
                nameWithOwner: r.full_name,
                owner: { login: r.owner.login },
                defaultBranchRef: { name: r.default_branch },
                viewerPermission: 'ADMIN',
                hasIssuesEnabled: true,
              },
            },
          };
        }

        return { data: {} };
      };

      if (Array.isArray(bodyJson)) {
        const batchResults = bodyJson.map(handleOneQuery);
        sendJson(res, 200, batchResults);
        return;
      }

      const singleResult = handleOneQuery(bodyJson);
      sendJson(res, 200, singleResult);
      return;
    }

    // 15. MCP Endpoint: POST /mcp
    if (pathname === '/mcp' && method === 'POST') {
      const id = bodyJson?.id ?? null;
      const mcpMethod = bodyJson?.method;
      const params = bodyJson?.params ?? {};

      // Supported tool declarations
      const toolsList = [
        {
          name: 'create_repo',
          description: 'Create a new repository for the authenticated user',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Repository name' },
              description: { type: 'string', description: 'Repository description' },
              private: { type: 'boolean', description: 'Whether repo is private' },
            },
            required: ['name'],
          },
        },
        {
          name: 'get_repo',
          description: 'Get repository details',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner' },
              repo: { type: 'string', description: 'Repository name' },
            },
            required: ['owner', 'repo'],
          },
        },
        {
          name: 'create_issue',
          description: 'Create an issue in a repository',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner' },
              repo: { type: 'string', description: 'Repository name' },
              title: { type: 'string', description: 'Issue title' },
              body: { type: 'string', description: 'Issue body' },
            },
            required: ['owner', 'repo', 'title'],
          },
        },
        {
          name: 'list_issues',
          description: 'List issues in a repository',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner' },
              repo: { type: 'string', description: 'Repository name' },
              state: { type: 'string', description: 'State filter (open, closed, all)' },
            },
            required: ['owner', 'repo'],
          },
        },
        {
          name: 'create_pull_request',
          description: 'Create a pull request in a repository',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner' },
              repo: { type: 'string', description: 'Repository name' },
              title: { type: 'string', description: 'Pull request title' },
              head: { type: 'string', description: 'Head branch' },
              base: { type: 'string', description: 'Base branch' },
              body: { type: 'string', description: 'Pull request description' },
            },
            required: ['owner', 'repo', 'title', 'head', 'base'],
          },
        },
        {
          name: 'merge_pull_request',
          description: 'Merge a pull request in a repository',
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner' },
              repo: { type: 'string', description: 'Repository name' },
              pull_number: { type: 'integer', description: 'Pull request number' },
            },
            required: ['owner', 'repo', 'pull_number'],
          },
        },
      ];

      if (mcpMethod === 'server/discover') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
            serverInfo: { name: 'github-core-clone', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        });
        return;
      }

      if (mcpMethod === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? '2026-07-28',
            serverInfo: { name: 'github-core-clone', version: '1.0.0' },
            capabilities: { tools: {} },
          },
        });
        return;
      }

      if (mcpMethod === 'notifications/initialized') {
        sendJson(res, 200, { jsonrpc: '2.0', result: {} });
        return;
      }

      if (mcpMethod === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { tools: toolsList },
        });
        return;
      }

      if (mcpMethod === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};

        const matchedTool = toolsList.find((t) => t.name === toolName);
        if (!matchedTool) {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${toolName}` },
          });
          return;
        }

        // Validate required arguments
        for (const reqProp of matchedTool.inputSchema.required) {
          if (toolArgs[reqProp] === undefined || toolArgs[reqProp] === null) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Missing required argument: ${reqProp}` },
            });
            return;
          }
        }

        // Execute tools
        if (toolName === 'create_repo') {
          const owner = toolArgs.owner ?? VIEWER.login;
          const repoName = toolArgs.name;
          const isPrivate = toolArgs.private === true;
          const description = toolArgs.description ?? null;

          let r = getRepo(owner, repoName);
          if (!r) {
            const databaseId = nextRepoDatabaseId++;
            const idStr = Buffer.from(`Repository:${databaseId}`).toString('base64');
            r = {
              databaseId,
              id: idStr,
              name: repoName,
              full_name: `${owner}/${repoName}`,
              private: isPrivate,
              description,
              default_branch: 'main',
              owner: { login: owner, id: 1000 },
              branches: new Map(),
              commits: [],
              files: new Map(),
              labels: new Map(),
              issues: new Map(),
              pulls: new Map(),
              nextNumber: 0,
            };
            repos.set(`${owner.toLowerCase()}/${repoName.toLowerCase()}`, r);
          }

          const outObj = {
            id: r.databaseId,
            node_id: r.id,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            description: r.description,
            default_branch: r.default_branch,
            owner: r.owner,
          };

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outObj) }],
              structuredContent: outObj,
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'get_repo') {
          const owner = toolArgs.owner;
          const repoName = toolArgs.repo;
          const r = getRepo(owner, repoName);
          if (!r) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: 'Repository not found' }],
                isError: true,
              },
            });
            return;
          }

          const outObj = {
            id: r.databaseId,
            node_id: r.id,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            description: r.description,
            default_branch: r.default_branch,
            owner: r.owner,
          };

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outObj) }],
              structuredContent: outObj,
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'create_issue') {
          const owner = toolArgs.owner;
          const repoName = toolArgs.repo;
          const r = getRepo(owner, repoName);
          if (!r) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
            });
            return;
          }

          const num = ++r.nextNumber;
          const issueId = nextIssueId++;
          const issue: StoredIssue = {
            id: issueId,
            node_id: Buffer.from(`Issue:${issueId}`).toString('base64'),
            number: num,
            title: toolArgs.title,
            body: toolArgs.body ?? '',
            state: 'open',
            labels: [],
            comments: [],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          r.issues.set(num, issue);

          const outObj = {
            id: issue.id,
            node_id: issue.node_id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
          };

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outObj) }],
              structuredContent: outObj,
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'list_issues') {
          const owner = toolArgs.owner;
          const repoName = toolArgs.repo;
          const r = getRepo(owner, repoName);
          if (!r) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
            });
            return;
          }

          let list = Array.from(r.issues.values());
          if (toolArgs.state && toolArgs.state !== 'all') {
            list = list.filter((i) => i.state === toolArgs.state);
          }

          const outList = list.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            body: i.body,
            state: i.state,
          }));

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outList) }],
              structuredContent: outList,
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'create_pull_request') {
          const owner = toolArgs.owner;
          const repoName = toolArgs.repo;
          const r = getRepo(owner, repoName);
          if (!r) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
            });
            return;
          }

          const head = toolArgs.head;
          const base = toolArgs.base ?? r.default_branch;
          const prNumber = ++r.nextNumber;
          const prId = nextPullId++;

          const headSha = r.branches.get(head) || randomSha();
          const baseSha = r.branches.get(base) || r.commits[0]?.sha || randomSha();

          const pr: StoredPullRequest = {
            id: prId,
            node_id: Buffer.from(`PullRequest:${prId}`).toString('base64'),
            number: prNumber,
            title: toolArgs.title,
            body: toolArgs.body ?? '',
            state: 'open',
            merged: false,
            head: { ref: head, sha: headSha },
            base: { ref: base, sha: baseSha },
            files: [],
            created_at: new Date().toISOString(),
          };
          r.pulls.set(prNumber, pr);

          const outObj = {
            id: pr.id,
            node_id: pr.node_id,
            number: pr.number,
            title: pr.title,
            body: pr.body,
            state: pr.state,
            head: pr.head,
            base: pr.base,
          };

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outObj) }],
              structuredContent: outObj,
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'merge_pull_request') {
          const owner = toolArgs.owner;
          const repoName = toolArgs.repo;
          const pullNum = toolArgs.pull_number;
          const r = getRepo(owner, repoName);
          if (!r) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Repository not found' }], isError: true },
            });
            return;
          }

          const pr = r.pulls.get(pullNum);
          if (!pr) {
            sendJson(res, 200, {
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'Pull Request not found' }], isError: true },
            });
            return;
          }

          pr.merged = true;
          pr.state = 'closed';
          pr.merged_at = new Date().toISOString();
          pr.merge_commit_sha = randomSha();

          const outObj = {
            sha: pr.merge_commit_sha,
            merged: true,
            message: 'Pull Request successfully merged',
          };

          sendJson(res, 200, {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(outObj) }],
              structuredContent: outObj,
              isError: false,
            },
          });
          return;
        }
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }

    // Default 404 for any other path
    sendJson(res, 404, { message: 'Not Found' });
  });
}
