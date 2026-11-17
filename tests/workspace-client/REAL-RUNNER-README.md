<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Real-backend runner for the workspace-client suite (V3-04c)

`real-runner.mjs` runs the untouched V2-25 conformance suite
(`*.test.mjs` in this directory, 164 cases) against a REAL backend:
the Fastify server from a backend checkout, over a scratch Postgres
17 database and a scratch workspace directory on disk. It also runs
the suite in mock mode to prove the harness itself, and against an
already running backend in external mode.

This runner writes no server code and edits no suite file. The suite
files stay exactly as V2-25 merged them; if a suite change is ever
needed for real-backend runs, it is proposed in the V3-04c report,
not edited here.

## What the runner does in real mode

1. Probes the backend checkout source under `server/src` for the 24
   canonical workspace routes and the 3 auth routes. This is evidence
   for the "feature not landed" classification, never runtime proof.
2. Creates a fresh scratch workspace directory (default under
   `~/workspace/note-gen-fork/scratch/v3-04c/ws`) and a fresh scratch
   database (default `v3_04c_ws` on `127.0.0.1:55434`, user
   `postgres`, trust auth). Any previous scratch database with the
   same name is dropped first.
3. Installs (`pnpm install --frozen-lockfile`) and builds (`pnpm run
   build`) the server in the backend checkout, then runs migrations
   through the server's own drizzle migrator (`runMigrations` from
   the built `server/dist/db/migrate.js`). No raw SQL is applied by
   the runner.
4. Boots `node server/dist/server.js` on a fixed port (default
   35531), waits for `GET /api/health/live`, and records
   `GET /api/health/ready`.
5. Bootstraps one test account through the public endpoints only:
   `POST /api/auth/setup` with a random in-memory setup token, then
   `POST /api/auth/login`. The session cookie and CSRF token are held
   in memory only. If setup and login both answer 404, the run is
   classified not-landed and the suite is not run: 164 unauthenticated
   failures would only mask the real finding.
6. Runs each suite file sequentially (one file at a time, so
   per-group counts are clean) with `WORKSPACE_BASE_URL`,
   `WORKSPACE_COOKIE`, `WORKSPACE_CSRF_TOKEN`, and `WORKSPACE_ORIGIN`
   set from the bootstrap. Fixture-dependent cases skip themselves
   in real mode by design (10 cases; runnable total 154 of 164).
7. Writes `results.json` plus one raw TAP log per suite file and the
   server log under the scratch results directory, prints a per-group
   summary, and stops the server. The scratch database and workspace
   are kept for inspection unless `--clean` is given.

## Prerequisites

- Node 24 (the suite uses `node:test` and global `fetch`).
- `psql` on PATH, able to reach Postgres 17 at `127.0.0.1:55434` as
  user `postgres` with trust auth, and able to create and drop
  databases. Verify with:
  `psql -h 127.0.0.1 -p 55434 -U postgres -c 'SELECT version();'`
- `pnpm` at `~/.local/bin/pnpm` (or `pnpm` on PATH, or
  `WS_REAL_PNPM`). Installs run inside the backend checkout's
  `server/` directory, which has its own lockfile.
- A backend checkout containing `server/package.json` and a built
  or buildable server. For unmerged feature branches, the integrator
  owns merging; the runner never merges. Point `--backend-dir` at a
  checkout that already contains the merged backend code to test.

## Commands

Mock mode (proves the runner and reproduces the V2-25 result):

```sh
node tests/workspace-client/real-runner.mjs --mode mock
# Expected: pass=164 fail=0 skip=0, exit 0.
```

Real mode against this checkout (the checkout must already contain
the auth and workspace backend code):

```sh
node tests/workspace-client/real-runner.mjs --mode real
```

Real mode against a different checkout (for example a scratch merge
checkout prepared by the integrator):

```sh
node tests/workspace-client/real-runner.mjs --mode real --backend-dir ~/workspace/note-gen-fork/work/merge-scratch
```

Real mode, reusing an existing install and build (faster iteration):

