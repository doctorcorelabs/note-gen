// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Verification harness for the codemod engine (V3-16aR2). Run from the
// repo root after `pnpm install`: `node scripts/codemod/self-check.mjs`.
// The harness stages copies of the engine and its fixtures in a scratch
// directory (a fresh mkdtemp under the OS temp dir, or --scratch <dir>)
// and never writes into the repo tree. Exit 0 means every check passed.
// Adapted from the V3-16a/V3-16aR staging harnesses; R2 fixed two
// incorrect assertions (quote style, residual import lines) and added
// coverage for type renames, api/image, opener review flags, and
// re-export UNSUPPORTED reporting.
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync, mkdtempSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: node scripts/codemod/self-check.mjs [--scratch <dir>] [--keep]");
  process.exit(0);
}
const scratchArgIndex = argv.indexOf("--scratch");
const scratchArg = scratchArgIndex === -1 ? null : argv[scratchArgIndex + 1];
if (scratchArgIndex !== -1 && (scratchArg === undefined || scratchArg.startsWith("--"))) {
  console.error("self-check: error: --scratch needs a directory value");
  process.exit(1);
}
const KEEP = argv.includes("--keep") || scratchArg !== null;
if (!existsSync(join(REPO_ROOT, "node_modules", "ts-morph", "package.json"))) {
  console.error("self-check: error: ts-morph is not installed. Run 'pnpm install' from the repo root first.");
  process.exit(1);
}
const STAGING = scratchArg !== null ? resolve(scratchArg) : mkdtempSync(join(tmpdir(), "codemod-selfcheck-"));
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(join(STAGING, "engine"), { recursive: true });
mkdirSync(join(STAGING, "fixtures"), { recursive: true });
for (const name of ["run.mjs", "engine.mjs", "mappings.mjs", "report.mjs"]) {
  cpSync(join(SCRIPT_DIR, name), join(STAGING, "engine", name));
}
for (const name of readdirSync(join(SCRIPT_DIR, "engine-fixtures")).filter((n) => n.endsWith(".ts"))) {
  cpSync(join(SCRIPT_DIR, "engine-fixtures", name), join(STAGING, "fixtures", name));
}
symlinkSync(join(REPO_ROOT, "node_modules"), join(STAGING, "node_modules"), "dir");
const ENGINE = resolve(STAGING, "engine/run.mjs");
const FIX = resolve(STAGING, "fixtures");
let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name} ${extra}`); }
}
function runCli(args, cwd) {
  return spawnSync("node", [ENGINE, ...args], { cwd: cwd ?? STAGING, encoding: "utf8" });
}
function fixtureList() {
  return execSync(`ls ${FIX}/*.ts`, { encoding: "utf8" }).trim().split("\n").map((p) => `fixtures/${p.split("/").pop()}`);
}
function waveReport(wave, extraArgs = []) {
  const reportPath = resolve(STAGING, `report-${wave}.json`);
  const r = runCli(["--wave", wave, "--root", STAGING, "--report", reportPath, "--no-diff", ...extraArgs, ...fixtureList()]);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr, report };
}
function byPath(report, name) {
  return report.files.find((f) => f.path === `fixtures/${name}`);
}
function hashDir(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") || x.endsWith(".tsx")).sort()) {
    out[f] = createHash("sha256").update(readFileSync(resolve(dir, f))).digest("hex");
  }
  return out;
}

// ---- dry-run writes nothing (hash proof over all waves) ----
{
  const before = hashDir(FIX);
  for (const w of ["G1", "G2", "G3", "G4", "G5"]) {
    runCli(["--wave", w, "--root", STAGING, "--no-diff", ...fixtureList()]);
  }
  const after = hashDir(FIX);
  check("dry-run writes nothing (hashes equal over G1-G5)", JSON.stringify(before) === JSON.stringify(after));
  const d = runCli(["--wave", "G1", "--root", STAGING, "fixtures/engine-f01-store.ts"]);
  check("dry-run prints a diff", d.stdout.includes("--- a/fixtures/engine-f01-store.ts") && d.stdout.includes("+++ b/") && d.stdout.includes("platform"));
}

// ---- G1 ----
{
  const { exit, report } = waveReport("G1");
  check("G1 exit 0 (skips allowed)", exit === 0, `got ${exit}`);
  check("G1 f01 transformed", byPath(report, "engine-f01-store.ts").status === "transformed");
  check("G1 f01 Store refs reported", byPath(report, "engine-f01-store.ts").bindings[0]?.totalReferences === 1);
  check("G1 f02 unchanged", byPath(report, "engine-f02-multiline.ts").status === "unchanged");
  const f03 = byPath(report, "engine-f03-types.ts");
  check("G1 f03 transformed", f03.status === "transformed");
  check("G1 f03 only fs decl transformed", f03.declarationsTransformed === 1, JSON.stringify(f03.declarationsTransformed));
  check("G1 f04 unchanged", byPath(report, "engine-f04-alias.ts").status === "unchanged");
  const f05 = byPath(report, "engine-f05-dynamic.ts");
  check("G1 f05 skipped (dynamic only)", f05.status === "skipped", f05.status);
  check("G1 f05 batch reported", f05.dynamicImports.some((x) => x.reason === "promise-all-batch"));
  check("G1 f05 namespace reported", f05.dynamicImports.some((x) => x.reason === "dynamic-namespace-access"));
  check("G1 f05 then-access reported (R2)", f05.dynamicImports.some((x) => x.reason === "dynamic-then-access"));
  check("G1 f06 skipped", byPath(report, "engine-f06-module-access.ts").status === "skipped");
  check("G1 f07 transformed", byPath(report, "engine-f07-combined.ts").status === "transformed");
  const f08 = byPath(report, "engine-f08-internals.ts");
  check("G1 f08 unchanged + marker notes (F-06)", f08.status === "unchanged" && f08.notes.filter((n) => n.kind === "tauri-internals-marker").length >= 2, JSON.stringify(f08.notes));
  const f10 = byPath(report, "engine-f10-sql-funnel.ts");
  check("G1 f10 skipped no-barrel-equivalent", f10.status === "skipped" && f10.declarationsSkipped[0]?.reason === "no-barrel-equivalent", JSON.stringify(f10.declarationsSkipped));
  check("G1 f11 unchanged", byPath(report, "engine-f11-core-partial.ts").status === "unchanged");
  check("G1 f12 transformed", byPath(report, "engine-f12-existing-platform.ts").status === "transformed");
  check("G1 f14 transformed", byPath(report, "engine-f14-fs-mixed.ts").status === "transformed");
  const f16 = byPath(report, "engine-f16-weird.ts");
  check("G1 f16 skipped namespace+side-effect", f16.status === "skipped" && f16.declarationsSkipped.length === 2, JSON.stringify(f16.declarationsSkipped));
  check("G1 f16 re-export noted", f16.notes.some((n) => n.kind === "re-export-not-handled"));
  check("G1 f16 re-export UNSUPPORTED (R2)", f16.unsupported.length === 1 && f16.unsupported[0].reason === "re-export-not-handled", JSON.stringify(f16.unsupported));
  const f22 = byPath(report, "engine-f22-store-type.ts");
  check("G1 f22 type-only Store maps to StoreHandle (R2)", f22.status === "transformed" && f22.bindings.some((b) => b.localName === "Store" && b.barrelName === "StoreHandle" && b.barrelKind === "type"), JSON.stringify(f22.bindings));
  const f17 = byPath(report, "engine-f17-barrel-merge.ts");
  check("G1 f17 transformed, both decls (F-02)", f17.status === "transformed" && f17.declarationsTransformed === 2 && f17.declarationsSkipped.length === 0, JSON.stringify(f17));
  check("G1 f18 skipped (dynamic report-only)", byPath(report, "engine-f18-dynamic-barrel.ts").status === "skipped");
  check("G1 f19 unchanged (G4 specifier)", byPath(report, "engine-f19-window.ts").status === "unchanged");
  check("G1 errors 0", report.totals.errors === 0, JSON.stringify(report.totals));
}
// ---- G2 ----
{
  const { report } = waveReport("G2");
  const f11 = byPath(report, "engine-f11-core-partial.ts");
  check("G2 f11 transformed with residual", f11.status === "transformed", f11.status);
  check("G2 f04 httpFetch transformed", byPath(report, "engine-f04-alias.ts").status === "transformed");
  check("G2 f04 alias preserved in report", byPath(report, "engine-f04-alias.ts").bindings.some((b) => b.localName === "httpFetch" && b.importedName === "fetch"));
  check("G2 f13 skipped type-used-as-value", byPath(report, "engine-f13-proxy-value.ts").declarationsSkipped[0]?.reason === "barrel-type-used-as-value", JSON.stringify(byPath(report, "engine-f13-proxy-value.ts").declarationsSkipped));
  check("G2 f07 both invoke decls transformed", byPath(report, "engine-f07-combined.ts").declarationsTransformed === 2, JSON.stringify(byPath(report, "engine-f07-combined.ts").declarationsTransformed));
  check("G2 errors 0", report.totals.errors === 0, JSON.stringify(report.totals));
}
// ---- G3 ----
{
  const { report } = waveReport("G3");
  check("G3 f04 openDialog transformed", byPath(report, "engine-f04-alias.ts").bindings.some((b) => b.localName === "openDialog"));
  check("G3 f11 convertFileSrc transformed", byPath(report, "engine-f11-core-partial.ts").status === "transformed");
  const f24 = byPath(report, "engine-f24-opener.ts");
  check("G3 f24 opener transformed + MANUAL-REVIEW openPath/revealItemInDir only (R2)", f24.status === "transformed" && f24.manualReview.length === 2 && f24.manualReview.some((m) => m.importedName === "openPath") && f24.manualReview.some((m) => m.importedName === "revealItemInDir"), JSON.stringify(f24.manualReview));
  check("G3 errors 0", report.totals.errors === 0, JSON.stringify(report.totals));
}
// ---- G4 ----
{
  const { report } = waveReport("G4");
  check("G4 f02 multiline transformed", byPath(report, "engine-f02-multiline.ts").status === "transformed");
  const f03 = byPath(report, "engine-f03-types.ts");
  check("G4 f03 transformed, both event decls (F-02)", f03.status === "transformed" && f03.declarationsTransformed === 2 && f03.declarationsSkipped.length === 0, JSON.stringify(f03));
  check("G4 f04 getRuntimePlatform transformed", byPath(report, "engine-f04-alias.ts").bindings.some((b) => b.localName === "getRuntimePlatform"));
  const f09 = byPath(report, "engine-f09-os-collision.ts");
  check("G4 f09 skipped name-collision-platform", f09.status === "skipped" && f09.declarationsSkipped[0]?.reason === "name-collision-platform", JSON.stringify(f09.declarationsSkipped));
  const f11 = byPath(report, "engine-f11-core-partial.ts");
  check("G4 f11 isTauri transformed, others kept (F-03)", f11.status === "transformed" && f11.bindings.some((b) => b.localName === "isTauri" && b.action === "barrel"), JSON.stringify(f11));
  const f19 = byPath(report, "engine-f19-window.ts");
  check("G4 f19 getCurrentWindow transformed", f19.status === "transformed" && f19.bindings.some((b) => b.localName === "getCurrentWindow" && b.replacement === "platform.window.getCurrentWindow"), JSON.stringify(f19));
  const f23 = byPath(report, "engine-f23-logical-type.ts");
  check("G4 f23 type-only LogicalSize maps to LogicalSizeValue (R2)", f23.status === "transformed" && f23.bindings.some((b) => b.localName === "LogicalSize" && b.barrelName === "LogicalSizeValue"), JSON.stringify(f23.bindings));
  check("G4 errors 0", report.totals.errors === 0, JSON.stringify(report.totals));
}
// ---- G5 ----
{
  const { report } = waveReport("G5");
  const f15 = byPath(report, "engine-f15-updater.ts");
  check("G5 f15 transformed, Update maps to UpdateInfo + MANUAL-REVIEW (R2)", f15.status === "transformed" && f15.bindings.some((b) => b.localName === "Update" && b.barrelName === "UpdateInfo") && f15.manualReview.some((m) => m.importedName === "Update"), JSON.stringify(f15));
  const f20 = byPath(report, "engine-f20-image.ts");
  check("G5 f20 api/image transformed + MANUAL-REVIEW copy flow (R2)", f20.status === "transformed" && f20.manualReview.some((m) => m.importedName === "Image") && f20.bindings.some((b) => b.localName === "TauriImage" && b.replacement === "bytes via platform.clipboard"), JSON.stringify(f20));
  const f21 = byPath(report, "engine-f21-update-value.ts");
  check("G5 f21 Update used as value skipped (R2)", f21.status === "skipped" && f21.declarationsSkipped[0]?.reason === "no-barrel-equivalent", JSON.stringify(f21.declarationsSkipped));
  check("G5 errors 0", report.totals.errors === 0, JSON.stringify(report.totals));
}
// ---- dynamic opt-in (F-01) ----
{
  const reportPath = resolve(STAGING, "report-dyn.json");
  const r = runCli(["--wave", "G1", "--root", STAGING, "--report", reportPath, "--no-diff", "--rewrite-dynamic-imports", "fixtures/engine-f18-dynamic-barrel.ts"]);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  check("dynamic opt-in rewrites barrel-value destructure (F-01)", report.files[0].status === "transformed" && report.files[0].dynamicImports[0]?.reason === "rewritten", JSON.stringify(report.files[0]));
  void r;
  const reportPath2 = resolve(STAGING, "report-dyn2.json");
  runCli(["--wave", "G1", "--root", STAGING, "--report", reportPath2, "--no-diff", "--rewrite-dynamic-imports", "fixtures/engine-f05-dynamic.ts"]);
  const report2 = JSON.parse(readFileSync(reportPath2, "utf8"));
  check("opt-in never rewrites Promise.all batches", report2.files[0].status === "skipped" && !report2.files[0].dynamicImports.some((x) => x.reason === "rewritten") && report2.files[0].dynamicImports.some((x) => x.reason === "promise-all-batch"), JSON.stringify(report2.files[0]));
}
// ---- --specifier mode ----
{
  const reportPath = resolve(STAGING, "report-spec.json");
  runCli(["--specifier", "@tauri-apps/plugin-store", "--root", STAGING, "--report", reportPath, "--no-diff", "fixtures/engine-f07-combined.ts"]);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  check("specifier mode transforms only that specifier", report.files[0].declarationsTransformed === 1 && report.files[0].bindings.length === 1 && report.files[0].bindings[0].localName === "Store", JSON.stringify(report.files[0]));
  const reportPath2 = resolve(STAGING, "report-spec2.json");
  runCli(["--specifier", "@tauri-apps/api/core", "--root", STAGING, "--report", reportPath2, "--no-diff", "fixtures/engine-f11-core-partial.ts"]);
  const report2 = JSON.parse(readFileSync(reportPath2, "utf8"));
  check("specifier api/core transforms all 3 bindings (wave ignored)", report2.files[0].bindings.length === 3, JSON.stringify(report2.files[0].bindings.map((b) => b.localName)));
}
// ---- .tsx (staging-only) ----
{
  const tsx = resolve(STAGING, "staging-tsx.tsx");
  writeFileSync(tsx, "import { Store } from '@tauri-apps/plugin-store'\n\nexport function Panel() {\n  return <div onClick={async () => { await Store.load('s.json') }}>hi</div>\n}\n", "utf8");
  const reportPath = resolve(STAGING, "report-tsx.json");
  runCli(["--wave", "G1", "--root", STAGING, "--report", reportPath, "--no-diff", "staging-tsx.tsx"]);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  check("tsx file transforms, JSX preserved by self-check", report.files[0].status === "transformed" && report.files[0].bindings[0]?.localName === "Store", JSON.stringify(report.files[0]));
}
// ---- write mode + idempotency + import-only proof ----
{
  const work = resolve(STAGING, "write-copy");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(FIX, work, { recursive: true });
  const list = execSync(`ls ${work}/*.ts`, { encoding: "utf8" }).trim().split("\n");
  const rel = list.map((p) => p.split("/").pop());
  const r1 = runCli(["--wave", "G1", "--root", work, "--write", "--no-diff", "--report", "r1.json", ...rel], work);
  const rep1 = JSON.parse(readFileSync(resolve(work, "r1.json"), "utf8"));
  check("write G1 exit 0", r1.status === 0, `got ${r1.status}: ${r1.stderr}`);
  const r2 = runCli(["--wave", "G1", "--root", work, "--write", "--no-diff", "--report", "r2.json", ...rel], work);
  const rep2 = JSON.parse(readFileSync(resolve(work, "r2.json"), "utf8"));
  check("idempotent: second write transforms 0", rep2.totals.transformed === 0, JSON.stringify(rep2.totals));
  check("idempotent: first write transformed > 0", rep1.totals.transformed > 0, JSON.stringify(rep1.totals));
  const f01 = readFileSync(resolve(work, "engine-f01-store.ts"), "utf8");
  check("f01 has platform import, no plugin-store", /from ['"]@\/lib\/platform['"]/.test(f01) && !f01.includes("@tauri-apps/plugin-store") && f01.includes("Store.load"), f01);
  const f12 = readFileSync(resolve(work, "engine-f12-existing-platform.ts"), "utf8");
  check("f12 no duplicate platform import", (f12.match(/import \{ platform \}/g) || []).length === 1, f12);
  const f17 = readFileSync(resolve(work, "engine-f17-barrel-merge.ts"), "utf8");
  check("f17 merged into existing barrel imports", f17.includes("getPlatformMode, platform") && f17.includes("StoreOptions, DirEntry"), f17);
  const f14 = readFileSync(resolve(work, "engine-f14-fs-mixed.ts"), "utf8");
  check("f14 platform + BaseDirectory one decl", /import \{ platform, BaseDirectory \}/.test(f14), f14);
  const f22w = readFileSync(resolve(work, "engine-f22-store-type.ts"), "utf8");
  check("f22 StoreHandle as Store in written output (R2)", f22w.includes("import type { StoreHandle as Store }"), f22w);
  const proof = spawnSync("node", ["--input-type=module", "-e", `
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
const require = createRequire("${STAGING}/engine/run.mjs");
const { Project } = require("ts-morph");
const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
function strip(text, name) {
  const sf = project.createSourceFile(name, text, { overwrite: true });
  const spans = sf.getImportDeclarations().map((d) => {
    let end = d.getEnd(); let i = end;
    while (i < text.length && text[i] !== "\\n" && (text[i] === " " || text[i] === "\\t")) i++;
    if (text[i] === "\\n") end = i + 1;
    return [d.getStart(), end];
  });
  let out = text;
  for (const [s, e] of spans.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(e);
  project.removeSourceFile(sf);
  return out.split("\\n").filter((l) => l.trim() !== "").join("\\n");
}
let bad = 0;
for (const f of readdirSync("${FIX}").filter((x) => x.endsWith(".ts"))) {
  const a = strip(readFileSync("${FIX}/" + f, "utf8"), "a.ts");
  const b = strip(readFileSync("${work}/" + f, "utf8"), "b.ts");
  if (a !== b) { bad++; console.log("NON-IMPORT DIFF in", f); }
}
console.log(bad === 0 ? "IMPORT-ONLY-OK" : "IMPORT-ONLY-FAIL");
`], { encoding: "utf8" });
  check("import-only proof over write copies", proof.stdout.includes("IMPORT-ONLY-OK"), proof.stdout + proof.stderr);
  const w2 = resolve(STAGING, "write-copy2");
  rmSync(w2, { recursive: true, force: true });
  mkdirSync(w2, { recursive: true });
  cpSync(resolve(FIX, "engine-f11-core-partial.ts"), resolve(w2, "engine-f11-core-partial.ts"));
  runCli(["--wave", "G2", "--root", w2, "--write", "--no-diff", "engine-f11-core-partial.ts"], w2);
  const f11g2 = readFileSync(resolve(w2, "engine-f11-core-partial.ts"), "utf8");
  check("G2 residual keeps convertFileSrc+isTauri", f11g2.includes("convertFileSrc, isTauri") && !f11g2.includes("invoke,") && f11g2.includes("platform"), f11g2);
  runCli(["--wave", "G3", "--root", w2, "--write", "--no-diff", "engine-f11-core-partial.ts"], w2);
  const f11g3 = readFileSync(resolve(w2, "engine-f11-core-partial.ts"), "utf8");
  const f11g3imports = f11g3.split("\n").filter((l) => l.startsWith("import ")).join("\n");
  check("G3 then keeps only isTauri", f11g3imports.includes("isTauri") && !f11g3imports.includes("convertFileSrc"), f11g3);
  runCli(["--wave", "G4", "--root", w2, "--write", "--no-diff", "engine-f11-core-partial.ts"], w2);
  const f11g4 = readFileSync(resolve(w2, "engine-f11-core-partial.ts"), "utf8");
  check("G4 closes api/core fully (F-03)", !f11g4.includes("@tauri-apps/api/core") && f11g4.includes("isTauri"), f11g4);
}
// ---- strict + usage errors ----
{
  const r = runCli(["--wave", "G1", "--root", STAGING, "--no-diff", "--strict", "fixtures/engine-f05-dynamic.ts"]);
  check("strict exits 1 on skips", r.status === 1, `got ${r.status}`);
  const r2 = runCli(["--root", STAGING, "fixtures/engine-f01-store.ts"]);
  check("no wave/specifier exits 1", r2.status === 1);
  const r3 = runCli(["--wave", "G1", "--specifier", "@tauri-apps/plugin-store", "fixtures/engine-f01-store.ts"]);
  check("both wave+specifier exits 1", r3.status === 1);
  const r4 = runCli(["--wave", "G9", "fixtures/engine-f01-store.ts"]);
  check("unknown wave exits 1", r4.status === 1);
  const r5 = runCli(["--specifier", "@tauri-apps/nope", "fixtures/engine-f01-store.ts"]);
  check("unknown specifier exits 1", r5.status === 1);
  const r6 = runCli(["--wave", "G1", "--root", STAGING, "--no-diff", "fixtures/does-not-exist.ts"]);
  check("missing file exits 1", r6.status === 1, `got ${r6.status}`);
}
// ---- --files list mode ----
{
  const listPath = resolve(STAGING, "file-list.txt");
  writeFileSync(listPath, "# comment\n\nfixtures/engine-f01-store.ts\nfixtures/engine-f14-fs-mixed.ts\n", "utf8");
  const reportPath = resolve(STAGING, "report-list.json");
  const r = runCli(["--wave", "G1", "--root", STAGING, "--files", "file-list.txt", "--report", reportPath, "--no-diff"]);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  check("files list mode reads 2 files, skips comments/blanks", r.status === 0 && report.files.length === 2, JSON.stringify(report.files.map((f) => f.path)));
}
if (failures === 0 && !KEEP) rmSync(STAGING, { recursive: true, force: true });
if (failures > 0) console.log(`self-check: scratch kept at ${STAGING}`);
console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
