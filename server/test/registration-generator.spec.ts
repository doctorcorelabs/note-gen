// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration generator + scan contract suite (worker B-08, AD-61).
//
// RUNNER: Vitest. This file follows the server suite convention:
// server/package.json runs "vitest run", server/vitest.config.ts
// includes test/**/*.spec.ts, and every existing server spec imports
// from 'vitest'. There is no node:test usage under server/test/; the
// node:test runner at the repo root covers src/**/*.spec.mjs only.
//
// WHAT IS REAL HERE: the contract rules from
// desain-registrasi-programatik.md sections 3, 6, and 8 (adapter
// contract, fail-hard validation V-1..V-17, completeness, drift gate,
// deterministic byte formats), the real kind catalog and the real
// handler files under server/src/services/db/, which the "real tree
// scan" block below exercises with the fixture scanner.
//
// WHAT IS FAKE HERE: the scanner/generator under test in most blocks
// is the test-side fixture in ./helpers/registration-fixture-generator.ts.
// It implements the promised interface (regex parsing, directory
// enumeration, deterministic rendering, drift check) but it is NOT the
// production generator. At trunk 0699c620 the production generator
// (scripts/generate-registration.mjs, worker B-01), the scan (B-02),
// the adapters, and the generated files do not exist yet, so no test
// in this file can execute them. A green run here pins the contract
// the real generator must satisfy; it does NOT prove the real
// generator behaves this way.
//
// DEPENDENCY: when B-01 lands scripts/generate-registration.mjs, the
// "real generator CLI conformance" block at the end of this file
// activates automatically (it skips while the file is absent). That
// block copies the generator script into a temporary repo-shaped tree
// and runs it there with cwd set to the tree root, so it never writes
// into the working tree. It assumes the design promise that the
// generator is a single stdlib-only file deriving its root from its
// own location or cwd (sections 8.3.4, 9.1). If O-GEN-1 picks another
// language or path, the GENERATOR_PATH constant below must move with
// it in the same amendment.
//
// BOUNDARIES, read before citing a result from this file:
// - Duplicate routes: the generator never parses route paths from
//   registrar code (design section 2.1), so path-level duplicates are
//   NOT a generator check; they belong to the route-dump harness
//   (section 6.4 item 3). The duplicate cases pinned here are the
//   generator-level identities: adapter id (V-6), rank (V-5), handler
//   kind (V-12), and import alias (V-14, section 8.2 item 3).
// - "Handler without an adapter" is pinned three ways: an adapter
//   without registerGroup (V-7), a handler file that cannot be
//   accounted for (no HANDLER_KIND, no handle, kind outside the
//   catalog: V-9/V-10/V-11), and directory-enumeration completeness
//   (every handler file in the directory must appear exactly once in
//   the output; section 6.3 item 3). The design does not require the
//   generator to fail when a catalog kind has no handler file
//   (section 6.3 item 4); that case is pinned as a success.
// - "Missing adapter" is pinned as: zero adapters (V-1), a missing
//   routes directory (V-17), and a stale generated index that still
//   names a deleted adapter, detected by --check (section 6.3 item 5).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRegistration,
  generateRegistration,
  INFRA_FILES,
  parseCatalog,
  RegistrationGeneratorError,
  scanAdapters,
  scanHandlers,
} from './helpers/registration-fixture-generator.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATOR_PATH = join(REPO_ROOT, 'scripts', 'generate-registration.mjs');
const SCANNER_PATH = join(REPO_ROOT, 'scripts', 'scan-db-handlers.mjs');
const HAS_GENERATOR = existsSync(GENERATOR_PATH);
const HAS_SCANNER = existsSync(SCANNER_PATH);
const EM_DASH = '\u2014';

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// The real generator imports the scan implementation from
// scripts/scan-db-handlers.mjs (GEN-INT, AD-81), so a repo-shaped
// fixture tree needs BOTH scripts copied in before either entry point
// runs. Copying only the generator makes every CLI run fail with a
// module-not-found error instead of exercising the generator.
function installScripts(root: string): void {
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'generate-registration.mjs'), readFileSync(GENERATOR_PATH, 'utf8'), 'utf8');
  writeFileSync(join(scriptsDir, 'scan-db-handlers.mjs'), readFileSync(SCANNER_PATH, 'utf8'), 'utf8');
}

