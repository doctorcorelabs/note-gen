// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// FIXTURE ONLY. This module is NOT the production registration
// generator. It is a minimal test-side implementation of the promised
// generator/scan interface from desain-registrasi-programatik.md
// sections 3, 6, and 8 (AD-61), built so the B-08 suite can pin the
// contract while the real generator (B-01) and scan (B-02) are built
// in parallel. It lives under server/test/ on purpose: nothing under
// server/src/ may import it, and the server build (tsconfig.build.json
// includes only src) never sees it.
//
// Promised interface implemented here:
// - Adapter scan: regex over *.registration.ts, three mandatory
//   exports (REGISTRATION_ID, REGISTRATION_ORDER, registerGroup),
//   rank 1-9999 unique, ID equal to the file stem (section 3.1).
// - Handler scan: directory enumeration (never argv), HANDLER_KIND +
//   handle + optional validate, catalog classification from kinds.ts,
//   INFRA exclusion list (sections 3.4, 6.3).
// - Fail-hard validation V-1..V-17 (section 6.2). Every failure throws
//   RegistrationGeneratorError with a "<file>: <reason>" message; the
//   real CLI maps a throw to exit code 1 plus the message on stderr
//   (section 5.2 item 4). No output file is written on failure, and
//   both outputs are computed and validated before the first write
//   (atomic pair rule, section 6.2).
// - Deterministic byte output per section 8 (LF, one trailing newline,
//   two-space indent, rank-ordered adapters, byte-ordered handlers,
//   sequential await, no Promise.all, no re-exports).
// - Drift check: compare fresh generation byte-for-byte with the
//   checked-in files, reporting every drifted file with its first
//   differing line (section 6.1).
//
// What this fixture deliberately does NOT do: it never executes adapter
// or handler code, never reads route paths from registrar code (the
// generator assembles adapters only; section 2.1), and never reads
// environment variables or the clock (section 4.2 item 3).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RegistrationGeneratorError extends Error {
  readonly file: string;
  readonly reason: string;

  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = 'RegistrationGeneratorError';
    this.file = file;
    this.reason = reason;
  }
}

export interface AdapterInfo {
  id: string;
  order: number;
  fileName: string;
  alias: string;
}

export interface HandlerInfo {
  fileName: string;
  stem: string;
  kind: string;
  side: 'Read' | 'Write';
  alias: string;
  hasValidate: boolean;
}

export interface KindCatalog {
  reads: ReadonlySet<string>;
  writes: ReadonlySet<string>;
}

export interface GeneratedRegistration {
  routes: string;
  handlers: string;
  adapters: AdapterInfo[];
  handlersScanned: HandlerInfo[];
  readCount: number;
  writeCount: number;
  withoutValidateCount: number;
}

export interface DriftEntry {
  file: string;
  firstDiffLine: number;
  message: string;
}

export interface DriftCheckResult {
  ok: boolean;
  drifts: DriftEntry[];
}

/** Section 3.4 INFRA exclusion list, plus the generated file itself. */
export const INFRA_FILES: ReadonlySet<string> = new Set([
  'deps.ts',
  'dispatch.ts',
  'handlers.generated.ts',
  'idempotency.ts',
  'kinds.ts',
  'registry.ts',
  'runner.ts',
  'validation.ts',
  'workspace.ts',
]);

const ROUTES_REL = 'server/src/routes';
const DB_REL = 'server/src/services/db';
const ROUTES_GENERATED_REL = 'server/src/routes-generated.ts';
const HANDLERS_GENERATED_REL = 'server/src/services/db/handlers.generated.ts';
const EM_DASH = '\u2014';

function fail(file: string, reason: string): never {
  throw new RegistrationGeneratorError(file, reason);
}

/** Preseden camel(): kebab stem to camelCase (gen-db-wiring.py). */
export function camelAlias(stem: string): string {
  const parts = stem.split('-');
  return parts[0] + parts.slice(1).map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join('');
}

/** Section 8.2 item 3: PascalCase from a kebab id. */
export function pascalAlias(id: string): string {
  return id
    .split('-')
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join('');
}

function adapterAlias(id: string): string {
  return `register${pascalAlias(id)}Group`;
}

function readDirSorted(dir: string, displayDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return fail(displayDir, 'directory does not exist or cannot be read');
  }
  return entries.sort();
}

