// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Run the adapter node:test suites with asserted per-file counts
// (AD-36; finding T1 in fase1/audit-workflow-ci.md).
//
// The 15 TypeScript spec/test files under src/lib/platform use
// node:test, not Vitest. Vitest collects the 7 *.spec.ts files but
// counts 0 tests from them, and its unit project does not include
// the 8 *.test.ts files at all, so `vitest run --project unit
// --passWithNoTests` used to exit 0 with "no tests" while proving
// nothing. This runner closes that gap the same way the wave 2
// integrator reran the suites: bundle each file with esbuild
// (the sources use extensionless bundler-style imports that raw
// Node cannot resolve), run the bundle under `node --test` with
// the TAP reporter, and assert a real counted result per file.
//
// The file list below is explicit on purpose, matching the legacy
// spec list in .github/workflows/web-ci.yml: a listed file that is
// missing, a file with 0 counted tests, a file with any failure,
// and any *.spec.ts/*.test.ts file under src/lib/platform that is
// NOT in the list all fail this script. Add a new adapter suite
// here deliberately when it lands; do not let the suite grow or
// shrink silently.
//
// New adapter suites must use node:test (node:assert/strict), the
// style every file in the list already uses. A Vitest-style suite
// would fail loudly here instead of passing vacuously; if one ever
// lands, extend the unit wiring to run both runners instead of
// forcing it through this one.
//
// Usage: pnpm test:adapter (also wired as pnpm test:unit, so
// `pnpm test` runs the real suites). Requires `pnpm install`
// first, for the esbuild binary. Exit 0 only when every listed
// file ran with at least 1 counted passing test and 0 failures.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLATFORM_DIR = join(REPO_ROOT, "src", "lib", "platform");
const ESBUILD_BIN = join(REPO_ROOT, "node_modules", ".bin", "esbuild");

// Explicit list, sorted. See the header: this list is the suite.
const ADAPTER_SPECS = [
  "src/lib/platform/__tests__/v2-12-web-dialog-opener-clipboard.spec.ts",
  "src/lib/platform/asset/asset.web.test.ts",
  "src/lib/platform/autostart/autostart.web.spec.ts",
  "src/lib/platform/event/event.bus.test.ts",
  "src/lib/platform/fs/fs.web.contract.test.ts",
  "src/lib/platform/http/http.web.test.ts",
  "src/lib/platform/invoke/router.spec.ts",
  "src/lib/platform/notification/notification.fallback.test.ts",
  "src/lib/platform/os/os.web.test.ts",
  "src/lib/platform/path/path.web.contract.test.ts",
  "src/lib/platform/process/process.web.spec.ts",
  "src/lib/platform/shell/shell.web.spec.ts",
  "src/lib/platform/shortcut/shortcut.registry.test.ts",
  "src/lib/platform/store/store.fake.spec.ts",
  "src/lib/platform/updater/updater.web.spec.ts",
];

function discoverSpecs(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") discoverSpecs(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".test.ts"))) {
      out.push(relative(REPO_ROOT, full).split(sep).join("/"));
    }
  }
  return out;
}

function parseTapFooter(stdout) {
  const counts = {};
  for (const key of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const match = stdout.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    if (match) counts[key] = Number(match[1]);
  }
  if (counts.tests === undefined || counts.pass === undefined || counts.fail === undefined) return null;
  return counts;
}

function lastLines(text, n) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

