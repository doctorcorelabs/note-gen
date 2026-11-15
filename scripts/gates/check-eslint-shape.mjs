// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// ESLint config shape check: the codemod gates must use the merged M5
// .eslintrc.json form, not the V2-04 branch form.
//
// Merged form (4 overrides, verified at trunk c3f1c940):
//   1. files src/**/*.{ts,tsx} except src/lib/platform/**: warn on
//      @tauri-apps/*, tauri-plugin-clipboard-api, and direct adapter
//      implementation imports (**/*.tauri, **/*.web, alias spellings).
//   2. files src/lib/platform/**/*.{ts,tsx} except *.tauri.ts: error
//      on @tauri-apps/* (catch-all; the branch form listed only
//      interface/*.web.ts/registry/detect/errors/types/capabilities/
//      index/commands files).
//   3. files src/lib/platform/**/*.tauri.ts: error on *.web imports.
//   4. files src/lib/platform/**/*.web.ts: error on *.tauri imports
//      AND on @tauri-apps/* (the branch form had only the *.tauri
//      pattern here).
// At G5, override 1 becomes error (V3-21). This check accepts warn
// or error for override 1, reports the level, and in --wave G5 mode
// requires error.
//
// Usage: node scripts/gates/check-eslint-shape.mjs [--wave G5|all]
// Exit 0 when the shape matches, 1 otherwise.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let wave = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--wave") wave = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/gates/check-eslint-shape.mjs [--wave G5|all]");
    process.exit(0);
  } else {
    console.error(`check-eslint-shape: unknown argument: ${args[i]}`);
    process.exit(2);
  }
}

const root = process.cwd();
const configPath = path.join(root, ".eslintrc.json");
if (!fs.existsSync(configPath)) {
  console.error("check-eslint-shape: FAIL: .eslintrc.json not found");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const failures = [];

function groupsOf(override) {
  const rule = override.rules && override.rules["no-restricted-imports"];
  if (!rule || !Array.isArray(rule) || rule.length < 2) return null;
  return { level: rule[0], patterns: (rule[1].patterns || []).map((p) => p.group || []) };
}

const overrides = config.overrides || [];
if (overrides.length !== 4) {
  failures.push(`expected exactly 4 overrides (merged M5 form), found ${overrides.length}`);
} else {
  // Override 1.
  const o1 = overrides[0];
  const g1 = groupsOf(o1);
  const files1 = (o1.files || []).join(",");
  const excl1 = (o1.excludedFiles || []).join(",");
  if (!files1.includes("src/**/*.{ts,tsx}") || !excl1.includes("src/lib/platform/**/*")) {
    failures.push("override 1: expected files src/**/*.{ts,tsx} excluding src/lib/platform/**");
  }
  if (!g1) {
    failures.push("override 1: no-restricted-imports rule not found");
  } else {
    const flat = g1.patterns.flat();
    if (!flat.includes("@tauri-apps/*")) failures.push("override 1: missing @tauri-apps/* pattern");
    if (!flat.includes("tauri-plugin-clipboard-api")) failures.push("override 1: missing tauri-plugin-clipboard-api pattern");
    if (!flat.includes("**/*.tauri") || !flat.includes("**/*.web")) failures.push("override 1: missing **/*.tauri / **/*.web patterns");
    console.log(`check-eslint-shape: override 1 level: ${g1.level}`);
    if (wave === "G5" || wave === "all") {
      if (g1.level !== "error") failures.push(`override 1 must be error after G5, found ${g1.level}`);
    } else if (g1.level !== "warn" && g1.level !== "error") {
      failures.push(`override 1: unexpected level ${g1.level} (expected warn before G5)`);
    }
  }
  // Override 2: catch-all platform except *.tauri.ts.
  const o2 = overrides[1];
  const g2 = groupsOf(o2);
  const files2 = (o2.files || []).join(",");
  const excl2 = (o2.excludedFiles || []).join(",");
  if (!files2.includes("src/lib/platform/**/*.{ts,tsx}") || !excl2.includes("src/lib/platform/**/*.tauri.ts")) {
    failures.push("override 2: expected catch-all files src/lib/platform/**/*.{ts,tsx} excluding *.tauri.ts (merged M5 form, not the V2-04 branch file list)");
  }
  if (!g2 || g2.level !== "error" || !g2.patterns.flat().includes("@tauri-apps/*")) {
    failures.push("override 2: expected error on @tauri-apps/*");
  }
  // Override 3: *.tauri.ts must not import *.web.
  const o3 = overrides[2];
  const g3 = groupsOf(o3);
  const files3 = (o3.files || []).join(",");
  if (!files3.includes("src/lib/platform/**/*.tauri.ts")) {
    failures.push("override 3: expected files src/lib/platform/**/*.tauri.ts");
  }
  if (!g3 || g3.level !== "error" || !g3.patterns.flat().includes("**/*.web")) {
    failures.push("override 3: expected error on **/*.web");
  }
  // Override 4: *.web.ts must not import *.tauri nor @tauri-apps/*.
  const o4 = overrides[3];
  const g4 = groupsOf(o4);
  const files4 = (o4.files || []).join(",");
  if (!files4.includes("src/lib/platform/**/*.web.ts")) {
    failures.push("override 4: expected files src/lib/platform/**/*.web.ts");
  }
  if (!g4 || g4.level !== "error") {
    failures.push("override 4: expected error level");
  } else {
    const flat = g4.patterns.flat();
    if (!flat.includes("**/*.tauri")) failures.push("override 4: missing **/*.tauri pattern");
    if (!flat.includes("@tauri-apps/*")) failures.push("override 4: missing @tauri-apps/* pattern (merged M5 form)");
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log(`check-eslint-shape: FAIL: ${f}`);
  process.exit(1);
}
console.log("check-eslint-shape: PASS (merged M5 form)");
