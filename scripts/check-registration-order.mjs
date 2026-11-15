// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.
//
// check-registration-order.mjs: fail-closed static checker for the
// route-group registration order decided by AD-61 (see
// fase1/desain-registrasi-programatik.md sections 3-6).
//
// The checker never executes adapter, registrar, or app code. It only
// reads source text with a small string/comment-aware scanner, in the
// same spirit as the generator validation rules V-1..V-17. Anything
// it cannot resolve is reported as a violation, never skipped
// silently, except for the controls that need adapters: when no
// adapter file exists yet, those controls are reported NOT TESTED
// and do not affect the exit code.
//
// Modes (auto-detected from the tree under --root, default: repo root):
// (a) app.ts mode: the order of register*Routes calls in
//     server/src/app.ts must follow the frozen group convention,
//     health first, and the route files those registrars live in
//     must hold no duplicate method+path pair and no route without
//     a handler.
// (b) adapter mode: every server/src/routes/*.registration.ts file
//     must satisfy the adapter contract (REGISTRATION_ID,
//     REGISTRATION_ORDER, registerGroup), ranks must sit in 10-160
//     with no clash, health must hold the smallest rank, and the
//     rank order must follow the frozen group convention. When
//     server/src/routes-generated.ts exists, its call order must
//     match the rank order exactly.
//
// Exit codes: 0 = every applicable check passed; 1 = at least one
// violation; 2 = usage error or unreadable input (fail closed).
// With --json the report is one JSON object on stdout.
//
// Checks:
// C-1 rank in range 10-160 (adapter mode)
// C-2 rank clash: two adapters sharing one rank (adapter mode)
// C-3 health first: health holds the smallest rank / first call
// C-4 group order follows the frozen convention (both modes)
// C-5 no duplicate method+path across route files
// C-6 every route has a handler, and every route declaration
//     resolves to a literal method+path (unresolved = violation)
// C-7 adapter coverage: when adapters exist, no registrar may be
//     called directly from app.ts, and every registrar an adapter
//     calls must exist as an export in a route file
// C-8 adapter contract: ID matches the file stem, ORDER is an
//     integer, registerGroup exists, no adapter-to-adapter import,
//     no generated-alias collision (adapter mode)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RANK_MIN = 10;
const RANK_MAX = 160;

// Frozen group convention, desain-registrasi-programatik.md 3.3/4.1.
// Rank values in the table are the frozen assignments; this checker
// does NOT require an adapter to use its table rank (inserts use the
// gaps, and renumbering is a coordinator act). It requires the
// relative order of the groups that are present to match this list.
const CONVENTION = [
  'health',
  'auth-core',
  'auth-advanced',
  'admin',
  'workspace-read',
  'workspace-write',
  'workspace-structure',
  'workspace-reconcile',
  'workspace-media',
  'settings-secrets',
  'db',
  'records',
  'search',
  'assets',
  'stubs',
  'csp-reports',
  'events',
];
const CONVENTION_INDEX = new Map(CONVENTION.map((id, i) => [id, i]));

// Registrar function name to group id, for app.ts mode. The
// settings/secrets pair shares one adapter (seksi 3.3), and the
// workspace-structure adapter owns both the structure and the trash
// registrars. A registrar name missing from this map is a fail-closed
// C-4 violation: the checker cannot verify the order of a group it
// does not know, so a worker must extend the map by amendment.
const REGISTRAR_TO_GROUP = new Map([
  ['registerHealthRoutes', 'health'],
  ['registerAuthCoreRoutes', 'auth-core'],
  ['registerAuthAdvancedRoutes', 'auth-advanced'],
  ['registerAdminRoutes', 'admin'],
  ['registerWorkspaceReadRoutes', 'workspace-read'],
  ['registerWorkspaceWriteRoutes', 'workspace-write'],
  ['registerWorkspaceStructureRoutes', 'workspace-structure'],
  ['registerWorkspaceTrashRoutes', 'workspace-structure'],
  ['registerWorkspaceReconcileRoutes', 'workspace-reconcile'],
  ['registerWorkspaceMediaRoutes', 'workspace-media'],
  ['registerSettingsRoutes', 'settings-secrets'],
  ['registerSecretsRoutes', 'settings-secrets'],
  ['registerDbRoutes', 'db'],
  ['registerRecordsRoutes', 'records'],
  ['registerMarksRoutes', 'records'],
  ['registerTagsRoutes', 'records'],
  ['registerSearchRoutes', 'search'],
  ['registerAssetsRoutes', 'assets'],
  ['registerStubRoutes', 'stubs'],
  ['registerCspReportRoutes', 'csp-reports'],
  ['registerCspReportsRoutes', 'csp-reports'],
  ['registerEventsRoutes', 'events'],
  ['registerWorkspaceEventsRoutes', 'events'],
]);

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------------------
// Small string/comment-aware scanner. Comments are blanked (newlines kept,
// so line numbers survive); string spans are recorded so regex matches
// inside string literals are never mistaken for code.
// ---------------------------------------------------------------------------

