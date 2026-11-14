#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Codemod engine CLI (V3-16a). Stable interface for the gate scripts
 * (V3-16b) and the fixtures/guide (V3-16c). See README.md in this
 * directory for the interface contract.
 *
 * Usage:
 *   node scripts/codemod/run.mjs --wave G1 --files <list-file>
 *   node scripts/codemod/run.mjs --specifier <specifier> <file...>
 *
 * Dry-run is the default: nothing is written without --write.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { transformFile } from "./engine.mjs";
import { unifiedDiff, summarize, printSummary } from "./report.mjs";
import { WAVE_SPECIFIERS, KNOWN_SPECIFIERS } from "./mappings.mjs";

export const REPORT_SCHEMA_VERSION = 1;

const USAGE = `codemod engine: AST-based, import-only Tauri import migration (G1-G5).

Usage:
  node scripts/codemod/run.mjs --wave <G1|G2|G3|G4|G5> --files <list-file> [options] [file...]
  node scripts/codemod/run.mjs --specifier <specifier> --files <list-file> [options] [file...]

Exactly one of --wave / --specifier is required. Files come from --files
(one relative path per line; '#' comments and blank lines ignored) and/or
positional arguments. Paths are relative to --root (default: cwd).

Options:
  --root <dir>              Repo root for relative paths (default: cwd).
  --write                   Apply transforms. Without it, dry-run only.
  --report <path>           Write the JSON report (schema version 1).
  --diff / --no-diff        Print unified diffs (default: print).
  --strict                  Exit 1 when any file is skipped (default: 0).
  --rewrite-dynamic-imports Opt-in: rewrite the specifier literal of a
                            dynamic import() only when every destructured
                            name is a barrel value export. Default: report
                            dynamic imports, never edit them.
  --help                    Print this usage and exit 0.

Exit codes: 0 = completed (skips allowed unless --strict); 1 = usage
error, any file error, or (with --strict) any skipped file.
`;

function fail(message) {
  process.stderr.write(`codemod engine: error: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    wave: null,
    specifier: null,
    filesList: null,
    root: process.cwd(),
    write: false,
    reportPath: null,
    diff: true,
    strict: false,
    rewriteDynamicImports: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = (flag) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
      i += 1;
      return value;
    };
    if (arg === "--wave") options.wave = takeValue(arg);
    else if (arg === "--specifier") options.specifier = takeValue(arg);
    else if (arg === "--files") options.filesList = takeValue(arg);
    else if (arg === "--root") options.root = takeValue(arg);
    else if (arg === "--write") options.write = true;
    else if (arg === "--report") options.reportPath = takeValue(arg);
    else if (arg === "--diff") options.diff = true;
    else if (arg === "--no-diff") options.diff = false;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--rewrite-dynamic-imports") options.rewriteDynamicImports = true;
    else if (arg === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg.startsWith("--")) fail(`unknown flag: ${arg}`);
    else options.positional.push(arg);
  }
  return options;
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if ((options.wave === null) === (options.specifier === null)) {
    fail("exactly one of --wave / --specifier is required");
  }
  let specifiers;
  if (options.wave !== null) {
    if (!Object.hasOwn(WAVE_SPECIFIERS, options.wave)) {
      fail(`unknown wave: ${options.wave} (expected G1, G2, G3, G4, or G5)`);
    }
    specifiers = WAVE_SPECIFIERS[options.wave];
  } else {
    if (!KNOWN_SPECIFIERS.includes(options.specifier)) {
      fail(`unknown specifier: ${options.specifier} (known: ${KNOWN_SPECIFIERS.join(", ")})`);
    }
    specifiers = [options.specifier];
  }

  const root = resolve(options.root);
  if (!existsSync(root)) fail(`root does not exist: ${root}`);

  const relPaths = new Set();
  if (options.filesList !== null) {
    const listPath = resolve(root, options.filesList);
    if (!existsSync(listPath)) fail(`files list does not exist: ${listPath}`);
    for (const rawLine of readFileSync(listPath, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      relPaths.add(line);
    }
  }
  for (const positional of options.positional) relPaths.add(positional);
  const ordered = [...relPaths].sort();
  if (ordered.length === 0) fail("no input files: pass --files and/or positional paths");

  const specifierSet = new Set(specifiers);
  const results = [];
  const diffs = [];
  for (const relPath of ordered) {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) {
      results.push({
        path: relPath,
        status: "error",
        error: `file does not exist: ${absPath}`,
        declarationsTransformed: 0,
        declarationsSkipped: [],
        declarationsDeferred: [],
        bindings: [],
        dynamicImports: [],
        notes: [],
        changed: false,
        newText: null,
      });
      continue;
    }
    const result = transformFile({
      absPath,
      relPath: toPosix(relPath),
      specifiers: specifierSet,
      wave: options.wave,
      rewriteDynamicImports: options.rewriteDynamicImports,
    });
    if (result.changed && result.newText !== null) {
      const oldText = readFileSync(absPath, "utf8");
      if (options.diff) {
        const diff = unifiedDiff(oldText, result.newText, toPosix(relPath));
        if (diff !== "") diffs.push(diff);
      }
      if (options.write) writeFileSync(absPath, result.newText, "utf8");
    }
    const { newText: _dropped, ...reportable } = result;
    void _dropped;
    results.push({ ...reportable, written: options.write && result.changed });
  }

  for (const diff of diffs) process.stdout.write(diff);
  const totals = summarize(results);
  const mode = options.write ? "write" : "dry-run";
  process.stdout.write(printSummary(results, totals, mode));

  if (options.reportPath !== null) {
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      tool: "codemod-engine",
      wave: options.wave,
      specifier: options.specifier,
      specifiers,
      root: toPosix(root),
      mode,
      strict: options.strict,
      rewriteDynamicImports: options.rewriteDynamicImports,
      generatedAt: new Date().toISOString(),
      totals,
      files: results,
    };
    writeFileSync(resolve(root, options.reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const hasErrors = totals.errors > 0;
  const hasSkips = totals.skipped > 0;
  process.exit(hasErrors || (options.strict && hasSkips) ? 1 : 0);
}

main();
