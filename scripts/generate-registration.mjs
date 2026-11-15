// Generate server/src/registration.generated.ts from per-group manifests.
//
// Usage:
//   node scripts/generate-registration.mjs            # write the module
//   node scripts/generate-registration.mjs --check    # fail if the checked-in
//                                                       module differs from a
//                                                       fresh generation
//
// Mechanism (AD-58 prototype): each route group owns one small JSON manifest
// in server/registration/. The generator emits a single registration module
// that buildApp imports once, so workers never edit a shared registration
// file by hand: adding a group means adding a manifest, and adding a db kind
// handler means adding a handler file (the db manifest opts into a scan of
// services/db, extending the gen-db-wiring.py precedent: HANDLER_KIND plus
// the kinds.ts catalog decide read vs write, and validate is picked up when
// the file exports it).
//
// The frozen middleware shape (AD-40) is NOT generated: Fastify creation,
// request ids, error handling, verifier resolution, and auth hooks stay
// hand-written in server/src/app.ts, in their frozen order. Only the route
// blocks move into the generated module, in the same contract order, with
// the same deps construction and the same conditional auth block.
//
// Manifest schema (all keys required except where noted):
//   id: string, unique, must match the file name "<order>-<id>.json"
//   order: number, unique, defines registration order (contract order)
//   comment: string, emitted as the block comment
//   imports: [{ from: string, names: string[] }] (module paths relative to
//     server/src, with the .js suffix the NodeNext build requires)
//   setup: string[], statements emitted before the calls (one statement
//     per entry; entries are emitted verbatim, prefixed with the block
//     indent, so multi-line statements use one entry per line)
//   condition: string | null, guard expression with `ctx` in scope
//   bind: string | null, statement emitted first inside the guarded block
//   calls: [{ fn: string, args: string }] where args is a verbatim
//     TypeScript argument list with `app` and `ctx` in scope; continuation
//     lines are relative-indented and the generator adds the block indent
//   after: string[], statements emitted after the calls
//   handlerScan: boolean, true for exactly one manifest (db); the
//     generator inserts handler registrations between setup and calls,
//     using the registry variable bound by the setup line that calls
//     createDefaultDbRouteDeps.
//
// The generator never evaluates manifest content: args/setup/after strings
// are emitted verbatim into reviewed, checked-in code. Output is fully
// deterministic (sorted inputs, no timestamps), so --check detects any
// hand edit of the generated module.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, 'server');
const MANIFEST_DIR = join(SERVER, 'registration');
const OUT_FILE = join(SERVER, 'src', 'registration.generated.ts');
const KINDS_FILE = join(SERVER, 'src', 'services', 'db', 'kinds.ts');
const HANDLER_DIR = join(SERVER, 'src', 'services', 'db');

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

const MANIFEST_KEYS = new Set([
  'after',
  'bind',
  'calls',
  'comment',
  'condition',
  'handlerScan',
  'id',
  'imports',
  'order',
  'setup',
]);

function fail(message) {
  throw new Error(`generate-registration: ${message}`);
}

function camel(fileBase) {
  const parts = fileBase.split('-');
  return parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

function cap(name) {
  return name[0].toUpperCase() + name.slice(1);
}

function wrapComment(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
}

function readManifests() {
  const files = readdirSync(MANIFEST_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail(`no manifests in ${MANIFEST_DIR}`);
  }
  const manifests = [];
  const seenIds = new Set();
  const seenOrders = new Set();
  for (const file of files) {
    const parsed = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf8'));
    for (const key of Object.keys(parsed)) {
      if (!MANIFEST_KEYS.has(key)) {
        fail(`${file}: unknown key "${key}"`);
      }
    }
    for (const key of MANIFEST_KEYS) {
      if (!(key in parsed)) {
        fail(`${file}: missing key "${key}"`);
      }
    }
    const expected = `${String(parsed.order).padStart(2, '0')}-${parsed.id}.json`;
    if (file !== expected) {
      fail(`${file}: file name must be "${expected}" (order + id)`);
    }
    if (seenIds.has(parsed.id)) {
      fail(`duplicate manifest id "${parsed.id}"`);
    }
    if (seenOrders.has(parsed.order)) {
      fail(`duplicate manifest order ${parsed.order}`);
    }
    seenIds.add(parsed.id);
    seenOrders.add(parsed.order);
    if (typeof parsed.comment !== 'string' || parsed.comment === '') {
      fail(`${file}: comment must be a non-empty string`);
    }
    if (!Array.isArray(parsed.imports) || parsed.imports.length === 0) {
      fail(`${file}: imports must be a non-empty array`);
    }
    const imported = new Set();
    for (const imp of parsed.imports) {
      if (typeof imp.from !== 'string' || !Array.isArray(imp.names) || imp.names.length === 0) {
        fail(`${file}: each import needs "from" and a non-empty "names" list`);
      }
      for (const name of imp.names) {
        imported.add(name);
      }
    }
    if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
      fail(`${file}: calls must be a non-empty array`);
    }
    for (const call of parsed.calls) {
      if (!imported.has(call.fn)) {
        fail(`${file}: call to "${call.fn}" which no declared import provides`);
      }
      if (typeof call.args !== 'string') {
        fail(`${file}: args for "${call.fn}" must be a string`);
      }
    }
    for (const field of ['setup', 'after']) {
      if (!Array.isArray(parsed[field]) || parsed[field].some((s) => typeof s !== 'string')) {
        fail(`${file}: ${field} must be an array of strings`);
      }
    }
    if (parsed.condition !== null && typeof parsed.condition !== 'string') {
      fail(`${file}: condition must be a string or null`);
    }
    if (parsed.bind !== null && typeof parsed.bind !== 'string') {
      fail(`${file}: bind must be a string or null`);
    }
    if (parsed.bind !== null && parsed.condition === null) {
      fail(`${file}: bind without condition is not supported`);
    }
    if (typeof parsed.handlerScan !== 'boolean') {
      fail(`${file}: handlerScan must be a boolean`);
    }
    manifests.push({ file, ...parsed });
  }
  manifests.sort((a, b) => a.order - b.order);
  const scanners = manifests.filter((m) => m.handlerScan);
  if (scanners.length !== 1) {
    fail(`exactly one manifest must set handlerScan, found ${scanners.length}`);
  }
  return manifests;
}

