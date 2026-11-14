// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// SQL contract suite entry: the parameterized cases from sql-cases.ts
// run against the fake in-memory SQL adapter.
//
// Factories: fake only. This fake proves the cases are runnable and
// can detect violations; it does NOT replace the Postgres contract
// required by fase1/desain-pengujian.md section 2.4 (R2). The
// Postgres-backed factory is registered by the integrator, and the
// deferred cases listed in tests/contract/README.md run against real
// Postgres 17, never against this fake. The Tauri column (SQLite)
// runs only with CONTRACT_TAURI=1 and must never block PRs.

import { defineContractSuite } from "./contract-harness";
import { defineSqlCases } from "./sql-cases";
import type { SqlAdapter } from "./contract-types";
import { createFakeSqlAdapter } from "../fakes/fake-sql";

defineContractSuite<SqlAdapter>(
  "SQL contract",
  [
    {
      name: "fake",
      create: () => createFakeSqlAdapter(),
      teardown: async (impl) => {
        await impl.close();
      },
    },
  ],
  (getImpl) => defineSqlCases(getImpl),
);