function runScript(root: string, scriptName: string, args: string[]): CliResult {
  installScripts(root);
  const result = spawnSync(process.execPath, [join(root, 'scripts', scriptName), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGeneratorCli(root: string, args: string[]): CliResult {
  return runScript(root, 'generate-registration.mjs', args);
}

const createdRoots: string[] = [];

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'reg-gen-'));
  createdRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

function adapterSource(id: string, order: number | string): string {
  return [
    '// SPDX-License-Identifier: GPL-3.0-only',
    "import type { RegistrationContext } from '../registration/context.js';",
    '',
    `export const REGISTRATION_ID = '${id}' as const;`,
    `export const REGISTRATION_ORDER = ${order};`,
    'export async function registerGroup(ctx: RegistrationContext): Promise<void> {',
    '  void ctx;',
    '}',
    '',
  ].join('\n');
}

function handlerSource(kind: string, withValidate: boolean): string {
  const lines = [
    '// SPDX-License-Identifier: GPL-3.0-only',
    '',
    `export const HANDLER_KIND = '${kind}' as const;`,
    '',
  ];
  if (withValidate) {
    lines.push('export function validate(): boolean {', '  return true;', '}', '');
  }
  lines.push('export async function handle(): Promise<void> {', '}', '');
  return lines.join('\n');
}

function kindsSource(reads: string[], writes: string[]): string {
  const render = (kinds: string[]): string => kinds.map((kind) => `  '${kind}',`).join('\n');
  return (
    `export const DB_READ_OP_KINDS = [\n${render(reads)}\n] as const;\n\n` +
    `export const DB_WRITE_OP_KINDS = [\n${render(writes)}\n] as const;\n`
  );
}

function infraSource(): string {
  return '// Infrastructure module, excluded from the handler scan.\n\nexport const INFRA = true;\n';
}

const DEFAULT_ADAPTERS: Array<[string, number]> = [
  ['health', 10],
  ['auth-core', 20],
  ['workspace-read', 40],
  ['workspace-write', 50],
  ['settings-secrets', 90],
  ['db', 100],
  ['stubs', 140],
  ['csp-reports', 150],
];

function defaultFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [id, order] of DEFAULT_ADAPTERS) {
    files[`server/src/routes/${id}.registration.ts`] = adapterSource(id, order);
  }
  files['server/src/services/db/kinds.ts'] = kindsSource(
    ['marks.list', 'canvases.get', 'tags.list'],
    ['canvases.create'],
  );
  files['server/src/services/db/marks-list.ts'] = handlerSource('marks.list', true);
  files['server/src/services/db/canvases-get.ts'] = handlerSource('canvases.get', false);
  files['server/src/services/db/canvases-create.ts'] = handlerSource('canvases.create', true);
  for (const infra of ['deps.ts', 'dispatch.ts', 'idempotency.ts', 'registry.ts', 'runner.ts', 'validation.ts', 'workspace.ts']) {
    files[`server/src/services/db/${infra}`] = infraSource();
  }
  files['server/src/services/db/README.md'] = '# Db handlers\n';
  return files;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function rankComments(routes: string): Array<[number, string]> {
  return [...routes.matchAll(/^  \/\/ (\d+) (\S+)$/gm)].map((match) => [Number(match[1]), match[2]]);
}

function awaitAliases(routes: string): string[] {
  return [...routes.matchAll(/^  await (\w+)\(ctx\);$/gm)].map((match) => match[1]);
}

describe('registration generator determinism (fixture)', () => {
  it('two in-memory runs are byte-identical for both outputs', () => {
    const root = createTree(defaultFiles());
    const first = generateRegistration(root, { write: false });
    const second = generateRegistration(root, { write: false });
    expect(second.routes).toBe(first.routes);
    expect(second.handlers).toBe(first.handlers);
    expect(sha256(second.routes)).toBe(sha256(first.routes));
    expect(sha256(second.handlers)).toBe(sha256(first.handlers));
  });

  it('repeated writes are idempotent and --check passes after generate', () => {
    const root = createTree(defaultFiles());
    generateRegistration(root, { write: true });
    const routesPath = join(root, 'server/src/routes-generated.ts');
    const handlersPath = join(root, 'server/src/services/db/handlers.generated.ts');
    const firstRoutes = readFileSync(routesPath, 'utf8');
    const firstHandlers = readFileSync(handlersPath, 'utf8');
    generateRegistration(root, { write: true });
    expect(readFileSync(routesPath, 'utf8')).toBe(firstRoutes);
    expect(readFileSync(handlersPath, 'utf8')).toBe(firstHandlers);
    expect(checkRegistration(root).ok).toBe(true);
  });

  it('file creation order does not change the output bytes', () => {
    const normal = createTree(defaultFiles());
    const reversedFiles: Record<string, string> = {};
    const entries = Object.entries(defaultFiles()).reverse();
    for (const [rel, content] of entries) {
      reversedFiles[rel] = content;
    }
    const reversed = createTree(reversedFiles);
    const normalOut = generateRegistration(normal, { write: false });
    const reversedOut = generateRegistration(reversed, { write: false });
    expect(reversedOut.routes).toBe(normalOut.routes);
    expect(reversedOut.handlers).toBe(normalOut.handlers);
  });

  it('--check fails after a one-line manual edit, naming the file and first differing line', () => {
    const root = createTree(defaultFiles());
    generateRegistration(root, { write: true });
    const handlersPath = join(root, 'server/src/services/db/handlers.generated.ts');
    const fresh = readFileSync(handlersPath, 'utf8');
    const lines = fresh.split('\n');
    const editedLineIndex = lines.findIndex((line) => line.includes('registerRead') || line.includes('registerWrite'));
    expect(editedLineIndex).toBeGreaterThan(0);
    lines[editedLineIndex] = '  // manually edited line';
    writeFileSync(handlersPath, lines.join('\n'), 'utf8');
    const result = checkRegistration(root);
    expect(result.ok).toBe(false);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0].file).toBe('server/src/services/db/handlers.generated.ts');
    expect(result.drifts[0].firstDiffLine).toBe(editedLineIndex + 1);
    expect(result.drifts[0].message).toContain('regenerate or revert the manual edit');
  });

  it('--check reports both files when both drift', () => {
    const root = createTree(defaultFiles());
    generateRegistration(root, { write: true });
    writeFileSync(join(root, 'server/src/routes-generated.ts'), '// drifted\n', 'utf8');
    writeFileSync(join(root, 'server/src/services/db/handlers.generated.ts'), '// drifted\n', 'utf8');
    const result = checkRegistration(root);
    expect(result.ok).toBe(false);
    expect(result.drifts.map((drift) => drift.file).sort()).toEqual([
      'server/src/routes-generated.ts',
      'server/src/services/db/handlers.generated.ts',
    ]);
  });

  it('--check fails when an output file is missing', () => {
    const root = createTree(defaultFiles());
    const result = checkRegistration(root);
    expect(result.ok).toBe(false);
    expect(result.drifts).toHaveLength(2);
    for (const drift of result.drifts) {
      expect(drift.message).toContain('run the generator without --check first');
    }
  });
});