function parseCatalog() {
  const text = readFileSync(KINDS_FILE, 'utf8');
  const extract = (name) => {
    const m = text.match(new RegExp(`export const ${name} = \\[(.*?)\\] as const;`, 's'));
    if (!m) {
      fail(`kinds.ts: cannot find ${name}`);
    }
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  };
  const reads = extract('DB_READ_OP_KINDS');
  const writes = extract('DB_WRITE_OP_KINDS');
  for (const kind of reads) {
    if (writes.has(kind)) {
      fail(`kinds.ts: kind "${kind}" is in both read and write lists`);
    }
  }
  return { reads, writes };
}

function scanHandlers() {
  const { reads, writes } = parseCatalog();
  const files = readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.ts') && !INFRA_FILES.has(f)).sort();
  const seen = new Map();
  const rows = [];
  const aliases = new Set();
  for (const file of files) {
    const src = readFileSync(join(HANDLER_DIR, file), 'utf8');
    const kindMatch = src.match(/export const HANDLER_KIND = '([^']+)' as const;/);
    if (!kindMatch) {
      fail(`services/db/${file}: no HANDLER_KIND export`);
    }
    const kind = kindMatch[1];
    if (!src.includes('export async function handle')) {
      fail(`services/db/${file}: no exported async handle function`);
    }
    if (seen.has(kind)) {
      fail(`duplicate kind "${kind}": ${seen.get(kind)} and ${file}`);
    }
    seen.set(kind, file);
    let side;
    if (reads.has(kind)) {
      side = 'Read';
    } else if (writes.has(kind)) {
      side = 'Write';
    } else {
      fail(`kind "${kind}" (${file}) is not in the kinds.ts catalog`);
    }
    const base = camel(file.slice(0, -3));
    if (aliases.has(base)) {
      fail(`handler alias collision on "${base}"`);
    }
    aliases.add(base);
    rows.push({
      file,
      module: file.slice(0, -3),
      kind,
      side,
      base,
      hasValidate: src.includes('export function validate'),
    });
  }
  return rows;
}

