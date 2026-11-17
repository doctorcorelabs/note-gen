<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Fakes

Independent in-memory implementations of the scaffold-local adapter
interfaces in `tests/contract/contract-types.ts`, for the contract
suites in `tests/contract/`. Each fake is written directly against
the interface. No fake wraps the web or Tauri implementation: a fake
that wraps the code under test proves nothing.

## Allowed simplifications

Per `fase1/desain-pengujian.md` section 2.1, the fakes may simplify
in exactly these ways, and no others without an entry in
`tests/contract/EXCEPTIONS.md`:

- No persistence across process restarts. Restart is simulated
  in-process by constructing a new adapter over the same backing
  (store) or not at all (filesystem, SQL). See EXCEPTIONS.md E1.
- No real OS filesystem events. Filesystem events are simulated
  explicitly through `FakeFsAdapter.simulateExternalWrite`, which
  the filesystem contract factory exposes as `writeExternally`.
- No real database, no SQL execution, no network, no auth. The SQL
  fake enforces constraints, guards, and the hash status machine
  over plain maps. Cases needing catalog, migration, auth, or true
  concurrency truth are deferred to Postgres; see
  `tests/contract/README.md` and EXCEPTIONS.md E3.
- No cross-tab, cross-process, or timing truth. Concurrency cases
  run sequentially against the fakes and prove only that the guard
  itself rejects the second writer. Timestamps come from a monotonic
  in-fake clock (SQL) so ordering assertions are deterministic.

Cases that demand a simplified-away property run only on the web
and Tauri factories and are marked explicitly in the case file.

## Per-fake notes

### `fake-store.ts`

`FakeStoreAdapter` / `FakeStoreHandle` over a `Map` per store file.
Backing maps can be shared between adapter instances (the `backings`
option), which is how cases simulate a second session or a restart.
Only `store.json` loads; every other name fails closed with
`PlatformCapabilityError`. Secret classification is the minimal
fake-local subset of the store design: the exact key `pin` and keys
whose lowercase name contains a sensitive pattern behave as absent
on every read surface, and `set` over them throws. The full
key-schema module belongs to the store-interface owner. The `corrupt: true` option makes
`load()` reject as if the stored document were corrupt, for C-ST-04.
`set(key, undefined)` throws a validation error and leaves the key
unchanged (H3, CT-02, see EXCEPTIONS.md E4). A nested undefined field
inside an object value is dropped at the `set()` boundary and an
undefined array element becomes null, matching the JSON wire form
(F1-22 step 3, CT-02-nested, W4-F122Q).

### `fake-fs.ts`

`FakeFsAdapter` over a `Map` keyed by normalized workspace-relative
paths. Writes are single assignments, the in-memory equivalent of
the atomic write (temp file plus rename) the server must provide.
Dot segments are filtered on every observation path, including
events. Rename rewrites Markdown links and image references by
default (AD-17) and reports rewritten files. Paths escaping the
root are rejected with a typed `VALIDATION` error. Trash lives in a
separate map outside the workspace tree. There is no symlink
support (see EXCEPTIONS.md E8).

### `fake-sql.ts`

`FakeSqlAdapter` over plain maps. It enforces unique constraints,
trigger-equivalent tag semantics, the hash status machine,
transaction atomicity via snapshot/restore, optimistic guards, and
idempotency keys. Fake-local decisions, recorded so the integrator
can compare them with the real implementation: the fake starts
empty (no seeded tag, no workspace; seeding is a server bootstrap
concern); FK-style rejections use `VALIDATION`, guard conflicts use
`CONFLICT`, missing rows on write use `NOT_FOUND`; unknown operation
kinds are rejected with `VALIDATION`, while extra fields on an
operation are ignored (strict unknown-field rejection is a server
TypeBox concern); idempotency keys never expire; `ready()` reports
`migrationsCurrent: true` because the fake has no migrations; a
null `sourceId` is stored as null and stays null on read, so null
rows stay independent exactly like rows under a partial unique
index (the duplicate check only runs for non-null `sourceId`).

### `broken-fake-store.ts`

Deliberately broken store for the negative control only. It leaks
secret keys and discards the document on `save()`. Selected only
with `CONTRACT_BROKEN_STORE=1`. Never use it as a normal factory.
Do not fix it; its defects are the point. See
`tests/contract/README.md` (Negative control).
