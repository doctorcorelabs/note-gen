// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Run the adapter node:test suites with asserted per-file counts
// (AD-36; finding T1 in fase1/audit-workflow-ci.md).
//
// The 15 TypeScript spec/test files under src/lib/platform and the
// 3 under src/lib/web (V3-30a plus the V3-28 search client) use
// node:test, not Vitest. Vitest collects the *.spec.ts files but
// counts 0 tests from them, and
// its unit project does not include the *.test.ts files at all, so
// `vitest run --project unit --passWithNoTests` used to exit 0
// with "no tests" while proving nothing. This runner closes that
// gap the same way the wave 2 integrator reran the suites: bundle
// each file with esbuild (the sources use extensionless
// bundler-style imports that raw Node cannot resolve), run the
// bundle under `node --test` with the TAP reporter, and assert a
// real counted result per file.
//
// Since V3-30b the tree also holds one Vitest-style suite,
// src/lib/web/csrf.spec.ts, which this runner must never execute
// (it would fail on the wrong runner, not on the code). It runs in
// the Vitest leg of `pnpm test:unit`; VITEST_SPECS below keeps the
// discovery guard from flagging it. The three node:test suites under
// src/lib/web run here like the platform suites: leaving them out
// would orphan their counted tests from `pnpm test`.
//
// The file lists below are explicit on purpose, matching the legacy
// spec list in .github/workflows/web-ci.yml: a listed file that is
// missing, a file with 0 counted tests, a file with any failure,
// and any *.spec.ts/*.test.ts file under src/lib/platform or
// src/lib/web that is in neither list nor the Vitest allowlist all
// fail this script. Add a new suite deliberately when it lands; do
// not let the suite grow or shrink silently.
//
// New node:test suites must use node:test (node:assert/strict), the
// style every file in the lists already uses. A Vitest-style suite
// would fail loudly here instead of passing vacuously; one already
// exists (csrf.spec.ts), so the unit wiring runs both runners
// (`pnpm test:unit`): this script plus `vitest run --project
// unit`. Never force a Vitest-style suite through this runner.
//
// Usage: pnpm test:adapter (the first leg of pnpm test:unit, so
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
const WEB_DIR = join(REPO_ROOT, "src", "lib", "web");
const ESBUILD_BIN = join(REPO_ROOT, "node_modules", ".bin", "esbuild");

// Explicit list, sorted. See the header: this list is the suite.
const ADAPTER_SPECS = [
  "src/lib/platform/__tests__/v2-12-web-dialog-opener-clipboard.spec.ts",
  "src/lib/platform/__tests__/v3b-11c-registry-wiring.spec.ts",
  "src/lib/platform/asset/asset.web.test.ts",
  "src/lib/platform/autostart/autostart.web.spec.ts",
  "src/lib/platform/dialog/dialog-wiring.spec.ts",
  "src/lib/platform/event/event.bus.test.ts",
  "src/lib/platform/fs/fs.web.contract.test.ts",
  "src/lib/platform/http/http.web.test.ts",
  "src/lib/platform/invoke/channel.web.spec.ts",
  "src/lib/platform/invoke/router.spec.ts",
  "src/lib/platform/notification/notification.fallback.test.ts",
  "src/lib/platform/os/os.web.test.ts",
  "src/lib/platform/path/path.web.contract.test.ts",
  "src/lib/platform/process/process.web.spec.ts",
  "src/lib/platform/shell/shell.web.spec.ts",
  "src/lib/platform/shortcut/shortcut.registry.test.ts",
  "src/lib/platform/store/key-schema.spec.ts",
  "src/lib/platform/store/poc-cleanup.spec.ts",
  "src/lib/platform/store/store.fake.spec.ts",
  "src/lib/platform/store/store.tauri.spec.ts",
  "src/lib/platform/store/store.web.spec.ts",
  "src/lib/platform/updater/updater.web.spec.ts",
];

// Node:test suites under src/lib/web (V3-30a). Same runner, same
// asserted-count contract; the discovery guard below covers both
// directories.
const WEB_NODE_SPECS = [
  "src/lib/web/api-client.spec.ts",
  "src/lib/web/errors.spec.ts",
  "src/lib/web/platform-boot.spec.ts",
  "src/lib/web/search-client.spec.ts",
];