describe('registration generator order and output shape (fixture)', () => {
  it('health is first in imports and calls', () => {
    const root = createTree(defaultFiles());
    const { routes } = generateRegistration(root, { write: false });
    const importLines = routes.split('\n').filter((line) => line.startsWith('import { registerGroup'));
    expect(importLines[0]).toContain('health.registration.js');
    expect(awaitAliases(routes)[0]).toBe('registerHealthGroup');
    expect(rankComments(routes)[0]).toEqual([10, 'health']);
  });

  it('adapter call order matches the frozen rank table and the header list matches the body', () => {
    const root = createTree(defaultFiles());
    const { routes } = generateRegistration(root, { write: false });
    expect(rankComments(routes)).toEqual(DEFAULT_ADAPTERS.map(([id, order]) => [order, id]));
    const headerLine = routes.split('\n').find((line) => line.startsWith('// Adapters (rank order):'));
    expect(headerLine).toBeDefined();
    const headerEntries = [...(headerLine as string).matchAll(/(\d+) ([a-z-]+)/g)].map((match) => [
      Number(match[1]),
      match[2],
    ]);
    expect(headerEntries).toEqual(DEFAULT_ADAPTERS.map(([id, order]) => [order, id]));
  });

  it('workspace-write precedes stubs (content-type parser dependency)', () => {
    const root = createTree(defaultFiles());
    const { routes } = generateRegistration(root, { write: false });
    const aliases = awaitAliases(routes);
    expect(aliases.indexOf('registerWorkspaceWriteGroup')).toBeLessThan(aliases.indexOf('registerStubsGroup'));
  });

  it('handler imports and registrations follow byte order of file names', () => {
    const root = createTree(defaultFiles());
    const { handlers } = generateRegistration(root, { write: false });
    const importStems = [...handlers.matchAll(/^import \{ HANDLER_KIND as \w+Kind, handle as \w+.* from '\.\/(.+)\.js';$/gm)].map(
      (match) => match[1],
    );
    expect(importStems).toEqual(['canvases-create', 'canvases-get', 'marks-list']);
    const registered = [...handlers.matchAll(/registry\.register(?:Read|Write)\((\w+)Kind,/g)].map((match) => match[1]);
    expect(registered).toEqual(['canvasesCreate', 'canvasesGet', 'marksList']);
  });

  it('adapter calls are sequential await with no Promise.all', () => {
    const root = createTree(defaultFiles());
    const { routes } = generateRegistration(root, { write: false });
    expect(routes).not.toContain('Promise.all');
    expect(awaitAliases(routes)).toHaveLength(DEFAULT_ADAPTERS.length);
  });

  it('each generated file exports exactly one function and contains no re-export', () => {
    const root = createTree(defaultFiles());
    const { routes, handlers } = generateRegistration(root, { write: false });
    expect(routes).toContain('export async function registerRouteGroups');
    expect(routes.match(/export /g)).toHaveLength(1);
    expect(handlers).toContain('export function registerDbHandlers');
    expect(handlers.match(/export /g)).toHaveLength(1);
    for (const text of [routes, handlers]) {
      expect(text).not.toContain('export *');
      expect(text).not.toMatch(/export \{[^}]*\} from/);
    }
  });

  it('import aliases follow register<PascalCase>Group', () => {
    const root = createTree(defaultFiles());
    const { routes } = generateRegistration(root, { write: false });
    expect(routes).toContain('import { registerGroup as registerHealthGroup }');
    expect(routes).toContain('import { registerGroup as registerAuthCoreGroup }');
    expect(routes).toContain('import { registerGroup as registerSettingsSecretsGroup }');
    expect(routes).toContain('import { registerGroup as registerWorkspaceReadGroup }');
  });

  it('header counts match body counts and the read/write split', () => {
    const root = createTree(defaultFiles());
    const { routes, handlers } = generateRegistration(root, { write: false });
    expect(routes).toContain('// Route groups: 8 adapters.');
    expect(awaitAliases(routes)).toHaveLength(8);
    expect(handlers).toContain('// Db kind handlers: 3 (2 read, 1 write; 1 without validate).');
    expect(handlers.match(/registry\.registerRead\(/g)).toHaveLength(2);
    expect(handlers.match(/registry\.registerWrite\(/g)).toHaveLength(1);
  });

  it('byte rules hold: LF only, one trailing newline, no trailing space, no tab, no em dash', () => {
    const root = createTree(defaultFiles());
    const { routes, handlers } = generateRegistration(root, { write: false });
    for (const text of [routes, handlers]) {
      expect(text).not.toContain('\r');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
      expect(text).not.toContain('\t');
      expect(text).not.toContain(EM_DASH);
      for (const line of text.split('\n')) {
        expect(line).not.toMatch(/ $/);
      }
    }
  });
});

describe('registration generator ranks (fixture)', () => {
  it('gaps in rank are allowed and produce no placeholder lines', () => {
    const files = defaultFiles();
    delete files['server/src/routes/auth-core.registration.ts'];
    delete files['server/src/routes/workspace-read.registration.ts'];
    const root = createTree(files);
    const { routes } = generateRegistration(root, { write: false });
    expect(rankComments(routes).map(([order]) => order)).toEqual([10, 50, 90, 100, 140, 150]);
    expect(routes).not.toContain('20 ');
    expect(routes).not.toContain('placeholder');
  });

  it('inserting an adapter into a gap sorts it between its neighbors', () => {
    const files = defaultFiles();
    files['server/src/routes/auth-advanced.registration.ts'] = adapterSource('auth-advanced', 30);
    const root = createTree(files);
    const { routes } = generateRegistration(root, { write: false });
    const orders = rankComments(routes).map(([order]) => order);
    expect(orders).toEqual([10, 20, 30, 40, 50, 90, 100, 140, 150]);
  });

  it('duplicate rank fails hard (V-5) and writes nothing', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] = adapterSource('stubs', 100);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: true })).toThrow(RegistrationGeneratorError);
    expect(() => generateRegistration(root, { write: true })).toThrow(/stubs\.registration\.ts.*duplicate REGISTRATION_ORDER 100/);
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(false);
    expect(existsSync(join(root, 'server/src/services/db/handlers.generated.ts'))).toBe(false);
  });

  it('rank outside 1-9999 fails hard (V-4)', () => {
    for (const badOrder of [0, 10000]) {
      const files = defaultFiles();
      files['server/src/routes/stubs.registration.ts'] = adapterSource('stubs', badOrder);
      const root = createTree(files);
      expect(() => generateRegistration(root, { write: false })).toThrow(/REGISTRATION_ORDER .*outside 1-9999/);
    }
  });

  it('non-integer or string rank fails hard (V-4)', () => {
    for (const badOrder of ['10.5', "'10'"]) {
      const files = defaultFiles();
      files['server/src/routes/stubs.registration.ts'] = adapterSource('stubs', badOrder);
      const root = createTree(files);
      expect(() => generateRegistration(root, { write: false })).toThrow(/not an integer/);
    }
  });

  it('missing REGISTRATION_ORDER fails hard (V-4)', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] =
      "// SPDX-License-Identifier: GPL-3.0-only\n" +
      "export const REGISTRATION_ID = 'stubs' as const;\n" +
      'export async function registerGroup(): Promise<void> {}\n';
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/missing REGISTRATION_ORDER/);
  });

  it('missing REGISTRATION_ID fails hard (V-2)', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] =
      '// SPDX-License-Identifier: GPL-3.0-only\n' +
      'export const REGISTRATION_ORDER = 140;\n' +
      'export async function registerGroup(): Promise<void> {}\n';
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/missing export const REGISTRATION_ID/);
  });

  it('REGISTRATION_ID different from the file stem fails hard (V-3)', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] = adapterSource('other-name', 140);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(
      /does not match file stem 'stubs'/,
    );
  });

  it('adapter without registerGroup fails hard (V-7)', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] =
      "// SPDX-License-Identifier: GPL-3.0-only\n" +
      "export const REGISTRATION_ID = 'stubs' as const;\n" +
      'export const REGISTRATION_ORDER = 140;\n';
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/missing export async function registerGroup/);
  });

  it('adapter importing another adapter fails hard (V-8)', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] =
      "import { registerGroup as other } from './health.registration.js';\n" +
      "export const REGISTRATION_ID = 'stubs' as const;\n" +
      'export const REGISTRATION_ORDER = 140;\n' +
      'export async function registerGroup(): Promise<void> { void other; }\n';
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/imports another adapter/);
  });

  it('duplicate REGISTRATION_ID declaration fails hard (V-3 fires first; V-6 is the second defense)', () => {
    const files = defaultFiles();
    files['server/src/routes/alpha.registration.ts'] = adapterSource('beta', 15);
    files['server/src/routes/beta.registration.ts'] = adapterSource('beta', 25);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(RegistrationGeneratorError);
    expect(() => generateRegistration(root, { write: false })).toThrow(/alpha\.registration\.ts/);
  });
});

