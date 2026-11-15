// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// api/core subset check for waves G2/G3.
//
// @tauri-apps/api/core closes at G2 except the convertFileSrc subset,
// which closes at G3 (V1-05 section 4.2), and the isTauri binding,
// which closes at G4 (AD-86 gate exception). The allowlist wave column
// marks all 75 api/core pairs G2, so the gate must not trust that
// column for this specifier. This script inspects the imported
// bindings of every @tauri-apps/api/core import outside
// src/lib/platform/ and fails when any import still brings in a
// binding that must already have closed, an unknown binding, or a
// namespace import that cannot be classified.
//
// In G2 mode (default) the allowed remainder is convertFileSrc and/or
// isTauri. A convertFileSrc-only file passes as OK. A file whose
// api/core bindings are only isTauri, or convertFileSrc plus isTauri,
// passes as DEFERRED-G4: the isTauri remainder is allowed only until
// G4, when layer 1 requires 0 api/core lines including isTauri. The
// exception is narrow (only isTauri), bounded (only G2/G3 gate
// modes), and self-expiring (no DEFERRED-G4 verdict exists at G4).
// In G3 mode (--wave G3) only isTauri may remain: convertFileSrc and
// the G2 bindings fail, because both waves have closed.
//
// A file passes only when every one of its api/core imports is
// within the allowed remainder for the selected wave (static or
// dynamic). Files that only mention convertFileSrc or isTauri in
// comments, or import through a local funnel such as src/lib/utils.ts,
// do not import api/core and are not listed.
//
// Usage: node scripts/gates/check-api-core-subset.mjs [--root <dir>] [--wave G2|G3]
// Exit 0 when the remainder is within the allowed set, 1 otherwise.

import fs from "node:fs";
import path from "node:path";

const G2_BINDINGS = new Set(["invoke", "Channel", "transformCallback"]);
const G3_BINDINGS = new Set(["convertFileSrc"]);
const G4_BINDINGS = new Set(["isTauri"]);
const SPEC = "@tauri-apps/api/core";