// Vitest-style suites, run by `vitest run --project unit` (the second
// leg of `pnpm test:unit`), never through this runner. Listed here so
// the discovery guard does not mistake them for unlisted node:test
// files in either directory. The Vitest unit project excludes the
// node:test lists below (see vitest.config.ts); keep the two in
// sync. A Vitest-style suite must never be added to the node:test
// lists: it would fail loudly here instead of passing.
const VITEST_SPECS = [
  "src/lib/platform/sql/db-client.spec.ts",
  "src/lib/platform/sql/reconciled-forms.spec.ts",
  "src/lib/platform/sql/sql.tauri.spec.ts",
  "src/lib/platform/sql/sql.web.spec.ts",
  "src/lib/web/auth-client.spec.ts",
  "src/lib/web/csrf.spec.ts",
  "src/lib/web/record-assets.spec.ts",
  "src/lib/web/record-inputs.spec.ts",
  "src/lib/web/records-client.spec.ts",
  "src/lib/web/records-kind-client.spec.ts",
  "src/lib/web/security-settings.spec.ts",
  "src/lib/web/tag-inputs.spec.ts",
  "src/lib/web/watcher-client.spec.ts",
];

const NODE_TEST_SPECS = [...ADAPTER_SPECS, ...WEB_NODE_SPECS];

// Specs that need --test-force-exit: they open persistent handles
// (BroadcastChannel) that keep the event loop alive after the tests
// finish, hanging the runner without the flag. The flag must stay
// per-spec: applied globally it truncates other specs' counts.
const FORCE_EXIT_SPECS = new Set([
  "src/lib/platform/__tests__/v3b-11c-registry-wiring.spec.ts",
  "src/lib/web/platform-boot.spec.ts",
]);

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
  // Per-spec --test-force-exit (see FORCE_EXIT_SPECS): only specs
  // that open persistent handles get the flag. A global flag was
  // tried and REVERTED: it silently cut counted tests in specs
  // without persistent handles (key-schema 49 to 36, store.fake
  // 25 to 23, errors 96 to 54 in run 3 of G-3B4 gating).
  const forceExit = FORCE_EXIT_SPECS.has(spec) ? ["--test-force-exit"] : [];
  const run = spawnSync(process.execPath, ["--test", ...forceExit, "--test-reporter=tap", bundle], { encoding: "utf8" });
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

  // Guard 1: the explicit lists must match what is on disk, exactly,
  // in both directories. Vitest-style files are subtracted from the
  // combined discovery before the comparison: they belong to the
  // Vitest leg of `pnpm test:unit`, not to this runner.
  const discovered = [...discoverSpecs(PLATFORM_DIR, []), ...discoverSpecs(WEB_DIR, [])]
    .filter((spec) => !VITEST_SPECS.includes(spec))
    .sort();
  const listed = [...NODE_TEST_SPECS].sort();
  const missing = listed.filter((spec) => !existsSync(join(REPO_ROOT, spec)));
  const unlisted = discovered.filter((spec) => !listed.includes(spec));
  if (missing.length > 0) {
    failures.push(`listed spec file(s) missing from the tree: ${missing.join(", ")}`);
  }
  if (unlisted.length > 0) {
    failures.push(
      `node:test spec/test file(s) under src/lib/platform or src/lib/web not in the explicit lists in scripts/run-adapter-tests.mjs: ${unlisted.join(", ")}. Add them deliberately or remove them; the suite must not grow silently. (Vitest-style suites belong in VITEST_SPECS plus the Vitest leg, not here.)`,
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
    let totalFail = 0;
    let totalSkipped = 0;
    const results = [];
    for (let i = 0; i < NODE_TEST_SPECS.length; i += 1) {
      const result = runOne(NODE_TEST_SPECS[i], i, workDir);
      results.push(result);
      if (result.counts) {
        totalTests += result.counts.tests;
        totalPass += result.counts.pass;
        totalFail += result.counts.fail;
        totalSkipped += result.counts.skipped || 0;
      }
      if (result.ok) {
        console.log(
          `PASS ${result.spec} tests=${result.counts.tests} pass=${result.counts.pass} fail=0 skipped=${result.counts.skipped || 0}`,
        );
      } else {
        console.log(`FAIL ${result.spec}${result.counts ? ` tests=${result.counts.tests} pass=${result.counts.pass} fail=${result.counts.fail}` : ""}`);
        console.log(result.detail);
      }
    }
    const passedFiles = results.filter((r) => r.ok).length;
    if (passedFiles !== NODE_TEST_SPECS.length) {
      console.error(
        `ADAPTER TESTS FAILED: ${passedFiles}/${NODE_TEST_SPECS.length} files passed, ${totalTests} tests counted, ${totalPass} passed, ${totalFail} failed, ${totalSkipped} skipped.`,
      );
      process.exit(1);
    }
    console.log(
      `ADAPTER TESTS: ${passedFiles}/${NODE_TEST_SPECS.length} files, ${totalTests} tests, ${totalPass} passed, 0 failed, ${totalSkipped} skipped.`,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main();
