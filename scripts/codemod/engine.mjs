// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Codemod engine core (V3-16a).
 *
 * AST-based, import-only transformation of Tauri module imports to the
 * platform registry. The engine edits import declarations and nothing
 * else: no call sites, no string literals, no comments, no other
 * statements. Every run ends with a self-check that proves the
 * non-import text is byte-identical before and after the transform; a
 * failed self-check discards the edits and reports an error.
 *
 * The engine never writes files itself. Callers (run.mjs) decide whether
 * to apply the returned newText (only with an explicit --write flag).
 *
 * Dynamic import() expressions are reported, never edited, unless the
 * caller opts in with rewriteDynamicImports. Even then, only the
 * specifier literal of a fully barrel-mappable destructure is rewritten,
 * and Promise.all batches are never partially rewritten.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { lookupMapping, PLATFORM_BARREL } from "./mappings.mjs";

const require = createRequire(import.meta.url);
let tsMorph;
try {
  tsMorph = require("ts-morph");
} catch {
  process.stderr.write(
    "codemod engine: error: the 'ts-morph' package is required. Install dev dependencies with 'pnpm install' (ts-morph is a devDependency; see scripts/codemod/README.md).\n",
  );
  process.exit(1);
}
const { Project, SyntaxKind, Node } = tsMorph;

const MAX_REPORTED_REFERENCES = 200;
const INTERNALS_MARKER = "__TAURI_INTERNALS__";

/** Extensions the engine parses. Anything else is skipped, never guessed. */
export const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** Kind names that mark a type position when walking up from an identifier. */
const TYPE_POSITION_EXTRA = new Set([
  "TypeReference",
  "ImportType",
  "QualifiedName",
  "ExpressionWithTypeArguments",
  "HeritageClause",
  "TypeAliasDeclaration",
  "InterfaceDeclaration",
  "TypeParameterDeclaration",
  "TypeOperator",
  "TypePredicate",
  "TypeQuery",
  "TypeLiteral",
  "NamedTupleMember",
]);

/** Kind names that mark a value position when walking up from an identifier. */
const VALUE_POSITION_KINDS = new Set([
  "CallExpression",
  "NewExpression",
  "PropertyAccessExpression",
  "ElementAccessExpression",
  "TaggedTemplateExpression",
  "Decorator",
  "JsxOpeningElement",
  "JsxSelfClosingElement",
  "JsxOpeningFragment",
]);

function isBarrelSpecifier(specifier) {
  return (
    specifier === PLATFORM_BARREL ||
    /(^|\/)lib\/platform(\/index)?$/.test(specifier)
  );
}

function declarationHasSemicolon(declaration) {
  return declaration.getText().trimEnd().endsWith(";");
}

function specifierQuote(declaration) {
  const text = declaration.getModuleSpecifier().getText();
  return text.startsWith('"') ? '"' : "'";
}

/** Span covering a whole import declaration line when the rest is blank. */
function removalSpan(text, declaration) {
  const start = declaration.getStart();
  let end = declaration.getEnd();
  let i = end;
  while (i < text.length && text[i] !== "\n" && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) {
    i += 1;
  }
  if (text[i] === "\n") end = i + 1;
  else if (i === text.length) end = i;
  return { start, end };
}

