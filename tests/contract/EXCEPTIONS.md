<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Contract exceptions

Documented divergences for the contract suites, per
`fase1/desain-pengujian.md` section 2.1. A deliberate difference must
be recorded here and asserted as the expected divergent behavior. A
silent `it.skip` is forbidden. A divergence without an entry here is
a review failure.

## E1: fakes have no cross-process persistence

The in-memory fakes do not persist across process restarts and have
no on-disk backing. C-ST-06 (persistence across restart) runs
against the fake only as an in-process restart simulation: a new
adapter instance over the same backing map. Cross-process
persistence is a web/Tauri property and is proven only by the web
and Tauri factories once they exist. No case in this scaffold may
claim persistence beyond one process.

## E2: Tauri rename does not rewrite plain Markdown links (R3)

AD-17 fixes the upstream defect: rename rewrites image links AND
plain Markdown links by default. The Tauri implementation keeps the
upstream behavior (plain Markdown links are not rewritten). When the
Tauri factory is registered, its C-FS-05a case asserts the upstream
behavior as the expected divergent result and references this entry.
The web and fake columns assert the AD-17 behavior. No Tauri factory
exists yet, so this entry is forward-looking.

## E3: the fake SQL adapter does not replace Postgres (R2)

`fase1/desain-pengujian.md` section 2.4 requires SQL contracts to
run against real Postgres 17. The fake SQL adapter exists only to
prove the adapter-level cases are runnable and can detect
violations. Cases needing catalog truth, migration truth, auth
truth, or true concurrency are deferred to Postgres and listed in
`tests/contract/README.md`. If the fake and Postgres disagree,
Postgres wins.

## E4: CT-02 asserts H3 behavior (F1-22 decided, AD-106)

`fase1/desain-store-adapter.md` section 5.1 left the verdict for
`set(key, undefined)` (H1/H2/H3/H4) unconfirmed pending a check
against the Rust implementation. AD-106 records the parent decision:
H3, so `set(key, undefined)` throws a validation error
(`PlatformCapabilityError`, `invalid_argument`, capability
`store.set`) and leaves the key unchanged. CT-02 asserts that
behavior in both columns, and the interim "delete" case is
superseded. The desktop behavior test (step 2 of the section 5.1
plan) is deferred, not a Fase 1 gate; if it ever contradicts H3,
the contract is reviewed again.

## E5: watcher latency bound is a placeholder (A5)

`WATCHER_MAX_LATENCY_MS` is 1000 ms in `contract-types.ts`. The
design derives the bound from the 300 ms watcher debounce plus D3
reconciliation, neither re-verified from source in the scaffold.
The fake delivers events synchronously, so any bound passes against
it. The web implementation must meet the confirmed value once the
scaffold confirms it from source; the constant and this entry are
then updated together.

## E6: error taxonomy differs from the store-design sketch

`fase1/desain-store-adapter.md` section 3.2 sketches
`PlatformCapabilityError(capability, reason)` extending
`PlatformError` with codes `NOT_FOUND`, `PERMISSION_DENIED`,
`CAPABILITY_UNAVAILABLE`, `NETWORK_ERROR`, `CONFLICT`, `TIMEOUT`,
`VALIDATION_ERROR`. The real `src/lib/platform/errors.ts` at branch
point `a28fd02` defines
`PlatformCapabilityError(code, { capability, adapter, mode, reason? })`
with codes `unsupported`, `unavailable`, `not_implemented`,
`permission_denied`, `invalid_argument`, `backend_error`, plus a
`capabilityError` helper. The scaffold uses the real signature; the
sketch is superseded for this purpose. Related scaffold-local
choices: SQL/FS cases use `ContractError` (`VALIDATION`,
`NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`, `UNKNOWN`) until V2-04
lands the final taxonomy, including the closed-handle `NOT_FOUND`
in CT-03c, which the design requires through the `PlatformError`
taxonomy that does not exist yet. The integrator rewires these
assertions to the real error types without changing the asserted
codes.

