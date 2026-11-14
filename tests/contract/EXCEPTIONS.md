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

## E4: CT-02 asserts interim behavior (F1-22 unconfirmed)

`fase1/desain-store-adapter.md` section 5.1 leaves the verdict for
`set(key, undefined)` (H1/H2/H3/H4) unconfirmed pending a check
against the Rust implementation, and states CT-02 stays pending
until the verdict is recorded. The scaffold runs CT-02 as
`CT-02-interim`, asserting the interim "delete" behavior matching
the POC shim, with the case name saying so. When the verdict lands,
the case must be re-parameterized over the verdict and this entry
updated. The store migration gate does not pass on the interim case
alone.

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
