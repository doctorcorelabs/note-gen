// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Vitest configuration (fase1/desain-pengujian.md section 1.4).
//
// Two projects: `unit` for colocated TypeScript unit specs and
// `contract` for parameterized adapter contract suites. The `unit`
// project is empty until unit specs land; run it with
// --passWithNoTests (see the test:unit script) so the empty project
// does not fail the suite. There is deliberately no coverage
// threshold (desain-pengujian.md section 5.4) and no DOM environment.

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
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
          // One contract file is one adapter; files may run in
          // parallel, but cases inside one file share a per-case
          // fixture setup and must not share state across
          // implementations.
          fileParallelism: true,
        },
      },
    ],
  },
});