## E7: `tags.create` duplicate semantics conflict between design sections

`fase1/desain-sql-adapter.md` section 6 (CT-K3) requires two tags
with the same name in one workspace to be rejected. Section 3.4
states `tags.create` "memakai `ON CONFLICT DO NOTHING` atas nama
per workspace dan mengembalikan baris yang ada" (returns the
existing row). Both cannot hold at adapter level. The fake and
CT-K3 lock the section 6 reading: a duplicate name is rejected
with `CONFLICT`, and names differing only by case are distinct.
This conflict needs a recorded design resolution; until then, do
not change the fake to the `DO NOTHING` reading without amending
CT-K3 and this entry together.

## E8: symlink traversal has no fake equivalent

C-FS-09 requires rejecting a symlink inside the root that points
outside it. An in-memory fake has no symlinks, so the case covers
path-string traversal only (`..` escapes, absolute paths). The web
implementation must reject symlink escapes as well; its factory
adds that coverage when it lands. The fake column passing C-FS-09
does not prove symlink safety.

## E9: scaffold mirrors differ from the canonical V2-04 interfaces

The canonical shim interfaces (V2-04, branch `web-registry-g0`,
commit `76e1660`, verified method by method against the installed
upstream declarations and every call site at `4dcaa3f`) do not
match the scaffold-local mirrors in `tests/contract/contract-types.ts`.
The mirrors are retained deliberately: they express the observable
workspace-level behavior the contract cases lock, while the
canonical interfaces express the narrow upstream shim surface. The
integrator remaps the cases onto the canonical interfaces composed
with the workspace layer; deleting the mirrors and importing the
canonical shapes method-for-method would silently drop the locked
behaviors below. Until that remapping lands, the mirrors are the
running contract and this entry is the record of the difference.

Store. The core matches (`load`, `get`, `set`, `has`, `delete`,
`clear`, `reset`, `keys`, `values`, `entries`, `reload`, `save`,
`onKeyChange`, `onChange`, `StoreOptions`). Five mirror members
have no canonical counterpart because V2-04 excluded them as
zero-call-site surface: the read-only `path` field on the handle,
`length()`, `close()`, `getStore()`, and `closeAll()`. Cases CT-01
and CT-03c assert that mirror-only surface (including the
closed-handle `NOT_FOUND` behavior). The integrator either drops
those assertions or extends the canonical interface; either choice
is recorded here before the cases change. The fake-only
`backings`/`corrupt` construction options are not interface
surface and never migrate.

Filesystem. The canonical `FsAdapter` is the upstream plugin-fs
surface: `exists`, `mkdir`, `readFile`, `writeFile`,
`readTextFile`, `writeTextFile`, `readDir`, `remove`, `lstat`,
`stat`, `copyFile`, `rename`, `open`, `watch`, with
`BaseDirectory` option bags and `DirEntry` carrying exactly four
fields. The mirror is a workspace contract: `scanMarkdown`,
`removeToTrash`/`restoreFromTrash`/`purgeFromTrash`/`listTrash`,
`rename` with `rewriteLinks` and a `rewrittenFiles` report,
`resolveImage`, and `seq`-ordered `created`/`changed`/`deleted`/
`moved` events. None of those exist on the shim. The C-FS cases
bind the composed workspace layer (AD-17 rename/link rewriting,
trash, dot filtering, atomic write); the web factory provides that
layer over the shim plus the workspace API, and the Tauri factory
provides it over the Tauri shim with the E2 divergence for C-FS-05a.

