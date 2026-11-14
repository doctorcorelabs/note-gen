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