describe('registration generator duplicates (fixture)', () => {
  it('duplicate kind across two handler files fails hard (V-12) and writes nothing', () => {
    const files = defaultFiles();
    files['server/src/services/db/marks-list-copy.ts'] = handlerSource('marks.list', true);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: true })).toThrow(/duplicate kind 'marks\.list'/);
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(false);
    expect(existsSync(join(root, 'server/src/services/db/handlers.generated.ts'))).toBe(false);
  });

  it('kind in both catalog lists fails hard (V-13)', () => {
    const files = defaultFiles();
    files['server/src/services/db/kinds.ts'] = kindsSource(['marks.list'], ['marks.list']);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/kind in both catalog lists: marks\.list/);
  });

  it('handler alias collision fails hard (V-14)', () => {
    const files = defaultFiles();
    files['server/src/services/db/kinds.ts'] = kindsSource(['marks.list', 'tags.list'], []);
    files['server/src/services/db/foo-bar.ts'] = handlerSource('marks.list', true);
    files['server/src/services/db/fooBar.ts'] = handlerSource('tags.list', true);
    delete files['server/src/services/db/marks-list.ts'];
    delete files['server/src/services/db/canvases-get.ts'];
    delete files['server/src/services/db/canvases-create.ts'];
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/alias collision 'fooBar'/);
  });

  it('adapter alias collision via capitalization fails hard (section 8.2 item 3)', () => {
    const files = defaultFiles();
    files['server/src/routes/foo-bar.registration.ts'] = adapterSource('foo-bar', 15);
    files['server/src/routes/foo-Bar.registration.ts'] = adapterSource('foo-Bar', 25);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/alias collision 'registerFooBarGroup'/);
  });
});

describe('registration generator missing adapter fail-closed (fixture)', () => {
  it('zero adapters fails hard (V-1) and writes nothing', () => {
    const files = defaultFiles();
    for (const key of Object.keys(files)) {
      if (key.endsWith('.registration.ts')) {
        delete files[key];
      }
    }
    const root = createTree(files);
    mkdirSync(join(root, 'server/src/routes'), { recursive: true });
    expect(() => generateRegistration(root, { write: true })).toThrow(/no adapter files/);
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(false);
    expect(existsSync(join(root, 'server/src/services/db/handlers.generated.ts'))).toBe(false);
  });

  it('missing routes directory fails hard (V-17)', () => {
    const root = mkdtempSync(join(tmpdir(), 'reg-gen-'));
    createdRoots.push(root);
    mkdirSync(join(root, 'server/src/services/db'), { recursive: true });
    writeFileSync(join(root, 'server/src/services/db/kinds.ts'), kindsSource(['marks.list'], []), 'utf8');
    expect(() => generateRegistration(root, { write: false })).toThrow(/directory does not exist/);
  });

  it('a deleted adapter is detected by --check as drift (stale entry)', () => {
    const root = createTree(defaultFiles());
    generateRegistration(root, { write: true });
    expect(checkRegistration(root).ok).toBe(true);
    rmSync(join(root, 'server/src/routes/stubs.registration.ts'));
    const result = checkRegistration(root);
    expect(result.ok).toBe(false);
    expect(result.drifts.map((drift) => drift.file)).toContain('server/src/routes-generated.ts');
  });

  it('missing kinds.ts fails hard', () => {
    const files = defaultFiles();
    delete files['server/src/services/db/kinds.ts'];
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/kinds\.ts.*cannot be read/);
  });
});

