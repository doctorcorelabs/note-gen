// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Guard for finding C1 in the G2 codemod review (fase1/laporan-3c-rev2b.md,
// section 4, note C1): local bindings named `platform` in
// src/lib/sync/auto-sync.ts and src/stores/sync-platform-switch.ts shadowed
// the platform registry barrel imported as `platform`. The shadowing was
// correct but fragile: a future barrel call added inside a shadowing
// function would bind the local value instead of the registry. The fix
// renamed every shadowing local; this suite pins the fixed state with a
// static AST scan, so the fragility cannot return silently.
//
// Runner: Vitest, unit project (vitest run --project unit). The suite
// reads source files and parses them; it imports no application code.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const AUDITED_FILES = [
  "src/lib/sync/auto-sync.ts",
  "src/stores/sync-platform-switch.ts",
];

type PlatformBinding = {
  kind: string;
  line: number;
  moduleSpecifier?: string;
};

function collectBindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, out);
    }
  }
}

function platformBindings(sourcePath: string): PlatformBinding[] {
  const text = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    sourcePath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: PlatformBinding[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  let importSpecifier: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const previous = importSpecifier;
      importSpecifier = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
      if (
        node.importClause?.name?.text === "platform"
      ) {
        found.push({
          kind: "import",
          line: lineOf(node.importClause.name),
          moduleSpecifier: importSpecifier,
        });
      }
      ts.forEachChild(node, visit);
      importSpecifier = previous;
      return;
    }
    if (ts.isImportSpecifier(node) && node.name.text === "platform") {
      found.push({
        kind: "import",
        line: lineOf(node),
        moduleSpecifier: importSpecifier,
      });
    }
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      const names: string[] = [];
      collectBindingNames(node.name, names);
      if (names.includes("platform")) {
        found.push({
          kind: ts.isVariableDeclaration(node) ? "variable" : "parameter",
          line: lineOf(node),
        });
      }
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name?.text === "platform"
    ) {
      found.push({ kind: "declaration", line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("platform barrel shadowing (C1 rev2b)", () => {
  it.each(AUDITED_FILES)(
    "has no local binding named platform in %s",
    (relativePath) => {
      const bindings = platformBindings(join(REPO_ROOT, relativePath));
      const shadowing = bindings.filter(
        (binding) => binding.kind !== "import",
      );
      expect(shadowing).toEqual([]);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.moduleSpecifier).toBe("@/lib/platform");
    },
  );
});
