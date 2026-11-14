<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Contract tests: store, filesystem, SQL

One suite, many implementations. The same cases run once per factory,
each case against a fresh instance, with no shared state between cases
or implementations. Cases assert observable behavior and error
types/codes, never exact message text, except CT-X6 which pins one
upstream message verbatim.

Design authority: `fase1/desain-pengujian.md` (V1-15), sections 2.1
to 2.4 for case IDs, reconciled by AD-05, AD-07, AD-09, AD-16, and
AD-17. Case behavior details come from `fase1/desain-store-adapter.md`
(section 8, CT-01 to CT-22) and `fase1/desain-sql-adapter.md`
(section 6, CT-M/K/T/H/X/S/I/P). This README is the interface mapping
required by assumption A2 of the test design: it records how the
scaffold-local interface mirrors relate to the designs and to the
canonical V2-04 interfaces (branch `web-registry-g0`), and what the
integrator must reconcile at merge time (see EXCEPTIONS.md E9).

## Status

Scaffold state: fake column only. The web and Tauri factories do not
exist yet. The suite proves the cases are runnable and can detect
violations (see Negative control). It does not prove anything about a
real backend, a real database, or a real filesystem.

What this scaffold deliberately does NOT do (integrator follow-ups,
not oversights):

- No web or Tauri factory (`tests/contract/implementations/` does not
  exist yet). The Tauri column runs only with `CONTRACT_TAURI=1` and
  must never block PRs.
- No AI transport cases (C-AI-01 to C-AI-06) and no event/cache cases
  (C-EV-01 to C-EV-04). Those belong to later scaffold work, not to
  this store/filesystem/SQL scaffold.
- No Postgres, no network, no real filesystem in any case in this
  scaffold. Cases that need them are listed as deferred below and
  must fail explicitly (not skip silently) if wired to an
  implementation that cannot run them.

Wiring that IS present on this branch: `package.json` carries the
`test`/`test:legacy`/`test:unit`/`test:contract`/
`test:contract:tauri`/`test:watch`/`typecheck` scripts and the pinned
devDependencies `vitest 3.2.7` and `vite-tsconfig-paths 5.1.4`
(the Vitest version matches the one already installed for
`server/`); `tsconfig.json` includes `tests/**/*.ts` and
`vitest.config.ts` and the stale `.bak` entry (P0-2) is removed.
Two wiring items stay with the integrator: regenerating
`pnpm-lock.yaml` for the new devDependencies (this branch does not
carry a regenerated lockfile, so the first `pnpm install` updates
it and CI `--frozen-lockfile` needs the committed result), and the
P0-1 cleanup of `mark-view-mode.mjs` plus the `playwright.config.ts`
`include` entry, which land with the E2E scaffold merge.

## How to run

```sh
pnpm install
pnpm test:contract
```

The first `pnpm install` on this branch regenerates
`pnpm-lock.yaml` for the new devDependencies (see Status above);
after that, `pnpm install --frozen-lockfile` works as in CI.

Single adapter:

```sh
pnpm vitest run --project contract tests/contract/store.contract.ts
pnpm vitest run --project contract tests/contract/fs.contract.ts
pnpm vitest run --project contract tests/contract/sql.contract.ts
```

The contract project is defined in `vitest.config.ts` (two projects,
`unit` and `contract`, environment `node`, alias `@/` resolved through
`vite-tsconfig-paths` from `tsconfig.json`; no hardcoded alias, no
coverage threshold). Test files match
`tests/contract/**/*.contract.ts`. Case definition modules
(`*-cases.ts`), the harness, the type mirrors, and the fakes are not
test files on their own; they only run through a `*.contract.ts`
entry.

## Layout

| Path | Contents |
|---|---|
| `tests/contract/contract-harness.ts` | `defineContractSuite`, `ContractFactory`, fresh instance per case |
| `tests/contract/contract-types.ts` | Scaffold-local interface mirrors (see mapping below) and shared constants |
| `tests/contract/contract-errors.ts` | Scaffold-local `ContractError` taxonomy (see mapping below) |
| `tests/contract/store-cases.ts` | `defineStoreCases`, `defineCorruptStoreCases` |
| `tests/contract/fs-cases.ts` | `defineFsCases` |
| `tests/contract/sql-cases.ts` | `defineSqlCases` |
| `tests/contract/store.contract.ts` | Store entry: fake factory + corrupt-backing suite |
| `tests/contract/fs.contract.ts` | Filesystem entry: fake factory + `writeExternally` |
| `tests/contract/sql.contract.ts` | SQL entry: fake factory |
| `tests/contract/EXCEPTIONS.md` | Documented divergences (E1 to E9); silent `it.skip` is forbidden |
| `tests/contract/implementations/README.md` | Factory contract for web/Tauri/Postgres factories (no factories yet) |
| `tests/fakes/fake-store.ts` | Independent in-memory `StoreAdapter` |
| `tests/fakes/fake-fs.ts` | Independent in-memory `FsAdapter` |
| `tests/fakes/fake-sql.ts` | Independent in-memory `SqlAdapter` (see R2 note below) |
| `tests/fakes/broken-fake-store.ts` | Deliberately broken store, negative control only |
| `tests/fakes/README.md` | Allowed fake simplifications |