function applyEdits(text, edits) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = text;
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function lineStartsOf(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineTextAt(text, starts, lineNumber) {
  const start = starts[lineNumber - 1] ?? 0;
  let end = text.indexOf("\n", start);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

/**
 * Decide whether an identifier reference sits in a type position by
 * walking up the ancestor chain to the first decisive node kind.
 * Conservative: an undecided walk counts as a value position.
 */
function isTypePositionReference(identifierNode) {
  let current = identifierNode.getParent();
  while (current !== undefined && !Node.isSourceFile(current)) {
    const kindName = current.getKindName();
    if (kindName === "ExpressionWithTypeArguments") {
      const parent = current.getParent();
      if (parent !== undefined && Node.isHeritageClause(parent)) {
        const token = parent.compilerNode.token;
        const grandparent = parent.getParent();
        const isClassHeritage =
          token === SyntaxKind.ExtendsKeyword &&
          grandparent !== undefined &&
          (Node.isClassDeclaration(grandparent) || Node.isClassExpression(grandparent));
        return !isClassHeritage;
      }
      return true;
    }
    if (kindName.endsWith("Type") || TYPE_POSITION_EXTRA.has(kindName)) return true;
    if (VALUE_POSITION_KINDS.has(kindName)) return false;
    current = current.getParent();
  }
  return false;
}

/**
 * References of an imported binding, excluding the import declaration
 * itself. Returns { references, total } with references capped for the
 * report and total counting every use site.
 */
function collectReferences(nameNode, sourceFile, text, starts) {
  const nodes = nameNode.findReferencesAsNodes();
  const references = [];
  let total = 0;
  for (const node of nodes) {
    if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined) continue;
    total += 1;
    if (references.length >= MAX_REPORTED_REFERENCES) continue;
    const pos = node.getStart();
    const line = node.getStartLineNumber();
    const lineStart = starts[line - 1] ?? 0;
    references.push({
      line,
      column: pos - lineStart + 1,
      snippet: lineTextAt(text, starts, line).trim().slice(0, 160),
    });
  }
  return { references, total };
}

function allReferencesAreTypes(nameNode) {
  const nodes = nameNode.findReferencesAsNodes();
  for (const node of nodes) {
    if (node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined) continue;
    if (!isTypePositionReference(node)) return false;
  }
  return true;
}

function newProject() {
  return new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true, strict: false },
  });
}

/**
 * Prove that only import declarations (and, under the opt-in dynamic
 * rewrite, dynamic import specifier literals) differ between two texts:
 * strip every import declaration (plus its blank remainder line) and
 * normalize every dynamic import() specifier literal on both sides,
 * then compare what remains, ignoring blank lines. Any other change
 * inside a dynamic import still fails the check.
 */
function verifyImportOnly(oldText, newText, extension) {
  const project = newProject();
  const strip = (label, content) => {
    const sf = project.createSourceFile(label, content, { overwrite: true });
    const edits = sf
      .getImportDeclarations()
      .map((decl) => ({ ...removalSpan(content, decl), text: "" }));
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
      const args = call.getArguments();
      if (args.length > 0 && Node.isStringLiteral(args[0])) {
        edits.push({ start: args[0].getStart(), end: args[0].getEnd(), text: '""' });
      }
    }
    let stripped = content;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      stripped = stripped.slice(0, edit.start) + edit.text + stripped.slice(edit.end);
    }
    project.removeSourceFile(sf);
    return stripped
      .split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n");
  };
  const before = strip(`__check_old__${extension}`, oldText);
  const after = strip(`__check_new__${extension}`, newText);
  return before === after;
}

function nearestStatementLine(node, text, starts) {
  let current = node;
  let parent = current.getParent();
  while (
    parent !== undefined &&
    !Node.isSourceFile(parent) &&
    !Node.isBlock(parent) &&
    !Node.isModuleBlock(parent) &&
    !Node.isCaseBlock(parent) &&
    parent.getKindName() !== "SyntaxList"
  ) {
    current = parent;
    parent = current.getParent();
  }
  const line = current.getStartLineNumber();
  return { line, snippet: lineTextAt(text, starts, line).trim().slice(0, 160) };
}

function isInsidePromiseAll(callExpression) {
  let current = callExpression.getParent();
  while (current !== undefined && !Node.isSourceFile(current)) {
    if (Node.isArrayLiteralExpression(current)) {
      const parent = current.getParent();
      if (
        parent !== undefined &&
        Node.isCallExpression(parent) &&
        parent.getExpression().getText() === "Promise.all"
      ) {
        return true;
      }
    }
    current = current.getParent();
  }
  return false;
}

