// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Registration equivalence dump (Fase 1, grup B, pekerja B-09).
//
// Builds the real app through buildApp with an injected test auth
// context and permissive verifiers, then writes a deterministic
// fingerprint to the path in REG_DUMP_OUT: the printRoutes tree,
// the declared (method, path) pairs with their traversal order and
// group, the db kind handlers in registration order, the catalog
// kinds left unregistered, and the group order. The BEFORE dump is
// committed at server/scripts/registration-before.txt; the AFTER
// dump must be byte-identical (see
// server/scripts/compare-registration-dump.mjs). The only allowed
// differences are the ones that script documents, and today that
// list is empty.
//
// Run it only through the runner (never by hand-editing the dump):
//   node server/scripts/dump-registration.mjs <out-path>
// Without REG_DUMP_OUT this spec is a no-op that passes, so normal
// suite runs stay green and fast.
//
// Determinism rules: no timestamps, no random values, no absolute
// paths. The version string is the constant 'dump'. The temporary
// workspace directory and any BUILD_ID value are scrubbed from the
// output before writing. Probe statuses are deliberately NOT part
// of the dump: only the static route options captured per route.
//
// How each section is observed at runtime (no source parsing):
// - Routes: app.printRoutes(), parsed back into (method, path)
//   pairs with the radix-tree parser from the rf2 prototype
//   (fase1/evidence/v3b-rf2/zz-routedump.spec.ts). The seq column
//   is the printRoutes traversal order, a deterministic router
//   order. Fastify exposes no registration-order API on a built
//   app, and radix matching makes behavior independent of
//   registration order, so traversal order is the honest,
//   refactor-stable order for an equivalence dump.
// - Declared vs implicit HEAD: every parsed route is probed once
//   through an app with permissive verifiers, and a preHandler
//   hook captures routeOptions. A HEAD pair is implicit when its
//   routeOptions.method is the scalar 'HEAD' and a GET pair exists
//   for the same path (Fastify exposeHeadRoutes); it is declared
//   when the method came from a method array (for example the
//   GET+HEAD file route) or when no GET sibling exists. This keeps
//   the declared count on the B04 definition (34 pairs, 30 paths)
//   without hardcoding any path.
// - Handlers: DbHandlerRegistry.prototype registerRead/registerWrite
//   are wrapped before buildApp runs, so every kind registration
//   is recorded in call order with its side and validate presence.
//   registerReadMap/registerWriteMap delegate to those two, so map
//   based wiring is recorded exactly once per kind. The wrappers
//   are restored in a finally block. No app.ts change is needed.
// - Groups: the GROUP_BY_PATH table below maps each of the 30
//   known paths to its registrar group (B04 enumeration). An
//   unknown path fails the dump loudly instead of being silently
//   misgrouped: new groups must extend the table explicitly.
//   Group order is first appearance in printRoutes traversal
//   order, which is stable across registration reorder.

import { mkdtemp } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { SessionPrincipal } from '../src/middleware/auth-hook.js';
import { DB_READ_OP_KINDS, DB_WRITE_OP_KINDS } from '../src/services/db/kinds.js';
import { DbHandlerRegistry } from '../src/services/db/registry.js';
import { CANONICAL_ORIGIN, makeTestAuth, testConfig } from './auth/helpers.js';

const PRINCIPAL: SessionPrincipal = { userId: 'dump-user', role: 'user', sessionId: 'dump-session' };