```sh
node tests/workspace-client/real-runner.mjs --mode real --skip-install --no-build
```

Real mode with cleanup at the end (workspace removed, database dropped):

```sh
node tests/workspace-client/real-runner.mjs --mode real --clean
```

External mode against an already running backend (auth values come
from the environment; never paste them into a report or a log):

```sh
WORKSPACE_BASE_URL=http://127.0.0.1:35531 \
WORKSPACE_COOKIE='notegen_session=...' \
WORKSPACE_CSRF_TOKEN='...' \
WORKSPACE_ORIGIN=http://127.0.0.1:35531 \
node tests/workspace-client/real-runner.mjs --mode external
```

All flags are also listed by `--help`. Environment overrides:
`WS_REAL_MODE`, `WS_REAL_BACKEND_DIR`, `WS_REAL_OUT`,
`WS_REAL_PORT`, `WS_REAL_DB`, `WS_REAL_PGHOST`, `WS_REAL_PGPORT`,
`WS_REAL_PGUSER`, `WS_REAL_WORKSPACE_DIR`, `WS_REAL_SCRATCH_ROOT`,
`WS_REAL_BODY_LIMIT_BYTES`, `WS_REAL_PNPM`.

## Environment the runner sets for the server

The server child gets: `NODE_ENV=development`, `HOST=127.0.0.1`,
`PORT` (default 35531), `DATABASE_URL` (scratch database, no
password, trust auth), `WORKSPACE_ROOT` (scratch directory),
`BODY_LIMIT_BYTES` (default 22020096, see below),
`AUTH_SECRET`/`ENCRYPTION_KEY`/`SETUP_TOKEN` (random per run, memory
only), `REGISTRATION_MODE=closed`,
`PUBLIC_BASE_URL` (same origin as the server, so Origin checks pass
for the suite's own requests), `TRUST_PROXY=false`,
`COOKIE_SECURE=false`, `CF_ACCESS_ENABLED=false`, `LOG_LEVEL=warn`,
`MIGRATE_ON_START=true`.

Body limit note: the server default body limit is 1 MiB. Left at the
default, the suite 2 MiB text boundary and 20 MiB media boundary
would fail as generic payload errors instead of exercising the
per-endpoint limits (`text_too_large`, `media_too_large`). The
runner raises only the harness limit to 21 MiB so the suite tests
what it claims to test. This is a test-harness choice, not a claim
about the product default.

## Reading the results

`results.json` carries, per suite file: pass/fail/skip/total, the
failing case names, the skipped case names, a classification, and
the path of the raw TAP log. Classifications:

- `pass`: every case in the file passed (skips allowed in real mode).
- `not-landed`: cases failed and none of the file's routes are
  present in the backend source probe. Record this as "feature not
  landed", not as a bug.
- `partially-landed`: cases failed and only some of the file's routes
  are present in the backend source probe.
- `behavior`: cases failed while the file's routes are present in
  the backend source probe. These are findings; reproduce from the
  failing case names and the raw TAP log.
- `unparsed`: the TAP summary could not be read; inspect the raw log.

Exit codes: 0 all runnable cases pass; 1 behavior failures;
2 feature not landed or backend cannot boot; 3 usage or config
error. A not-landed exit is an honest outcome, not a runner failure.

The file also records the backend checkout HEAD, the ready-check
payload, the source probe, and the runtime read probes (status and
error code only). It never records cookies, tokens, passwords, or
database URLs.

## Known limits

- The WebSocket channel (`/api/workspace/events`) is out of scope
  for this suite, same as in V2-25.
- Range support is SHOULD: Range cases accept a 200 full-body
  fallback against a real backend (V2-25 behavior, unchanged).
- Rate limiting and 503 behavior are not exercised by the suite.
- The runner runs suite files sequentially. Within a file, cases run
  in the order `node:test` runs them.
- If `pnpm install` fails with the known root EPERM on
  `.modules.yaml`, the runner chowns that file to 0:0 and retries
  once (see `fase1/investigasi-hang-eperm.md` section 2). A fresh
  checkout without `node_modules` does not hit this.