function runOne(spec, index, workDir) {
  const source = join(REPO_ROOT, spec);
  const bundle = join(workDir, `adapter-${index}.mjs`);
  const esbuild = spawnSync(
    ESBUILD_BIN,
    [source, "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`],
    { encoding: "utf8" },
  );
  if (esbuild.status !== 0) {
    return { spec, ok: false, detail: `esbuild failed (exit ${esbuild.status}):\n${esbuild.stderr || esbuild.stdout || ""}` };
  }
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", bundle], { encoding: "utf8" });
  const stdout = run.stdout || "";
  const counts = parseTapFooter(stdout);
  if (counts === null) {
    return {
      spec,
      ok: false,
      detail: `no TAP summary footer found in node --test output (exit ${run.status}); output tail:\n${lastLines(stdout, 30)}\nstderr:\n${run.stderr || ""}`,
    };
  }
  const notOk = stdout.split("\n").filter((line) => /^\s*not ok /.test(line));
  const problems = [];
  if (run.status !== 0) problems.push(`node --test exited ${run.status}`);
  if (counts.tests < 1) problems.push(`0 counted tests (vacuous run)`);
  if (counts.pass < 1) problems.push(`0 counted passing tests`);
  if (counts.fail !== 0) problems.push(`${counts.fail} failing tests`);
  if ((counts.cancelled || 0) !== 0) problems.push(`${counts.cancelled} cancelled tests`);
  if (counts.pass + (counts.skipped || 0) !== counts.tests) {
    problems.push(`count mismatch: pass ${counts.pass} + skipped ${counts.skipped || 0} != tests ${counts.tests}`);
  }
  if (notOk.length > 0) problems.push(`${notOk.length} "not ok" TAP lines`);
  if (problems.length > 0) {
    return {
      spec,
      ok: false,
      counts,
      detail: `${problems.join("; ")}.\nOutput tail:\n${lastLines(stdout, 40)}\nstderr:\n${run.stderr || ""}`,
    };
  }
  return { spec, ok: true, counts };
}

function main() {
  const failures = [];

  if (!existsSync(ESBUILD_BIN)) {
    console.error(`ADAPTER TESTS FAILED: esbuild binary not found at ${ESBUILD_BIN}. Run \`pnpm install\` first.`);
    process.exit(1);
  }

  // Guard 1: the explicit list must match what is on disk, exactly.
  const discovered = discoverSpecs(PLATFORM_DIR, []).sort();
  const listed = [...ADAPTER_SPECS].sort();
  const missing = listed.filter((spec) => !existsSync(join(REPO_ROOT, spec)));
  const unlisted = discovered.filter((spec) => !listed.includes(spec));
  if (missing.length > 0) {
    failures.push(`listed spec file(s) missing from the tree: ${missing.join(", ")}`);
  }
  if (unlisted.length > 0) {
    failures.push(
      `adapter spec/test file(s) under src/lib/platform not in the explicit list in scripts/run-adapter-tests.mjs: ${unlisted.join(", ")}. Add them deliberately or remove them; the suite must not grow silently.`,
    );
  }
  if (failures.length > 0) {
    console.error(`ADAPTER TESTS FAILED:\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exit(1);
  }

  const workDir = mkdtempSync(join(tmpdir(), "notegen-adapter-tests-"));
  try {
    let totalTests = 0;
    let totalPass = 0;
    let totalSkipped = 0;
    const results = [];
    for (let i = 0; i < ADAPTER_SPECS.length; i += 1) {
      const result = runOne(ADAPTER_SPECS[i], i, workDir);
      results.push(result);
      if (result.ok) {
        totalTests += result.counts.tests;
        totalPass += result.counts.pass;
        totalSkipped += result.counts.skipped || 0;
        console.log(
          `PASS ${result.spec} tests=${result.counts.tests} pass=${result.counts.pass} fail=0 skipped=${result.counts.skipped || 0}`,
        );
      } else {
        console.log(`FAIL ${result.spec}${result.counts ? ` tests=${result.counts.tests} pass=${result.counts.pass} fail=${result.counts.fail}` : ""}`);
        console.log(result.detail);
      }
    }
    const passedFiles = results.filter((r) => r.ok).length;
    if (passedFiles !== ADAPTER_SPECS.length) {
      console.error(
        `ADAPTER TESTS FAILED: ${passedFiles}/${ADAPTER_SPECS.length} files passed, ${totalTests} tests counted, ${totalPass} passed.`,
      );
      process.exit(1);
    }
    console.log(
      `ADAPTER TESTS: ${passedFiles}/${ADAPTER_SPECS.length} files, ${totalTests} tests, ${totalPass} passed, 0 failed, ${totalSkipped} skipped.`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