// Registrar group per path (B04 enumeration: 30 unique paths).
// The one shared path, /api/workspace/file, is resolved by method
// in groupFor below: GET and HEAD belong to workspace-read, PUT
// belongs to workspace-write.
const GROUP_BY_PATH: Readonly<Record<string, string>> = {
  '/api/health': 'health',
  '/api/health/live': 'health',
  '/api/health/ready': 'health',
  '/api/auth/setup': 'auth-core',
  '/api/auth/login': 'auth-core',
  '/api/auth/login/totp': 'auth-core',
  '/api/auth/logout': 'auth-core',
  '/api/auth/logout-all': 'auth-core',
  '/api/auth/sessions': 'auth-core',
  '/api/auth/sessions/:id': 'auth-core',
  '/api/auth/csrf': 'auth-core',
  '/api/auth/me': 'auth-core',
  '/api/auth/register': 'auth-core',
  '/api/workspace/list': 'workspace-read',
  '/api/workspace/file': 'workspace-read',
  '/api/workspace/scan': 'workspace-read',
  '/api/workspace/stat': 'workspace-read',
  '/api/workspace/file/append': 'workspace-write',
  '/api/workspace/file/patch': 'workspace-write',
  '/api/workspace/media': 'workspace-write',
  '/api/settings': 'settings',
  '/api/settings/revision': 'settings',
  '/api/settings/secrets/status': 'secrets',
  '/api/settings/secrets/ai-providers': 'secrets',
  '/api/settings/secrets/ai-providers/:providerKey': 'secrets',
  '/api/transactions': 'db',
  '/api/db/batch': 'db',
  '/api/backups/restore': 'stubs',
  '/api/documents/parse': 'stubs',
  '/api/csp-reports': 'csp-reports',
};

function groupFor(method: string, path: string): string {
  if (path === '/api/workspace/file' && method === 'PUT') {
    return 'workspace-write';
  }
  const group = GROUP_BY_PATH[path];
  if (group === undefined) {
    throw new Error(`registration dump: unknown path with no group table entry: ${method} ${path}`);
  }
  return group;
}

interface ParsedRoute {
  method: string;
  path: string;
}

// Parse the radix-compressed tree printed by app.printRoutes() back
// into (method, path) pairs. Each line carries a label that
// concatenates with its ancestors; depth comes from the label
// column (4 spaces per level). Parser from the rf2 prototype.
function parsePrintRoutes(tree: string): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  const stack: string[] = [];
  for (const raw of tree.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '') {
      continue;
    }
    const labelStart = line.search(/[^ │├└─]/);
    if (labelStart < 0) {
      continue;
    }
    const depth = Math.max(0, Math.floor((labelStart - 4) / 4));
    let label = line.slice(labelStart);
    const methodsMatch = label.match(/ \(([A-Z, ]+)\)$/);
    let methods: string[] = [];
    if (methodsMatch) {
      methods = methodsMatch[1].split(',').map((m) => m.trim());
      label = label.slice(0, methodsMatch.index);
    }
    stack.length = depth;
    stack.push(label);
    if (methods.length > 0) {
      const path = stack.join('');
      for (const method of methods) {
        routes.push({ method, path });
      }
    }
  }
  return routes;
}

function probeUrl(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'x').replace(/\*/g, 'x');
}

function sortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value) ?? 'null';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJson(record[k])}`).join(',')}}`;
}

interface CapturedRoute {
  fromArray: boolean;
  config: string;
}

interface CapturedHandler {
  seq: number;
  side: 'read' | 'write';
  kind: string;
  hasValidate: boolean;
}

async function probe(app: FastifyInstance, method: string, path: string): Promise<void> {
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
  await app.inject({
    method: method as InjectOptions['method'],
    url: probeUrl(path),
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    payload: hasBody ? '{}' : undefined,
  });
}

