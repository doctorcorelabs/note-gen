#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Compare a fresh registration dump against the committed BEFORE
// dump. The registration refactor passes this gate only when the
// AFTER dump is byte-identical to BEFORE.
//
// Usage:
//   node server/scripts/compare-registration-dump.mjs [--before <path>] [--actual <path>]
//   --before <path>   BEFORE dump to compare against.
//                     Default: server/scripts/registration-before.txt
//                     (resolved next to this script).
//   --actual <path>   Compare this existing file instead of running
//                     a fresh dump. Used for the negative control:
//                     delete one route line from a copy of BEFORE
//                     and this script must exit non-zero.
//
// Exit codes: 0 = byte-identical, 1 = differs (unified diff printed
// to stdout), 2 = usage or run error.
//
// Allowed differences: NONE. Every difference fails the gate and
// must be explained line by line before any merge. A future
// allowed difference needs explicit normalization code here plus
// a written justification approved by the coordinator; silent
// filtering is forbidden.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultBefore = join(here, 'registration-before.txt');
const dumpScript = join(here, 'dump-registration.mjs');

function fail(message) {
  console.error(`compare-registration-dump: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let beforePath = defaultBefore;
let actualPath = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--before' && args[i + 1] !== undefined) {
    beforePath = resolve(args[i + 1]);
    i += 1;
  } else if (args[i] === '--actual' && args[i + 1] !== undefined) {
    actualPath = resolve(args[i + 1]);
    i += 1;
  } else {
    fail('usage: node server/scripts/compare-registration-dump.mjs [--before <path>] [--actual <path>]');
  }
}

if (!existsSync(beforePath)) {
  fail(`BEFORE dump not found: ${beforePath}`);
}

let tempDir = null;
if (actualPath === null) {
  tempDir = mkdtempSync(join(tmpdir(), 'reg-compare-'));
  actualPath = join(tempDir, 'after.txt');
  const result = spawnSync(process.execPath, [dumpScript, actualPath], { stdio: 'inherit' });
  if (result.error) {
    fail(`failed to run the dump script: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`dump script exited with code ${result.status}`);
  }
}
if (!existsSync(actualPath)) {
  fail(`actual dump not found: ${actualPath}`);
}

try {
  const before = readFileSync(beforePath);
  const actual = readFileSync(actualPath);
  if (before.equals(actual)) {
    console.log('compare-registration-dump: IDENTICAL');
    process.exit(0);
  }
  console.log('compare-registration-dump: DIFFERENT');
  try {
    execFileSync('diff', ['-u', '--label', 'BEFORE', '--label', 'AFTER', beforePath, actualPath], {
      stdio: 'inherit',
    });
  } catch (diffError) {
    // diff exits 1 when files differ; anything else means diff
    // itself failed, so report sizes instead of hiding the error.
    if (diffError.status !== 1) {
      console.log(`(diff unavailable, status ${diffError.status}; BEFORE ${before.length} bytes, AFTER ${actual.length} bytes)`);
    }
  }
  process.exit(1);
} finally {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
