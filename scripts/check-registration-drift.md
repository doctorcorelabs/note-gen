# Registration drift gate

Fail-closed check that the two generated registration files match a fresh
generation from the current adapters and db handlers (AD-61, design
section 6.1).

## Command

```sh
node scripts/check-registration-drift.mjs
```

Exit 0: both files match. Exit 1: drift, a missing file, a missing
generator, a generator error, or a `--check` run that rewrote a file.
The gate never writes, never regenerates, and never passes vacuously.

## What it checks

One invocation checks both files (design section 6.1 item 3):

- `server/src/routes-generated.ts`
- `server/src/services/db/handlers.generated.ts`

The gate runs `node scripts/generate-registration.mjs --check`, forwards
the generator diagnostics, and verifies the check wrote nothing (hash
snapshot before and after). A failure message names the guarded files
and the fix.

## Fixing drift

```sh
node scripts/generate-registration.mjs
```

Commit the handwritten inputs plus both generated outputs in the same
commit, then re-run the gate. Never edit a generated file by hand,
including while resolving a merge conflict: resolve the handwritten
inputs first, then regenerate (design section 7.3).

## CI

The `registration-drift` job in `.github/workflows/web-ci.yml` runs this
gate on every push and pull request. It needs no dependency install:
the gate and the generator use only the Node standard library (design
section 8.3 item 4).

## Missing generator (TODO-ANTARMUKA)

Until `scripts/generate-registration.mjs` lands, the gate fails with a
`TODO-ANTARMUKA` message naming the missing interface. That red state is
honest: the gate cannot verify files it cannot regenerate. Do not
weaken the gate into a skip.