/**
 * Transform one source text. Options:
 * - specifiers: Set of module specifiers in scope for this run.
 * - wave: wave label (G1..G5) or null in --specifier mode. In wave mode
 *   a binding whose mapping wave differs is deferred (kept); in
 *   --specifier mode every mapped binding transforms.
 * - rewriteDynamicImports: opt-in dynamic import() specifier rewrites.
 */
export function transformSource({ text, relPath, extension, specifiers, wave, rewriteDynamicImports }) {
  const result = {
    path: relPath,
    status: "unchanged",
    declarationsTransformed: 0,
    declarationsSkipped: [],
    declarationsDeferred: [],
    bindings: [],
    dynamicImports: [],
    notes: [],
    changed: false,
    newText: null,
  };

  const project = newProject();
  const sourceFile = project.createSourceFile(relPath, text, { overwrite: true });
  const starts = lineStartsOf(text);
  const edits = [];

  // Snapshot: existing barrel imports and any binding named `platform`.
  let platformSpecifierInUse = null;
  let platformAlreadyImported = false;
  let platformNameTaken = false;
  let barrelValueDecl = null;
  let barrelTypeDecl = null;
  const barrelLocalNames = new Map();
  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    const isBarrel = isBarrelSpecifier(spec);
    for (const named of decl.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      if (isBarrel) {
        barrelLocalNames.set(localName, named.getName());
        if (localName === "platform") platformAlreadyImported = true;
      } else if (localName === "platform") {
        platformNameTaken = true;
      }
    }
    if (decl.getDefaultImport()?.getText() === "platform" && !isBarrel) platformNameTaken = true;
    if (decl.getNamespaceImport()?.getText() === "platform") platformNameTaken = true;
    if (isBarrel) {
      platformSpecifierInUse = spec;
      if (decl.isTypeOnly() && barrelTypeDecl === null) barrelTypeDecl = decl;
      if (!decl.isTypeOnly() && barrelValueDecl === null) barrelValueDecl = decl;
    }
  }
  for (const statement of sourceFile.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      for (const decl of statement.getDeclarationList().getDeclarations()) {
        if (decl.getName() === "platform") platformNameTaken = true;
      }
    }
    if (
      (Node.isFunctionDeclaration(statement) ||
        Node.isClassDeclaration(statement) ||
        Node.isEnumDeclaration(statement) ||
        Node.isInterfaceDeclaration(statement) ||
        Node.isTypeAliasDeclaration(statement)) &&
      statement.getName?.() === "platform"
    ) {
      platformNameTaken = true;
    }
  }

  const barrelSpecifier = platformSpecifierInUse ?? PLATFORM_BARREL;
  const needPlatform = { value: false };
  const barrelValueNames = new Map();
  const barrelTypeNames = new Map();
  let firstEditedStart = null;
  let firstQuote = "'";
  let firstSemicolon = false;
  let sawFirstStyle = false;

  const noteStyle = (decl) => {
    if (sawFirstStyle) return;
    sawFirstStyle = true;
    firstQuote = specifierQuote(decl);
    firstSemicolon = declarationHasSemicolon(decl);
  };

  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!specifiers.has(spec)) continue;
    const line = decl.getStartLineNumber();
    const named = decl.getNamedImports();
    const defaultImport = decl.getDefaultImport();
    const namespaceImport = decl.getNamespaceImport();

    if (namespaceImport !== undefined) {
      result.declarationsSkipped.push({
        line,
        specifier: spec,
        reason: "namespace-import",
        names: [namespaceImport.getText()],
        detail: "Namespace imports are never rewritten; migrate the call sites manually.",
      });
      continue;
    }
    if (named.length === 0 && defaultImport === undefined) {
      result.declarationsSkipped.push({
        line,
        specifier: spec,
        reason: "side-effect-import",
        names: [],
        detail: "Side-effect imports are never rewritten.",
      });
      continue;
    }

    const kept = [];
    const removedBindings = [];
    const plannedBarrelValue = [];
    const plannedBarrelType = [];
    let skipReason = null;
    let skipDetail = null;
    let needsPlatform = false;

    const planNamed = (importedName, localName, nameNode, specText) => {
      const mapping = lookupMapping(spec, importedName);
      if (mapping === null) {
        skipReason = "unknown-import-name";
        skipDetail = `No mapping entry for '${importedName}' from '${spec}'.`;
        return false;
      }
      if (wave !== null && mapping.wave !== wave) {
        kept.push(specText);
        return true;
      }
      if (mapping.action === "none") {
        skipReason = "no-barrel-equivalent";
        skipDetail = mapping.note ?? `No replacement for '${importedName}' from '${spec}'.`;
        return false;
      }
      if (mapping.action === "barrel") {
        if (mapping.barrelKind === "type" && !allReferencesAreTypes(nameNode)) {
          skipReason = "barrel-type-used-as-value";
          skipDetail = `'${importedName}' is a type-only barrel export but is used in a value position.`;
          return false;
        }
        const existing = barrelLocalNames.get(localName);
        if (existing !== undefined && existing !== importedName) {
          skipReason = "barrel-name-taken";
          skipDetail = `Local name '${localName}' is already bound from the barrel to '${existing}'.`;
          return false;
        }
        if (existing === undefined) {
          if (mapping.barrelKind === "value") plannedBarrelValue.push({ importedName, localName });
          else plannedBarrelType.push({ importedName, localName });
        }
        removedBindings.push({
          localName,
          importedName,
          specifier: spec,
          action: "barrel",
          barrelKind: mapping.barrelKind,
          nameNode,
        });
        return true;
      }
      if (localName === "platform") {
        skipReason = "name-collision-platform";
        skipDetail =
          "Removed binding is named 'platform' and would silently rebind to the registry import. Migrate manually with a per-call-site audit.";
        return false;
      }
      needsPlatform = true;
      removedBindings.push({
        localName,
        importedName,
        specifier: spec,
        action: "platform",
        adapter: mapping.adapter,
        replacement: mapping.replacement,
        note: mapping.note,
        nameNode,
      });
      return true;
    };

    let planned = true;
    if (defaultImport !== undefined) {
      const localName = defaultImport.getText();
      const mapping = lookupMapping(spec, "default");
      if (mapping === null) {
        skipReason = "unknown-default-import";
        skipDetail = `No mapping entry for the default import from '${spec}'.`;
        planned = false;
      } else if (wave !== null && mapping.wave !== wave) {
        kept.push(localName);
      } else if (mapping.action === "none") {
        skipReason = "no-barrel-equivalent";
        skipDetail = mapping.note ?? "No replacement for the default import.";
        planned = false;
      } else if (mapping.action === "barrel") {
        skipReason = "default-import-barrel";
        skipDetail = "Default imports are never rewritten to barrel bindings.";
        planned = false;
      } else {
        if (localName === "platform") {
          skipReason = "name-collision-platform";
          skipDetail = "Removed default binding is named 'platform'. Migrate manually.";
          planned = false;
        } else {
          needsPlatform = true;
          removedBindings.push({
            localName,
            importedName: "default",
            specifier: spec,
            action: "platform",
            adapter: mapping.adapter,
            replacement: mapping.replacement,
            note: mapping.note,
            nameNode: defaultImport,
          });
        }
      }
    }
    if (planned) {
      for (const specifier of named) {
        const importedName = specifier.getName();
        const localName = specifier.getAliasNode()?.getText() ?? importedName;
        const ok = planNamed(importedName, localName, specifier.getNameNode(), specifier.getText().trim());
        if (!ok) {
          planned = false;
          break;
        }
      }
    }
    if (planned && needsPlatform && platformNameTaken && !platformAlreadyImported) {
      skipReason = "platform-name-taken";
      skipDetail = "The name 'platform' is already bound in this file to something other than the registry import.";
      planned = false;
    }

    if (!planned) {
      result.declarationsSkipped.push({
        line,
        specifier: spec,
        reason: skipReason,
        names: named.map((s) => s.getName()),
        detail: skipDetail,
      });
      continue;
    }

    if (removedBindings.length === 0) {
      result.declarationsDeferred.push({ line, specifier: spec, names: kept });
      continue;
    }

    noteStyle(decl);
    if (firstEditedStart === null || decl.getStart() < firstEditedStart) {
      firstEditedStart = decl.getStart();
    }
    if (needsPlatform) needPlatform.value = true;
    for (const entry of plannedBarrelValue) barrelValueNames.set(entry.localName, entry);
    for (const entry of plannedBarrelType) barrelTypeNames.set(entry.localName, entry);

    for (const binding of removedBindings) {
      const { references, total } = collectReferences(binding.nameNode, sourceFile, text, starts);
      result.bindings.push({
        localName: binding.localName,
        importedName: binding.importedName,
        specifier: binding.specifier,
        action: binding.action,
        ...(binding.adapter ? { adapter: binding.adapter } : {}),
        ...(binding.replacement ? { replacement: binding.replacement } : {}),
        ...(binding.barrelKind ? { barrelKind: binding.barrelKind } : {}),
        ...(binding.note ? { note: binding.note } : {}),
        references,
        totalReferences: total,
        referencesTruncated: total > references.length,
      });
    }

    if (kept.length > 0) {
      const typeKeyword = decl.isTypeOnly() ? "type " : "";
      const semi = declarationHasSemicolon(decl) ? ";" : "";
      const quote = specifierQuote(decl);
      edits.push({
        start: decl.getStart(),
        end: decl.getEnd(),
        text: `import ${typeKeyword}{ ${kept.join(", ")} } from ${quote}${spec}${quote}${semi}`,
      });
    } else {
      const span = removalSpan(text, decl);
      edits.push({ start: span.start, end: span.end, text: "" });
    }
    result.declarationsTransformed += 1;
  }

  // Re-exports of a target specifier are reported, never edited.
  for (const decl of sourceFile.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec !== undefined && specifiers.has(spec)) {
      result.notes.push({
        kind: "re-export-not-handled",
        line: decl.getStartLineNumber(),
        detail: `Re-export from '${spec}' is never rewritten by the engine.`,
      });
    }
  }

  // Dynamic import() expressions: report-only by default.
  const batchStatements = new Set();
  const dynamicCalls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword);
  for (const call of dynamicCalls) {
    const args = call.getArguments();
    if (args.length === 0) continue;
    const firstArg = args[0];
    if (!Node.isStringLiteral(firstArg)) {
      if (firstArg.getText().includes("@tauri-apps") || firstArg.getText().includes("tauri-plugin")) {
        result.dynamicImports.push({
          line: call.getStartLineNumber(),
          specifier: null,
          reason: "dynamic-specifier-non-literal",
          names: [],
          detail: "Dynamic import with a non-literal specifier; the grep gate owns this case.",
        });
      }
      continue;
    }
    const spec = firstArg.getLiteralValue();
    if (!specifiers.has(spec)) continue;
    const line = call.getStartLineNumber();

    if (isInsidePromiseAll(call)) {
      const statement = nearestStatementLine(call, text, starts);
      if (!batchStatements.has(statement.line)) {
        batchStatements.add(statement.line);
        result.dynamicImports.push({
          line: statement.line,
          specifier: spec,
          reason: "promise-all-batch",
          names: [],
          detail: `Promise.all batch at line ${statement.line} is handled as one unit by the wave worker; the engine never partially rewrites a batch. Snippet: ${statement.snippet}`,
        });
      }
      continue;
    }

    let container = call.getParent();
    if (container !== undefined && Node.isAwaitExpression(container)) container = container.getParent();
    let destructured = null;
    let namespaceBound = false;
    if (container !== undefined && Node.isVariableDeclaration(container)) {
      const nameNode = container.getNameNode();
      if (Node.isObjectBindingPattern(nameNode)) {
        destructured = nameNode.getElements().map((el) => ({
          propertyName: el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText(),
          localName: el.getNameNode().getText(),
          nameNode: el.getNameNode(),
        }));
      } else if (Node.isIdentifier(nameNode)) {
        namespaceBound = true;
      }
    }
    if (namespaceBound) {
      result.dynamicImports.push({
        line,
        specifier: spec,
        reason: "dynamic-namespace-access",
        names: [],
        detail: "Dynamic import bound to a namespace identifier; migrate manually.",
      });
      continue;
    }
    if (destructured === null) {
      const parentText = call.getParent()?.getText() ?? "";
      result.dynamicImports.push({
        line,
        specifier: spec,
        reason: parentText.includes(".then(") ? "dynamic-then-access" : "dynamic-import-unclassified",
        names: [],
        detail: "Dynamic import without an object destructure; migrate manually.",
      });
      continue;
    }
    const names = destructured.map((d) => d.propertyName);
    const entries = destructured.map((d) => lookupMapping(spec, d.propertyName));
    const allBarrelValue =
      entries.every((entry) => entry !== null && entry.action === "barrel" && entry.barrelKind === "value") &&
      (wave === null || entries.every((entry) => entry.wave === wave));
    if (rewriteDynamicImports && allBarrelValue) {
      const quote = firstArg.getText()[0];
      edits.push({
        start: firstArg.getStart(),
        end: firstArg.getEnd(),
        text: `${quote}${barrelSpecifier}${quote}`,
      });
      result.declarationsTransformed += 1;
      result.dynamicImports.push({
        line,
        specifier: spec,
        reason: "rewritten",
        names,
        detail: `Specifier rewritten to '${barrelSpecifier}' (opt-in dynamic rewrite; all destructured names are barrel values).`,
      });
    } else {
      const reason = entries.some((entry) => entry === null)
        ? "dynamic-unknown-name"
        : "dynamic-import-needs-manual";
      result.dynamicImports.push({
        line,
        specifier: spec,
        reason,
        names,
        detail:
          "Dynamic import reported only; the wave worker migrates it. Enable --rewrite-dynamic-imports only for all-barrel-value destructures.",
      });
    }
  }

  // Tauri internals marker mentions (identifier and string forms):
  // report-only, never edited.
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (identifier.getText() !== INTERNALS_MARKER) continue;
    if (identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined) continue;
    result.notes.push({
      kind: "tauri-internals-marker",
      line: identifier.getStartLineNumber(),
      detail: "File mentions __TAURI_INTERNALS__; detection moves to detect.ts manually, not via import rewrite.",
    });
  }
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    if (!literal.getLiteralValue().includes(INTERNALS_MARKER)) continue;
    result.notes.push({
      kind: "tauri-internals-marker",
      line: literal.getStartLineNumber(),
      detail: "File mentions __TAURI_INTERNALS__ as a string; detection moves to detect.ts manually, not via import rewrite.",
    });
  }

  // Barrel / platform import: merge into an existing declaration when
  // possible, otherwise insert new declarations at the first edit site.
  const valueNamesToAdd = [];
  if (needPlatform.value && !platformAlreadyImported) {
    valueNamesToAdd.push({ importedName: "platform", localName: "platform" });
  }
  for (const entry of barrelValueNames.values()) {
    if (barrelLocalNames.has(entry.localName)) continue;
    valueNamesToAdd.push(entry);
  }
  const typeNamesToAdd = [...barrelTypeNames.values()].filter(
    (entry) => !barrelLocalNames.has(entry.localName),
  );

  const formatBinding = (entry) =>
    entry.localName === entry.importedName
      ? entry.importedName
      : `${entry.importedName} as ${entry.localName}`;

  const mergeInto = (decl, entries, asType) => {
    const namedImports = decl.getNamedImports();
    if (namedImports.length === 0 || decl.getNamespaceImport() !== undefined) return false;
    const last = namedImports[namedImports.length - 1];
    const rendered = entries.map((entry) =>
      asType && !decl.isTypeOnly() ? `type ${formatBinding(entry)}` : formatBinding(entry),
    );
    edits.push({ start: last.getEnd(), end: last.getEnd(), text: `, ${rendered.join(", ")}` });
    return true;
  };

  let insertedValueDecl = false;
  let insertedTypeDecl = false;
  if (valueNamesToAdd.length > 0) {
    if (barrelValueDecl !== null) {
      insertedValueDecl = mergeInto(barrelValueDecl, valueNamesToAdd, false);
    }
    if (!insertedValueDecl && firstEditedStart !== null) {
      const semi = firstSemicolon ? ";" : "";
      edits.push({
        start: firstEditedStart,
        end: firstEditedStart,
        text: `import { ${valueNamesToAdd.map(formatBinding).join(", ")} } from ${firstQuote}${barrelSpecifier}${firstQuote}${semi}\n`,
      });
      insertedValueDecl = true;
    }
  }
  if (typeNamesToAdd.length > 0) {
    let merged = false;
    if (barrelTypeDecl !== null) merged = mergeInto(barrelTypeDecl, typeNamesToAdd, true);
    if (!merged && barrelValueDecl !== null && valueNamesToAdd.length === 0) {
      merged = mergeInto(barrelValueDecl, typeNamesToAdd, true);
    }
    if (!merged && firstEditedStart !== null) {
      const semi = firstSemicolon ? ";" : "";
      edits.push({
        start: firstEditedStart,
        end: firstEditedStart,
        text: `import type { ${typeNamesToAdd.map(formatBinding).join(", ")} } from ${firstQuote}${barrelSpecifier}${firstQuote}${semi}\n`,
      });
      insertedTypeDecl = true;
    }
  }
  void insertedTypeDecl;

  if (edits.length === 0) {
    if (
      result.declarationsSkipped.length > 0 ||
      result.dynamicImports.some((entry) => entry.reason !== "rewritten")
    ) {
      result.status = "skipped";
    } else {
      result.status = "unchanged";
    }
    return result;
  }

  const newText = applyEdits(text, edits);
  if (!verifyImportOnly(text, newText, extension)) {
    result.status = "error";
    result.error = "Import-only self-check failed: non-import text differs after transform. Edits discarded.";
    result.newText = null;
    result.changed = false;
    return result;
  }

  result.status = "transformed";
  result.changed = true;
  result.newText = newText;
  return result;
}

/** Read a file and transform it. Returns the per-file result object. */
export function transformFile({ absPath, relPath, specifiers, wave, rewriteDynamicImports }) {
  const extension = relPath.slice(relPath.lastIndexOf("."));
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return {
      path: relPath,
      status: "skipped",
      declarationsTransformed: 0,
      declarationsSkipped: [],
      declarationsDeferred: [],
      bindings: [],
      dynamicImports: [],
      notes: [{ kind: "unsupported-extension", detail: `Extension '${extension}' is not parsed by the engine.` }],
      changed: false,
      newText: null,
    };
  }
  try {
    const text = readFileSync(absPath, "utf8");
    return transformSource({ text, relPath, extension, specifiers, wave, rewriteDynamicImports });
  } catch (error) {
    return {
      path: relPath,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      declarationsTransformed: 0,
      declarationsSkipped: [],
      declarationsDeferred: [],
      bindings: [],
      dynamicImports: [],
      notes: [],
      changed: false,
      newText: null,
    };
  }
}