function readText(path: string, displayFile: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return fail(displayFile, 'file cannot be read');
  }
}

/** Scan adapters. Throws on V-1..V-8 and on alias collision (8.2.3). */
export function scanAdapters(routesDir: string): AdapterInfo[] {
  const entries = readDirSorted(routesDir, ROUTES_REL);
  const adapterFiles = entries.filter((entry) => entry.endsWith('.registration.ts'));
  if (adapterFiles.length === 0) {
    fail(ROUTES_REL, 'no adapter files (*.registration.ts) found');
  }
  const adapters: AdapterInfo[] = [];
  const seenOrders = new Map<number, string>();
  const seenIds = new Map<string, string>();
  const seenAliases = new Map<string, string>();
  for (const fileName of adapterFiles) {
    const displayFile = `${ROUTES_REL}/${fileName}`;
    const text = readText(join(routesDir, fileName), displayFile);
    const stem = fileName.slice(0, -'.registration.ts'.length);
    const idMatch = /export const REGISTRATION_ID = '([^']+)' as const;/.exec(text);
    if (idMatch === null) {
      fail(displayFile, 'missing export const REGISTRATION_ID as a string literal with as const (V-2)');
    }
    const id = idMatch[1];
    if (id !== stem) {
      fail(displayFile, `REGISTRATION_ID '${id}' does not match file stem '${stem}' (V-3)`);
    }
    const orderMatch = /REGISTRATION_ORDER\s*=\s*([^;]+);/.exec(text);
    if (orderMatch === null) {
      fail(displayFile, 'missing REGISTRATION_ORDER (V-4)');
    }
    const orderText = orderMatch[1].trim();
    if (!/^-?\d+$/.test(orderText)) {
      fail(displayFile, `REGISTRATION_ORDER '${orderText}' is not an integer (V-4)`);
    }
    const order = Number(orderText);
    if (!Number.isInteger(order) || order < 1 || order > 9999) {
      fail(displayFile, `REGISTRATION_ORDER ${order} is outside 1-9999 (V-4)`);
    }
    if (!/export async function registerGroup\s*\(/.test(text)) {
      fail(displayFile, 'missing export async function registerGroup (V-7)');
    }
    for (const importMatch of text.matchAll(/import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = importMatch[1];
      if (/(^|\/)[^/'"]*\.registration(\.js)?$/.test(specifier) || specifier.includes('.registration.')) {
        fail(displayFile, `adapter imports another adapter ('${specifier}') (V-8)`);
      }
    }
    const previousOrderFile = seenOrders.get(order);
    if (previousOrderFile !== undefined) {
      fail(displayFile, `duplicate REGISTRATION_ORDER ${order} (also in ${previousOrderFile}) (V-5)`);
    }
    seenOrders.set(order, fileName);
    const previousIdFile = seenIds.get(id);
    if (previousIdFile !== undefined) {
      fail(displayFile, `duplicate REGISTRATION_ID '${id}' (also in ${previousIdFile}) (V-6)`);
    }
    seenIds.set(id, fileName);
    const alias = adapterAlias(id);
    const previousAliasFile = seenAliases.get(alias);
    if (previousAliasFile !== undefined) {
      fail(displayFile, `adapter alias collision '${alias}' (also in ${previousAliasFile})`);
    }
    seenAliases.set(alias, fileName);
    adapters.push({ id, order, fileName, alias });
  }
  adapters.sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order));
  return adapters;
}