## Interface mapping (A2)

At branch point `a28fd02`, `src/lib/platform/` contains only
`detect.ts`, `errors.ts`, `poc-app-shim.ts`, `poc-store-shim.ts`, and
a registry skeleton that states interface definitions land with wave
2. No store, SQL, or filesystem interface exists on this branch, so
the scaffold cannot import them. The mirrors in `contract-types.ts`
stand in for the designs. Only `PlatformCapabilityError` (via the
`capabilityError` helper) is imported from
`src/lib/platform/errors.ts` today, because it already exists.

Reconciliation with the canonical interfaces (V2-04, branch
`web-registry-g0`, commit `76e1660`, 20 interfaces in 19
subdirectories under `src/lib/platform/`): the canonical interfaces
have now been written, and a method-by-method comparison shows the
mirrors do NOT match them. The differences are structural, and the
integrator must NOT resolve them by deleting the mirrors and
importing the canonical shapes: the canonical interfaces fix the
narrow upstream shim surface (what the Tauri plugins expose), while
the mirrors fix the observable workspace-level behavior the contract
cases lock (what the web app must do). Both layers are needed; the
remapping composes them. Summary (detail in EXCEPTIONS.md E9):

| Adapter | Mirror in `contract-types.ts` | Canonical (V2-04) | Verdict |
|---|---|---|---|
| Store | `IStore` sketch + `path`, `length`, `close`, `getStore`, `closeAll` | `StoreHandle` without `path`/`length`/`close`; adapter is `load` only | Close: same core; 5 mirror-only members need a drop-or-extend decision |
| Filesystem | Workspace contract: scan, trash, link rewrite, image resolve, `seq` events | Plugin-fs surface: `readTextFile`, `readDir`, `rename`, `watch`, `BaseDirectory` options | Different layers: cases bind the workspace layer, built on the shim |
| SQL | Typed operation catalog (`query`/`execute`/`transaction`) | Raw `{sql, params}` shim (`execute`/`select`/`close`) for legacy `src/db` callers | Different layers: cases bind the typed catalog; raw SQL stays out of the contract |

Fakes location note: the test design (section 6.1) places fakes at
`tests/contract/fakes/`, but this scaffold keeps them at
`tests/fakes/`, the location already cataloged by the wave 2 merge
plan. The deviation is layout only; imports and the Vitest config do
not depend on it. Do not move the directory without updating the
merge plan catalog in the same change.

### Store: mirror matches the design sketch, not the canonical interface

`StoreAdapter`, `StoreHandle`, `StoreOptions`, and `UnlistenFn` in
`contract-types.ts` are identical in shape to
`fase1/desain-store-adapter.md` section 3.3, which mirrors `IStore`
from `@tauri-apps/plugin-store` 2.3.0 plus a read-only `path` field.
Against the canonical V2-04 interface, the core matches
(`load`/`get`/`set`/`has`/`delete`/`clear`/`reset`/`keys`/`values`/
`entries`/`reload`/`save`/`onKeyChange`/`onChange`, same
`StoreOptions`), but five mirror members have no canonical
counterpart: the `path` field, `length()`, `close()`,
`getStore()`, and `closeAll()`. V2-04 excluded them as zero-call-site
surface. Cases CT-01 and CT-03c assert that mirror-only surface;
the integrator either drops those assertions or extends the
canonical interface, and records the choice in EXCEPTIONS.md E9.
Two related items the integrator must still resolve:

- `createLazyStore` (CT-04) is not part of the mirror. The design
  places it in `store/interface.ts`, but V2-04 excluded `LazyStore`
  (0 call sites); CT-04 stays deferred unless the integrator
  reintroduces the helper.