describe('registration generator handler accounting (fixture)', () => {
  it('handler without HANDLER_KIND fails hard (V-9)', () => {
    const files = defaultFiles();
    files['server/src/services/db/orphan.ts'] = 'export async function handle(): Promise<void> {}\n';
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/missing export const HANDLER_KIND/);
  });

  it('handler without handle fails hard (V-10)', () => {
    const files = defaultFiles();
    files['server/src/services/db/orphan.ts'] = "export const HANDLER_KIND = 'marks.list' as const;\n";
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/missing export async function handle/);
  });

  it('handler kind outside the catalog fails hard (V-11)', () => {
    const files = defaultFiles();
    files['server/src/services/db/orphan.ts'] = handlerSource('nope.unknown', true);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/not in the catalog/);
  });

  it('kinds.ts without a parseable catalog array fails hard (V-15)', () => {
    for (const kinds of [
      'export const DB_WRITE_OP_KINDS = [\n  \'canvases.create\',\n] as const;\n',
      'export const DB_READ_OP_KINDS = readKinds;\n\nexport const DB_WRITE_OP_KINDS = [\n  \'canvases.create\',\n] as const;\n',
    ]) {
      const files = defaultFiles();
      files['server/src/services/db/kinds.ts'] = kinds;
      const root = createTree(files);
      expect(() => generateRegistration(root, { write: false })).toThrow(/cannot parse DB_READ_OP_KINDS \(V-15\)/);
    }
  });

  it('handler without validate emits the handle-only form; handler with validate emits the validate form', () => {
    const root = createTree(defaultFiles());
    const { handlers } = generateRegistration(root, { write: false });
    expect(handlers).toContain(
      "import { HANDLER_KIND as canvasesGetKind, handle as canvasesGet } from './canvases-get.js';",
    );
    expect(handlers).toContain('registry.registerRead(canvasesGetKind, { handle: canvasesGet });');
    expect(handlers).toContain(
      "import { HANDLER_KIND as marksListKind, handle as marksList, validate as validateMarksList } from './marks-list.js';",
    );
    expect(handlers).toContain(
      'registry.registerRead(marksListKind, { validate: validateMarksList, handle: marksList });',
    );
  });

  it('directory enumeration accounts for every handler file: added appears once, removed disappears', () => {
    const root = createTree(defaultFiles());
    const first = generateRegistration(root, { write: false });
    expect(first.handlers).not.toContain('tagsList');
    writeFileSync(
      join(root, 'server/src/services/db/tags-list.ts'),
      handlerSource('tags.list', true),
      'utf8',
    );
    const second = generateRegistration(root, { write: false });
    expect(second.handlers.match(/tagsListKind/g)).toHaveLength(2);
    rmSync(join(root, 'server/src/services/db/marks-list.ts'));
    const third = generateRegistration(root, { write: false });
    expect(third.handlers).not.toContain('marksList');
  });

  it('INFRA files and the generated file itself are excluded from the scan', () => {
    const files = defaultFiles();
    files['server/src/services/db/handlers.generated.ts'] = '// stale generated copy, must be ignored by the scan\n';
    const root = createTree(files);
    const { handlersScanned, handlers } = generateRegistration(root, { write: false });
    expect(handlersScanned).toHaveLength(3);
    expect(handlers).not.toContain('handlers.generated');
    expect(handlers).not.toContain('depsKind');
    expect(handlers).not.toContain('registryKind');
  });

  it('catalog kind without a handler file is not a failure and emits no registration', () => {
    const root = createTree(defaultFiles());
    const { handlers } = generateRegistration(root, { write: false });
    expect(handlers).not.toContain('tagsList');
  });

  it('handler-stage failure writes neither output file (atomic pair rule)', () => {
    const root = createTree(defaultFiles());
    const routesPath = join(root, 'server/src/routes-generated.ts');
    const handlersPath = join(root, 'server/src/services/db/handlers.generated.ts');
    writeFileSync(routesPath, 'sentinel-routes\n', 'utf8');
    writeFileSync(handlersPath, 'sentinel-handlers\n', 'utf8');
    writeFileSync(
      join(root, 'server/src/services/db/orphan.ts'),
      handlerSource('nope.unknown', true),
      'utf8',
    );
    expect(() => generateRegistration(root, { write: true })).toThrow(/not in the catalog/);
    expect(readFileSync(routesPath, 'utf8')).toBe('sentinel-routes\n');
    expect(readFileSync(handlersPath, 'utf8')).toBe('sentinel-handlers\n');
  });

  it('generated output containing an em dash fails hard (V-16)', () => {
    const weirdId = `we${EM_DASH}ird`;
    const files = defaultFiles();
    files[`server/src/routes/${weirdId}.registration.ts`] = adapterSource(weirdId, 15);
    const root = createTree(files);
    expect(() => generateRegistration(root, { write: false })).toThrow(/em dash \(V-16\)/);
  });
});

