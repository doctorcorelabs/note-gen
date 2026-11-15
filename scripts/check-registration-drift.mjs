// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Registration drift gate (AD-61, design sections 6.1 and 7.2 M-1).
//
// Usage: node scripts/check-registration-drift.mjs
//
// The gate runs the registration generator in check mode and fails hard
// when either generated file differs from a fresh generation:
//
//   server/src/routes-generated.ts
//   server/src/services/db/handlers.generated.ts
//
// One invocation checks both files. Per-file checks are forbidden as a
// gate (design section 6.1 item 3): a pair checked separately can pass
// one by one while the pair is stale.
//
// Contract with the generator (scripts/generate-registration.mjs,
// owned by the generator worker, not by this gate):
//   - `node scripts/generate-registration.mjs --check` scans the
//     adapters and db handlers, rebuilds both outputs in memory, and
//     compares each output byte-for-byte with the checked-in file.
//   - Exit 0 when both files match; exit 1 otherwise, with a message
//     on stderr naming each differing file and its first differing
//     line (design section 6.1 item 2).
//   - Check mode must not write any file. This gate snapshots the
//     hashes of both generated files before running the generator and
//     fails if either hash changed afterwards, even on exit 0.
//
// Missing interface: when the generator script does not exist yet,
// this gate fails with a TODO-ANTARMUKA message. It never passes
// vacuously: a missing generator, a missing generated file, or a
// failing generator check is a red gate, not a skip.
//
// This gate never writes, never regenerates, and never edits a
// generated file. To fix drift, regenerate and commit the inputs plus
// both outputs together (design section 6.1 item 5):
//   node scripts/generate-registration.mjs
//
// Node standard library only: no install step is needed to run this
// gate in CI (design section 8.3 item 4).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATOR_REL = 'scripts/generate-registration.mjs';
const GENERATED_RELS = [
  'server/src/routes-generated.ts',
  'server/src/services/db/handlers.generated.ts',
];
const REGENERATE_COMMAND = 'node scripts/generate-registration.mjs';

function hashFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function fail(lines) {
  for (const line of lines) {
    console.error(line);
  }
  return 1;
}

function main() {
  const generatorAbs = join(ROOT, GENERATOR_REL);

  if (!existsSync(generatorAbs)) {
    return fail([
      'DRIFT GATE FAILED: generator missing.',
      `  Missing interface: ${GENERATOR_REL}`,
      '  TODO-ANTARMUKA: the promised generator interface (B-01/B-02) has not',
      '  landed in this tree yet, so the drift gate cannot verify the generated',
      '  files. This is a hard failure, not a pass. Guarded files:',
      ...GENERATED_RELS.map((rel) => `    - ${rel}`),
      `  Fix: land ${GENERATOR_REL} with --check support, generate both files`,
      `  with \`${REGENERATE_COMMAND}\`, and re-run this gate.`,
    ]);
  }

  const missing = GENERATED_RELS.filter((rel) => !existsSync(join(ROOT, rel)));
  if (missing.length > 0) {
    return fail([
      'DRIFT GATE FAILED: generated file(s) missing.',
      ...missing.map((rel) => `  Missing: ${rel}`),
      '  A missing generated file is drift: the checked-in pair does not match',
      '  a fresh generation (design section 6.1 item 2).',
      `  Fix: run \`${REGENERATE_COMMAND}\` first, commit both generated files,`,
      '  and re-run this gate.',
    ]);
  }

  const before = new Map(GENERATED_RELS.map((rel) => [rel, hashFile(join(ROOT, rel))]));

  const result = spawnSync(process.execPath, [generatorAbs, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.error) {
    return fail([
      'DRIFT GATE FAILED: could not run the generator check.',
      `  Command: node ${GENERATOR_REL} --check`,
      `  Error: ${result.error.message}`,
      '  Guarded files:',
      ...GENERATED_RELS.map((rel) => `    - ${rel}`),
    ]);
  }

  // Forward the generator diagnostics verbatim so the CI log keeps the
  // per-file drift detail (first differing line) from the generator.
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const after = new Map(GENERATED_RELS.map((rel) => [rel, hashFile(join(ROOT, rel))]));
  const rewritten = GENERATED_RELS.filter((rel) => before.get(rel) !== after.get(rel));
  if (rewritten.length > 0) {
    return fail([
      'DRIFT GATE FAILED: check mode rewrote generated file(s).',
      ...rewritten.map((rel) => `  Rewritten by --check: ${rel}`),
      '  The generator --check mode must compare in memory without writing',
      '  (design section 6.1 item 1). Restore the files and fix the generator.',
    ]);
  }

  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const named = GENERATED_RELS.filter((rel) => output.includes(rel));
    const lines = [
      'DRIFT GATE FAILED: generated registration file(s) are stale or invalid.',
      '  Checked files:',
      ...GENERATED_RELS.map((rel) => `    - ${rel}`),
    ];
    if (named.length > 0) {
      lines.push('  File(s) named by the generator output:');
      for (const rel of named) {
        lines.push(`    - ${rel}`);
      }
    } else {
      lines.push(
        '  The generator output above did not name a guarded file; treat both',
        '  checked files as suspect until the generator error is resolved.',
      );
    }
    lines.push(
      '  Fix: resolve the generator error above, then regenerate with',
      `  \`${REGENERATE_COMMAND}\` (or revert a manual edit to a generated file),`,
      '  commit the inputs plus both generated files together, and re-run this gate.',
    );
    return fail(lines);
  }

  console.log(
    'DRIFT GATE PASSED: both generated files match a fresh generation: ' +
      GENERATED_RELS.join(', ') +
      '.',
  );
  return 0;
}

process.exitCode = main();