- The key-schema module (`classifyKey`, S/R/L lists, `aiModelList`
  split) is not part of the mirror. The fake uses a minimal
  pattern-based secret classification only; the full module belongs
  to the store-interface owner and the real adapter. Cases CT-05 to CT-08 need it and are
  deferred (see below).

### SQL: mirror is a subset, with four flagged divergences

The `SqlAdapter` shape (mode, `ready`, `query`, `queryOne`,
`queryMany`, `execute`, `transaction`, `close`) matches
`fase1/desain-sql-adapter.md` section 3.2. It does NOT match the
canonical V2-04 `SqlAdapter`, which is the narrow raw shim
(`load(path)` returning `execute(query, bindValues)` /
`select(query, bindValues)` / `close()`) for the legacy `src/db`
callers. The contract cases bind the typed-operation catalog, not
the raw shim; no case sends raw SQL, and the raw shim must never
become a contract surface (see EXCEPTIONS.md E9 and CT-S5/C-SQ-08).
The operation catalog is a subset: 12 read kinds and 18 write kinds, covering only the
operations exercised by the contract cases plus their minimal
neighbors. The full MVP catalog in section 3.4 (conversations,
messages, notes, compactions, activity, memories, policy, image
cache, wiki pages/jobs/segments) is not mirrored; the typed-catalog
owner (branch `web-sql-ops-catalog`) defines it.

Divergences the integrator must resolve (do not silently "fix" the
cases to match one side without recording the decision):

1. `WriteResult` in the mirror adds `duplicate?: boolean` (marks
   create with a known `sourceId`) and `committed?: boolean` (wiki
   commit with a stale version). The section 3.2 sketch has only
   `affected`, `id`, and `version`. The duplicate flag carries the
   `insertExternalMark` idempotency semantics from section 3.4 and
   C-SQ-05; the committed flag carries the "return false on
   conflict, do not throw" semantics of `commitWikiSourceRevision`
   in section 3.4. The typed-catalog owner must confirm the field names or rename
   them in the cases and the fake together.
2. `SqlHealth.mode` and `SqlAdapter.mode` in the mirror allow
   `"fake"` in addition to `"tauri" | "web"`. Production interfaces
   keep only `"tauri" | "web"`; the integrator removes `"fake"`
   from the production type and keeps it only on the fake class if
   the real type does not allow it.
3. Knowledge operation names in the mirror (`registerSource`,
   `claimSource`, `completeSource`, `failSource`, `retrySource`)
   follow the hash-machine vocabulary of section 1.7 and CT-H1 to
   CT-H6. The section 3.4 table names different operations
   (`knowledge.upsertSource`, `knowledge.updateStatus`,
   `knowledge.removeSource`). The typed-catalog owner must confirm the canonical
   names; whichever wins, the cases and the fake change together.
4. `vector.insertChunk` exists in the mirror only to test the
   unique-chunk-key behavior (CT-K4/C-SQ-06a) at adapter level.
   Section 3.4 says chunk writes are worker-only (W2) and "TIDAK
   diekspos ke SqlAdapter web". The integrator may need to move
   CT-K4 to the worker/handler level once the real adapter lands;
   until then the case runs against the fake through this
   scaffold-only surface. `vector.replaceChunks` is likewise
   worker-only in the design and is mirrored for the same reason.
5. `marks.create` in the mirror omits the `activity` input shown in
   the section 3.3 example, and `marks.list` omits the `cursor`
   field. No case asserts activity rows or cursor pagination; the
   typed-catalog owner adds them to the real catalog without changing these cases.
   `marks.create` also omits the `ON CONFLICT` wording: see E7 for
   the `tags.create` duplicate conflict, and the CT-K2 note below.

CT-K2 reading (recorded so the integrator does not "correct" it
backwards): section 6 states a duplicate `source_id` is "ditolak
partial unique" at database level, while section 3.4 states a
`marks.create` with an already-known `sourceId` "mengembalikan
baris yang sama (idempotensi `insertExternalMark`)" at adapter
level, and C-SQ-05 requires the `{ mark, duplicate: true }` shape.
The fake implements the adapter-level reading: duplicate returns
the existing row with `duplicate: true` and no new row. The
database constraint still rejects a raw duplicate insert; the
adapter is what turns it into idempotency. Null `sourceId` values
stay independent (partial unique index ignores nulls).

### Filesystem: mirror names are scaffold inventions (unverified)