describe('registration scan against the real tree (fixture scanner, real files)', () => {
  it('the real kinds.ts parses with disjoint read/write sets', () => {
    const catalog = parseCatalog(join(REPO_ROOT, 'server/src/services/db/kinds.ts'));
    expect(catalog.reads.size).toBeGreaterThan(0);
    expect(catalog.writes.size).toBeGreaterThan(0);
    for (const kind of catalog.reads) {
      expect(catalog.writes.has(kind)).toBe(false);
    }
  });

  it('every real handler file scans clean: kind in catalog, no duplicates, no alias collisions', () => {
    const dbDir = join(REPO_ROOT, 'server/src/services/db');
    const catalog = parseCatalog(join(dbDir, 'kinds.ts'));
    const handlers = scanHandlers(dbDir, catalog);
    const files = readdirSync(dbDir).filter((entry) => entry.endsWith('.ts') && !INFRA_FILES.has(entry));
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers).toHaveLength(files.length);
    expect(handlers.map((handler) => handler.fileName)).toEqual([...files].sort());
    expect(new Set(handlers.map((handler) => handler.kind)).size).toBe(handlers.length);
    expect(new Set(handlers.map((handler) => handler.alias)).size).toBe(handlers.length);
  });

  it('real adapters, if any, satisfy the contract; zero adapters fails V-1', () => {
    const routesDir = join(REPO_ROOT, 'server/src/routes');
    const adapterFiles = readdirSync(routesDir).filter((entry) => entry.endsWith('.registration.ts'));
    if (adapterFiles.length === 0) {
      expect(() => scanAdapters(routesDir)).toThrow(RegistrationGeneratorError);
      expect(() => scanAdapters(routesDir)).toThrow(/no adapter files/);
    } else {
      const adapters = scanAdapters(routesDir);
      expect(adapters).toHaveLength(adapterFiles.length);
      const orders = adapters.map((adapter) => adapter.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      expect(new Set(orders).size).toBe(orders.length);
    }
  });
});

describe.skipIf(!HAS_GENERATOR)('real generator CLI conformance (activates when B-01 lands)', () => {
  function runCli(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    return runGeneratorCli(root, args);
  }

  it('CLI writes both outputs and exits 0', () => {
    const root = createTree(defaultFiles());
    const run = runCli(root, []);
    expect(run.status).toBe(0);
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(true);
    expect(existsSync(join(root, 'server/src/services/db/handlers.generated.ts'))).toBe(true);
  });

  it('CLI two runs are byte-identical', () => {
    const root = createTree(defaultFiles());
    expect(runCli(root, []).status).toBe(0);
    const firstRoutes = readFileSync(join(root, 'server/src/routes-generated.ts'), 'utf8');
    const firstHandlers = readFileSync(join(root, 'server/src/services/db/handlers.generated.ts'), 'utf8');
    expect(runCli(root, []).status).toBe(0);
    expect(readFileSync(join(root, 'server/src/routes-generated.ts'), 'utf8')).toBe(firstRoutes);
    expect(readFileSync(join(root, 'server/src/services/db/handlers.generated.ts'), 'utf8')).toBe(firstHandlers);
  });

  it('CLI orders health first by rank', () => {
    const root = createTree(defaultFiles());
    expect(runCli(root, []).status).toBe(0);
    const routes = readFileSync(join(root, 'server/src/routes-generated.ts'), 'utf8');
    const aliases = awaitAliases(routes);
    expect(aliases[0]).toBe('registerHealthGroup');
    expect(aliases).toHaveLength(DEFAULT_ADAPTERS.length);
  });

  it('CLI rank conflict exits 1, names the file, and writes nothing', () => {
    const files = defaultFiles();
    files['server/src/routes/stubs.registration.ts'] = adapterSource('stubs', 100);
    const root = createTree(files);
    const run = runCli(root, []);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('stubs.registration.ts');
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(false);
    expect(existsSync(join(root, 'server/src/services/db/handlers.generated.ts'))).toBe(false);
  });

  it('CLI duplicate kind exits 1', () => {
    const files = defaultFiles();
    files['server/src/services/db/marks-list-copy.ts'] = handlerSource('marks.list', true);
    const root = createTree(files);
    const run = runCli(root, []);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('marks.list');
  });

  it('CLI --check passes fresh, fails after an edit, and fails when an output is missing', () => {
    const root = createTree(defaultFiles());
    expect(runCli(root, []).status).toBe(0);
    expect(runCli(root, ['--check']).status).toBe(0);
    const handlersPath = join(root, 'server/src/services/db/handlers.generated.ts');
    writeFileSync(handlersPath, `${readFileSync(handlersPath, 'utf8')}// edit\n`, 'utf8');
    expect(runCli(root, ['--check']).status).toBe(1);
    rmSync(join(root, 'server/src/routes-generated.ts'));
    expect(runCli(root, ['--check']).status).toBe(1);
  });

  it('CLI zero adapters exits 1 (fail-closed)', () => {
    const files = defaultFiles();
    for (const key of Object.keys(files)) {
      if (key.endsWith('.registration.ts')) {
        delete files[key];
      }
    }
    const root = createTree(files);
    const run = runCli(root, []);
    expect(run.status).toBe(1);
    expect(existsSync(join(root, 'server/src/routes-generated.ts'))).toBe(false);
  });
});

