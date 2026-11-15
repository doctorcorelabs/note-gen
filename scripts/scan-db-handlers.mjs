// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Scan db kind handler files and generate handlers.generated.ts.
//
// Usage (standalone runs are for debug only; the drift gate is the
// route-level generator, see the integration note below):
//   node scripts/scan-db-handlers.mjs          # write the generated file
//   node scripts/scan-db-handlers.mjs --check  # fail if the checked-in file
//                                              # differs from a fresh scan
//
// Mechanism (AD-61 hybrid, desain-registrasi-programatik.md sections 3.4,
// 6.2, 6.3, and 8.1): the scanner enumerates server/src/services/db/
// from the directory, reads HANDLER_KIND from each handler file,
// classifies read vs write from the kinds.ts catalog, and picks up
// validate when the file exports it, following the gen-db-wiring.py
// precedent and the scan core of the rf2 prototype generator. There
// is no per-kind manifest and no JSON input of any kind: the handler
// files themselves are the only input.
//
// The output (server/src/services/db/handlers.generated.ts) exports
// exactly one function, registerDbHandlers, which the db adapter
// (db.registration.ts) calls with its registry. Until that adapter
// lands, the generated file has no importer; it is still typechecked
// by the server tsconfig, which includes all of src.
//
// Fail-closed rules: the scanner exits 1 and writes nothing when any
// handler file lacks HANDLER_KIND or an exported async handle, when a
// kind is outside the catalog, duplicated, or in both catalog lists,
// when two files collide on one camelCase alias, when kinds.ts cannot
// be parsed, or when no handler file is found at all. A handler file
// is never skipped silently: every .ts file in the directory is
// either listed infrastructure, the generated output itself, or one
// registration. Catalog kinds without a handler file are NOT an
// error: they keep answering 500 (W1) or 410 (W2) until their handler
// lands. Output is deterministic: sorted directory order, no clock,
// no environment, no timestamps, so two runs over one tree produce
// byte-identical output.
//
// Integration note: this scan is folded into the route-level
// generator (scripts/generate-registration.mjs), which imports
// buildHandlersOutput() from this file so one --check invocation
// guards both generated files (desain section 6.1). The GENERATED
// header of the output therefore names that generator as the
// regenerate command (desain section 8.3). This file remains the
// scan implementation and stays runnable standalone for debug, but
// it is NOT a gate: the gate is
// `node scripts/generate-registration.mjs --check`.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HANDLER_DIR = join(ROOT, 'server', 'src', 'services', 'db');
const KINDS_FILE = join(HANDLER_DIR, 'kinds.ts');
const OUT_FILE = join(HANDLER_DIR, 'handlers.generated.ts');

const REL_HANDLER_DIR = 'server/src/services/db';
const REL_KINDS_FILE = `${REL_HANDLER_DIR}/kinds.ts`;
const REL_OUT_FILE = `${REL_HANDLER_DIR}/handlers.generated.ts`;

// Infrastructure files in the handler directory: never handler
// registrations (desain section 3.4). The generated file itself is
// listed separately so the scanner never scans its own output.
const INFRA_FILES = new Set([
  'deps.ts',
  'dispatch.ts',
  'idempotency.ts',
  'kinds.ts',
  'registry.ts',
  'runner.ts',
  'validation.ts',
  'workspace.ts',
]);
const GENERATED_FILE = 'handlers.generated.ts';

function fail(message) {
  throw new Error(`scan-db-handlers: ${message}`);
}