/** Parse the kind catalog. Throws on V-13 and V-15. */
export function parseCatalog(kindsPath: string): KindCatalog {
  const displayFile = `${DB_REL}/kinds.ts`;
  const text = readText(kindsPath, displayFile);
  const extract = (constName: string): Set<string> => {
    const match = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`).exec(text);
    if (match === null) {
      fail(displayFile, `cannot parse ${constName} (V-15)`);
    }
    return new Set([...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]));
  };
  const reads = extract('DB_READ_OP_KINDS');
  const writes = extract('DB_WRITE_OP_KINDS');
  const overlap = [...reads].filter((kind) => writes.has(kind));
  if (overlap.length > 0) {
    fail(displayFile, `kind in both catalog lists: ${overlap.sort().join(', ')} (V-13)`);
  }
  return { reads, writes };
}

/** Scan handler files. Throws on V-9..V-12 and V-14. */
export function scanHandlers(dbDir: string, catalog: KindCatalog): HandlerInfo[] {
  const entries = readDirSorted(dbDir, DB_REL);
  const handlers: HandlerInfo[] = [];
  const seenKinds = new Map<string, string>();
  const seenAliases = new Map<string, string>();
  for (const fileName of entries) {
    if (!fileName.endsWith('.ts') || INFRA_FILES.has(fileName)) {
      continue;
    }
    const displayFile = `${DB_REL}/${fileName}`;
    const text = readText(join(dbDir, fileName), displayFile);
    const kindMatch = /export const HANDLER_KIND = '([^']+)' as const;/.exec(text);
    if (kindMatch === null) {
      fail(displayFile, 'missing export const HANDLER_KIND (V-9)');
    }
    const kind = kindMatch[1];
    if (!text.includes('export async function handle')) {
      fail(displayFile, 'missing export async function handle (V-10)');
    }
    let side: 'Read' | 'Write';
    if (catalog.reads.has(kind)) {
      side = 'Read';
    } else if (catalog.writes.has(kind)) {
      side = 'Write';
    } else {
      fail(displayFile, `kind '${kind}' is not in the catalog (V-11)`);
    }
    const previousKindFile = seenKinds.get(kind);
    if (previousKindFile !== undefined) {
      fail(displayFile, `duplicate kind '${kind}' (also in ${previousKindFile}) (V-12)`);
    }
    seenKinds.set(kind, fileName);
    const stem = fileName.slice(0, -'.ts'.length);
    const alias = camelAlias(stem);
    const previousAliasFile = seenAliases.get(alias);
    if (previousAliasFile !== undefined) {
      fail(displayFile, `handler alias collision '${alias}' (also in ${previousAliasFile}) (V-14)`);
    }
    seenAliases.set(alias, fileName);
    handlers.push({
      fileName,
      stem,
      kind,
      side,
      alias,
      hasValidate: text.includes('export function validate'),
    });
  }
  return handlers;
}

const SPDX_HEADER = [
  '// SPDX-License-Identifier: GPL-3.0-only',
  '// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.',
  '// See LICENSE and FORK.md.',
  '',
  '// GENERATED by scripts/generate-registration.mjs. DO NOT EDIT BY HAND.',
  '// Regenerate with: node scripts/generate-registration.mjs',
];

function finishLines(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

/** Render routes-generated.ts per section 8.2. */
export function renderRoutes(adapters: AdapterInfo[]): string {
  const sourceLine = `// Adapters (rank order): ${adapters.map((a) => `${a.order} ${a.id}`).join(', ')}.`;
  const lines: string[] = [
    ...SPDX_HEADER,
    sourceLine,
    `// Route groups: ${adapters.length} adapters.`,
    '// The frozen middleware shape (AD-40) lives in app.ts, not here:',
    '// this module only calls group adapters, in rank order.',
    '',
    "import type { RegistrationContext } from './registration/context.js';",
  ];
  for (const adapter of adapters) {
    lines.push(
      `import { registerGroup as ${adapter.alias} } from './routes/${adapter.id}.registration.js';`,
    );
  }
  lines.push('');
  lines.push('export async function registerRouteGroups(ctx: RegistrationContext): Promise<void> {');
  for (const adapter of adapters) {
    lines.push(`  // ${adapter.order} ${adapter.id}`);
    lines.push(`  await ${adapter.alias}(ctx);`);
  }
  lines.push('}');
  return finishLines(lines);
}

/** Render handlers.generated.ts per section 8.1. */
export function renderHandlers(handlers: HandlerInfo[]): string {
  const readCount = handlers.filter((h) => h.side === 'Read').length;
  const writeCount = handlers.filter((h) => h.side === 'Write').length;
  const withoutValidate = handlers.filter((h) => !h.hasValidate).length;
  const lines: string[] = [
    ...SPDX_HEADER,
    '// Source: handler files scanned from server/src/services/db (byte order by file name).',
    `// Db kind handlers: ${handlers.length} (${readCount} read, ${writeCount} write; ${withoutValidate} without validate).`,
    '// Consumed only by the db adapter (db.registration.ts); no other importer, no re-exports.',
    '',
    "import type { DbHandlerRegistry } from './registry.js';",
  ];
  for (const handler of handlers) {
    const capitalized = handler.alias.slice(0, 1).toUpperCase() + handler.alias.slice(1);
    const validatePart = handler.hasValidate ? `, validate as validate${capitalized}` : '';
    lines.push(
      `import { HANDLER_KIND as ${handler.alias}Kind, handle as ${handler.alias}${validatePart} } from './${handler.stem}.js';`,
    );
  }
  lines.push('');
  lines.push('export function registerDbHandlers(registry: DbHandlerRegistry): void {');
  for (const handler of handlers) {
    const capitalized = handler.alias.slice(0, 1).toUpperCase() + handler.alias.slice(1);
    const validatePart = handler.hasValidate ? `validate: validate${capitalized}, ` : '';
    lines.push(`  registry.register${handler.side}(${handler.alias}Kind, { ${validatePart}handle: ${handler.alias} });`);
  }
  lines.push('}');
  return finishLines(lines);
}

function assertNoEmDash(displayFile: string, text: string): void {
  if (text.includes(EM_DASH)) {
    fail(displayFile, 'generated output contains an em dash (V-16)');
  }
}

/**
 * Generate both outputs from a repo-shaped root. Computes and validates
 * everything before writing the first file (atomic pair rule). When
 * write is true, both files are written; on any failure nothing is
 * written and RegistrationGeneratorError is thrown.
 */
export function generateRegistration(
  repoRoot: string,
  options: { write: boolean },
): GeneratedRegistration {
  const routesDir = join(repoRoot, ROUTES_REL);
  const dbDir = join(repoRoot, DB_REL);
  const adapters = scanAdapters(routesDir);
  const catalog = parseCatalog(join(dbDir, 'kinds.ts'));
  const handlersScanned = scanHandlers(dbDir, catalog);
  const routes = renderRoutes(adapters);
  const handlers = renderHandlers(handlersScanned);
  assertNoEmDash(ROUTES_GENERATED_REL, routes);
  assertNoEmDash(HANDLERS_GENERATED_REL, handlers);
  if (options.write) {
    mkdirSync(join(repoRoot, 'server/src'), { recursive: true });
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(repoRoot, ROUTES_GENERATED_REL), routes, 'utf8');
    writeFileSync(join(repoRoot, HANDLERS_GENERATED_REL), handlers, 'utf8');
  }
  return {
    routes,
    handlers,
    adapters,
    handlersScanned,
    readCount: handlersScanned.filter((h) => h.side === 'Read').length,
    writeCount: handlersScanned.filter((h) => h.side === 'Write').length,
    withoutValidateCount: handlersScanned.filter((h) => !h.hasValidate).length,
  };
}

