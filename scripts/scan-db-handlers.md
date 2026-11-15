# Handler scan: db kind handlers (AD-61)

`scripts/scan-db-handlers.mjs` scans `server/src/services/db/` and
generates `server/src/services/db/handlers.generated.ts`, which
exports one function, `registerDbHandlers(registry)`, for the db
adapter (`db.registration.ts`). It is the handler-scan half of the
AD-61 hybrid mechanism; the route-level generator
(`scripts/generate-registration.mjs`) imports `buildHandlersOutput()`
from this file and assembles adapters, so one invocation covers both
generated files.

## Commands

- Generate: `node scripts/scan-db-handlers.mjs`
- Drift check: `node scripts/scan-db-handlers.mjs --check` (exit 1
  when the checked-in file differs from a fresh scan, naming the
  first differing line)

Standalone runs are for debug only. The drift gate is
`node scripts/generate-registration.mjs --check`, which checks both
generated files in one invocation; per-file checks are forbidden as
a gate (desain section 6.1 item 3).

## Rules

- Input is the handler directory itself: every `.ts` file there is
  infrastructure (8 files, listed in the script), the generated
  file itself, or exactly one handler registration. Nothing is
  skipped silently and there is no manifest or JSON input.
- Each handler file must export `HANDLER_KIND` (exactly one
  declaration) and `export async function handle`. Read vs write
  comes from the `kinds.ts` catalog only. `validate` is picked up
  when the file exports `export function validate(`; handlers
  without it register as `{ handle }`.
- The scanner fails hard (exit 1, writes nothing) on: a missing or
  unparsable catalog, a kind outside the catalog or in both lists,
  a duplicate kind, a missing `handle`, an alias collision, an
  unsupported `validate` form, or an empty handler set. Catalog
  kinds without a handler file are not an error.
- Output is deterministic (byte order by file name, no clock, no
  environment) and follows desain-registrasi-programatik.md
  section 8.1. Never edit the generated file by hand; regenerate
  to resolve conflicts.
- The scan is folded into the route-level generator: the GENERATED
  header names `scripts/generate-registration.mjs` as the regenerate
  command, and standalone output is byte-identical to the
  generator's handler output (shared `buildHandlersOutput()`).