No filesystem interface sketch exists in the wave 1 designs with
method-level names. The workspace API design names only the upstream
plugin-fs operations being replaced (`readDir`, `readTextFile`,
`writeTextFile`). The mirror's method names (`listDir`,
`scanMarkdown`, `readText`, `writeText`, `exists`, `mkdir`, `rename`,
`removeToTrash`, `restoreFromTrash`, `purgeFromTrash`, `listTrash`,
`resolveImage`, `onEvent`) are chosen from the observable behaviors
in C-FS-01 to C-FS-11 and are UNVERIFIED against V2-04. The
canonical V2-04 `FsAdapter` is the upstream plugin-fs surface
(`readTextFile`, `writeTextFile`, `readDir`, `remove`, `rename`,
`watch`, `BaseDirectory` options, ...): it has no scanner, no trash,
no link rewriting, and no image resolution, because those are
workspace-layer behaviors composed on top of the shim. The
integrator remaps the cases to that composed layer and records the
mapping here; remapping them to the raw shim method-for-method
would delete the AD-17 behaviors the cases exist to lock. Behavior,
not names, is what the cases lock.

Two design points are only partly testable through the mirror:

- C-FS-03 names four observation paths (watcher, tree, scanner,
  import). The mirror has no dedicated import operation, so the
  import path is exercised as write-then-observe through the
  scanner and the tree.
- C-FS-06 names a resolve-then-`toMarkdownImagePath` round-trip.
  The mirror has no `toMarkdownImagePath` operation (that round-trip
  is covered by unit test U-IMG-05 over the pure function); the
  contract case asserts resolution through the adapter only.

### Error taxonomy mapping