function firstDiffLine(expected: string, actual: string): number {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return index + 1;
    }
  }
  return 0;
}

/**
 * Drift check per section 6.1: one call checks BOTH outputs, reports
 * every drifted file with its first differing line, and fails when a
 * checked-in file is missing. Validation failures throw, as in
 * generate mode.
 */
export function checkRegistration(repoRoot: string): DriftCheckResult {
  const fresh = generateRegistration(repoRoot, { write: false });
  const drifts: DriftEntry[] = [];
  const pairs: Array<{ file: string; fresh: string }> = [
    { file: ROUTES_GENERATED_REL, fresh: fresh.routes },
    { file: HANDLERS_GENERATED_REL, fresh: fresh.handlers },
  ];
  for (const pair of pairs) {
    const path = join(repoRoot, pair.file);
    if (!existsSync(path)) {
      drifts.push({
        file: pair.file,
        firstDiffLine: 0,
        message: `${pair.file}: file does not exist; run the generator without --check first`,
      });
      continue;
    }
    const checkedIn = readFileSync(path, 'utf8');
    if (checkedIn !== pair.fresh) {
      const line = firstDiffLine(pair.fresh, checkedIn);
      drifts.push({
        file: pair.file,
        firstDiffLine: line,
        message:
          `${pair.file}: drift detected at line ${line}; file differs from fresh generation; ` +
          'regenerate or revert the manual edit',
      });
    }
  }
  return { ok: drifts.length === 0, drifts };
}