function parseArgs(argv) {
  const out = { root: process.cwd(), wave: "G2" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      out.root = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--wave") {
      out.wave = argv[i + 1];
      i += 1;
      if (out.wave !== "G2" && out.wave !== "G3") {
        console.error(`check-api-core-subset: unknown wave: ${out.wave} (expected G2 or G3)`);
        process.exit(2);
      }
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/gates/check-api-core-subset.mjs [--root <dir>] [--wave G2|G3]");
      process.exit(0);
    } else {
      console.error(`check-api-core-subset: unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return out;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") continue;
      walk(full, out);
    } else if (entry.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

function stripStrings(line) {
  return line.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

// Collect import statements (static and dynamic) that reference SPEC.
// Returns an array of { start, end, text } line ranges (0-based).
function findApiCoreStatements(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*import\s+[^=(]/.test(line) || /^\s*import\s*\(/.test(line) || /^\s*import\s+type\s/.test(line)) {
      let depth = 0;
      let end = i;
      let text = "";
      for (let j = i; j < Math.min(lines.length, i + 40); j += 1) {
        text += `${lines[j]}\n`;
        const clean = stripStrings(lines[j].replace(/\/\/.*$/, ""));
        for (const ch of clean) {
          if (ch === "(" || ch === "[" || ch === "{") depth += 1;
          if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
        }
        end = j;
        if (depth <= 0 && /;/.test(lines[j])) break;
        if (depth <= 0 && /from\s+['"]/.test(lines[j])) break;
      }
      if (text.includes(SPEC)) found.push({ start: i, end, text });
      i = end;
    } else if (line.includes("import(") && line.includes(SPEC)) {
      found.push({ start: i, end: i, text: `${line}\n` });
    } else if (line.includes("import(") && /['"]@tauri-apps\/api\/core['"]/.test(line)) {
      found.push({ start: i, end: i, text: `${line}\n` });
    }
  }
  return found;
}

// Also catch dynamic imports whose specifier sits on the same line but
// the statement does not start with import (await import, Promise.all).
function findDynamicStatements(lines, already) {
  const covered = new Set(already.map((s) => s.start));
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (covered.has(i)) continue;
    if (lines[i].includes("import(") && lines[i].includes(SPEC)) {
      const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 3)).join("\n");
      found.push({ start: i, end: i, text: context });
    }
  }
  return found;
}

function bindingsOf(statementText) {
  const text = statementText;
  if (/import\s*\*\s*as\s/.test(text)) return { kind: "namespace", names: [] };
  const names = new Set();
  const braceBlocks = text.match(/\{[^}]*\}/g) || [];
  for (const block of braceBlocks) {
    const inner = block.slice(1, -1);
    for (const part of inner.split(",")) {
      const trimmed = part.trim().replace(/^type\s+/, "");
      if (!trimmed) continue;
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.add(name);
    }
  }
  // Default import: import Foo from '...' or import Foo, { ... } from '...'
  const def = text.match(/import\s+(?:type\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(,|\s+from\s)/);
  if (def && !text.includes("{")) names.add(def[1]);
  if (def && text.includes("{") && /import\s+(?:type\s+)?[A-Za-z_$][\w$]*\s*,/.test(text)) names.add(def[1]);
  return { kind: "named", names: [...names] };
}

function main() {
  const { root, wave } = parseArgs(process.argv.slice(2));
  const srcDir = path.join(root, "src");
  const platformDir = path.join(srcDir, "lib", "platform");
  const files = walk(srcDir, []).filter((f) => !f.startsWith(platformDir + path.sep));
  const rows = [];
  let failures = 0;

  for (const file of files.sort()) {
    const content = fs.readFileSync(file, "utf8");
    if (!content.includes(SPEC)) continue;
    const lines = content.split("\n");
    const statements = findApiCoreStatements(lines);
    const dynamic = findDynamicStatements(lines, statements);
    const all = [...statements, ...dynamic];
    if (all.length === 0) {
      // Mention without an import statement (comment or string): not an
      // import, but report it so a reviewer can see why it was skipped.
      rows.push({ file: path.relative(root, file), verdict: "MENTION-ONLY", detail: "specifier mentioned, no import statement found" });
      continue;
    }
    const allNames = new Set();
    let namespace = false;
    let empty = false;
    for (const st of all) {
      const b = bindingsOf(st.text);
      if (b.kind === "namespace") namespace = true;
      if (b.names.length === 0 && b.kind === "named") empty = true;
      for (const n of b.names) allNames.add(n);
    }
    const names = [...allNames].sort();
    const hasConvert = allNames.has("convertFileSrc");
    const hasIsTauri = allNames.has("isTauri");
    const hasG2 = names.some((n) => G2_BINDINGS.has(n));
    // Allowed remainder for the selected wave. G2 allows convertFileSrc
    // and isTauri; G3 allows only isTauri (AD-86). G2 bindings are
    // never in the allowed set: they fail in both modes.
    const allowed = wave === "G3" ? G4_BINDINGS : new Set([...G3_BINDINGS, ...G4_BINDINGS]);
    const isUnknown = (n) => !allowed.has(n) && !G2_BINDINGS.has(n) && !G3_BINDINGS.has(n);
    const hasOther = names.some(isUnknown);
    const rel = path.relative(root, file);
    if (namespace) {
      rows.push({ file: rel, verdict: "FAIL", detail: "namespace import of api/core cannot be classified; review manually" });
      failures += 1;
    } else if (hasG2) {
      rows.push({ file: rel, verdict: "FAIL", detail: `still imports G2 binding(s): ${names.filter((n) => G2_BINDINGS.has(n)).join(", ")}` });
      failures += 1;
    } else if (wave === "G3" && hasConvert) {
      rows.push({ file: rel, verdict: "FAIL", detail: "still imports G3 binding(s): convertFileSrc" });
      failures += 1;
    } else if (hasOther) {
      rows.push({ file: rel, verdict: "FAIL", detail: `unknown api/core binding(s): ${names.filter(isUnknown).join(", ")}` });
      failures += 1;
    } else if (empty && !hasConvert && !hasIsTauri) {
      rows.push({ file: rel, verdict: "FAIL", detail: "api/core import with no classifiable bindings; review manually" });
      failures += 1;
    } else if (hasIsTauri) {
      rows.push({ file: rel, verdict: "DEFERRED-G4", detail: "isTauri remainder (closes at G4; AD-86 exception expires at G4)" });
    } else if (hasConvert && names.length === 1) {
      rows.push({ file: rel, verdict: "OK", detail: "convertFileSrc-only remainder (closes at G3)" });
    } else {
      rows.push({ file: rel, verdict: "FAIL", detail: `unclassified api/core import, bindings: ${names.join(", ") || "(none)"}` });
      failures += 1;
    }
  }

  for (const row of rows) console.log(`${row.verdict} ${row.file} :: ${row.detail}`);
  const ok = rows.filter((r) => r.verdict === "OK").length;
  const deferred = rows.filter((r) => r.verdict === "DEFERRED-G4").length;
  console.log(`check-api-core-subset: ${rows.length} file(s) mention api/core, ${ok} convertFileSrc-only remainder, ${deferred} deferred-G4 remainder, ${failures} failure(s) (wave ${wave})`);
  if (failures > 0) {
    console.log("check-api-core-subset: FAIL");
    process.exit(1);
  }
  console.log("check-api-core-subset: PASS");
}

main();
