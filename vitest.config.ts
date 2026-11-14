// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Vitest configuration (fase1/desain-pengujian.md section 1.4).
//
// Two projects: `unit` for colocated TypeScript unit specs and
// `contract` for parameterized adapter contract suites. The adapter
// suites under src/lib/platform use node:test, not Vitest, so they
// are NOT run through this config: scripts/run-adapter-tests.mjs
// (pnpm test:unit / pnpm test:adapter) runs them with asserted
// per-file counts (AD-36). The `unit` project below stays for a
// future Vitest-style suite; running it today collects the
// node:test specs but counts 0 tests from them, which must never
// be read as a passing unit suite. There is deliberately no coverage
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
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["**/node_modules/**"],
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
