// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Vitest configuration (fase1/desain-pengujian.md section 1.4).
//
// Two projects: `unit` for colocated TypeScript unit specs and
// `contract` for parameterized adapter contract suites. The
// node:test suites under src/lib/platform and src/lib/web are NOT
// run through this config: scripts/run-adapter-tests.mjs
// (pnpm test:adapter) runs them with asserted per-file counts
// (AD-36). The `unit` project below runs the Vitest-style suites
// (today: src/lib/web/csrf.spec.ts); the node:test specs are
// excluded below, mirroring the runner's lists (only the .spec.ts
// entries: this include never matches .test.ts). Keep the two in
// sync: every spec runs under exactly one runner, and a spec in
// neither scope fails loudly in one of them. `pnpm test:unit`
// runs both runners, so a vacuous run on either side fails.
// There is deliberately no coverage
// threshold (desain-pengujian.md section 5.4) and no DOM environment.

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // Contract files may run in parallel, but cases inside one file
    // share a per-case fixture setup and must not share state across
    // implementations. Vitest 3 only allows fileParallelism at the
    // top level (it is a NonProjectOption), not inside a project.
    fileParallelism: true,
    projects: [
      {
        // The root `plugins` entry above does not reach project
        // runs under Vitest 3 (proven 18 Nov 2026: a runtime `@/`
        // import failed until this entry landed). Without it no
        // unit spec can import a module that uses the `@/` alias,
        // which is every module under src/db and src/app.
        plugins: [tsconfigPaths()],
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          // Node:test specs, excluded here and run by
          // scripts/run-adapter-tests.mjs with asserted counts.
          // Mirrors the runner's .spec.ts lists; keep in sync.
          exclude: [
            "**/node_modules/**",
            "src/lib/platform/__tests__/v2-12-web-dialog-opener-clipboard.spec.ts",
            "src/lib/platform/__tests__/v3b-11c-registry-wiring.spec.ts",
            "src/lib/platform/autostart/autostart.web.spec.ts",
            "src/lib/platform/dialog/dialog-wiring.spec.ts",
            "src/lib/platform/invoke/channel.web.spec.ts",
            "src/lib/platform/invoke/router.spec.ts",
            "src/lib/platform/notification/in-app-toasts.spec.ts",
            "src/lib/platform/process/process.web.spec.ts",
            "src/lib/platform/shell/shell.web.spec.ts",
            "src/lib/platform/store/key-schema.spec.ts",
            "src/lib/platform/store/poc-cleanup.spec.ts",
            "src/lib/platform/store/store.fake.spec.ts",
            "src/lib/platform/store/store.tauri.spec.ts",
            "src/lib/platform/store/store.web.spec.ts",
            "src/lib/platform/updater/updater.web.spec.ts",
            "src/lib/web/api-client.spec.ts",
            "src/lib/web/boot-guard.spec.ts",
            "src/lib/web/errors.spec.ts",
            "src/lib/web/platform-boot.spec.ts",
            "src/lib/web/search-client.spec.ts",
            "src/lib/web/user-error-message.spec.ts",
          ],
        },
      },
      {
        test: {
          name: "contract",
          include: ["tests/contract/**/*.contract.ts"],
          exclude: ["**/node_modules/**"],
        },
      },
    ],
  },
});
