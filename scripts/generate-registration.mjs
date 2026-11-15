// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// Generate server/src/routes-generated.ts from handwritten per-group
// registration adapters, and server/src/services/db/handlers.generated.ts
// from the db handler scan (AD-61 hybrid mechanism).
//
// Usage:
//   node scripts/generate-registration.mjs            # write both modules
//   node scripts/generate-registration.mjs --check    # fail if either checked-in
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
// This generator covers both tiers of the hybrid mechanism. The route
// tier assembles adapters into server/src/routes-generated.ts (design
// section 8.2). The db handler tier scans handler files into
// server/src/services/db/handlers.generated.ts (design section 8.1)
// by importing the scan logic from scripts/scan-db-handlers.mjs; that
// file remains the scan implementation, runnable standalone for debug,
// but it is not a gate. One invocation of this script writes both
// files, and one --check invocation guards both: per-file checks are
// forbidden as a gate (design section 6.1 item 3). Both outputs are
// fully computed and validated before the first file is written, so a
// handler-stage validation failure never leaves one fresh file and one
// stale file behind (design section 6.2, atomic pair rule).
//
// Both outputs are fully deterministic (sorted inputs, rank order, no
// timestamps, no environment reads), so --check detects any hand edit
// of either generated module. Any validation failure aborts before
// writing anything: there are no warnings that allow generation to
// continue.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHandlersOutput,
  HANDLERS_GENERATED_ABS,
  HANDLERS_GENERATED_REL,
} from './scan-db-handlers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROUTES_DIR = join(ROOT, 'server', 'src', 'routes');
const ROUTES_OUT_FILE = join(ROOT, 'server', 'src', 'routes-generated.ts');

const ROUTES_DIR_LABEL = 'server/src/routes';
const ROUTES_OUT_LABEL = 'server/src/routes-generated.ts';

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

function generateRoutes(adapters) {
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
    '  node scripts/generate-registration.mjs           write both generated files',
    '  node scripts/generate-registration.mjs --check   fail if either checked-in file differs',
    'Generated files:',
    '  server/src/routes-generated.ts',
    '  server/src/services/db/handlers.generated.ts',
    '',
  ].join('\n');
}

function firstDifferenceLine(current, fresh) {
  const currentLines = current.split('\n');
  const freshLines = fresh.split('\n');
  let first = 0;
  while (first < Math.min(currentLines.length, freshLines.length) && currentLines[first] === freshLines[first]) {
    first += 1;
  }
  return first + 1;
}

function checkOne(label, absPath, fresh) {
  let current;
  try {
    current = readFileSync(absPath, 'utf8');
  } catch {
    return `${label} does not exist; run the generator without --check first`;
  }
  if (current !== fresh) {
    return `drift detected: ${label} differs from a fresh generation (first difference at line ${firstDifferenceLine(current, fresh)}); regenerate or revert the hand edit`;
  }
  return null;
}

function writeOne(label, absPath, output) {
  try {
    writeFileSync(absPath, output);
  } catch {
    fail(`${label}: cannot be written`);
  }
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
  // Atomic pair rule (design section 6.2): compute both outputs, with
  // all validation, before writing the first file.
  const adapters = readAdapters();
  const routesOutput = generateRoutes(adapters);
  const handlers = buildHandlersOutput();
  const routesSummary = `${adapters.length} adapters (${adapters.map((a) => `${a.order} ${a.id}`).join(', ')})`;
  const summary = `${routesSummary}; ${handlers.counts}`;
  if (check) {
    // One invocation checks both files and names every differing file
    // (design section 6.1 items 2-3). Check mode writes nothing.
    const problems = [
      checkOne(ROUTES_OUT_LABEL, ROUTES_OUT_FILE, routesOutput),
      checkOne(HANDLERS_GENERATED_REL, HANDLERS_GENERATED_ABS, handlers.output),
    ].filter((p) => p !== null);
    if (problems.length > 0) {
      fail(problems.join('\n'));
    }
    process.stderr.write(`registration up to date: ${summary}\n${handlers.uncoveredLine}`);
    return 0;
  }
  writeOne(ROUTES_OUT_LABEL, ROUTES_OUT_FILE, routesOutput);
  writeOne(HANDLERS_GENERATED_REL, HANDLERS_GENERATED_ABS, handlers.output);
  process.stderr.write(`wrote ${ROUTES_OUT_LABEL}: ${routesSummary}\nwrote ${HANDLERS_GENERATED_REL}: ${handlers.counts}\n${handlers.uncoveredLine}`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