function camel(fileBase) {
  const parts = fileBase.split('-');
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

function cap(name) {
  return name[0].toUpperCase() + name.slice(1);
}

function parseCatalog() {
  let text;
  try {
    text = readFileSync(KINDS_FILE, 'utf8');
  } catch {
    fail(`${REL_KINDS_FILE}: cannot be read`);
  }
  const extract = (name) => {
    const m = text.match(new RegExp(`export const ${name} = \\[(.*?)\\] as const;`, 's'));
    if (!m) {
      fail(`${REL_KINDS_FILE}: cannot find ${name}`);
    }
    const kinds = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    if (kinds.size === 0) {
      fail(`${REL_KINDS_FILE}: ${name} holds no kinds`);
    }
    return kinds;
  };
  const reads = extract('DB_READ_OP_KINDS');
  const writes = extract('DB_WRITE_OP_KINDS');
  for (const kind of reads) {
    if (writes.has(kind)) {
      fail(`${REL_KINDS_FILE}: kind "${kind}" is in both read and write lists`);
    }
  }
  return { reads, writes };
}

function scanHandlers(catalog) {
  let entries;
  try {
    entries = readdirSync(HANDLER_DIR);
  } catch {
    fail(`${REL_HANDLER_DIR}: directory cannot be read`);
  }
  // Default string sort is code-unit order, which equals byte order
  // for the ASCII file names in this directory.
  const files = entries.filter((f) => f.endsWith('.ts')).sort();
  const seen = new Map();
  const aliases = new Map();
  const rows = [];
  let infraCount = 0;
  for (const file of files) {
    if (INFRA_FILES.has(file)) {
      infraCount += 1;
      continue;
    }
    if (file === GENERATED_FILE) {
      continue;
    }
    const rel = `${REL_HANDLER_DIR}/${file}`;
    const stem = file.slice(0, -3);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(stem)) {
      fail(`${rel}: file name stem "${stem}" is not kebab-case`);
    }
    let src;
    try {
      src = readFileSync(join(HANDLER_DIR, file), 'utf8');
    } catch {
      fail(`${rel}: cannot be read`);
    }
    const kindMatches = [...src.matchAll(/^export const HANDLER_KIND = '([^']+)' as const;/gm)];
    if (kindMatches.length === 0) {
      fail(`${rel}: no HANDLER_KIND export`);
    }
    if (kindMatches.length > 1) {
      fail(`${rel}: ${kindMatches.length} HANDLER_KIND exports, expected exactly one`);
    }
    const kind = kindMatches[0][1];
    if (!/^export async function handle\s*\(/m.test(src)) {
      fail(`${rel}: no exported async handle function`);
    }
    const hasValidate = /^export function validate\s*\(/m.test(src);
    if (
      !hasValidate &&
      /^export\s+(?:async\s+function\s+validate\s*\(|const\s+validate\s*=|let\s+validate\s*=|var\s+validate\s*=)/m.test(src)
    ) {
      fail(`${rel}: validate is exported in an unsupported form; use "export function validate("`);
    }
    if (seen.has(kind)) {
      fail(`duplicate kind "${kind}": ${seen.get(kind)} and ${file}`);
    }
    seen.set(kind, file);
    let side;
    if (catalog.reads.has(kind)) {
      side = 'Read';
    } else if (catalog.writes.has(kind)) {
      side = 'Write';
    } else {
      fail(`kind "${kind}" (${file}) is not in the kinds.ts catalog`);
    }
    const base = camel(stem);
    if (aliases.has(base)) {
      fail(`handler alias collision on "${base}": ${aliases.get(base)} and ${file}`);
    }
    aliases.set(base, file);
    rows.push({ file, stem, kind, side, base, hasValidate });
  }
  if (rows.length === 0) {
    fail(`${REL_HANDLER_DIR}: no handler files found`);
  }
  return { rows, infraCount };
}

function generate(rows) {
  const readCount = rows.filter((r) => r.side === 'Read').length;
  const noValidateCount = rows.filter((r) => !r.hasValidate).length;
  const lines = [];
  lines.push('// SPDX-License-Identifier: GPL-3.0-only');
  lines.push('// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.');
  lines.push('// See LICENSE and FORK.md.');
  lines.push('');
  lines.push('// GENERATED by scripts/generate-registration.mjs. DO NOT EDIT BY HAND.');
  lines.push('// Regenerate with: node scripts/generate-registration.mjs');
  lines.push('// Source: handler files scanned from server/src/services/db (byte order by file name).');
  lines.push(
    `// Db kind handlers: ${rows.length} (${readCount} read, ${rows.length - readCount} write; ${noValidateCount} without validate).`,
  );
  lines.push('// Consumed only by the db adapter (db.registration.ts); no other importer, no re-exports.');
  lines.push('');
  lines.push("import type { DbHandlerRegistry } from './registry.js';");
  for (const row of rows) {
    const validatePart = row.hasValidate ? `, validate as validate${cap(row.base)}` : '';
    lines.push(`import { HANDLER_KIND as ${row.base}Kind, handle as ${row.base}${validatePart} } from './${row.stem}.js';`);
  }
  lines.push('');
  lines.push('export function registerDbHandlers(registry: DbHandlerRegistry): void {');
  for (const row of rows) {
    const validatePart = row.hasValidate ? `validate: validate${cap(row.base)}, ` : '';
    lines.push(`  registry.register${row.side}(${row.base}Kind, { ${validatePart}handle: ${row.base} });`);
  }
  lines.push('}');
  const output = `${lines.join('\n')}\n`;
  if (output.includes('\u2014')) {
    fail('generated output contains an em dash, which is forbidden');
  }
  if (output.includes('\r') || output.includes('\t') || / \n/.test(output) || !output.endsWith('\n') || output.endsWith('\n\n')) {
    fail('generated output violates the byte rules (LF only, no tabs, no trailing spaces, one trailing newline)');
  }
  return output;
}

function summaryLine(rows, infraCount, catalog) {
  const readCount = rows.filter((r) => r.side === 'Read').length;
  const noValidateCount = rows.filter((r) => !r.hasValidate).length;
  const registered = new Set(rows.map((r) => r.kind));
  const uncovered = [...catalog.reads, ...catalog.writes].filter((k) => !registered.has(k)).sort();
  const counts =
    `${rows.length} handlers (${readCount} read, ${rows.length - readCount} write; ` +
    `${noValidateCount} without validate), ${infraCount} infra files, ` +
    `${uncovered.length} catalog kinds without handler`;
  const uncoveredLine = uncovered.length > 0 ? `kinds without handler: ${uncovered.join(', ')}\n` : '';
  return { counts, uncoveredLine };
}

// One composed entry point for reuse: parse the catalog, scan the
// handler directory, and render the generated file, with all
// fail-hard validation. Imported by scripts/generate-registration.mjs
// and used by the standalone main() below, so both entry points
// always emit byte-identical output.
function buildHandlersOutput() {
  const catalog = parseCatalog();
  const { rows, infraCount } = scanHandlers(catalog);
  const output = generate(rows);
  const { counts, uncoveredLine } = summaryLine(rows, infraCount, catalog);
  return { output, rows, infraCount, counts, uncoveredLine };
}

function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--check')) {
    fail('usage: node scripts/scan-db-handlers.mjs [--check]');
  }
  const check = argv.length === 1;
  const { output, counts, uncoveredLine } = buildHandlersOutput();
  if (check) {
    let current;
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      fail(`${REL_OUT_FILE} does not exist; run the scanner without --check first`);
    }
    if (current !== output) {
      const currentLines = current.split('\n');
      const freshLines = output.split('\n');
      let first = 0;
      while (first < Math.min(currentLines.length, freshLines.length) && currentLines[first] === freshLines[first]) {
        first += 1;
      }
      fail(
        `drift detected: ${REL_OUT_FILE} differs from a fresh scan ` +
          `(first difference at line ${first + 1}); regenerate or revert the hand edit`,
      );
    }
    process.stderr.write(`up to date: ${REL_OUT_FILE}: ${counts}\n${uncoveredLine}`);
    return 0;
  }
  try {
    writeFileSync(OUT_FILE, output);
  } catch {
    fail(`${REL_OUT_FILE}: cannot be written`);
  }
  process.stderr.write(`wrote ${REL_OUT_FILE}: ${counts}\n${uncoveredLine}`);
  return 0;
}

// Import-based reuse: the route-level generator imports
// buildHandlersOutput() (plus the output paths) so both generated
// files come from one invocation. Importing this module must not run
// main(): only a direct CLI invocation does.
export {
  buildHandlersOutput,
  generate as generateHandlersFile,
  parseCatalog,
  scanHandlers,
  REL_OUT_FILE as HANDLERS_GENERATED_REL,
  OUT_FILE as HANDLERS_GENERATED_ABS,
};

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