function generate(manifests, handlers) {
  const lines = [];
  lines.push('// SPDX-License-Identifier: GPL-3.0-only');
  lines.push('// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.');
  lines.push('// See LICENSE and FORK.md.');
  lines.push('');
  lines.push('// GENERATED by scripts/generate-registration.mjs. DO NOT EDIT BY HAND.');
  lines.push('// Regenerate with: node scripts/generate-registration.mjs');
  lines.push(`// Source manifests (registration order): ${manifests.map((m) => m.file).join(', ')}`);
  const readCount = handlers.filter((h) => h.side === 'Read').length;
  lines.push(`// Db kind handlers discovered by scanning services/db: ${handlers.length} (${readCount} read, ${handlers.length - readCount} write).`);
  lines.push('// The frozen middleware shape (AD-40) lives in app.ts, not here:');
  lines.push('// this module only registers route blocks, in contract order.');
  lines.push('');
  lines.push("import type { FastifyInstance } from 'fastify';");
  lines.push("import type { AuthContext } from './auth/context.js';");
  lines.push("import type { ServerConfig } from './config.js';");
  lines.push("import type { HealthDbPool } from './db/pool.js';");
  const emittedImports = new Set();
  for (const m of manifests) {
    for (const imp of m.imports) {
      const key = `${imp.from}::${imp.names.join(',')}`;
      if (emittedImports.has(key)) {
        continue;
      }
      emittedImports.add(key);
      lines.push(`import { ${imp.names.join(', ')} } from '${imp.from}';`);
    }
  }
  lines.push('');
  lines.push('// Db kind handlers: one direct import per handler file,');
  lines.push('// no barrel (see services/db/deps.ts wiring pattern).');
  for (const h of handlers) {
    const validatePart = h.hasValidate ? `, validate as validate${cap(h.base)}` : '';
    lines.push(`import { HANDLER_KIND as ${h.base}Kind, handle as ${h.base}${validatePart} } from './services/db/${h.module}.js';`);
  }
  lines.push('');
  lines.push('// The subset of AppDeps the route blocks need. buildApp passes its');
  lines.push('// own deps object, which is structurally compatible; the verifier');
  lines.push('// fields stay in app.ts because only the frozen middleware uses them.');
  lines.push('export interface RegistrationContext {');
  lines.push('  config: ServerConfig;');
  lines.push('  pool: HealthDbPool | null;');
  lines.push('  version: string;');
  lines.push('  auth?: AuthContext;');
  lines.push('}');
  lines.push('');
  lines.push('export async function registerAllRoutes(app: FastifyInstance, ctx: RegistrationContext): Promise<void> {');
  for (const m of manifests) {
    for (const wrapped of wrapComment(m.comment, 96)) {
      lines.push(`  // ${wrapped}`);
    }
    const baseIndent = m.condition === null ? '  ' : '    ';
    const emitStatementLines = (entries) => {
      for (const entry of entries) {
        const parts = entry.split('\n');
        lines.push(baseIndent + parts[0]);
        for (const rest of parts.slice(1)) {
          lines.push(baseIndent + rest);
        }
      }
    };
    const emitCalls = () => {
      for (const call of m.calls) {
        const argLines = call.args.split('\n');
        lines.push(`${baseIndent}await ${call.fn}(${argLines[0]}`);
        for (const rest of argLines.slice(1)) {
          lines.push(baseIndent + rest);
        }
        lines[lines.length - 1] += ');';
      }
    };
    if (m.condition !== null) {
      lines.push(`  if (${m.condition}) {`);
      if (m.bind !== null) {
        lines.push(`${baseIndent}${m.bind}`);
      }
    }
    emitStatementLines(m.setup);
    if (m.handlerScan) {
      const registryMatch = m.setup.join('\n').match(/const (\w+) = createDefaultDbRouteDeps\(/);
      if (!registryMatch) {
        fail(`${m.file}: handlerScan needs a setup line binding createDefaultDbRouteDeps(...)`);
      }
      const registryVar = registryMatch[1];
      lines.push(`${baseIndent}// Register ${handlers.length} discovered kind handlers. Unregistered kinds keep`);
      lines.push(`${baseIndent}// answering 500 (W1) / 410 (W2) until their handler file lands.`);
      for (const h of handlers) {
        const validatePart = h.hasValidate ? `validate: validate${cap(h.base)}, ` : '';
        lines.push(`${baseIndent}${registryVar}.registry.register${h.side}(${h.base}Kind, { ${validatePart}handle: ${h.base} });`);
      }
    }
    emitCalls();
    emitStatementLines(m.after);
    if (m.condition !== null) {
      lines.push('  }');
    }
    lines.push('');
  }
  // Drop the trailing blank line inside the function body, keep one newline at EOF.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push('}');
  const output = `${lines.join('\n')}\n`;
  if (output.includes('\u2014')) {
    fail('generated output contains an em dash, which is forbidden');
  }
  return output;
}

function main(argv) {
  const check = argv.includes('--check');
  const manifests = readManifests();
  const handlers = scanHandlers();
  const output = generate(manifests, handlers);
  const readCount = handlers.filter((h) => h.side === 'Read').length;
  if (check) {
    let current;
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      fail(`${OUT_FILE} does not exist; run the generator without --check first`);
    }
    if (current !== output) {
      const currentLines = current.split('\n');
      const freshLines = output.split('\n');
      let first = 0;
      while (first < Math.min(currentLines.length, freshLines.length) && currentLines[first] === freshLines[first]) {
        first += 1;
      }
      fail(`drift detected: ${OUT_FILE} differs from a fresh generation (first difference at line ${first + 1}); regenerate or revert the hand edit`);
    }
    process.stderr.write(`registration up to date: ${manifests.length} manifests, ${handlers.length} handlers (${readCount} read, ${handlers.length - readCount} write)\n`);
    return 0;
  }
  writeFileSync(OUT_FILE, output);
  process.stderr.write(`wrote ${OUT_FILE}: ${manifests.length} manifests, ${handlers.length} handlers (${readCount} read, ${handlers.length - readCount} write)\n`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
