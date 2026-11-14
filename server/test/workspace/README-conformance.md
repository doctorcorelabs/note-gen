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
| `read-conformance.spec.ts` | Real read routes over HTTP (`app.inject`), alone and combined with the real write routes on one app: independently recomputed revisions, HEAD/304, stat shape and version, scan/list pagination, the read-side 400 vs 404 path matrix, and the read/write ETag round trip. |

## Real vs fake in this wiring

Real: write routes, frozen auth hooks, guard parsers, atomic write
path, write queue, V3-04a path validation, symlink walk, and revision
formula. Faked: index, event, and idempotency ports (V3-04b fakes),
session/CSRF verifiers (stubs behind the real hooks), and the
workspace identity resolver. The Postgres index port is integrator
wiring; the WebSocket fan-out belongs to V3-08; key storage belongs
to the auth worker. Nothing here claims a result against a live
server with real auth: that run is the `real-runner.mjs` real mode,
which needs an integrated tree (auth + read + write + M8 migration);
see the V3-04c report in `fase1/` for its status.

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

## Read-side conformance (delivered by V3-04cR2)

The V3-04a read service and routes landed on `web-workspace-read`
(`37b2d8b5`), and `read-conformance.spec.ts` (V3-04cR2, 45 tests)
covers the waiting list: scan pagination (cursor walk, `hasMore`
consistent with `nextCursor`, limit validation and clamping,
invalid-cursor and wrong-kind-cursor rejection, `.md` only,
lexicographic order, symlinks and hidden entries skipped), list
(one level, folders first, pagination, `not_a_directory`), GET file
(raw text, quoted `ETag` equal to the independently recomputed
revision, `X-Revision`, `Last-Modified`, 304), HEAD (identical
headers, empty body, 200 for binary and invalid-UTF-8 files), stat
(entry shape, `ETag`/`Last-Modified`, version from the fake index,
null version for disk-only files), the read-side path matrix
(`..` 400, hidden and symlink paths 404), no mutation through
GET/HEAD, and the read/write ETag round trip. GET 415/422, 401, and
503-unconfigured-root stay pinned by V3-04a `read.spec.ts` and are
not duplicated here. The remaining wait is the live-server
`real-runner.mjs` real mode over an integrated tree; see the
V3-04c report in `fase1/`.
