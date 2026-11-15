// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// Self-test for check-registration-order.mjs. Run with:
//   node scripts/check-registration-order.selftest.mjs
// Exit 0 when every asserted case passes. The baseline case (case 3)
// only records the result of running the checker over the real tree;
// it never fails this script, because the baseline is evidence to
// report as-is, not a target the checker must hit.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const CHECKER = join(SCRIPT_DIR, 'check-registration-order.mjs');
const FIXTURES = join(SCRIPT_DIR, 'fixtures', 'registration-order');
const DOC = join(SCRIPT_DIR, 'check-registration-order.md');

let failures = 0;

function check(name, ok, detail) {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail === undefined ? '' : ` (${detail})`}\n`);
  if (!ok) failures += 1;
}

function runChecker(args) {
  return spawnSync('node', [CHECKER, ...args], { encoding: 'utf8' });
}

function parseJson(output) {
  return JSON.parse(output);
}

function walkFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

// Case 1: positive fixture must pass with the expected counts.
{
  const run = runChecker(['--root', join(FIXTURES, 'positive'), '--json']);
  let report = null;
  try {
    report = parseJson(run.stdout);
  } catch {
    report = null;
  }
  check('positive fixture exits 0', run.status === 0, `status=${run.status}`);
  check(
    'positive fixture reports ok with 2 adapters and 5 routes',
    report !== null && report.ok === true && report.counts.adapters === 2 && report.counts.routes === 5,
    report === null ? 'unparsable output' : JSON.stringify(report.counts),
  );
}

// Case 2: negative fixture must fail with exactly C-2 and C-5.
{
  const run = runChecker(['--root', join(FIXTURES, 'negative'), '--json']);
  let report = null;
  try {
    report = parseJson(run.stdout);
  } catch {
    report = null;
  }
  check('negative fixture exits 1', run.status === 1, `status=${run.status}`);
  const codes = report === null ? [] : report.violations.map((v) => v.code);
  check(
    'negative fixture reports exactly C-2 and C-5',
    report !== null && codes.length === 2 && codes[0] === 'C-2' && codes[1] === 'C-5',
    `codes=${codes.join(',')}`,
  );
  const text = report === null ? '' : report.violations.map((v) => v.message).join('\n');
  check('negative fixture names the clashing rank 20', text.includes('rank 20'), '');
  check('negative fixture names the duplicate POST /api/shared', text.includes('POST /api/shared'), '');
}

// Case 3: baseline over the real tree. Record only, never fail.
{
  const run = runChecker(['--root', REPO_ROOT]);
  const summary = run.stdout
    .split('\n')
    .find((line) => line.startsWith('adapters:'));
  process.stdout.write(`INFO: baseline exit=${run.status} ${summary ?? '(no summary line)'}\n`);
  check('baseline run completes (exit 0 or 1) with a summary line', (run.status === 0 || run.status === 1) && summary !== undefined, `status=${run.status}`);
}

// Case 4: missing input fails closed with exit 2.
{
  const missing = join(REPO_ROOT, 'does-not-exist-check-registration-order');
  const run = runChecker(['--root', missing]);
  check('missing root exits 2', run.status === 2, `status=${run.status}`);
}

// Case 5: no em dash in the checker, this self-test, the doc, or any
// fixture file (permanent repo rule).
{
  const files = [CHECKER, join(SCRIPT_DIR, 'check-registration-order.selftest.mjs'), DOC];
  if (statSync(FIXTURES, { throwIfNoEntry: false })?.isDirectory()) {
    walkFiles(FIXTURES, files);
  }
  const offenders = files.filter((file) => readFileSync(file, 'utf8').includes('\u2014'));
  check('no em dash in checker, self-test, doc, or fixtures', offenders.length === 0, offenders.join(', '));
}

process.stdout.write(failures === 0 ? 'SELFTEST: all asserted cases pass\n' : `SELFTEST: ${failures} case(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
