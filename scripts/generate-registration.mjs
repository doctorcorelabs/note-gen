// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// Generate server/src/routes-generated.ts from handwritten per-group
// registration adapters (AD-61 hybrid mechanism).
//
// Usage:
//   node scripts/generate-registration.mjs            # write the module
//   node scripts/generate-registration.mjs --check    # fail if the checked-in
//                                                       module differs from a
//                                                       fresh generation
//
// Mechanism: each route group owns one handwritten TypeScript adapter in
// server/src/routes/, named <group>.registration.ts, exporting exactly
// REGISTRATION_ID, REGISTRATION_ORDER, and registerGroup (see
// fase1/desain-registrasi-programatik.md section 3.1). This generator only
// assembles the adapters: it imports each adapter once and calls its
// registerGroup in rank order. It never infers deps, conditions, or order
// from registrar code, and it never executes adapter code: it reads the
// three contract exports with regular expressions only.
//
// The frozen middleware shape (AD-40) is NOT generated: Fastify creation,
// request ids, error handling, verifier resolution, and auth hooks stay
// hand-written in server/src/app.ts, in their frozen order. Only the route
// blocks move into adapters plus this generated index, in rank order.
//
// This is the route tier of the generator only. The db handler scan tier
// (handlers.generated.ts, design section 8.1) is a separate increment and
// is intentionally not implemented here; this script reads no handler
// files and writes no handler output. Its --check mode therefore guards
// routes-generated.ts only.
//
// Output is fully deterministic (sorted inputs, rank order, no timestamps,
// no environment reads), so --check detects any hand edit of the generated
// module. Any validation failure aborts before writing anything: there
// are no warnings that allow generation to continue.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROUTES_DIR = join(ROOT, 'server', 'src', 'routes');
const OUT_FILE = join(ROOT, 'server', 'src', 'routes-generated.ts');

const ROUTES_DIR_LABEL = 'server/src/routes';
const OUT_FILE_LABEL = 'server/src/routes-generated.ts';

function fail(message) {
  throw new Error(`generate-registration: ${message}`);
}

