<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Workspace conformance specs (V3-04cR, wave 3A)

Server-side conformance specs for the workspace read/write contract,
run against the REAL implementation modules. They complement the
client suite in `tests/workspace-client/` (164 cases, driven against
a live server by `real-runner.mjs`) and the V3-04b HTTP contract
specs in `server/test/workspace-write.spec.ts` (same wire behavior,
pinned against path/revision test doubles).

## What runs here

| File | What it pins |
|---|---|
| `real-ports.ts` | Test-only thin adapter: real V3-04a `paths.ts` / `revision.ts` behind the V3-04b write ports. Mirrors the adapter the integrator writes in `app.ts`. Never imported by `server/src/`. |
| `paths-conformance.spec.ts` | `validateWorkspacePath`, `assertNoSymlinkComponents`, text-file helpers: traversal, malformed spellings, limits, hidden flag, symlink refusal. |
| `revision-conformance.spec.ts` | `buildRevision` against an independent SHA-256 computation, `contentHash`, ETag parsing, `If-Match` / `If-None-Match` parsing, GET revalidation. |
| `write-conformance.spec.ts` | Real write routes over HTTP (`app.inject`): ETag/`If-Match` consistency, 412/409 conflict payloads with zero corruption, unknown-field rejection, traversal and symlink refusal, media guards. |

## Real vs fake in this wiring

Real: write routes, frozen auth hooks, guard parsers, atomic write
path, write queue, V3-04a path validation, symlink walk, and revision
formula. Faked: index, event, and idempotency ports (V3-04b fakes),
session/CSRF verifiers (stubs behind the real hooks), and the
workspace identity resolver. The Postgres index port is integrator
wiring; the WebSocket fan-out belongs to V3-08; key storage belongs
to the auth worker. Nothing here claims a result against a live
server with real auth: that run is the `real-runner.mjs` real mode,
which stays blocked until the auth routes land (see the V3-04c
report in `fase1/`).

## How to run

These specs import modules from the V3-04a branch
(`server/src/lib/paths.ts`, `server/src/lib/revision.ts`) and the
V3-04b branch (`server/src/routes/workspace-write.ts`,
`server/src/services/workspace/*`, `server/test/helpers/*`). They
typecheck and run only in a tree that contains both branches: the
integrated tree, or a scratch assembly of trunk + `web-workspace-read`
+ `web-workspace-write` + this branch. On this branch alone the
imports do not resolve; that is expected, not a regression.

```sh
pnpm --dir server run typecheck
pnpm --dir server exec vitest run test/workspace/
```

## Waiting: read-side conformance (no read route exists yet)

The V3-04a read service and routes (list, GET/HEAD file, scan, stat)
have not landed on any branch. When they do, add
`read-conformance.spec.ts` here covering, at minimum:

- Scan pagination: cursor walk over more than one page, `hasMore`
  consistent with `nextCursor`, limit 0 and non-numeric answered 400
  `invalid_limit`, limit above 1000 clamped, invalid cursor answered
  400 `invalid_cursor`, `.md` files only, lexicographic ordering by
  path, symlinks skipped silently, hidden entries skipped.
- List: one level only, folders first then files, alphabetical by
  name, same pagination rules, `not_a_directory` for a file path.
- GET file: raw text body, `ETag` quoted revision equal to the
  revision computed from the same bytes, `X-Revision`,
  `Last-Modified`, 304 on matching `If-None-Match`, 415
  `not_text_file` for non-text extensions.
- HEAD file: headers identical to GET, empty body.
- Stat: entry shape, `ETag`/`Last-Modified` for files, never writes
  the index.
- Read-side path matrix: `..` answered 400 `invalid_path`, hidden
  paths answered 404 `not_found`, symlink paths answered 404
  `not_found` (no existence leak), missing files 404.
- No mutation through GET/HEAD: repeated reads leave disk, index,
  and trash unchanged.

The client suite in `tests/workspace-client/files-crud.test.mjs`
already states the HTTP-level expectations for these cases; the
server specs must pin the same behavior against the real read
modules once they exist.
