# Database handlers, group A (V3-13b)

Status: SKELETON ONLY. No per-kind handler exists in this directory yet.

## Gate AD-42f (binding)

The handler-kind division note
(`fase1/pembagian-handler-kind.md`: one kind, one handler, one author)
MUST exist before any per-kind handler code is pushed. This skeleton
was pushed while waiting for that note. It contains only:

- `handler.ts`: the shared generic handler shape (typed input in,
  typed result out, Drizzle only, no raw SQL strings per AD-26).
- `registry.ts`: the minimal registration seam (immutable registry,
  duplicate-kind merge guard, unknown-kind dispatch rejection).
- This README.

No operation kind is named or implemented here.

## Rules for the handlers that follow

- One kind per file, in this directory only. Group A kinds only, as
  listed for V3-13b in the division note. Never take group B kinds
  (V3-13c) and never invent a division.
- Drizzle only. No raw SQL strings anywhere (AD-26).
- Every query is scoped to the workspace id from the handler context.
  The workspace id is never an operation field.
- Handlers register through `registry.ts`. The route dispatch worker
  (V3-13a) owns routes and dispatch; if its seam differs, the
  integrator reconciles the two seams at merge time.
- No routes, no migrations, no group B handlers in this branch.
