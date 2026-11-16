# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nh0cksh0ck02/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nh0cksh0ck02/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

An in-process, high-performance GitHub-compatible forge written in TypeScript/Node 22 for the [make.fun bounty 'github-core-clone-01'](https://make.fun/bounty/github-core-clone-01).

## Architecture & Features

This repository implements the GitHub API surface required by the contest:
- **Zero Runtime Dependencies**: Built entirely using Node.js 22 built-in modules (`node:http`, `node:crypto`).
- **REST API v3**:
  - `GET /healthz`: Boot and liveness probe (no auth required).
  - `GET /api/v3/`: Root API endpoint returning hypermedia links and `X-OAuth-Scopes`.
  - `GET /api/v3/meta`: Version information (`installed_version: 1.0.0`).
  - `GET /api/v3/rate_limit`: Core and GraphQL rate limit resource meters.
  - `GET /api/v3/user`: Authenticated user profile (`adaiversen`).
  - `GET /api/v3/user/repos` & `POST /api/v3/user/repos`: Repository listing with RFC-5988 `Link` pagination header and repository creation.
  - `GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}`: Repository inspection, metadata patching, and removal.
  - `POST /api/v3/repos/{owner}/{repo}/git/refs`: Git reference and branch creation.
  - `GET /api/v3/repos/{owner}/{repo}/branches`: Branch enumeration with commit tip SHAs.
  - `GET /api/v3/repos/{owner}/{repo}/commits`: Commit history with optional branch/SHA filtering.
  - `GET / PUT / DELETE /api/v3/repos/{owner}/{repo}/contents/{path}`: File and directory manipulation, base64 content encoding, SHA-1 checksum verification, and 409 conflict detection for stale SHAs.
  - `GET / POST /api/v3/repos/{owner}/{repo}/labels`: Label management.
  - `GET / POST / PATCH /api/v3/repos/{owner}/{repo}/issues`: Issue lifecycle management, number sequence ordering, state filtering, sorting, and 422 validation on unknown labels.
  - `GET / POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments`: Comment threads on issues.
  - `GET / POST /api/v3/repos/{owner}/{repo}/pulls`: Pull request creation, head and base branch tip resolution.
  - `GET /api/v3/repos/{owner}/{repo}/pulls/{number}`: Detailed pull request status.
  - `GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files`: Changed files diff overview.
  - `PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge`: Squash merge support, base branch tip update, merge conflict detection (405).
- **GraphQL v4 (`POST /api/graphql`)**:
  - Viewer login query resolution.
  - Introspection support (`__type` for `Issue`, `PullRequest`, `Repository`, `SearchType`).
  - Relay Global Node queries (`node(id: $id)`).
  - Issue and Pull Request querying, cursor-based pagination (`IssuesPage`).
  - Mutations: `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`.
  - Batched GraphQL operations support.
- **Model Context Protocol (`POST /mcp`)**:
  - Full JSON-RPC 2.0 implementation supporting both modern (`server/discover`) and legacy (`initialize`) discovery/handshake protocols.
  - Tools listing (`tools/list`) and invocation (`tools/call`):
    - `create_repo`
    - `get_repo`
    - `create_issue`
    - `list_issues`
    - `create_pull_request`
    - `merge_pull_request`
  - Input schema validation and JSON-RPC error codes (`-32700`, `-32601`, `-32602`).
- **Standard Protocol Compliance**:
  - Every REST response is returned as `application/json; charset=utf-8`.
  - All responses include non-empty `X-GitHub-Request-Id` tracing headers.
  - Bearer token authentication against `$MAKEFUN_SHOP_TOKEN`.

## Running the Server

Start the server using Node 22:

```sh
node --experimental-strip-types main.ts
```

## Lifecycle (`main.ts`)

1. Binds ephemeral port `0` (avoiding port `8080` reserved for the evaluation environment).
2. Registers port with `POST $MAKEFUN_ENV_URL/register`.
3. Polls `GET $MAKEFUN_ENV_URL/done` until completion signal is received (`{"done": true}`).
4. Gracefully shuts down the HTTP server and exits 0.

## License

MIT