function scanRanges(src) {
  const strings = [];
  const comments = [];
  const n = src.length;
  let i = 0;
  // Frame stack for template literals: { subst: boolean, braces: number }.
  // The bottom frame is plain code and is never popped.
  const stack = [{ subst: false, braces: 0, template: false }];
  const top = () => stack[stack.length - 1];

  function readString(quote) {
    const start = i;
    i += 1;
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        i += 1;
        break;
      }
      if (ch === '\n' && quote !== '`') break;
      i += 1;
    }
    return [start, i];
  }

  while (i < n) {
    const frame = top();
    if (frame.template) {
      const ch = src[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        i += 1;
        strings.push([frame.strStart, i]);
        stack.pop();
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        i += 2;
        stack.push({ subst: true, braces: 0, template: false });
        continue;
      }
      i += 1;
      continue;
    }
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      while (i < n && src[i] !== '\n') i += 1;
      comments.push([start, i]);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      comments.push([start, i]);
      continue;
    }
    if (ch === "'" || ch === '"') {
      strings.push(readString(ch));
      continue;
    }
    if (ch === '`') {
      stack.push({ subst: false, braces: 0, template: true, strStart: i });
      i += 1;
      continue;
    }
    if (frame.subst) {
      if (ch === '{') frame.braces += 1;
      if (ch === '}') {
        if (frame.braces === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        frame.braces -= 1;
      }
    }
    i += 1;
  }
  // An unterminated template at EOF still counts as a string span.
  for (const frame of stack) {
    if (frame.template) strings.push([frame.strStart, n]);
  }
  return { strings, comments };
}

