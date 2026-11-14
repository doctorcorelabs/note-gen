<!-- SPDX-License-Identifier: GPL-3.0-only -->
# Contract factories: web, Tauri, Postgres

No factory lives here yet. This directory holds the factory
modules the integrator adds when the real adapters land:
one module per implementation column (`web.ts`, `tauri.ts`, and
the Postgres-backed SQL factory, e.g. `postgres.ts`). The fake
column stays in `tests/fakes/` and is wired directly from the
`*.contract.ts` entries; it is never registered from here.

## Factory shape

Every factory satisfies `ContractFactory<T>` from
`../contract-harness.ts`:

- `name`: exactly `web`, `tauri`, or `postgres`. The name appears
  in suite titles (`[impl=web]`) and in reports; a missing column
  is absent from the report, never reported as skipped.
- `create()`: returns a fresh implementation instance for one
  case. No state is shared between cases or between factories.
  For SQL, `create()` runs against a fresh database (fresh
  Postgres database per file with explicit cleanup between cases
  is acceptable if per-case setup is too slow; the cleanup must
  be explicit, not assumed).
- `teardown(impl)`: releases the instance (close connections,
  remove temp state). Optional only when there is nothing to
  release.

Per-adapter extras, carried on the factory object next to the
base shape (see the `*ContractFactory` interfaces in the
`*-cases.ts` files):

- Store: `reopen(impl)` returns a new adapter over the same
  backing, for C-ST-01/C-ST-06. The web factory reopens over the
  same settings storage; it must not share an in-memory document
  with the first instance in a way that hides a persistence bug.
- Store (corrupt backing): the corrupt suite needs a factory
  whose `load()` rejects with a typed error, for C-ST-04. The web
  factory provides its own corrupt-backing construction (a
  corrupt stored document, or an unreachable backend); the fake
  `corrupt: true` option is fake-only and never migrates.
- Filesystem: `writeExternally(impl, path, content)` writes a
  file bypassing the adapter under test (direct write to the
  workspace backing), for C-FS-10. It must not call the adapter
  write path; a factory that routes through the adapter proves
  nothing about external writes.
- SQL (Postgres): the factory additionally runs the deferred
  cases listed in `../README.md` (CT-M, CT-K5, CT-T6, CT-S1 to
  CT-S4, CT-I3, CT-P, C-SQ-02, C-SQ-09). Those cases do not run
  against the fake and must fail explicitly, not skip, if wired
  to an implementation that cannot run them.

## Column selection

- The `web` column runs in every PR run (`pnpm test:contract`).
- The `tauri` column runs only with `CONTRACT_TAURI=1`
  (`pnpm test:contract:tauri`, nightly/manual job, needs a
  webview/display) and must never block PRs. Without the flag,
  the Tauri factory is not registered at all: entries check
  `process.env.CONTRACT_TAURI === "1"` before importing or
  registering it, so a PR run never loads Tauri code.
- The `postgres` column runs in the CI `contract` job with a
  Postgres 17 service container, and locally against the compose
  test database. It is the only column that proves SQL behavior;
  the fake column proves only that the adapter-level cases are
  runnable and can detect violations (see EXCEPTIONS.md E3).

## Divergence rules

- A deliberate difference between columns is recorded in
  `../EXCEPTIONS.md` BEFORE the diverging case is written, and
  asserted as the expected divergent behavior. Silent `it.skip`
  is forbidden. The known forward-looking divergence is E2
  (Tauri rename keeps upstream behavior for plain Markdown
  links); the Tauri C-FS-05a case asserts it and references E2.
- A factory must not weaken a case to fit its implementation.
  If the implementation cannot meet a case, the case fails, the
  failure is reported, and the exception (if genuinely intended)
  is recorded in `../EXCEPTIONS.md` with the design decision that
  justifies it.
- Factories import adapters only through `src/lib/platform/`
  (registry/barrel) or the workspace API layer. Direct imports
  of `@tauri-apps/*` outside `src/lib/platform/` are forbidden,
  including here: the Tauri factory wraps the Tauri adapter, it
  does not call Tauri APIs itself.
- No factory reads secrets, prints secret values, or sends real
  data anywhere. AI transport cases (when they land) use the
  stub server only, with synthetic content.
