<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Workspace client conformance tests

Worker V2-25, Fase 1. An in-memory mock server plus `node:test`
conformance cases for the 24 canonical workspace/files HTTP routes in
`fase1/kontrak-api-kanonis.md` section 3.1 (binding), with domain
semantics from `fase1/desain-workspace-api.md` (V1-09). No real
backend implementation lives here: the mock holds state in memory
only, with no disk and no database.

## Routes covered (24)

| Method + path | File |
|---|---|
| `GET /api/workspace/list` | files-crud |
| `GET /api/workspace/file` | files-crud |
| `HEAD /api/workspace/file` | files-crud |
| `PUT /api/workspace/file` | files-crud, guards |
| `POST /api/workspace/file/append` | guards |
| `POST /api/workspace/file/patch` | guards |
| `POST /api/workspace/mkdir` | files-crud |
| `POST /api/workspace/move` | move |
| `POST /api/workspace/move/repair-links` | move |
| `DELETE /api/workspace/file` | trash |
| `DELETE /api/workspace/folder` | trash |
| `POST /api/workspace/trash` | trash |
| `GET /api/workspace/scan` | files-crud |
| `GET /api/workspace/stat` | files-crud |
| `GET /api/workspace/media/<path>` | media |
| `HEAD /api/workspace/media/<path>` | media |
| `POST /api/workspace/media` | media |
| `PUT /api/workspace/media` | media |
| `GET /api/workspace/trash` | trash |
| `POST /api/workspace/trash/{id}/restore` | trash |
| `DELETE /api/workspace/trash/{id}` | trash |
| `DELETE /api/workspace/trash` | trash |
| `POST /api/workspace/reconcile` | reconcile |
| `GET /api/workspace/reconcile` | reconcile |

Cross-cutting cases live in `auth.test.mjs`: session auth (401),
CSRF plus Origin checks (403), Bearer rejection, 405 handling, the
error envelope, and `X-Request-Id` echo. The WebSocket channel
(contract section 3.15) is out of scope for this suite.

Every route has at least one success case and at least one typed
error case. Header-guarded writes (`PUT` file, `PUT` media, guarded
`POST` media, guarded move) have a 412 `revision_conflict` case;
body-guarded writes (append, patch) have a 409 case instead, per the
canonical contract.

## Running

Mock mode (default, no dependencies beyond Node 20+):

```sh
node --test tests/workspace-client/*.test.mjs
```

Real-backend mode: point the suite at a deployed backend. Auth comes
from the environment. Fixture-dependent cases are skipped there.

```sh
WORKSPACE_BASE_URL=https://example.invalid \
WORKSPACE_COOKIE='session=...' \
WORKSPACE_CSRF_TOKEN='...' \
WORKSPACE_ORIGIN=https://example.invalid \
node --test tests/workspace-client/*.test.mjs
```

Standalone mock server (manual probing only):

```sh
PORT=3101 node tests/workspace-client/mock-server.mjs
```

## Files

- `mock-server.mjs`: the mock. Exports `startMockServer`,
  `createMockServer`, `computeRevision`, `validateWorkspacePath`, and
  the fixed test credentials below. Test-only fixtures
  (`injectFile`, `injectDir`, `injectSymlink`, `markBlobMissing`)
  plant states the API itself refuses to create.
- `helpers.mjs`: per-file context setup, an authenticated `request`
  helper with auth variants (`full`, `no-cookie`, `no-csrf`,
  `no-origin`, `bearer`, `none`), envelope assertions, and
  convenience operations. Each test file gets a fresh mock server
  and a unique path prefix, so files run in parallel safely.
- `*.test.mjs`: one file per route group (see the table above).

## Mock credentials

Fixed test values, not secrets. They exist only so the suite can
exercise the 401/403 contract paths:

- Session cookie: `session=mock-session`
- CSRF token: `mock-csrf`
- Workspace key for revision hashing: `mock-workspace`

## Notes for maintainers

- The repo `.gitignore` ignores `*.test.*`, so the `*.test.mjs`
  files in this directory are force-tracked (`git add -f`). Do not
  remove them from the index; a fresh clone that drops them loses
  the suite silently because the files still exist locally.
- `Range` support is SHOULD in V1-09: Range cases assert 206/416
  strictly in mock mode and accept a 200 full-body fallback against
  a real backend.
- HEAD responses never carry a body, so HEAD error cases assert
  status plus an empty body, not the error envelope.
- Size limits are "exceeds N": exactly 2 MiB of text, exactly 64 KiB
  of JSON, and exactly 20 MiB of media pass; one byte more fails.
  The suite pins all three boundaries.