function blankComments(src, comments) {
  const chars = src.split('');
  for (const [start, end] of comments) {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function inRanges(ranges, index) {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
    if (start > index) break;
  }
  return false;
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

// Parse one source file once: keep the original text, the
// comment-blanked code text, and the string spans (indexes are the
// same in both texts because blanking preserves length).
function parseFile(absPath, relPath) {
  const src = readFileSync(absPath, 'utf8');
  const { strings, comments } = scanRanges(src);
  return { absPath, relPath, src, code: blankComments(src, comments), strings };
}

// Find the index just past the balanced closer starting at openIdx,
// skipping over string literals. Returns -1 when unbalanced.
function balancedEnd(ctx, openIdx, openCh, closeCh) {
  const { code, strings } = ctx;
  let depth = 0;
  let i = openIdx;
  while (i < code.length) {
    if (inRanges(strings, i)) {
      i += 1;
      continue;
    }
    const ch = code[i];
    if (ch === openCh) depth += 1;
    if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return -1;
}

// Split the text between an opener and its closer on top-level commas.
// Whitespace-only parts (from a trailing comma) are dropped.
function splitTopLevel(ctx, absStart, absEnd) {
  const parts = [];
  let depthParen = 0;
  let depthBrace = 0;
  let depthBracket = 0;
  let partStart = absStart;
  for (let i = absStart; i < absEnd; i += 1) {
    if (inRanges(ctx.strings, i)) continue;
    const ch = ctx.code[i];
    if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen -= 1;
    else if (ch === '{') depthBrace += 1;
    else if (ch === '}') depthBrace -= 1;
    else if (ch === '[') depthBracket += 1;
    else if (ch === ']') depthBracket -= 1;
    else if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
      parts.push(ctx.code.slice(partStart, i));
      partStart = i + 1;
    }
  }
  parts.push(ctx.code.slice(partStart, absEnd));
  return parts.filter((part) => part.trim() !== '');
}

function isImportLine(code, index) {
  const lineStart = code.lastIndexOf('\n', index - 1) + 1;
  return code.slice(lineStart, index).trimStart().startsWith('import ');
}

// A string literal with no substitution, or null. Handles 'x', "x",
// and `x` forms; template literals containing ${ are not literals.
function literalString(text) {
  const trimmed = text.trim();
  const m = /^(['"`])((?:\\.|(?!\1).)*)\1$/.exec(trimmed);
  if (m === null) return null;
  if (m[1] === '`' && m[2].includes('${')) return null;
  return m[2];
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

// ---------------------------------------------------------------------------
// Path-constant resolution (file-local, plus one import hop for
// constants such as CSP_REPORT_PATH that live in another module).
// ---------------------------------------------------------------------------

function collectLocalConstants(ctx) {
  const map = new Map();
  const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)/g;
  let m;
  while ((m = re.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    const value = literalString(m[2]);
    if (value !== null && value.startsWith('/')) map.set(m[1], value);
  }
  return map;
}

function collectImports(ctx) {
  // Returns Map<localName, specifier> for named and default imports
  // from relative specifiers only.
  const map = new Map();
  const re = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*('[^']*'|"[^"]*")/g;
  let m;
  while ((m = re.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    const spec = literalString(m[3]);
    if (spec === null || !spec.startsWith('.')) continue;
    if (m[1] !== undefined) map.set(m[1], spec);
    if (m[2] !== undefined) {
      for (const part of m[2].split(',')) {
        const piece = part.trim().replace(/^type\s+/, '');
        if (piece === '') continue;
        const as = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(piece);
        if (as !== null) map.set(as[2], spec);
        else if (IDENT.test(piece)) map.set(piece, spec);
      }
    }
  }
  return map;
}

function resolveSpecifierToFile(fromAbsPath, spec) {
  const base = resolve(dirname(fromAbsPath), spec);
  const candidates = [];
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  candidates.push(`${base}.ts`, join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

class FileCache {
  constructor(root) {
    this.root = root;
    this.cache = new Map();
  }

  rel(absPath) {
    return absPath.slice(this.root.length + 1).split(sep).join('/');
  }

  get(absPath) {
    if (!this.cache.has(absPath)) {
      this.cache.set(absPath, parseFile(absPath, this.rel(absPath)));
    }
    return this.cache.get(absPath);
  }

  constants(absPath) {
    const key = `const:${absPath}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, collectLocalConstants(this.get(absPath)));
    }
    return this.cache.get(key);
  }

  // Resolve a path identifier used as a route first argument:
  // file-local constant first, then one relative-import hop.
  resolvePathIdentifier(ctx, name) {
    const local = this.constants(ctx.absPath);
    if (local.has(name)) return { value: local.get(name), via: null };
    const imports = collectImports(ctx);
    const spec = imports.get(name);
    if (spec === undefined) return null;
    const target = resolveSpecifierToFile(ctx.absPath, spec);
    if (target === null) return null;
    const targetConsts = this.constants(target);
    if (!targetConsts.has(name)) return null;
    return { value: targetConsts.get(name), via: this.rel(target) };
  }
}

// ---------------------------------------------------------------------------
// Route-file parsing.
// ---------------------------------------------------------------------------

function collectHandlerLikeNames(ctx) {
  const names = new Set();
  const arrow = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^;]*?\)|[A-Za-z_$][\w$]*)\s*=>/g;
  let m;
  while ((m = arrow.exec(ctx.code)) !== null) {
    if (!inRanges(ctx.strings, m.index)) names.add(m[1]);
  }
  const fn = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fn.exec(ctx.code)) !== null) {
    if (!inRanges(ctx.strings, m.index)) names.add(m[1]);
  }
  return names;
}

function collectObjectConstNames(ctx) {
  const names = new Set();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{/g;
  let m;
  while ((m = re.exec(ctx.code)) !== null) {
    if (!inRanges(ctx.strings, m.index)) names.add(m[1]);
  }
  return names;
}

// Decide whether the trailing argument of a route call is a handler:
// an arrow function, a named function/arrow const, or a bare
// identifier that is not a known options-object const (an imported
// function reference). An object literal or a known options const in
// the trailing position means the handler is missing.
function trailingArgIsHandler(argText, handlerNames, objectNames) {
  const trimmed = argText.trim();
  if (trimmed === '') return false;
  if (trimmed.includes('=>')) return true;
  if (trimmed.startsWith('{')) return false;
  if (trimmed.startsWith('async ') || trimmed.startsWith('function')) return true;
  if (IDENT.test(trimmed)) {
    if (objectNames.has(trimmed)) return false;
    return true;
  }
  return false;
}

// Receiver names that denote the Fastify instance in this file: the
// first parameter of the registrar function, plus the callback
// parameter of any app.register(...) encapsulated context (for
// example `scoped` in stubs.ts). Restricting route-call matching to
// these receivers keeps Map.get, Headers.get, and similar calls from
// being mistaken for route declarations.
function collectReceivers(ctx, registrar) {
  const receivers = new Set();
  const sig = new RegExp(`function\\s+${registrar}\\s*\\(([^)]*)\\)`).exec(ctx.code);
  if (sig !== null && !inRanges(ctx.strings, sig.index)) {
    const firstParam = sig[1].split(',')[0].trim();
    const name = /^([A-Za-z_$][\w$]*)/.exec(firstParam);
    if (name !== null) receivers.add(name[1]);
  }
  const registerRe = /\.register\s*\(\s*(?:async\s+)?(?:function\s*)?\(\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = registerRe.exec(ctx.code)) !== null) {
    if (!inRanges(ctx.strings, m.index)) receivers.add(m[1]);
  }
  if (receivers.size === 0) receivers.add('app');
  return receivers;
}

function parseRouteFile(ctx, files) {
  const registrarMatch = /export\s+(?:async\s+)?function\s+(register[A-Z][\w$]*Routes)\s*\(/.exec(ctx.code);
  if (registrarMatch === null || inRanges(ctx.strings, registrarMatch.index)) {
    return { skipped: true, registrar: null, routes: [], unresolved: [] };
  }
  const registrar = registrarMatch[1];
  const handlerNames = collectHandlerLikeNames(ctx);
  const objectNames = collectObjectConstNames(ctx);
  const receivers = collectReceivers(ctx, registrar);
  const routes = [];
  const unresolved = [];

  function resolveFirstArg(argText, callIndex) {
    const literal = literalString(argText);
    if (literal !== null) return { path: literal, via: null };
    const name = argText.trim();
    if (IDENT.test(name)) {
      const resolved = files.resolvePathIdentifier(ctx, name);
      if (resolved !== null) return { path: resolved.value, via: resolved.via };
      unresolved.push({
        line: lineOf(ctx.code, callIndex),
        reason: `route path identifier '${name}' cannot be resolved to a literal path in this file or its relative imports`,
      });
      return null;
    }
    unresolved.push({
      line: lineOf(ctx.code, callIndex),
      reason: 'route path argument is not a string literal or a resolvable path identifier',
    });
    return null;
  }

  // app.get/post/... and scoped.get/post/... calls, restricted to
  // Fastify-instance receivers (see collectReceivers).
  const callRe = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|head|options)\s*\(/g;
  let m;
  while ((m = callRe.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    if (!receivers.has(m[1])) continue;
    const openIdx = m.index + m[0].length - 1;
    const endIdx = balancedEnd(ctx, openIdx, '(', ')');
    if (endIdx === -1) {
      unresolved.push({ line: lineOf(ctx.code, m.index), reason: 'unbalanced route call parentheses' });
      continue;
    }
    const args = splitTopLevel(ctx, openIdx + 1, endIdx - 1);
    if (args.length === 0) {
      unresolved.push({ line: lineOf(ctx.code, m.index), reason: 'route call without arguments' });
      continue;
    }
    const resolved = resolveFirstArg(args[0], m.index);
    if (resolved === null) continue;
    const hasHandler =
      args.length >= 2 && trailingArgIsHandler(args[args.length - 1], handlerNames, objectNames);
    routes.push({
      method: m[2].toUpperCase(),
      path: resolved.path,
      line: lineOf(ctx.code, m.index),
      hasHandler,
      registrar,
    });
  }

  // app.route({ method, url, handler }) calls, same receivers.
  const routeRe = /\b([A-Za-z_$][\w$]*)\.route\s*\(/g;
  while ((m = routeRe.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    if (!receivers.has(m[1])) continue;
    const openIdx = m.index + m[0].length - 1;
    const endIdx = balancedEnd(ctx, openIdx, '(', ')');
    if (endIdx === -1) {
      unresolved.push({ line: lineOf(ctx.code, m.index), reason: 'unbalanced app.route call parentheses' });
      continue;
    }
    const callText = ctx.code.slice(openIdx + 1, endIdx - 1);
    const braceIdx = callText.indexOf('{');
    if (braceIdx === -1) {
      unresolved.push({ line: lineOf(ctx.code, m.index), reason: 'app.route call without an options object' });
      continue;
    }
    const objText = callText.slice(braceIdx);
    const methodMatch = /method\s*:\s*(\[[^\]]*\]|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/.exec(objText);
    const urlMatch = /url\s*:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[A-Za-z_$][\w$]*)/.exec(objText);
    const hasHandler = /handler\s*:/.test(objText);
    if (methodMatch === null || urlMatch === null) {
      unresolved.push({
        line: lineOf(ctx.code, m.index),
        reason: 'app.route call without a readable method and url',
      });
      continue;
    }
    const methods = [];
    const methodText = methodMatch[1].trim();
    if (methodText.startsWith('[')) {
      const litRe = /'([^']*)'|"([^"]*)"/g;
      let lm;
      while ((lm = litRe.exec(methodText)) !== null) methods.push((lm[1] ?? lm[2]).toUpperCase());
    } else {
      const single = literalString(methodText);
      if (single !== null) methods.push(single.toUpperCase());
    }
    const validMethods = methods.filter((method) => HTTP_METHODS.has(method));
    if (validMethods.length === 0 || validMethods.length !== methods.length) {
      unresolved.push({
        line: lineOf(ctx.code, m.index),
        reason: `app.route call with an unreadable method value '${methodText}'`,
      });
      continue;
    }
    const urlArg = urlMatch[1];
    const urlLiteral = literalString(urlArg);
    let path = urlLiteral;
    if (path === null && IDENT.test(urlArg.trim())) {
      const resolved = files.resolvePathIdentifier(ctx, urlArg.trim());
      if (resolved !== null) path = resolved.value;
    }
    if (path === null) {
      unresolved.push({
        line: lineOf(ctx.code, m.index),
        reason: `app.route url '${urlArg.trim()}' cannot be resolved to a literal path`,
      });
      continue;
    }
    for (const method of validMethods) {
      routes.push({ method, path, line: lineOf(ctx.code, m.index), hasHandler, registrar });
    }
  }

  return { skipped: false, registrar, routes, unresolved };
}

// ---------------------------------------------------------------------------
// app.ts and adapter parsing.
// ---------------------------------------------------------------------------

function findRegistrarCalls(ctx) {
  const calls = [];
  const re = /\b(register[A-Z][\w$]*Routes)\s*\(/g;
  let m;
  while ((m = re.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    if (isImportLine(ctx.code, m.index)) continue;
    calls.push({ registrar: m[1], line: lineOf(ctx.code, m.index) });
  }
  return calls;
}

function findGeneratedIndexCall(ctx) {
  const re = /\bregisterRouteGroups\s*\(/g;
  let m;
  while ((m = re.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    if (isImportLine(ctx.code, m.index)) continue;
    return { line: lineOf(ctx.code, m.index) };
  }
  return null;
}

function pascalCase(id) {
  return id
    .split('-')
    .map((part) => (part === '' ? '' : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function parseAdapter(ctx, fileName) {
  const stem = fileName.slice(0, -'.registration.ts'.length);
  const idMatch = /export\s+const\s+REGISTRATION_ID\s*=\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*as\s+const/.exec(ctx.code);
  const idLoose = /export\s+const\s+REGISTRATION_ID\s*=/.test(ctx.code);
  const orderMatch = /export\s+const\s+REGISTRATION_ORDER\s*=\s*(-?\d[\d_]*)/.exec(ctx.code);
  const orderLoose = /export\s+const\s+REGISTRATION_ORDER\s*=/.test(ctx.code);
  const hasGroup = /export\s+async\s+function\s+registerGroup\s*\(/.test(ctx.code);
  const groupLoose = /function\s+registerGroup\s*\(/.test(ctx.code);

  let id = null;
  if (idMatch !== null && !inRanges(ctx.strings, idMatch.index)) {
    id = literalString(idMatch[1]);
  }
  let order = null;
  if (orderMatch !== null && !inRanges(ctx.strings, orderMatch.index)) {
    const digits = orderMatch[1].replace(/_/g, '');
    if (/^-?\d+$/.test(digits)) order = Number.parseInt(digits, 10);
  }

  // Adapter-to-adapter import: any import specifier naming a
  // *.registration module.
  let importsAdapter = false;
  const importRe = /import\s+[^;]*?from\s*('[^']*'|"[^"]*")/g;
  let m;
  while ((m = importRe.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    const spec = literalString(m[1]);
    if (spec !== null && spec.includes('.registration.')) importsAdapter = true;
  }

  const registrarCalls = findRegistrarCalls(ctx).map((call) => call.registrar);
  return {
    stem,
    id,
    idPresent: idLoose,
    idWellFormed: id !== null,
    order,
    orderPresent: orderLoose,
    hasGroup,
    groupLoose,
    importsAdapter,
    registrarCalls,
    alias: id === null ? null : `register${pascalCase(id)}Group`,
  };
}

function parseGeneratedIndex(ctx) {
  const aliasToId = new Map();
  const importRe = /import\s*\{\s*registerGroup\s+as\s+([A-Za-z_$][\w$]*)\s*\}\s*from\s*('[^']*'|"[^"]*")/g;
  let m;
  while ((m = importRe.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    const spec = literalString(m[2]);
    const stem = spec === null ? null : /\.?\/?routes\/([\w-]+)\.registration\.js$/.exec(spec);
    aliasToId.set(m[1], stem === null ? null : stem[1]);
  }
  const callOrder = [];
  const callRe = /\bawait\s+([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)/g;
  while ((m = callRe.exec(ctx.code)) !== null) {
    if (inRanges(ctx.strings, m.index)) continue;
    callOrder.push({ alias: m[1], line: lineOf(ctx.code, m.index) });
  }
  return { aliasToId, callOrder };
}

// ---------------------------------------------------------------------------
// Checks.
// ---------------------------------------------------------------------------

function checkConventionOrder(sequence, describe, violations, fileLabel) {
  // sequence: [{group, label, line}] in observed order. Consecutive
  // repeats of one group (settings then secrets) collapse to one.
  const collapsed = [];
  for (const item of sequence) {
    if (collapsed.length > 0 && collapsed[collapsed.length - 1].group === item.group) continue;
    collapsed.push(item);
  }
  let prevIndex = -1;
  let prevLabel = null;
  for (const item of collapsed) {
    const index = CONVENTION_INDEX.get(item.group);
    if (index === undefined) {
      violations.push({
        code: 'C-4',
        file: fileLabel,
        line: item.line,
        message: `unknown group '${item.group}' (${describe} '${item.label}'): the checker cannot verify the order of a group outside the frozen convention; extend the convention map by amendment`,
      });
      continue;
    }
    if (index <= prevIndex) {
      violations.push({
        code: 'C-4',
        file: fileLabel,
        line: item.line,
        message: `group order violation: '${item.group}' (${describe} '${item.label}') appears after '${prevLabel}' but the frozen convention orders '${item.group}' before it`,
      });
    }
    if (index > prevIndex) {
      prevIndex = index;
      prevLabel = item.group;
    }
  }
  return collapsed;
}

function main(argv) {
  let root = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--root') {
      i += 1;
      if (i >= argv.length) {
        process.stderr.write('usage: check-registration-order.mjs [--root DIR] [--json]\n');
        return 2;
      }
      root = argv[i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: check-registration-order.mjs [--root DIR] [--json]\n');
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${arg}\nusage: check-registration-order.mjs [--root DIR] [--json]\n`);
      return 2;
    }
  }
  if (root === null) {
    root = dirname(dirname(fileURLToPath(import.meta.url)));
  }
  root = resolve(root);

  const violations = [];
  const notTested = [];
  const notes = [];

  const appTsPath = join(root, 'server', 'src', 'app.ts');
  const routesDir = join(root, 'server', 'src', 'routes');
  const generatedPath = join(root, 'server', 'src', 'routes-generated.ts');
  if (!existsSync(appTsPath)) {
    process.stderr.write(`input error: app.ts not found at ${appTsPath}\n`);
    return 2;
  }
  if (!existsSync(routesDir)) {
    process.stderr.write(`input error: routes directory not found at ${routesDir}\n`);
    return 2;
  }

  const files = new FileCache(root);
  const appCtx = files.get(appTsPath);
  const relApp = files.rel(appTsPath);

  let entries;
  try {
    entries = readdirSync(routesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    process.stderr.write(`input error: cannot read routes directory: ${error.message}\n`);
    return 2;
  }
  if (entries.length === 0) {
    process.stderr.write(`input error: no .ts files in ${routesDir}\n`);
    return 2;
  }

  const adapterFiles = entries.filter((name) => name.endsWith('.registration.ts'));
  const routeFiles = entries.filter(
    (name) => !name.endsWith('.registration.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.test.ts'),
  );

  // -- Adapter mode: contract, rank range, rank clash, alias clash.
  const adapters = [];
  for (const name of adapterFiles) {
    const ctx = files.get(join(routesDir, name));
    const adapter = parseAdapter(ctx, name);
    adapter.file = files.rel(join(routesDir, name));
    adapters.push(adapter);
    if (!adapter.idPresent) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}' has no 'export const REGISTRATION_ID'` });
    } else if (!adapter.idWellFormed) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}' REGISTRATION_ID is not a string literal with 'as const'` });
    } else if (adapter.id !== adapter.stem) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter REGISTRATION_ID '${adapter.id}' does not match the file stem '${adapter.stem}'` });
    }
    if (!adapter.orderPresent) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}' has no 'export const REGISTRATION_ORDER'` });
    } else if (adapter.order === null) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}' REGISTRATION_ORDER is not an integer literal` });
    } else if (adapter.order < RANK_MIN || adapter.order > RANK_MAX) {
      violations.push({ code: 'C-1', file: adapter.file, line: 1, message: `adapter '${name}' rank ${adapter.order} is outside the frozen range ${RANK_MIN}-${RANK_MAX}` });
    }
    if (!adapter.hasGroup) {
      const detail = adapter.groupLoose
        ? 'registerGroup exists but is not declared as \'export async function registerGroup\''
        : 'no \'export async function registerGroup\'';
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}': ${detail}` });
    }
    if (adapter.importsAdapter) {
      violations.push({ code: 'C-8', file: adapter.file, line: 1, message: `adapter '${name}' imports another *.registration module, which the adapter contract forbids` });
    }
  }

  // C-2: rank clash.
  const byRank = new Map();
  for (const adapter of adapters) {
    if (adapter.order === null) continue;
    if (!byRank.has(adapter.order)) byRank.set(adapter.order, []);
    byRank.get(adapter.order).push(adapter);
  }
  for (const [rank, group] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    if (group.length > 1) {
      const names = group.map((adapter) => adapter.file).join(', ');
      violations.push({
        code: 'C-2',
        file: group[0].file,
        line: 1,
        message: `rank clash: rank ${rank} is used by ${group.length} adapters: ${names}`,
      });
    }
  }

  // C-8: generated-alias collision (register<PascalId>Group).
  const byAlias = new Map();
  for (const adapter of adapters) {
    if (adapter.alias === null) continue;
    if (!byAlias.has(adapter.alias)) byAlias.set(adapter.alias, []);
    byAlias.get(adapter.alias).push(adapter);
  }
  for (const [alias, group] of [...byAlias.entries()].sort()) {
    if (group.length > 1) {
      violations.push({
        code: 'C-8',
        file: group[0].file,
        line: 1,
        message: `generated import alias clash: alias '${alias}' is produced by ${group.length} adapters: ${group.map((a) => a.file).join(', ')}`,
      });
    }
  }

  // C-3/C-4 in adapter mode: rank order must follow the convention,
  // and health must hold the smallest rank.
  if (adapters.length > 0) {
    const ranked = adapters
      .filter((adapter) => adapter.order !== null && adapter.id !== null)
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const health = ranked.find((adapter) => adapter.id === 'health');
    if (health !== undefined && ranked.length > 0 && ranked[0].id !== 'health') {
      violations.push({
        code: 'C-3',
        file: health.file,
        line: 1,
        message: `health is not first: adapter '${ranked[0].file}' holds the smallest rank (${ranked[0].order}) while health holds rank ${health.order}`,
      });
    }
    if (health === undefined) {
      notTested.push({ control: 'C-3', reason: 'no health adapter is present, so health-first cannot be checked in adapter mode' });
    }
    checkConventionOrder(
      ranked.map((adapter) => ({ group: adapter.id, label: `${adapter.id} (rank ${adapter.order})`, line: 1 })),
      'adapter',
      violations,
      ranked.length > 0 ? ranked[0].file : relApp,
    );
    notes.push(`adapter rank order: ${ranked.map((a) => `${a.order} ${a.id}`).join(', ') || '(none resolvable)'}`);
  } else {
    notTested.push({ control: 'C-1', reason: 'no *.registration.ts adapter file exists yet' });
    notTested.push({ control: 'C-2', reason: 'no *.registration.ts adapter file exists yet' });
    notTested.push({ control: 'C-8', reason: 'no *.registration.ts adapter file exists yet' });
  }

  // -- Route files: duplicates (C-5), handlers and resolution (C-6).
  const allRoutes = [];
  const exportedRegistrars = new Set();
  const skippedFiles = [];
  for (const name of routeFiles) {
    const absPath = join(routesDir, name);
    const ctx = files.get(absPath);
    const parsed = parseRouteFile(ctx, files);
    const rel = files.rel(absPath);
    if (parsed.skipped) {
      skippedFiles.push(rel);
      continue;
    }
    exportedRegistrars.add(parsed.registrar);
    for (const route of parsed.routes) {
      allRoutes.push({ ...route, file: rel });
    }
    for (const item of parsed.unresolved) {
      violations.push({ code: 'C-6', file: rel, line: item.line, message: `unresolved route declaration: ${item.reason}` });
    }
  }

  const byMethodPath = new Map();
  for (const route of allRoutes) {
    const key = `${route.method} ${route.path}`;
    if (!byMethodPath.has(key)) byMethodPath.set(key, []);
    byMethodPath.get(key).push(route);
    if (!route.hasHandler) {
      violations.push({
        code: 'C-6',
        file: route.file,
        line: route.line,
        message: `route ${key} (registrar ${route.registrar}) has no handler argument`,
      });
    }
  }
  for (const [key, group] of [...byMethodPath.entries()].sort()) {
    if (group.length > 1) {
      const locations = group.map((route) => `${route.file}:${route.line}`).join(', ');
      violations.push({
        code: 'C-5',
        file: group[0].file,
        line: group[0].line,
        message: `duplicate route ${key} registered ${group.length} times: ${locations}`,
      });
    }
  }

  // -- app.ts mode: registrar call order (C-3/C-4) and coverage (C-7).
  const appCalls = findRegistrarCalls(appCtx);
  const indexCall = findGeneratedIndexCall(appCtx);
  if (appCalls.length === 0 && indexCall === null) {
    violations.push({
      code: 'C-4',
      file: relApp,
      line: 1,
      message: 'app.ts calls no register*Routes function and no registerRouteGroups: no route group is registered',
    });
  }
  if (appCalls.length > 0) {
    const healthCall = appCalls.find((call) => call.registrar === 'registerHealthRoutes');
    if (healthCall !== undefined && appCalls[0].registrar !== 'registerHealthRoutes') {
      violations.push({
        code: 'C-3',
        file: relApp,
        line: healthCall.line,
        message: `health is not first: the first registrar call in app.ts is ${appCalls[0].registrar} (line ${appCalls[0].line}) while registerHealthRoutes is called at line ${healthCall.line}`,
      });
    }
    if (healthCall === undefined) {
      notTested.push({ control: 'C-3', reason: 'registerHealthRoutes is not called in app.ts, so health-first cannot be checked in app.ts mode' });
    }
    const sequence = [];
    for (const call of appCalls) {
      const group = REGISTRAR_TO_GROUP.get(call.registrar);
      sequence.push({ group: group ?? `?${call.registrar}`, label: call.registrar, line: call.line });
    }
    checkConventionOrder(sequence, 'registrar', violations, relApp);
    notes.push(`app.ts registrar order: ${appCalls.map((c) => c.registrar).join(', ')}`);
  } else if (indexCall !== null) {
    notes.push('app.ts delegates to registerRouteGroups (migrated shape); registrar order is checked in adapter mode');
  }

  // C-7: coverage. Only meaningful once adapters exist.
  if (adapters.length > 0) {
    for (const call of appCalls) {
      violations.push({
        code: 'C-7',
        file: relApp,
        line: call.line,
        message: `registrar ${call.registrar} is called directly from app.ts while adapters exist: registered groups must be reached through their adapter and the generated index`,
      });
    }
    for (const adapter of adapters) {
      for (const registrar of new Set(adapter.registrarCalls)) {
        if (!exportedRegistrars.has(registrar)) {
          violations.push({
            code: 'C-7',
            file: adapter.file,
            line: 1,
            message: `adapter '${adapter.file}' calls registrar ${registrar}, which is not exported by any route file`,
          });
        }
      }
    }
  } else {
    notTested.push({ control: 'C-7', reason: 'no *.registration.ts adapter file exists yet, so adapter coverage cannot be checked' });
  }

  // Generated index order (C-4): call order must equal rank order.
  if (existsSync(generatedPath)) {
    const genCtx = files.get(generatedPath);
    const relGen = files.rel(generatedPath);
    const parsed = parseGeneratedIndex(genCtx);
    const rankedIds = adapters
      .filter((adapter) => adapter.order !== null && adapter.id !== null)
      .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((adapter) => adapter.id);
    const calledIds = [];
    for (const call of parsed.callOrder) {
      const id = parsed.aliasToId.get(call.alias);
      if (id === undefined) {
        violations.push({ code: 'C-4', file: relGen, line: call.line, message: `generated index calls alias '${call.alias}' with no matching adapter import` });
        continue;
      }
      if (id === null) {
        violations.push({ code: 'C-4', file: relGen, line: call.line, message: `generated index import for alias '${call.alias}' does not name a *.registration module` });
        continue;
      }
      calledIds.push(id);
    }
    if (calledIds.join(',') !== rankedIds.join(',')) {
      violations.push({
        code: 'C-4',
        file: relGen,
        line: 1,
        message: `generated index call order (${calledIds.join(', ') || '(none)'}) does not match adapter rank order (${rankedIds.join(', ') || '(none)'})`,
      });
    }
    const seen = new Set();
    for (const id of calledIds) {
      if (seen.has(id)) {
        violations.push({ code: 'C-4', file: relGen, line: 1, message: `generated index calls adapter '${id}' more than once` });
      }
      seen.add(id);
    }
  } else if (adapters.length > 0) {
    notTested.push({ control: 'C-4-index', reason: 'routes-generated.ts does not exist yet, so generated-index order cannot be checked' });
  }

  violations.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));

  const counts = {
    adapters: adapters.length,
    routeFiles: routeFiles.length - skippedFiles.length,
    skippedRouteFiles: skippedFiles.length,
    routes: allRoutes.length,
    registrarCallsInAppTs: appCalls.length,
    violations: violations.length,
  };
  const ok = violations.length === 0;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok, root, counts, violations, notTested, notes, skippedFiles }, null, 2)}\n`,
    );
    return ok ? 0 : 1;
  }

  const lines = [];
  lines.push(`check-registration-order: ${root}`);
  lines.push(`adapters: ${counts.adapters}, route files: ${counts.routeFiles}, routes: ${counts.routes}, registrar calls in app.ts: ${counts.registrarCallsInAppTs}`);
  for (const note of notes) lines.push(`note: ${note}`);
  if (skippedFiles.length > 0) lines.push(`note: skipped files without a register*Routes export: ${skippedFiles.join(', ')}`);
  for (const violation of violations) {
    lines.push(`VIOLATION [${violation.code}] ${violation.file}:${violation.line}: ${violation.message}`);
  }
  for (const item of notTested) {
    lines.push(`NOT TESTED: ${item.control}: ${item.reason}`);
  }
  lines.push(ok ? 'PASS: no violations in the applicable checks' : `FAIL: ${violations.length} violation(s)`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (!ok) process.stderr.write(`check-registration-order: FAIL: ${violations.length} violation(s)\n`);
  return ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
