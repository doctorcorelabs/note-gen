#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Dump the registration fingerprint of the current tree.
//
// Usage (from anywhere; the output path resolves against the cwd):
//   node server/scripts/dump-registration.mjs <out-path>
//
// Runs the dump spec (server/test/zz-registration-dump.spec.ts)
// through the server vitest binary with REG_DUMP_OUT set. The spec
// builds the real app and writes a deterministic dump: no
// timestamps, no random values, no absolute paths. Exits with the
// vitest exit code. The BEFORE dump committed on the branch is
// server/scripts/registration-before.txt; regenerate it only by
// running this script on the trunk the BEFORE claim covers, never
// by hand-editing.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '..');
const specPath = join('test', 'zz-registration-dump.spec.ts');

function fail(message) {
  console.error(`dump-registration: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '') {
  fail('usage: node server/scripts/dump-registration.mjs <out-path>');
}
const outPath = resolve(args[0]);

const vitestBin = join(serverDir, 'node_modules', '.bin', 'vitest');
if (!existsSync(vitestBin)) {
  fail(`vitest binary not found at ${vitestBin}; install server dependencies first (pnpm install in server/).`);
}

const result = spawnSync(vitestBin, ['run', specPath], {
  cwd: serverDir,
  stdio: 'inherit',
  env: { ...process.env, REG_DUMP_OUT: outPath },
});
if (result.error) {
  fail(`failed to run vitest: ${result.error.message}`);
}
if (result.status !== 0) {
  console.error(`dump-registration: vitest exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}
if (!existsSync(outPath)) {
  fail(`vitest passed but no dump was written at ${outPath}`);
}
console.error(`dump-registration: wrote ${outPath}`);