function pascalCase(id) {
  return id
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function readAdapters() {
  let files;
  try {
    files = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.registration.ts'))
      .sort();
  } catch {
    fail(`${ROUTES_DIR_LABEL}: cannot read adapter directory`);
  }
  if (files.length === 0) {
    fail(`${ROUTES_DIR_LABEL}: no adapter files (*.registration.ts) found`);
  }
  const adapters = [];
  const seenIds = new Set();
  const seenOrders = new Map();
  const seenAliases = new Map();
  for (const file of files) {
    const label = `${ROUTES_DIR_LABEL}/${file}`;
    const stem = file.slice(0, -'.registration.ts'.length);
    let src;
    try {
      src = readFileSync(join(ROUTES_DIR, file), 'utf8');
    } catch {
      fail(`${label}: cannot read file`);
    }
    const idMatch = src.match(/export const REGISTRATION_ID = (['"])([^'"]+)\1 as const;/);
    if (!idMatch) {
      fail(`${label}: missing "export const REGISTRATION_ID = '<id>' as const;"`);
    }
    const id = idMatch[2];
    if (id !== stem) {
      fail(`${label}: REGISTRATION_ID "${id}" does not match file stem "${stem}"`);
    }
    if (!/^[A-Za-z0-9-]+$/.test(id)) {
      fail(`${label}: REGISTRATION_ID "${id}" contains characters outside [A-Za-z0-9-]`);
    }
    if (seenIds.has(id)) {
      fail(`duplicate REGISTRATION_ID "${id}"`);
    }
    seenIds.add(id);
    const orderDecl = src.match(/export const REGISTRATION_ORDER\s*=\s*([^;]+);/);
    if (!orderDecl) {
      fail(`${label}: missing "export const REGISTRATION_ORDER = <integer>;"`);
    }
    const orderText = orderDecl[1].trim();
    if (!/^\d+$/.test(orderText)) {
      fail(`${label}: REGISTRATION_ORDER must be an integer, found "${orderText}"`);
    }
    const order = Number(orderText);
    if (order < 1 || order > 9999) {
      fail(`${label}: REGISTRATION_ORDER ${order} is outside 1-9999`);
    }
    if (seenOrders.has(order)) {
      fail(`duplicate REGISTRATION_ORDER ${order}: ${seenOrders.get(order)} and ${file}`);
    }
    seenOrders.set(order, file);
    if (!/export async function registerGroup\s*\(/.test(src)) {
      fail(`${label}: missing "export async function registerGroup("`);
    }
    for (const imp of src.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
      if (/\.registration(\.js)?$/.test(imp[1])) {
        fail(`${label}: adapter must not import another adapter ("${imp[1]}")`);
      }
    }
    const alias = `register${pascalCase(id)}Group`;
    if (seenAliases.has(alias)) {
      fail(`adapter import alias collision on "${alias}": ${seenAliases.get(alias)} and ${file}`);
    }
    seenAliases.set(alias, file);
    adapters.push({ file, stem, id, order, alias });
  }
  adapters.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return adapters;
}

function generate(adapters) {
  const lines = [];
  lines.push('// SPDX-License-Identifier: GPL-3.0-only');
  lines.push('// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.');
  lines.push('// See LICENSE and FORK.md.');
  lines.push('');
  lines.push('// GENERATED by scripts/generate-registration.mjs. DO NOT EDIT BY HAND.');
  lines.push('// Regenerate with: node scripts/generate-registration.mjs');
  lines.push(`// Adapters (rank order): ${adapters.map((a) => `${a.order} ${a.id}`).join(', ')}.`);
  lines.push(`// Route groups: ${adapters.length} adapters.`);
  lines.push('// The frozen middleware shape (AD-40) lives in app.ts, not here:');
  lines.push('// this module only calls group adapters, in rank order.');
  lines.push('');
  lines.push("import type { RegistrationContext } from './registration/context.js';");
  for (const a of adapters) {
    lines.push(`import { registerGroup as ${a.alias} } from './routes/${a.stem}.registration.js';`);
  }
  lines.push('');
  lines.push('export async function registerRouteGroups(ctx: RegistrationContext): Promise<void> {');
  for (const a of adapters) {
    lines.push(`  // ${a.order} ${a.id}`);
    lines.push(`  await ${a.alias}(ctx);`);
  }
  lines.push('}');
  const output = `${lines.join('\n')}\n`;
  if (output.includes('\u2014')) {
    fail('generated output contains an em dash, which is forbidden');
  }
  return output;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/generate-registration.mjs           write server/src/routes-generated.ts',
    '  node scripts/generate-registration.mjs --check   fail if the checked-in module differs',
    '',
  ].join('\n');
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(usage());
    return 0;
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    process.stderr.write(usage());
    fail(`unknown arguments: ${argv.join(' ')}`);
  }
  const check = argv.length === 1;
  const adapters = readAdapters();
  const output = generate(adapters);
  const summary = `${adapters.length} adapters (${adapters.map((a) => `${a.order} ${a.id}`).join(', ')})`;
  if (check) {
    let current;
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      fail(`${OUT_FILE_LABEL} does not exist; run the generator without --check first`);
    }
    if (current !== output) {
      const currentLines = current.split('\n');
      const freshLines = output.split('\n');
      let first = 0;
      while (first < Math.min(currentLines.length, freshLines.length) && currentLines[first] === freshLines[first]) {
        first += 1;
      }
      fail(`drift detected: ${OUT_FILE_LABEL} differs from a fresh generation (first difference at line ${first + 1}); regenerate or revert the hand edit`);
    }
    process.stderr.write(`registration up to date: ${summary}\n`);
    return 0;
  }
  writeFileSync(OUT_FILE, output);
  process.stderr.write(`wrote ${OUT_FILE_LABEL}: ${summary}\n`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