describe('registration dump', () => {
  it('writes the deterministic registration fingerprint', async () => {
    const out = process.env['REG_DUMP_OUT'];
    if (out === undefined || out === '') {
      // No-op in normal suite runs: the dump is only written when
      // the runner sets REG_DUMP_OUT.
      expect(out ?? '').toBe('');
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'reg-dump-'));
    const config = testConfig({ workspaceRoot: dir, publicBaseUrl: CANONICAL_ORIGIN });

    // Record every db kind registration in call order. The wrappers
    // must be installed before buildApp runs and are always
    // restored, even when the build throws.
    const handlers: CapturedHandler[] = [];
    const originalRegisterRead = DbHandlerRegistry.prototype.registerRead;
    const originalRegisterWrite = DbHandlerRegistry.prototype.registerWrite;
    DbHandlerRegistry.prototype.registerRead = function (
      this: DbHandlerRegistry,
      kind,
      handler,
    ): void {
      handlers.push({
        seq: handlers.length + 1,
        side: 'read',
        kind,
        hasValidate: typeof handler !== 'function' && handler.validate !== undefined,
      });
      originalRegisterRead.call(this, kind, handler);
    };
    DbHandlerRegistry.prototype.registerWrite = function (
      this: DbHandlerRegistry,
      kind,
      handler,
    ): void {
      handlers.push({
        seq: handlers.length + 1,
        side: 'write',
        kind,
        hasValidate: typeof handler !== 'function' && handler.validate !== undefined,
      });
      originalRegisterWrite.call(this, kind, handler);
    };

    const testAuth = makeTestAuth();
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({
        config,
        pool: null,
        version: 'dump',
        auth: testAuth.auth,
        verifySession: async () => PRINCIPAL,
        verifyCsrf: async () => true,
        verifyOrigin: () => true,
      });
      await app.ready();
      const tree = app.printRoutes();
      const parsed = parsePrintRoutes(tree);
      expect(parsed.length).toBeGreaterThan(0);

      // No duplicate (method, path) pairs in the parsed tree.
      const seenPairs = new Set<string>();
      for (const route of parsed) {
        const key = `${route.method} ${route.path}`;
        expect(seenPairs.has(key)).toBe(false);
        seenPairs.add(key);
      }

      // Capture routeOptions per route: one probe per parsed route
      // through the permissive app, recorded by a preHandler hook.
      const captured = new Map<string, CapturedRoute>();
      await app.addHook('preHandler', async (request) => {
        const methodOption = request.routeOptions.method;
        const methods = Array.isArray(methodOption) ? methodOption : [methodOption];
        const fromArray = Array.isArray(methodOption);
        for (const method of methods) {
          const key = `${method} ${request.routeOptions.url}`;
          if (!captured.has(key)) {
            captured.set(key, { fromArray, config: sortedJson(request.routeOptions.config ?? {}) });
          }
        }
      });
      for (const route of parsed) {
        await probe(app, route.method, route.path);
      }
      for (const route of parsed) {
        const key = `${route.method} ${route.path}`;
        if (!captured.has(key)) {
          throw new Error(`registration dump: probe did not reach route: ${key}`);
        }
      }

      // Declared pairs: drop Fastify-implicit HEAD routes (scalar
      // 'HEAD' method with a GET sibling on the same path).
      const getPaths = new Set(parsed.filter((r) => r.method === 'GET').map((r) => r.path));
      const declaredFlags = parsed.map((route) => {
        const capture = captured.get(`${route.method} ${route.path}`) as CapturedRoute;
        if (route.method === 'HEAD' && !capture.fromArray && getPaths.has(route.path)) {
          return false;
        }
        return true;
      });
      const declared = parsed.filter((_route, index) => declaredFlags[index]);
      const uniquePaths = new Set(declared.map((r) => r.path));

      // Groups: every declared route must resolve, loudly on miss.
      const groupOf = new Map<string, string>();
      for (const route of parsed) {
        groupOf.set(`${route.method} ${route.path}`, groupFor(route.method, route.path));
      }
      const groupOrder: string[] = [];
      for (const route of parsed) {
        const group = groupOf.get(`${route.method} ${route.path}`) as string;
        if (!groupOrder.includes(group)) {
          groupOrder.push(group);
        }
      }

      // Handlers: no duplicate kinds, and every kind belongs to its
      // catalog side.
      const seenKinds = new Set<string>();
      for (const handler of handlers) {
        expect(seenKinds.has(handler.kind)).toBe(false);
        seenKinds.add(handler.kind);
      }
      expect(handlers.length).toBeGreaterThan(0);
      const readKinds = new Set<string>(DB_READ_OP_KINDS);
      const writeKinds = new Set<string>(DB_WRITE_OP_KINDS);
      for (const handler of handlers) {
        const catalog = handler.side === 'read' ? readKinds : writeKinds;
        expect(catalog.has(handler.kind)).toBe(true);
      }
      const registeredKinds = new Set(handlers.map((h) => h.kind));
      const unregistered: Array<{ side: 'read' | 'write'; kind: string }> = [];
      for (const kind of DB_READ_OP_KINDS) {
        if (!registeredKinds.has(kind)) {
          unregistered.push({ side: 'read', kind });
        }
      }
      for (const kind of DB_WRITE_OP_KINDS) {
        if (!registeredKinds.has(kind)) {
          unregistered.push({ side: 'write', kind });
        }
      }
      unregistered.sort((a, b) => a.kind.localeCompare(b.kind));

      const reads = handlers.filter((h) => h.side === 'read').length;
      const writes = handlers.filter((h) => h.side === 'write').length;

      // Sections. Route lines carry their printRoutes traversal seq
      // plus their group, so the sorted list still shows order.
      const lines: string[] = [];
      lines.push('# registration dump: deterministic, no timestamps, no random values, no absolute paths');
      lines.push('# variant: buildApp with injected test auth + permissive verifiers (all route groups present)');
      lines.push(
        `# counts: printRoutes pairs=${parsed.length} declared pairs=${declared.length} unique paths=${uniquePaths.size} handlers=${handlers.length} (reads=${reads} writes=${writes}) groups=${groupOrder.length} unregistered kinds=${unregistered.length}`,
      );
      lines.push('## printRoutes');
      lines.push(tree.trimEnd());
      lines.push(`## routes (${declared.length} declared pairs, sorted by path then method)`);
      const sortedDeclared = declared
        .map((route) => ({ route, seq: parsed.indexOf(route) + 1 }))
        .sort((a, b) => {
          const byPath = a.route.path.localeCompare(b.route.path);
          return byPath !== 0 ? byPath : a.route.method.localeCompare(b.route.method);
        });
      for (const entry of sortedDeclared) {
        const key = `${entry.route.method} ${entry.route.path}`;
        const capture = captured.get(key) as CapturedRoute;
        lines.push(
          `${String(entry.seq).padStart(3, ' ')} ${entry.route.method} ${entry.route.path} group=${groupOf.get(key)} methods=${capture.fromArray ? 'array' : 'scalar'} config=${capture.config}`,
        );
      }
      lines.push(`## routes-all (${parsed.length} printRoutes pairs, traversal order)`);
      parsed.forEach((route, index) => {
        const key = `${route.method} ${route.path}`;
        lines.push(
          `${String(index + 1).padStart(3, ' ')} ${route.method} ${route.path} declared=${declaredFlags[index] ? 'yes' : 'no'} group=${groupOf.get(key)}`,
        );
      });
      lines.push(`## handlers (${handlers.length}, registration order)`);
      for (const handler of handlers) {
        lines.push(
          `${String(handler.seq).padStart(3, ' ')} ${handler.side} ${handler.kind} validate=${handler.hasValidate ? 'yes' : 'no'}`,
        );
      }
      lines.push(`## handlers-sorted (${handlers.length}, sorted by kind)`);
      for (const handler of [...handlers].sort((a, b) => a.kind.localeCompare(b.kind))) {
        lines.push(`${handler.side} ${handler.kind} validate=${handler.hasValidate ? 'yes' : 'no'}`);
      }
      lines.push(`## unregistered-kinds (${unregistered.length}, sorted by kind)`);
      for (const entry of unregistered) {
        lines.push(`${entry.side} ${entry.kind}`);
      }
      lines.push(`## groups (${groupOrder.length}, first-appearance order in printRoutes traversal)`);
      groupOrder.forEach((group, index) => {
        const memberRoutes = declared.filter(
          (route) => groupOf.get(`${route.method} ${route.path}`) === group,
        );
        const memberPaths = new Set(memberRoutes.map((r) => r.path));
        lines.push(
          `${String(index + 1).padStart(3, ' ')} ${group} routes=${memberRoutes.length} paths=${memberPaths.size}`,
        );
      });

      let text = `${lines.join('\n')}\n`;
      // Scrub the temporary workspace path and any BUILD_ID value so
      // the dump never depends on the machine or the build.
      text = text.split(dir).join('<TMPDIR>');
      const buildId = process.env['BUILD_ID'];
      if (buildId !== undefined && buildId !== '') {
        text = text.split(buildId).join('<BUILD_ID>');
      }
      writeFileSync(out, text, 'utf8');
    } finally {
      DbHandlerRegistry.prototype.registerRead = originalRegisterRead;
      DbHandlerRegistry.prototype.registerWrite = originalRegisterWrite;
      if (app !== undefined) {
        await app.close();
      }
    }
  }, 180000);
});
