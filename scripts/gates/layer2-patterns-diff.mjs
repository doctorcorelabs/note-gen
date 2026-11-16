// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Codemod gate layer 2: derivative-pattern grep + import-only diff
// check (V1-05 4.4/2, plus the merge requirement that a codemod diff
// touches imports only).
//
// Subcheck A, derivative patterns, over src/:
//   - raw Store.load calls outside src/lib/platform/ (0 from G1 on)
//   - raw invoke calls outside src/lib/platform/ (0 from G2 on)
//   - __TAURI_INTERNALS__ outside src/lib/platform/detect.ts (AD-89:
//     0 files from the 3D detect.ts consolidation on; the delta
//     baseline {debug-log.ts, event-listener.tauri.ts} closed when
//     both markers moved to the detect.ts seam)
//   - direct adapter implementation imports (*.tauri / *.web) outside
//     registry.ts and __tests__/ (always 0; mirrors guard check 3)
// Without --wave, Store/invoke counts are informational, but a new
// internals file or any direct implementation import still fails.
//
// Subcheck B, import-only diff (only when --base or --worktree is
// given): every changed line under src/ must sit inside an import
// statement (static, type, side-effect, export-from, or dynamic
// import(), including multi-line statements and Promise.all batches),
// or be blank. With --diff-scope import-and-qualifier, two further
// allowances apply, both recorded in the invocation:
//   (a) paired removed/added lines in one hunk that differ only by a
//       platform.<adapter>. qualifier (in either capitalization:
//       Store.load vs platform.store.load, invoke vs
//       platform.invoke.invoke);
//   (b) batch replacement: when every removed line of a hunk sits
//       inside an import statement, added lines that are simple
//       platform-access statements (assignment or expression over
//       platform.<adapter>...) are allowed. This covers the V1-05
//       Promise.all batch pattern, which is replaced as one unit.
//       Anything else fails closed for manual review.
// Files outside src/
// may change only if they are the two allowlists or .eslintrc.json.
// Added or deleted source files fail, except the G4 deletion of
// src/lib/tauri-event-listener.ts (the transitional re-export).
//
// The import scanner is a line-based heuristic, not a full parser:
// it tracks bracket depth across lines and strips line comments and
// string literals for depth counting only. A changed line the scanner
// cannot place inside an import statement fails with its file and
// line number, so a human reviews it instead of the gate guessing.
// Dynamic imports whose specifier sits on a different line than the
// import( token are treated as import statements only when the
// import( line itself changed; other lines of such a statement fail
// closed for manual review.
//
// Subcheck C, engine idempotence (only when --engine-cmd is given):
// the codemod engine CLI (V3-16a) is run in dry-run mode over the
// wave's files. When the command includes "--report <path>", the
// gate reads that JSON report (schema version 1) and requires
// totals.transformed == 0, totals.skipped == 0 and totals.errors == 0
// (a skipped file means the engine declined a declaration, so the
// wave is not cleanly migrated). A missing or unparseable report
// fails closed. When the command has no --report flag, the generic
// contract applies: exit 0 and empty stdout. The command is run
// through the shell; a non-zero exit fails. Without --engine-cmd
// this subcheck is reported SKIP. Wiring example (V3-16a CLI, branch
// web-codemod-engine):
//   node scripts/codemod/run.mjs --wave G1 --files <list-file>
//     --strict --no-diff --report <report-path>
//
// Usage:
//   node scripts/gates/layer2-patterns-diff.mjs [--wave G1|G2|G3|G4|G5|all]
//     [--base <ref>] [--worktree] [--diff-scope import-only|import-and-qualifier]
//     [--engine-cmd "<command>"] [--root <dir>]
// Exit 0 when every applicable subcheck passes, 1 otherwise.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WAVE_ORDER = { G1: 1, G2: 2, G3: 3, G4: 4, G5: 5, all: 5 };
// AD-89 delta baseline, closed at the 3D detect.ts consolidation:
// developer-tools.ts lost its marker at G4 (now isTauri() via the
// registry); the tauri-event-listener.ts marker moved to the
// relocated event-listener.tauri.ts at G2 and was removed together
// with the debug-log.ts marker when both call sites moved to the
// detect.ts seam. Both sets stay empty: any marker file outside
// detect.ts fails in every mode. The intermediate draft sets
// ({debug-log.ts, event-listener.tauri.ts}) belong to the gate-patch
// slot as the pre-consolidation delta baseline; this branch records
// the post-consolidation state.
const INTERNALS_BASELINE = new Set();
const INTERNALS_G2_G3 = new Set();
const ALLOWED_OUTSIDE_SRC = new Set([
  "scripts/ci/tauri-import-allowlist.txt",
  "scripts/ci/tauri-internals-allowlist.txt",
  ".eslintrc.json",
]);