describe.skipIf(!HAS_GENERATOR || !HAS_SCANNER)(
  'real generator CLI handler-level contract (AD-81 O-GEN-1(d))',
  () => {
    const ROUTES_OUT = 'server/src/routes-generated.ts';
    const HANDLERS_OUT = 'server/src/services/db/handlers.generated.ts';

    function corruptLine(path: string, needle: string): number {
      const lines = readFileSync(path, 'utf8').split('\n');
      const index = lines.findIndex((line) => line.includes(needle));
      expect(index).toBeGreaterThan(0);
      lines[index] = '  // manually corrupted line';
      writeFileSync(path, lines.join('\n'), 'utf8');
      return index + 1;
    }

    function expectNoOutputs(root: string): void {
      expect(existsSync(join(root, ROUTES_OUT))).toBe(false);
      expect(existsSync(join(root, HANDLERS_OUT))).toBe(false);
    }

    it('CLI --check fails when only routes-generated.ts is corrupted, naming the file and first differing line', () => {
      const root = createTree(defaultFiles());
      expect(runGeneratorCli(root, []).status).toBe(0);
      const routesPath = join(root, ROUTES_OUT);
      const handlersPath = join(root, HANDLERS_OUT);
      const handlersBefore = readFileSync(handlersPath, 'utf8');
      const diffLine = corruptLine(routesPath, 'await registerHealthGroup(ctx);');
      const corruptedRoutes = readFileSync(routesPath, 'utf8');
      const run = runGeneratorCli(root, ['--check']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('server/src/routes-generated.ts');
      expect(run.stderr).toContain(`first difference at line ${diffLine}`);
      expect(run.stderr).not.toContain('handlers.generated.ts');
      expect(readFileSync(routesPath, 'utf8')).toBe(corruptedRoutes);
      expect(readFileSync(handlersPath, 'utf8')).toBe(handlersBefore);
    });

    it('CLI --check fails when only handlers.generated.ts is corrupted, naming the file and first differing line', () => {
      const root = createTree(defaultFiles());
      expect(runGeneratorCli(root, []).status).toBe(0);
      const routesPath = join(root, ROUTES_OUT);
      const handlersPath = join(root, HANDLERS_OUT);
      const routesBefore = readFileSync(routesPath, 'utf8');
      const diffLine = corruptLine(handlersPath, 'registry.registerRead');
      const corruptedHandlers = readFileSync(handlersPath, 'utf8');
      const run = runGeneratorCli(root, ['--check']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('server/src/services/db/handlers.generated.ts');
      expect(run.stderr).toContain(`first difference at line ${diffLine}`);
      expect(run.stderr).not.toContain('routes-generated.ts');
      expect(readFileSync(handlersPath, 'utf8')).toBe(corruptedHandlers);
      expect(readFileSync(routesPath, 'utf8')).toBe(routesBefore);
    });

    it('CLI --check names both files with their first differing lines when both drift', () => {
      const root = createTree(defaultFiles());
      expect(runGeneratorCli(root, []).status).toBe(0);
      const routesLine = corruptLine(join(root, ROUTES_OUT), 'await registerHealthGroup(ctx);');
      const handlersLine = corruptLine(join(root, HANDLERS_OUT), 'registry.registerRead');
      const run = runGeneratorCli(root, ['--check']);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        `server/src/routes-generated.ts differs from a fresh generation (first difference at line ${routesLine})`,
      );
      expect(run.stderr).toContain(
        `server/src/services/db/handlers.generated.ts differs from a fresh generation (first difference at line ${handlersLine})`,
      );
    });

    it('CLI --check writes nothing: hash snapshot unchanged on pass and on failure', () => {
      const root = createTree(defaultFiles());
      expect(runGeneratorCli(root, []).status).toBe(0);
      const routesPath = join(root, ROUTES_OUT);
      const handlersPath = join(root, HANDLERS_OUT);
      const snapshot = (): string[] => [
        sha256(readFileSync(routesPath, 'utf8')),
        sha256(readFileSync(handlersPath, 'utf8')),
      ];
      const fresh = snapshot();
      expect(runGeneratorCli(root, ['--check']).status).toBe(0);
      expect(snapshot()).toEqual(fresh);
      corruptLine(handlersPath, 'registry.registerRead');
      const corrupted = snapshot();
      expect(corrupted).not.toEqual(fresh);
      expect(runGeneratorCli(root, ['--check']).status).toBe(1);
      expect(snapshot()).toEqual(corrupted);
    });

    it('CLI handler-stage failure in write mode exits 1 and leaves both pre-existing outputs byte-identical (atomic pair)', () => {
      const root = createTree(defaultFiles());
      const routesPath = join(root, ROUTES_OUT);
      const handlersPath = join(root, HANDLERS_OUT);
      writeFileSync(routesPath, 'sentinel-routes\n', 'utf8');
      writeFileSync(handlersPath, 'sentinel-handlers\n', 'utf8');
      writeFileSync(
        join(root, 'server/src/services/db/orphan.ts'),
        handlerSource('nope.unknown', true),
        'utf8',
      );
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('nope.unknown');
      expect(run.stderr).toContain('not in the kinds.ts catalog');
      expect(readFileSync(routesPath, 'utf8')).toBe('sentinel-routes\n');
      expect(readFileSync(handlersPath, 'utf8')).toBe('sentinel-handlers\n');
    });

    it('CLI handler without HANDLER_KIND fails hard (V-9) and writes nothing', () => {
      const files = defaultFiles();
      files['server/src/services/db/orphan.ts'] = 'export async function handle(): Promise<void> {}\n';
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('orphan.ts');
      expect(run.stderr).toContain('no HANDLER_KIND export');
      expectNoOutputs(root);
    });

    it('CLI handler without handle fails hard (V-10) and writes nothing', () => {
      const files = defaultFiles();
      files['server/src/services/db/orphan.ts'] = "export const HANDLER_KIND = 'marks.list' as const;\n";
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('orphan.ts');
      expect(run.stderr).toContain('no exported async handle function');
      expectNoOutputs(root);
    });

    it('CLI handler kind outside the catalog fails hard (V-11) and writes nothing', () => {
      const files = defaultFiles();
      files['server/src/services/db/orphan.ts'] = handlerSource('nope.unknown', true);
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('nope.unknown');
      expect(run.stderr).toContain('not in the kinds.ts catalog');
      expectNoOutputs(root);
    });

    it('CLI duplicate kind fails hard (V-12) and writes nothing', () => {
      const files = defaultFiles();
      files['server/src/services/db/marks-list-copy.ts'] = handlerSource('marks.list', true);
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('duplicate kind "marks.list"');
      expectNoOutputs(root);
    });

    it('CLI kind in both catalog lists fails hard (V-13) and writes nothing', () => {
      const files = defaultFiles();
      files['server/src/services/db/kinds.ts'] = kindsSource(['marks.list'], ['marks.list']);
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('marks.list');
      expect(run.stderr).toContain('is in both read and write lists');
      expectNoOutputs(root);
    });

    it('CLI handler alias-collision fixture fails hard and writes nothing (V-14; kebab-case check fires first)', () => {
      // The fixture suite pins the V-14 alias-collision message itself.
      // The real scanner additionally rejects non-kebab stems before
      // alias comparison, so fooBar.ts fails the stem check first.
      // What this CLI case pins is the fail-hard contract: exit 1,
      // the offending file named, and no output written.
      const files = defaultFiles();
      // The real scanner rejects an empty catalog list (V-15), so the
      // writes list keeps one kind; a catalog kind without a handler
      // file is not an error (section 6.3 item 4).
      files['server/src/services/db/kinds.ts'] = kindsSource(['marks.list', 'tags.list'], ['canvases.create']);
      files['server/src/services/db/foo-bar.ts'] = handlerSource('marks.list', true);
      files['server/src/services/db/fooBar.ts'] = handlerSource('tags.list', true);
      delete files['server/src/services/db/marks-list.ts'];
      delete files['server/src/services/db/canvases-get.ts'];
      delete files['server/src/services/db/canvases-create.ts'];
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('fooBar');
      expect(run.stderr).toContain('kebab-case');
      expectNoOutputs(root);
    });

    it('CLI kinds.ts without a parseable catalog array fails hard (V-15) and writes nothing', () => {
      for (const kinds of [
        'export const DB_WRITE_OP_KINDS = [\n  \'canvases.create\',\n] as const;\n',
        'export const DB_READ_OP_KINDS = readKinds;\n\nexport const DB_WRITE_OP_KINDS = [\n  \'canvases.create\',\n] as const;\n',
      ]) {
        const files = defaultFiles();
        files['server/src/services/db/kinds.ts'] = kinds;
        const root = createTree(files);
        const run = runGeneratorCli(root, []);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('kinds.ts');
        expect(run.stderr).toContain('cannot find DB_READ_OP_KINDS');
        expectNoOutputs(root);
      }
    });

    it('standalone scan output is byte-identical to the generator handlers output', () => {
      const scanRoot = createTree(defaultFiles());
      const genRoot = createTree(defaultFiles());
      expect(runScript(scanRoot, 'scan-db-handlers.mjs', []).status).toBe(0);
      expect(runGeneratorCli(genRoot, []).status).toBe(0);
      const scanned = readFileSync(join(scanRoot, HANDLERS_OUT), 'utf8');
      const generated = readFileSync(join(genRoot, HANDLERS_OUT), 'utf8');
      expect(scanned).toBe(generated);
      expect(sha256(scanned)).toBe(sha256(generated));
      expect(existsSync(join(scanRoot, ROUTES_OUT))).toBe(false);
      expect(runScript(genRoot, 'scan-db-handlers.mjs', ['--check']).status).toBe(0);
    });

    // KNOWN GAPS documented by GEN-AUDIT (fase1/laporan-gen-audit.md,
    // findings T-1 and T-2). These cases assert the CURRENT behavior
    // (exit 0) so each gap stays visible; they are NOT the desired
    // behavior. Wave 4 hardening must flip them to exit 1 and update
    // the expectations here. The generator is deliberately NOT fixed
    // by this suite.

    it('KNOWN GAP T-1: side-effect import of another adapter exits 0 (desired: exit 1)', () => {
      const files = defaultFiles();
      files['server/src/routes/stubs.registration.ts'] =
        "import './health.registration.js';\n" + adapterSource('stubs', 140);
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(0);
      expect(existsSync(join(root, ROUTES_OUT))).toBe(true);
      expect(existsSync(join(root, HANDLERS_OUT))).toBe(true);
    });

    it('KNOWN GAP T-1: dynamic import of another adapter exits 0 (desired: exit 1)', () => {
      const files = defaultFiles();
      files['server/src/routes/stubs.registration.ts'] =
        "import type { RegistrationContext } from '../registration/context.js';\n" +
        '\n' +
        "export const REGISTRATION_ID = 'stubs' as const;\n" +
        'export const REGISTRATION_ORDER = 140;\n' +
        'export async function registerGroup(ctx: RegistrationContext): Promise<void> {\n' +
        "  await import('./health.registration.js');\n" +
        '  void ctx;\n' +
        '}\n';
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(0);
      expect(existsSync(join(root, ROUTES_OUT))).toBe(true);
    });

    it('KNOWN GAP T-2: adapter exports present only in comments exit 0 (desired: exit 1)', () => {
      const files = defaultFiles();
      files['server/src/routes/stubs.registration.ts'] =
        "// export const REGISTRATION_ID = 'stubs' as const;\n" +
        '// export const REGISTRATION_ORDER = 140;\n' +
        '// export async function registerGroup(ctx: RegistrationContext): Promise<void> {}\n' +
        'export const dummy = 1;\n';
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(0);
      expect(readFileSync(join(root, ROUTES_OUT), 'utf8')).toContain('registerStubsGroup');
    });

    it('KNOWN GAP T-2: handler exports present only in a block comment exit 0 (desired: exit 1)', () => {
      const files = defaultFiles();
      files['server/src/services/db/tags-list.ts'] =
        '/*\n' +
        "export const HANDLER_KIND = 'tags.list' as const;\n" +
        'export async function handle(): Promise<void> {}\n' +
        '*/\n' +
        'export const dummy = 1;\n';
      const root = createTree(files);
      const run = runGeneratorCli(root, []);
      expect(run.status).toBe(0);
      expect(readFileSync(join(root, HANDLERS_OUT), 'utf8')).toContain('tagsListKind');
    });
  },
);
