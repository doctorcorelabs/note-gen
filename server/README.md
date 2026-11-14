<!-- SPDX-License-Identifier: GPL-3.0-only -->
<!-- This file is part of the NoteGen web fork, licensed under the GNU General Public License v3. See LICENSE and FORK.md. -->
# note-gen-web-api

API backend for the NoteGen web fork, built on Fastify 5. Fase 0 scope:
the health endpoints only, plus the server skeleton. No data endpoints
exist yet.

This directory has its own `package.json` and lockfile, separate from
the frontend root, following the fork layout decision (AD-06). Do not
merge the two lockfiles.

## Endpoints

| Endpoint | Meaning |
|---|---|
| `GET /api/health/live` | Liveness: the process answers. No database or disk I/O. Always HTTP 200 while the process lives. |
| `GET /api/health/ready` | Readiness: Postgres plus workspace, with reported checks. HTTP 200 only when ready, HTTP 503 with `ok: false` otherwise. |
| `GET /api/health` | Alias of ready, same handler, same semantics. |

All three answer without application auth and with
`Cache-Control: no-store`. The response envelope is `ok`, `status`,
`service`, `version`, `uptimeSeconds`, `timestamp`, `checks`. Checks in
ready responses are always, in order: `db`, `workspace`, `migrations`,
`pgvector`, `worker`. Full contract, error catalog, failure semantics,
and the T01-T16 test matrix live in the Fase 0 health design document
(`fase0/desain-health-endpoint.md` in the fork planning tree); that
document governs in case of conflict.

## Run locally

```sh
cd server
pnpm install
pnpm build
DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database> \
WORKSPACE_ROOT=<absolute-path-to-workspace-root> \
pnpm start
```

Defaults: `PORT=3001`, `HOST=127.0.0.1`. The server starts even when
`DATABASE_URL` or `WORKSPACE_ROOT` is missing; readiness then fails
honestly with `DB_NOT_CONFIGURED` or `WORKSPACE_NOT_CONFIGURED`
instead of the backend dying. Only an invalid `PORT` fails startup.

## Environment variables

| Variable | Required for readiness | Default | Notes |
|---|---|---|---|
| `PORT` | No | `3001` | Integer 1-65535. Invalid value fails startup. |
| `HOST` | No | `127.0.0.1` | Deployments set `0.0.0.0` via deploy env. |
| `DATABASE_URL` | Yes | None, no silent default | Postgres DSN for the application pool. |
| `WORKSPACE_ROOT` | Yes | None, no silent default | Absolute path of the workspace root directory. No fallback to other names. |
| `NODE_ENV` | No | `development` | `development` or `production`. |
| `LOG_LEVEL` | No | `info` | Pino level. |
| `HEALTH_CHECK_TIMEOUT_MS` | No | `2000` | Per-check timeout in ms. |
| `HEALTH_OVERALL_TIMEOUT_MS` | No | `5000` | Total ready-handler bound in ms. Must exceed the per-check timeout. |

Never commit a real `.env` file. The `.env.example` file for this
server is owned by a separate Fase 0 hygiene task (W15); the variable
list above is the source it documents.

## Tests

```sh
pnpm test       # Vitest regression suite (schema, error mapping, timeouts, alias)
pnpm typecheck  # strict TypeScript check over src and test
```

The test file is named `health.spec.ts` instead of `health.test.ts`
because the root `.gitignore` ignores `*.test.*`, which would silently
drop a `.test.ts` file from git. Vitest picks up `.spec.ts` by
default.

## Notes for later phases

- `migrations` is skipped in Fase 0 (no migration registry yet) and
  becomes a hard drift check in Fase 1. `pgvector` is reported honestly
  but non-blocking in Fase 0 and becomes hard in Fase 2. `worker` is
  skipped until a worker exists.
- When auth or rate-limit middleware lands, it must exempt the health
  paths, and the middleware test debt noted in `test/health.spec.ts`
  must be paid.