- `ContractError` (`contract-errors.ts`) mirrors the
  `SqlErrorCode` set in `fase1/desain-sql-adapter.md` section 3.2
  (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`, `UNKNOWN`).
  It omits `UNAUTHORIZED` and `FORBIDDEN`: the fake has no auth
  surface, and cases CT-S1 to CT-S4 that need those codes are
  deferred to the server level. V2-04 added no further error
  taxonomy (`errors.ts` unchanged); when a final taxonomy lands,
  the integrator rewires the codes to it;
  cases assert codes, never message text, except CT-X6.
- Store cases assert `PlatformCapabilityError` for removed store
  files, secret-key writes, and custom serializers, using the real
  class from `src/lib/platform/errors.ts` through the
  `capabilityError` helper. Its real constructor signature differs
  from the sketch in `fase1/desain-store-adapter.md` section 3.2;
  see EXCEPTIONS.md entry E6.
- A closed store handle throws `ContractError` with code
  `NOT_FOUND` in the fake. The design requires `NOT_FOUND` for a
  closed handle but through the `PlatformError` taxonomy, which
  does not exist yet. The integrator rewires this assertion to the
  real error type when a final taxonomy defines it.

## Constants

- `WATCHER_MAX_LATENCY_MS = 1000` (placeholder, see E5). The design
  derives it from the 300 ms watcher debounce plus D3
  reconciliation, which was not re-verified from source (A5). The
  fake delivers events synchronously, so any bound passes against
  the fake; the web implementation must meet the confirmed value.
- `SQL_MAX_TRANSACTION_OPS = 50` (CT-X5: 51 operations rejected,
  50 accepted). The 1 MB body half of CT-X5 is server-level and
  deferred.
- `TAG_GUARD_CONFLICT_MESSAGE` is pinned verbatim from upstream
  (CT-X6). Do not reword it.

## Cases that run against the fake

### Filesystem: C-FS-01 to C-FS-11 (12 tests, C-FS-05 split in two)

| ID | Behavior |
|---|---|
| C-FS-01 | Recursive `readDir` filters dot files and dot folders |
| C-FS-02 | Scanner collects only lowercase `.md`; tree keeps images |
| C-FS-03 | Dot-segment filter holds on watcher, tree, scanner, import paths |
| C-FS-04 | Atomic write; readers see only OLD or NEW; exactly one `changed` event; no temp file left |
| C-FS-05a | Rename rewrites Markdown links and image references by default (AD-17) |
| C-FS-05b | Rename with `rewriteLinks: false` leaves referrers untouched |
| C-FS-06 | Image resolution is relative to the Markdown file directory |
| C-FS-07 | Absolute and slash-led paths are not local media |
| C-FS-08 | A missing image does not block the document |
| C-FS-09 | Traversal outside the root is rejected with a typed error (path strings only; symlink part deferred, see E8) |
| C-FS-10 | An external write surfaces through events within the latency bound; `seq` is monotonic |
| C-FS-11 | Delete moves to trash, restore returns content, purge removes permanently |

### Store: C-ST-01 to C-ST-06 plus CT-01/02/03/09/17/22 (13 tests)

| ID | Behavior |
|---|---|
| C-ST-01 | Round-trip get/set/save, visible to a reopened instance |
| C-ST-02 | A missing key reads as `undefined` (known-key defaults deferred, see below) |
| C-ST-03 | Concurrent writes from two sessions keep the store readable; last-write-wins per key is the asserted behavior for the shared key |
| C-ST-04 | A corrupt store fails with a typed error, never a hang or `undefined` (separate corrupt-backing suite) |
| C-ST-05/CT-09 | Secret keys are invisible and unwritable through the store (key-level reading, see below) |
| C-ST-06 | Settings survive a restart simulated by reopening over the same backing (in-process only, see E1) |
| CT-01 | Handle and adapter expose the full `IStore` surface |
| CT-02-interim | `set(key, undefined)` deletes the key (INTERIM, F1-22 unconfirmed, see E4) |
| CT-03a | Basic semantics: keys/values/entries/length stay consistent |
| CT-03b | Deep clone in both directions; `set` is visible without `save()` |
| CT-03c | Listeners, reload without events, close, reset, `getStore` |
| CT-17 | Removed and unknown store files fail closed on `load()` |
| CT-22 | Custom serializers are unavailable; `createNew` empties the document (autoSave clamping is not asserted: no observable surface in the mirror) |

Interpretation notes, recorded so a later reader does not mistake
them for the full design:

- C-ST-02 in the test design also requires documented defaults for
  known settings keys on an empty store. The scaffold has no key
  schema, so only the unknown-key half runs here. Known-key
  defaults are deferred with CT-05 to CT-08.
- C-ST-05 in the test design is written as a canary value that must
  not leak through read responses, adapter logs, or snapshots. The
  case here implements the store design's key-level reading
  (CT-09): secret keys behave as absent on every read surface and
  `set` over them throws. Server-side log/snapshot scanning belongs
  to the API cases (CT-11/CT-12) and is deferred.

### SQL: CT-K/T/H/X/I/S/P subset plus C-SQ aliases (27 tests)

| ID | Behavior |
|---|---|
| C-SQ-01 | `ready()` is idempotent and preserves data |
| C-SQ-03 | Creating a mark writes its `mark_tags` rows together |
| CT-K1 | A mark referencing a nonexistent tag is rejected |
| CT-K2/C-SQ-05 | Duplicate `sourceId` returns the existing row; null `sourceId` values stay independent; update onto a used `sourceId` conflicts |
| CT-K3 | Tag names are unique and case-sensitive (see E7) |
| CT-K4/C-SQ-06a | A duplicate vector chunk key is rejected |
| C-SQ-06b | `replaceChunks` is all-or-nothing when one chunk is invalid |
| CT-T1/C-SQ-04a | Moving the primary tag keeps extra tags |
| CT-T2/C-SQ-04b | Permanent delete cascades; soft delete keeps tags and restore returns them |
| CT-T3 | Deleting a used tag fails without `reassignTo` and never discards records |
| CT-T4 | `updateTags` replaces the set, creates new tags, and enforces the guard |
| CT-T5 | The primary invariant holds after a mixed scenario |
| CT-H1/C-SQ-07 | Register, claim, complete drives pending to ready with matching hashes |
| CT-H2 | New content returns a ready source to pending, keeping the old `indexedHash` |
| CT-H3 | Illegal status transitions are rejected |
| CT-H4 | Two claims over one pending source, exactly one wins (sequential against the fake; true concurrency is a Postgres property) |
| CT-H5 | A failed chunk write cancels the status change |
| CT-H6 | A failed source retries to pending with the error cleared |
| CT-X1 | A transaction with a failing operation leaves nothing behind |
| CT-X2/C-SQ-10 | Two guarded writers, one wins; retry with fresh state succeeds (sequential against the fake) |
| CT-X3 | Canvas save with a stale version conflicts; force succeeds |
| CT-X4 | Wiki commit with a stale version does not commit; the correct version commits |
| CT-X5 | A transaction over the operation limit is rejected (op-count half only) |
| CT-X6 | The tag guard conflict uses the pinned upstream message |
| CT-S5/C-SQ-08 | Injection strings are data; unknown kinds and removed tables are rejected; no raw SQL path |
| CT-S6 | Responses never carry embeddings |
| CT-I1/CT-I2 | An idempotency key replays identical results and rejects a different body |
| CT-P2-shape | Query results use stable fields and epoch millisecond timestamps (shape half of CT-P2 only) |
| (unnamed) | `queryMany`: batch reads keep order and fail as a batch on an unknown kind; `queryOne` returns null when empty |

## Cases deferred (do not run against the fake)

These cases need a real Postgres catalog, HTTP auth, migration
files, a browser, a production bundle, or the desktop harness.
Wiring any of them to the fake would prove nothing. They are
recorded here instead of being silently skipped, per the test
design section 2.1.

SQL (`fase1/desain-sql-adapter.md` section 6), against Postgres 17:

- CT-M1 to CT-M6: migrator from empty, idempotent rerun, drift 0,
  advisory lock, no DDL from application code (CI grep), CI
  generate check.
- CT-K5: `mark_tags` workspace mismatch (needs workspace isolation).
- CT-T6: no triggers in the Postgres catalog (`pg_trigger` query).
- CT-S1 to CT-S4: cross-workspace 404, unauthenticated 401,
  ignored `workspace_id` in body, token scope 403.
- CT-I3: idempotency key expiry and reuse after cleanup.
- CT-P1: parity scenarios run against both Postgres and SQLite.
- CT-P2 (full): identical `query` result shapes in both modes; only
  the shape half runs here as CT-P2-shape.
- CT-P3: production bundle contains 0 forbidden strings.
- C-SQ-02: additive migration from a legacy schema fixture
  (`tests/fixtures/db/legacy-schema.sql`, not yet created). Until
  the fixture exists, this case must fail explicitly, not skip.
- C-SQ-09: no DDL from application paths; migration drift is zero.
- CT-X5 (second half): request body over 1 MB rejected (server
  level).

Store (`fase1/desain-store-adapter.md` section 8):

- CT-04: `createLazyStore` helper (excluded by V2-04; see the
  Store mapping above).
- CT-05 to CT-08: key-schema list parity, client/server schema
  parity, key classification routing, `aiModelList` split (need
  the key-schema module and the server).
- CT-10 to CT-15, CT-18, CT-21: settings/secret API contracts,
  clear/reset server transaction, revision conflict, persistence
  and flush semantics, cross-tab sync, auth/security (need the
  Fastify server over Postgres 17).
- CT-16: POC cleanup in the browser (needs `localStorage`).
- CT-19: desktop parity (needs the desktop harness).
- CT-20: POC removal gates (lives in CI, not in Vitest).

Filesystem:

- C-FS-09 (symlink half): a symlink inside the root pointing
  outside it has no in-memory equivalent; the web implementation
  must reject it (see E8).

## The fake SQL adapter and R2

The test design (R2, section 0.3) states there is no in-memory fake
for SQL: SQL is tested against real Postgres 17, because SQL
semantics are the content of the contract and a fake would test
itself. This scaffold deliberately adds a fake SQL adapter anyway,
for one narrow purpose: proving the adapter-level cases are runnable
and can detect violations before the Postgres-backed implementation
lands. The fake never runs SQL, never touches a database, and never
touches the network. It does NOT replace the Postgres contract.
Every case that needs catalog truth, migration truth, auth truth,
or true concurrency is deferred above and must run against
Postgres 17. If the fake and Postgres ever disagree, Postgres wins
and the fake (or the case) is fixed, with the disagreement recorded
in `EXCEPTIONS.md`.

## Negative control

The broken fake (`tests/fakes/broken-fake-store.ts`) violates the
store contract in two documented ways: secret keys leak instead of
being rejected and invisible, and `save()` discards the document.
Run the store suite against it with:

```sh
CONTRACT_BROKEN_STORE=1 pnpm vitest run --project contract tests/contract/store.contract.ts
```

Expected result: the run FAILS, with at least C-ST-01, C-ST-05 /
CT-09, and C-ST-06 failing against the broken fake while the same
cases pass against the correct fake. If a future change makes the
negative control pass, the cases have lost their detection power
and the change must not merge. The corrupt-backing suite is not
affected by the flag and keeps passing in the negative run. Do not
"fix" the broken fake; its defects are the point. If the contract
changes, update the defect list in the broken fake and the expected
failures here together.

## Exceptions

Divergences that are intentional, and divergences forced by missing
implementations, are recorded in `EXCEPTIONS.md` (E1 to E9) and
asserted as the expected divergent behavior where a case covers
them. A divergence without an entry there is a review failure.
