// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Analyze ESLint --format json output for the codemod gate.
//
// Rules:
//   - Any no-restricted-imports ERROR fails, always.
//   - In wave mode, any no-restricted-imports diagnostic (warning or
//     error) on a line that still mentions a specifier of a closed
//     wave fails: the migrated file must be clean for its wave.
//   - Other diagnostics are reported as counts only; this helper does
//     not fail on them (the full `pnpm lint` exit code is the check
//     for the rest of the rules).
//   - Diagnostics in files outside src/ are ignored.
//   - AD-86 exception, G3 mode only: a diagnostic on an api/core
//     import statement that imports only isTauri does not fail as a
//     closed-wave failure; it is reported as DEFERRED-G4. isTauri
//     closes at G4, so the exception expires at G4 and above, where
//     any api/core diagnostic fails again. Any other binding in the
//     same statement (including convertFileSrc), a namespace import,
//     or an unclassifiable statement still fails at G3.
//
// Usage: node scripts/gates/eslint-wave-check.mjs <eslint-json-file>
//   [--wave G1|G2|G3|G4|G5|all]
// Exit 0 when the rules above pass, 1 otherwise.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let jsonFile = "";
let wave = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--wave") wave = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: node scripts/gates/eslint-wave-check.mjs <eslint-json-file> [--wave G1|G2|G3|G4|G5|all]");
    process.exit(0);
  } else if (!jsonFile) jsonFile = args[i];
  else {
    console.error(`eslint-wave-check: unknown argument: ${args[i]}`);
    process.exit(2);
  }
}
if (!jsonFile) {
  console.error("eslint-wave-check: missing <eslint-json-file>");
  process.exit(2);
}

const WAVE_ORDER = ["G1", "G2", "G3", "G4", "G5"];
let closedSpecs = [];
if (wave) {
  const upto = wave === "all" ? 5 : WAVE_ORDER.indexOf(wave) + 1;
  if (upto <= 0) {
    console.error(`eslint-wave-check: unknown wave: ${wave}`);
    process.exit(2);
  }
  const waves = JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts/gates/waves.json"), "utf8")).waves;
  for (const name of WAVE_ORDER.slice(0, upto)) closedSpecs.push(...waves[name]);
  // api/core at G2 is handled by the binding check, not here: a
  // convertFileSrc-only remainder still warns under override 1 until
  // G3, so exclude api/core from the G2 specifier set.
  if (wave === "G2") closedSpecs = closedSpecs.filter((s) => s !== "@tauri-apps/api/core");
}

const results = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
let errors = 0;
let warnings = 0;
let waveFailures = 0;
let deferredG4 = 0;
const fileCache = new Map();

// True only when the statement text positively proves an isTauri-only
// api/core import: its brace blocks name isTauri and nothing else.
// Namespace imports, missing braces, and any other binding return
// false, so the diagnostic still fails. Conservative by design: an
// unclassifiable statement never earns the AD-86 leniency.
function isIsTauriOnlyStatement(text) {
  if (/import\s*\*\s*as\s/.test(text)) return false;
  const braceBlocks = text.match(/\{[^}]*\}/g) || [];
  if (braceBlocks.length === 0) return false;
  const names = new Set();
  for (const block of braceBlocks) {
    const inner = block.slice(1, -1);
    for (const part of inner.split(",")) {
      const trimmed = part.trim().replace(/^type\s+/, "");
      if (!trimmed) continue;
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) names.add(name);
    }
  }
  return names.size === 1 && names.has("isTauri");
}

function statementText(filePath, lineNo, endLineNo) {
  if (!fileCache.has(filePath)) {
    try {
      fileCache.set(filePath, fs.readFileSync(filePath, "utf8").split("\n"));
    } catch {
      fileCache.set(filePath, []);
    }
  }
  const lines = fileCache.get(filePath);
  const end = Math.max(lineNo, endLineNo || lineNo);
  return lines.slice(lineNo - 1, end).join("\n");
}

for (const result of results) {
  const rel = path.relative(process.cwd(), result.filePath).split(path.sep).join("/");
  if (!rel.startsWith("src/")) continue;
  for (const msg of result.messages || []) {
    if (msg.ruleId !== "no-restricted-imports") continue;
    if (msg.severity === 2) {
      errors += 1;
      console.log(`eslint-wave-check: ERROR ${rel}:${msg.line} ${msg.message}`);
    } else {
      warnings += 1;
    }
    if (wave && closedSpecs.length > 0) {
      const srcText = statementText(result.filePath, msg.line, msg.endLine);
      const hit = closedSpecs.find((s) => srcText.includes(s));
      if (hit) {
        if (wave === "G3" && hit === "@tauri-apps/api/core" && isIsTauriOnlyStatement(srcText)) {
          deferredG4 += 1;
          console.log(`eslint-wave-check: DEFERRED-G4 ${rel}:${msg.line} isTauri-only api/core remainder (closes at G4)`);
        } else {
          waveFailures += 1;
          console.log(`eslint-wave-check: FAIL ${rel}:${msg.line} still mentions closed-wave specifier ${hit} (severity ${msg.severity})`);
        }
      }
    }
  }
}

console.log(`eslint-wave-check: no-restricted-imports errors: ${errors}, warnings: ${warnings}, closed-wave failures: ${waveFailures}, deferred-G4: ${deferredG4}`);
if (errors > 0 || waveFailures > 0) {
  console.log("eslint-wave-check: FAIL");
  process.exit(1);
}
console.log("eslint-wave-check: PASS");
