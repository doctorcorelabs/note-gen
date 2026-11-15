# check-registration-order.mjs

Fail-closed static checker for the route-group registration order
decided by AD-61 (`fase1/desain-registrasi-programatik.md` sections
3-6). It never executes adapter, registrar, or app code: it reads
source text with a string/comment-aware scanner and regexes, in the
same spirit as the generator validation rules V-1..V-17. Anything it
cannot resolve is a violation, never a silent skip, except for the
controls that need adapters: when no adapter file exists yet, those
controls are reported `NOT TESTED` and do not affect the exit code.

## Usage

```sh
node scripts/check-registration-order.mjs [--root DIR] [--json]
node scripts/check-registration-order.selftest.mjs
```

`--root` defaults to the repo root (derived from the script path).
Exit codes: 0 = every applicable check passed, 1 = at least one
violation, 2 = usage error or unreadable input. `--json` prints one
JSON object: `{ ok, root, counts, violations, notTested, notes }`.

## Checks

| Code | Rule | Mode |
|---|---|---|
| C-1 | Rank is an integer in 10-160 | Adapter |
| C-2 | No rank clash: two adapters sharing one rank | Adapter |
| C-3 | Health first: smallest rank / first registrar call | Both |
| C-4 | Group order follows the frozen convention (health, auth-core, auth-advanced, admin, workspace-read, workspace-write, workspace-structure, workspace-reconcile, workspace-media, settings-secrets, db, records, search, assets, stubs, csp-reports, events); generated-index call order matches rank order | Both |
| C-5 | No duplicate method+path across route files | Both |
| C-6 | Every route declaration resolves to a literal method+path and has a handler argument | Both |
| C-7 | When adapters exist: no registrar called directly from app.ts; every registrar an adapter calls exists as a route-file export | Adapter |
| C-8 | Adapter contract: REGISTRATION_ID is a string literal with `as const` and matches the file stem, REGISTRATION_ORDER is an integer, `registerGroup` exists, no adapter-to-adapter import, no generated-alias collision | Adapter |

Notes on the rules:

- The checker does NOT require an adapter to use its frozen table
  rank. Inserts use the gaps (for example 30/35), and renumbering is
  a coordinator act, so only the range, the uniqueness, and the
  relative order are enforced.
- "Spaced" in the task brief is enforced as uniqueness, not as a
  minimum gap, because the frozen table itself holds the 30/35 pair.
- In app.ts mode, `registerSettingsRoutes` and
  `registerSecretsRoutes` collapse to the one `settings-secrets`
  group, and the structure/trash registrars collapse to
  `workspace-structure`, following section 3.3. A registrar name the
  checker does not know is a C-4 violation: the order of an unknown
  group cannot be verified, so the map must be extended by
  amendment.
- Route paths resolve from string literals, file-local path
  constants, `app.route({ method, url })` forms (including method
  arrays), and path constants imported through one relative-import
  hop (for example `CSP_REPORT_PATH` from the auth middleware).
  Anything else is a C-6 violation naming the file and line.

## Baseline method

The baseline runs the checker over the current tree with `--root`
pointing at the trunk checkout: app.ts mode reads the registrar call
order straight from `server/src/app.ts`, and the route scan reads
the route files those registrars live in. No route dump and no
running server is involved. On trunk `0699c620` the baseline passes
the applicable checks (9 registrar calls in convention order, 34
declared routes, no duplicates, every route with a handler) and
reports C-1, C-2, C-7, and C-8 as NOT TESTED because no adapter
file exists yet. The 34 declared routes are consistent with the
rf2 harness fingerprint of 46 routes: 12 GET routes gain an
implicit HEAD route from Fastify (the 13th GET already declares
HEAD explicitly), 34 + 12 = 46.

## Fixtures

`scripts/fixtures/registration-order/` holds two miniature trees
with the repo layout (`server/src/app.ts`, `server/src/routes/`,
`server/src/routes-generated.ts`):

- `positive/`: 2 adapters (health rank 10, workspace-read rank 40),
  5 routes, migrated app.ts shape. Must exit 0.
- `negative/`: rank clash (two adapters on rank 20) plus a duplicate
  route (POST /api/shared, once literal and once through a path
  constant). Must exit 1 with exactly the C-2 and C-5 violations.

The self-test asserts both fixtures, the exit-2 behavior on a
missing root, the em-dash ban over these files, and records the
baseline run without asserting its verdict.

## Scope boundary

Db kind-handler completeness (kind in catalog, kind duplicate,
missing `handle`, alias collision) belongs to the generator
validation V-9..V-14, not to this checker. This checker covers
group rank, group order, route duplicates, route handlers, and
adapter coverage only. The route scan is static: a route declared
through a computed path, a loop over a data table, or a path
constant imported from more than one hop away is reported
unresolved (C-6) for manual review instead of being guessed.