function parseArgs(argv) {
  const out = { root: process.cwd(), wave: "", base: "", worktree: false, diffScope: "import-only", engineCmd: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--wave") out.wave = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--worktree") out.worktree = true;
    else if (a === "--diff-scope") out.diffScope = argv[++i];
    else if (a === "--engine-cmd") out.engineCmd = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/gates/layer2-patterns-diff.mjs [--wave G1|G2|G3|G4|G5|all] [--base <ref>] [--worktree] [--diff-scope import-only|import-and-qualifier] [--engine-cmd \"<command>\"] [--root <dir>]");
      process.exit(0);
    } else {
      console.error(`layer2: unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (out.wave && !(out.wave in WAVE_ORDER)) {
    console.error(`layer2: unknown wave: ${out.wave}`);
    process.exit(2);
  }
  if (out.diffScope !== "import-only" && out.diffScope !== "import-and-qualifier") {
    console.error(`layer2: unknown --diff-scope: ${out.diffScope}`);
    process.exit(2);
  }
  // The runner passes the engine command via environment variable so
  // that commands containing spaces survive intact (no shell eval).
  if (!out.engineCmd && process.env.CODEMOD_ENGINE_CMD) out.engineCmd = process.env.CODEMOD_ENGINE_CMD;
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

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------- patterns
function checkPatterns(root, wave) {
  const failures = [];
  const srcDir = path.join(root, "src");
  const platformDir = path.join(srcDir, "lib", "platform");
  const files = walk(srcDir, []).sort();
  const storeHits = [];
  const invokeHits = [];
  const internalsFiles = new Set();
  const directHits = [];
  const storeRe = /(^|[^A-Za-z0-9_.])Store\.load\s*\(/;
  const invokeRe = /(^|[^A-Za-z0-9_.])invoke\s*(\(|<)/;
  const directRe = /from\s+['"][^'"]*\.(tauri|web)['"]|import\(\s*['"][^'"]*\.(tauri|web)['"]\)/;

  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const inPlatform = file.startsWith(platformDir + path.sep);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!inPlatform) {
        if (storeRe.test(line)) storeHits.push(`${rel}:${idx + 1}`);
        if (invokeRe.test(line) && !rel.endsWith("plugin-item-list.tsx")) invokeHits.push(`${rel}:${idx + 1}`);
      }
      if (line.includes("__TAURI_INTERNALS__") && rel !== "src/lib/platform/detect.ts") {
        internalsFiles.add(rel);
      }
      if (directRe.test(line)
        && rel !== "src/lib/platform/registry.ts"
        && !rel.includes("src/lib/platform/__tests__/")
        && !/\.(test|spec)\.tsx?$/.test(rel)) {
        directHits.push(`${rel}:${idx + 1}`);
      }
    });
  }

  console.log(`layer2 patterns: raw Store.load lines outside platform: ${storeHits.length}`);
  console.log(`layer2 patterns: raw invoke lines outside platform: ${invokeHits.length}`);
  console.log(`layer2 patterns: internals marker files (excl. detect.ts): ${internalsFiles.size} (${[...internalsFiles].sort().join(", ") || "none"})`);
  console.log(`layer2 patterns: direct implementation imports: ${directHits.length}`);

  const waveNum = wave ? WAVE_ORDER[wave] : 0;
  if (waveNum >= 1 && storeHits.length > 0) {
    failures.push(`raw Store.load calls remain after ${wave}: ${storeHits.slice(0, 10).join(", ")}${storeHits.length > 10 ? ` (+${storeHits.length - 10} more)` : ""}`);
  }
  if (waveNum >= 2 && invokeHits.length > 0) {
    failures.push(`raw invoke calls remain after ${wave}: ${invokeHits.slice(0, 10).join(", ")}${invokeHits.length > 10 ? ` (+${invokeHits.length - 10} more)` : ""}`);
  }
  if (waveNum >= 4 && internalsFiles.size > 0) {
    failures.push(`internals marker remains after ${wave} in: ${[...internalsFiles].sort().join(", ")}`);
  } else if (waveNum === 2 || waveNum === 3) {
    const extra = [...internalsFiles].filter((f) => !INTERNALS_G2_G3.has(f));
    if (extra.length > 0) failures.push(`internals marker remains after ${wave} outside the allowed remainder: ${extra.join(", ")}`);
  } else if (waveNum === 0 || waveNum === 1) {
    const extra = [...internalsFiles].filter((f) => !INTERNALS_BASELINE.has(f));
    if (extra.length > 0) failures.push(`new internals marker file(s) outside the baseline set: ${extra.join(", ")}`);
  }
  if (directHits.length > 0) {
    failures.push(`direct implementation imports: ${directHits.slice(0, 10).join(", ")}${directHits.length > 10 ? ` (+${directHits.length - 10} more)` : ""}`);
  }
  return failures;
}

// ------------------------------------------------------- import scanner
function stripForDepth(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

// A dynamic import may sit inside a larger statement (Promise.all
// batch, await expression). The whole statement is the import unit:
// expand upward from the import( line while the previous line does
// not end the previous statement, and scan forward until the
// statement terminator. Expansion stops before block openers,
// statement terminators, blank lines, and other import/export lines.
function importLineSet(lines) {
  const inImport = new Set();
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2);
    }
    const blockStart = line.indexOf("/*");
    if (blockStart !== -1 && line.indexOf("*/", blockStart + 2) === -1) {
      inBlockComment = true;
      line = line.slice(0, blockStart);
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isStatic = /^\s*import\s+[^=(]/.test(line) || /^\s*import\s*['"]/.test(line);
    const isExportFrom = /^\s*export\s/.test(line);
    const hasDynamic = line.includes("import(") || line.includes("import (");
    if (!isStatic && !isExportFrom && !hasDynamic) continue;
    let start = i;
    if (hasDynamic && !isStatic) {
      // Expand upward to the statement start (at most 10 lines).
      for (let up = i - 1; up >= Math.max(0, i - 10); up -= 1) {
        const prev = lines[up];
        const ptrim = prev.trim();
        if (!ptrim) break;
        if (/[;{}]\s*$/.test(prev)) break;
        if (/^\s*(import|export)\b/.test(prev)) break;
        start = up;
      }
    }
    // Scan the statement, tracking bracket depth, up to its terminator.
    let depth = 0;
    let end = start;
    let text = "";
    for (let j = start; j < Math.min(lines.length, start + 60); j += 1) {
      if (j > start && depth <= 0 && /^\s*$/.test(lines[j])) { end = j - 1; break; }
      text += `${lines[j]}\n`;
      const clean = stripForDepth(lines[j]);
      for (const ch of clean) {
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      }
      end = j;
      if (depth <= 0 && /;/.test(lines[j])) break;
      if (isStatic && depth <= 0 && /\bfrom\s+['"]/.test(lines[j])) break;
    }
    if (isExportFrom && !/\bfrom\s+['"]/.test(text)) continue; // plain export, not a module specifier
    if (isStatic && !text.includes("from") && !/import\s*['"]/.test(text) && !text.includes("import(")) continue;
    for (let k = start; k <= end; k += 1) inImport.add(k);
    i = end;
  }
  return inImport;
}

function collapseWs(line) {
  return line.replace(/\s+/g, " ").trim();
}

// Two qualifier normalizations, tried in both directions when pairing
// removed/added lines: strip platform.<adapter>. entirely (invoke vs
// platform.invoke.invoke), or replace it with the capitalized adapter
// name (Store.load vs platform.store.load).
function stripPlatform(line) {
  return collapseWs(line.replace(/platform\.[A-Za-z_$][A-Za-z0-9_$]*\./g, ""));
}
function capitalizePlatform(line) {
  return collapseWs(line.replace(/platform\.([A-Za-z_$][A-Za-z0-9_$]*)\./g, (_, n) => `${n.charAt(0).toUpperCase()}${n.slice(1)}.`));
}
function qualifierPair(removedText, addedText) {
  const r = collapseWs(removedText);
  const a = collapseWs(addedText);
  if (!r || !a || r === a) return false;
  const forms = (t) => [t, stripPlatform(t), capitalizePlatform(t)];
  for (const rf of forms(r)) {
    for (const af of forms(a)) {
      if (rf === af) return true;
    }
  }
  return false;
}

// Simple platform-access statements allowed as batch replacements:
// a declaration assigned from platform.<adapter>..., or a bare/return/
// await expression over platform.<adapter>... . Anything more complex
// fails closed.
function isSimplePlatformStatement(text) {
  const t = collapseWs(text);
  if (/^(const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(await\s+)?platform\.[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*(\(.*\))?)?;?$/.test(t)) return true;
  if (/^(return\s+|await\s+)?platform\.[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*(\(.*\))?)?;?$/.test(t)) return true;
  return false;
}

// ------------------------------------------------------------- diff check
function parseDiff(diffText) {
  // Returns Map relPath -> { added: [{no, text}], removed: [{no, text}], hunks: [{removed, added}] }
  const perFile = new Map();
  let current = null;
  let oldNo = 0;
  let newNo = 0;
  let hunk = null;
  const lines = diffText.split("\n");
  for (const raw of lines) {
    if (raw.startsWith("+++ b/")) {
      const rel = raw.slice(6);
      current = { added: [], removed: [], hunks: [] };
      perFile.set(rel, current);
      hunk = null;
      continue;
    }
    if (raw.startsWith("+++ ")) continue; // /dev/null for deletions, handled via name-status
    if (raw.startsWith("@@ ")) {
      const m = raw.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[3]);
        hunk = { removed: [], added: [] };
        if (current) current.hunks.push(hunk);
      }
      continue;
    }
    if (!current || !hunk) continue;
    if (raw.startsWith("---") || raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("similarity") || raw.startsWith("rename ")) continue;
    if (raw.startsWith("\\ ")) continue;
    if (raw.startsWith("-")) {
      const rec = { no: oldNo, text: raw.slice(1) };
      current.removed.push(rec);
      hunk.removed.push(rec);
      oldNo += 1;
    } else if (raw.startsWith("+")) {
      const rec = { no: newNo, text: raw.slice(1) };
      current.added.push(rec);
      hunk.added.push(rec);
      newNo += 1;
    } else {
      oldNo += 1;
      newNo += 1;
    }
  }
  return perFile;
}

function checkDiff(root, opts) {
  const failures = [];
  let oldRef;
  let newFromDisk = false;
  let rangeArg;
  if (opts.worktree) {
    oldRef = "HEAD";
    newFromDisk = true;
    rangeArg = "HEAD";
  } else {
    const mergeBase = git(root, ["merge-base", opts.base, "HEAD"]).trim();
    oldRef = mergeBase;
    rangeArg = `${opts.base}...HEAD`;
  }
  const statusText = git(root, ["diff", "--name-status", rangeArg, "--"]);
  const statuses = statusText.split("\n").filter(Boolean).map((l) => l.split("\t"));
  const changed = statuses.map((parts) => ({ code: parts[0], path: parts[parts.length - 1] }));
  if (changed.length === 0 && !opts.worktree) {
    console.log("layer2 diff: SKIP: no changed files in range (nothing to check)");
    return { failures, skipped: true };
  }
  if (opts.worktree) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "--"]).split("\n").filter(Boolean);
    for (const u of untracked) changed.push({ code: "?", path: u });
    if (changed.length === 0) {
      console.log("layer2 diff: SKIP: working tree clean vs HEAD (nothing to check)");
      return { failures, skipped: true };
    }
  }

  const srcChanges = [];
  for (const c of changed) {
    const rel = c.path;
    const inSrc = rel.startsWith("src/") && (rel.endsWith(".ts") || rel.endsWith(".tsx"));
    if (!inSrc) {
      if (ALLOWED_OUTSIDE_SRC.has(rel)) {
        console.log(`layer2 diff: allowed non-src change: ${rel} (${c.code})`);
        continue;
      }
      failures.push(`changed file outside the codemod scope: ${rel} (${c.code}); codemod merges touch src/ imports plus the allowlists/.eslintrc.json only`);
      continue;
    }
    if (c.code.startsWith("A") || c.code === "?") {
      failures.push(`new source file in a codemod diff: ${rel}; codemod edits existing files only`);
      continue;
    }
    if (c.code.startsWith("D")) {
      if (rel === "src/lib/tauri-event-listener.ts" && (opts.wave === "G4" || opts.wave === "G5" || opts.wave === "all")) {
        console.log("layer2 diff: allowed G4 deletion of the transitional re-export src/lib/tauri-event-listener.ts");
        continue;
      }
      failures.push(`deleted source file in a codemod diff: ${rel}; only the G4 re-export deletion is allowed`);
      continue;
    }
    if (c.code.startsWith("R")) {
      failures.push(`renamed source file in a codemod diff: ${rel}; renames do not belong in a codemod merge`);
      continue;
    }
    srcChanges.push(rel);
  }

  if (srcChanges.length === 0) {
    if (failures.length === 0) console.log("layer2 diff: no src/ content changes to check");
    return { failures, skipped: false };
  }

  const diffText = git(root, ["diff", "--unified=0", "--no-color", "--no-ext-diff", rangeArg, "--", ...srcChanges]);
  const perFile = parseDiff(diffText);

  for (const rel of srcChanges) {
    const entry = perFile.get(rel);
    if (!entry) continue;
    let oldContent = "";
    try {
      oldContent = git(root, ["show", `${oldRef}:${rel}`]);
    } catch {
      failures.push(`cannot read old version of ${rel} at ${oldRef}; refusing to guess`);
      continue;
    }
    let newContent;
    if (newFromDisk) {
      newContent = fs.readFileSync(path.join(root, rel), "utf8");
    } else {
      try {
        newContent = git(root, ["show", `HEAD:${rel}`]);
      } catch {
        failures.push(`cannot read new version of ${rel} at HEAD; refusing to guess`);
        continue;
      }
    }
    const oldImport = importLineSet(oldContent.split("\n"));
    const newImport = importLineSet(newContent.split("\n"));
    const badRemoved = [];
    const badAdded = [];
    // Qualifier pairing + batch replacement apply per hunk when the
    // scope allows them.
    const pairedRemoved = new Set();
    const pairedAdded = new Set();
    const batchAdded = new Set();
    if (opts.diffScope === "import-and-qualifier") {
      for (const h of entry.hunks) {
        const n = Math.min(h.removed.length, h.added.length);
        for (let k = 0; k < n; k += 1) {
          const r = h.removed[k];
          const a = h.added[k];
          if (qualifierPair(r.text, a.text)) {
            pairedRemoved.add(`${r.no}:${r.text}`);
            pairedAdded.add(`${a.no}:${a.text}`);
          }
        }
        // Batch replacement: removed side entirely import lines.
        const removedAllImport = h.removed.length > 0 && h.removed.every(
          (r) => r.text.trim() === "" || oldImport.has(r.no - 1) || pairedRemoved.has(`${r.no}:${r.text}`),
        );
        if (removedAllImport) {
          for (const a of h.added) {
            if (a.text.trim() === "" || newImport.has(a.no - 1)) continue;
            if (isSimplePlatformStatement(a.text)) batchAdded.add(`${a.no}:${a.text}`);
          }
        }
      }
    }
    for (const r of entry.removed) {
      if (r.text.trim() === "") continue;
      if (pairedRemoved.has(`${r.no}:${r.text}`)) continue;
      if (!oldImport.has(r.no - 1)) badRemoved.push(`${rel}:${r.no}: ${r.text.slice(0, 100)}`);
    }
    for (const a of entry.added) {
      if (a.text.trim() === "") continue;
      if (pairedAdded.has(`${a.no}:${a.text}`)) continue;
      if (batchAdded.has(`${a.no}:${a.text}`)) continue;
      if (!newImport.has(a.no - 1)) badAdded.push(`${rel}:${a.no}: ${a.text.slice(0, 100)}`);
    }
    if (badRemoved.length > 0 || badAdded.length > 0) {
      failures.push(`non-import changes in ${rel} (removed: ${badRemoved.length}, added: ${badAdded.length}): ${[...badRemoved, ...badAdded].slice(0, 6).join(" | ")}${badRemoved.length + badAdded.length > 6 ? " ..." : ""}`);
    } else {
      console.log(`layer2 diff: OK ${rel} (removed ${entry.removed.length}, added ${entry.added.length}, import-only)`);
    }
  }
  return { failures, skipped: false };
}

// ---------------------------------------------------------------- engine
function reportPathFromCommand(engineCmd) {
  const parts = engineCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i].replace(/^"|"$/g, "");
    if (part === "--report" && i + 1 < parts.length) {
      return parts[i + 1].replace(/^"|"$/g, "");
    }
    if (part.startsWith("--report=")) return part.slice("--report=".length);
  }
  return null;
}

function checkEngine(engineCmd, root) {
  let out;
  try {
    out = execSync(engineCmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 });
  } catch (err) {
    const detail = (err && err.stderr ? String(err.stderr) : String(err)).slice(0, 500);
    return [`engine dry-run command failed: ${detail}`];
  }
  const reportPath = reportPathFromCommand(engineCmd);
  if (reportPath !== null) {
    const absReport = path.isAbsolute(reportPath) ? reportPath : path.join(root, reportPath);
    let report;
    try {
      report = JSON.parse(fs.readFileSync(absReport, "utf8"));
    } catch (err) {
      return [`engine report ${reportPath} missing or unparseable: ${String(err).slice(0, 200)}`];
    }
    const totals = report && report.totals;
    if (!totals || typeof totals.transformed !== "number" || typeof totals.errors !== "number" || typeof totals.skipped !== "number") {
      return [`engine report ${reportPath} has no usable totals (expected schema version 1)`];
    }
    console.log(`layer2 engine: report totals: transformed=${totals.transformed} unchanged=${totals.unchanged} skipped=${totals.skipped} errors=${totals.errors}`);
    if (totals.transformed !== 0 || totals.skipped !== 0 || totals.errors !== 0) {
      const bad = (report.files || []).filter((f) => f.status !== "unchanged").map((f) => `${f.path} (${f.status})`).slice(0, 10);
      return [`engine dry-run not idempotent: transformed=${totals.transformed} skipped=${totals.skipped} errors=${totals.errors}${bad.length > 0 ? `; ${bad.join(", ")}` : ""}`];
    }
    console.log("layer2 engine: dry-run report clean (idempotent)");
    return [];
  }
  if (out.trim() !== "") {
    return [`engine dry-run produced output (expected empty when already migrated); first 500 chars: ${out.slice(0, 500)}`];
  }
  console.log("layer2 engine: dry-run output empty (idempotent)");
  return [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const failures = [];

  const patternFailures = checkPatterns(opts.root, opts.wave);
  for (const f of patternFailures) console.log(`layer2 patterns: FAIL: ${f}`);
  failures.push(...patternFailures);
  if (patternFailures.length === 0) console.log("layer2 patterns: PASS");

  if (opts.base || opts.worktree) {
    const { failures: diffFailures, skipped } = checkDiff(opts.root, opts);
    for (const f of diffFailures) console.log(`layer2 diff: FAIL: ${f}`);
    failures.push(...diffFailures);
    if (!skipped && diffFailures.length === 0) console.log("layer2 diff: PASS");
  } else {
    console.log("layer2 diff: SKIP: no --base and no --worktree given (diff check needs a base ref)");
  }

  if (opts.engineCmd) {
    const engineFailures = checkEngine(opts.engineCmd, opts.root);
    for (const f of engineFailures) console.log(`layer2 engine: FAIL: ${f}`);
    failures.push(...engineFailures);
    if (engineFailures.length === 0) console.log("layer2 engine: PASS");
  } else {
    console.log("layer2 engine: SKIP: no --engine-cmd given (engine idempotence not checked)");
  }

  if (failures.length > 0) {
    console.log(`layer2: FAIL (${failures.length} check(s) failed)`);
    process.exit(1);
  }
  console.log("layer2: PASS");
}

main();