SQL. The canonical `SqlAdapter` is the raw shim (`load(path)` then
`execute(query, bindValues)`, `select(query, bindValues)`,
`close()`), kept only for the legacy `src/db` callers funneled
through `getDb`. The mirror is the typed operation catalog from
`fase1/desain-sql-adapter.md` (`query`/`queryOne`/`queryMany`/
`execute`/`transaction` over `DbReadOperation`/`DbWriteOperation`,
plus `ready()` and `mode`). The C-SQ/CT cases bind the typed
catalog; no case sends raw SQL (CT-S5/C-SQ-08 asserts the raw path
is rejected). The raw shim must never become a contract surface:
the Postgres-backed factory implements the typed catalog over
Drizzle, and the deferred migration/catalog/auth cases run there.

Errors. V2-04 added no new error taxonomy (`errors.ts` unchanged:
`PlatformCapabilityError` only). The scaffold-local `ContractError`
codes (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`,
`UNKNOWN`) stay until a final taxonomy lands; cases assert codes,
never message text, except CT-X6.

F6 resolution (wave 4, W4-CODEMOD): the SQL part of this entry is
RESOLVED. The SQL mirror folded into re-exports of the canonical
surface (`SqlAdapter` from `src/lib/platform/sql/interface.ts`,
the 74-kind catalog from `ops-catalog.ts`, row types from
`src/types/`), and the SQL cases assert the canonical
`SqlAdapterError` / `SqlErrorCode` instead of `ContractError`.
The six ghost kinds are gone (see the header of `sql-cases.ts`);
CT-K4 was deleted with no canonical replacement. The Store and
Filesystem parts of this entry remain open. CT-X6 no longer
asserts message text on any leg (see E14).

## E10: the web column uses catalogued S keys (UNKNOWN writes throw)

The web adapter with the production classifier rejects UNKNOWN
writes by design (`desain-store-adapter.md` section 2.3): `set`
and `delete` over a key the key schema does not know throw
`PlatformCapabilityError` (`invalid_argument`,
`store.setUnknownKey` / `store.deleteUnknownKey`). The fake has no
key schema and accepts any non-secret key. Cases that write
arbitrary keys therefore use catalogued S keys in the web column,
while the fake column keeps its original keys:

| Case | Fake keys | Web keys (all S in key-schema.ts) |
|---|---|---|
| CT-02 | `to-delete`, `never-existed` | `darkMode`, `centeredContent` |
| CT-03a | `missing`, `a`, `b` | `primaryModel`, `language`, `editorLineHeight` |
| CT-03b | `obj` | `language` |
| CT-03c | `watched`, `other`, `after-reset` | `language`, `editorLineHeight`, `primaryModel` |
| CT-22 | `keep-me` | `language` |

This is a key renaming, not a weakened assertion: the asserted
behavior (throw on `undefined` with the key unchanged,
keys/values/entries consistency, deep clone, listeners,
`createNew`) is identical in both columns.
C-ST-02 is unchanged: UNKNOWN reads are tolerant in both columns
(the web adapter reads UNKNOWN keys from its S cache and reports
absent keys as `undefined`). The UNKNOWN-write rejection itself is
covered by the key-schema and adapter specs, not by a contract
case, because the fake cannot express it.

## E11: cross-handle visibility needs save plus reload (C-ST-03)

The fake shares one backing map, so a write through one handle is
visible through another immediately. The web adapter holds
per-handle caches over HTTP: a write is visible to another handle
only after `save()` (PATCH with the baseRevision guard) and
`reload()` (refetch). The web column of C-ST-03 therefore saves
both handles and reloads the asserting handle before reading; the
fake column keeps immediate visibility. The asserted behavior (the
store stays readable, last-write-wins per key for the shared key,
the document stays JSON-serializable) is identical. The save order
also exercises the 409 path: both handles load at one revision,
the first save advances it, and the second save retries after a
`revision_conflict` before the reload reads the merged document.

## E12: web closed-handle and corrupt errors use the real taxonomy

CT-03c. The fake throws scaffold-local `ContractError`
(`NOT_FOUND`) on closed-handle access (see E6). The web adapter
throws a plain `Error` with the message `Store handle for
"<path>" is closed`, because the landed error skeleton has no
`NOT_FOUND` code yet (`store.web.ts` header, R-03 in
`fase1/laporan-store-interface.md`). The web column asserts the
plain-`Error` shape: an `Error` that is neither a `ContractError`
nor a `StoreWebError`, with a message matching `/is closed/`.
The message-pattern match is a deliberate, recorded exception to
the "never message text" rule: a plain `Error` carries no code to
assert. The exact message is not pinned beyond that pattern.

C-ST-04. The fake-corrupt column throws `ContractError`
(`UNAVAILABLE`). The web-corrupt column runs the real adapter
against an unreachable backend and throws `StoreWebError` with
the client-side code `network_error` (the wire code is carried
verbatim when the server answers; here no answer arrives). The
web column asserts `isStoreWebError` plus the code. Neither
divergence weakens its case: both columns assert a typed failure,
never a hang or `undefined`.
## E13: the 50-operation bound lives at three layers, and only the adapter layer is contract-asserted

CT-X5 asserts that a transaction of 51 operations is rejected
with `VALIDATION` and a transaction of 50 succeeds, on every leg.
The bound itself is enforced at three layers with different
mechanics, and the case deliberately asserts only the
adapter-level one:

- Adapter layer: `WebSqlAdapter.transaction` rejects oversized
  transactions locally instead of splitting them ("transactions
  are never split"); the fake and the Postgres shim mirror that
  rejection. Read batches over 50 operations ARE split: the web
  adapter chunks `queryMany` itself, and the Postgres shim
  chunks likewise.
- Transport layer: `createSqlDbClient` chunks calls over 50
  operations into consecutive 50-operation requests. Atomicity
  holds per chunk, not per call: a later-chunk failure leaves
  earlier chunks committed. No contract case exercises a
  multi-chunk write call, because the adapter never issues one.
- Server layer: route validation rejects request bodies over 50
  operations (400) and over 1 MB. The 1 MB half of CT-X5 stays
  deferred to the server level (see README.md); the op-count
  half at the server layer is covered by server specs, not by
  this suite.

## E14: Fase 1 410 stubs, fake-only cases, and adapter-observable surfaces

Four cases run on the fake leg only, because the server behavior
they need is stubbed with 410 `capability_unavailable` in Fase 1
and planned for Fase 2: C-SQ-06b, CT-H5, and CT-S6 seed chunks
through `vector.replaceChunks`, and CT-X4 commits through
`wiki.commitRevision` (with `wiki.upsertSource` /
`wiki.upsertPage` likewise stubbed). Their fake-local semantics
(chunk validation rules, the wiki commit guard, the absence of
wiki_meta dirty modeling) are documented in the fake header and
are NOT server behavior; when the Fase 2 handlers land, these
cases move to all legs and any disagreement is resolved in
favor of the server. CT-K4 (`vector.insertChunk`) has no
canonical operation at any layer and was deleted, not moved.

Three more adapter-observability facts the remapped cases rely
on:

- The fake reports mode `"web"`. `SqlMode` has no `"fake"`; the
  old mirror-only mode value is gone with the fold, and no case
  asserts the mode value.
- The web adapter rebuilds error messages from wire codes, so
  server message text never reaches the caller. CT-X6 therefore
  asserts the `CONFLICT` code plus the guard details
  (`currentTagIds`, `currentPrimaryTagId`) on all legs; the
  pinned upstream message stays pinned by
  `server/test/db-handlers-records-tags.spec.ts`, and the
  `TAG_GUARD_CONFLICT_MESSAGE` constant stays exported from
  `contract-types.ts` as a Kelas J record.
- The Postgres leg (`implementations/postgres.ts`) is registered
  but live-unverified: it has never run against a real database
  in this workspace. Its first live run belongs to CI or the
  merge gate, against a scratch database named by
  `SQL_CONTRACT_DATABASE_URL`.
