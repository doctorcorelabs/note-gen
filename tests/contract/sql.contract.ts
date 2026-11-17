// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// SQL contract suite entry: the parameterized cases from sql-cases.ts
// run against the fake in-memory adapter, the real web adapter over
// a fake DB endpoint, and (when SQL_CONTRACT_DATABASE_URL is set)
// the real server dispatch over Postgres.
//
// The fake proves the cases are runnable and can detect violations;
// it does NOT replace the Postgres contract required by
// fase1/desain-pengujian.md section 2.4 (R2). The Postgres column
// runs only when SQL_CONTRACT_DATABASE_URL points at a scratch
// database; when the variable is unset the column is absent, never
// silently skipped. The deferred cases listed in
// tests/contract/README.md run against real Postgres 17, never
// against the fake. The Tauri column (SQLite) runs only with
// CONTRACT_TAURI=1 and must never block PRs.
//
// Cases that need server behavior stubbed with 410 in Fase 1
// (vector.replaceChunks, wiki.commitRevision) run on the fake leg
// only; see the header of sql-cases.ts and EXCEPTIONS.md E13-E14.

import { defineContractSuite, type ContractFactory } from "./contract-harness";
import { defineSqlCases } from "./sql-cases";
import type { SqlAdapter } from "./contract-types";
import { createFakeSqlAdapter } from "../fakes/fake-sql";
import { postgresSqlFactory } from "./implementations/postgres";
import { webSqlFactory } from "./implementations/web-sql";

const factories: ContractFactory<SqlAdapter>[] = [
  {
    name: "fake",
    create: () => createFakeSqlAdapter(),
    teardown: async (impl) => {
      await impl.close();
    },
  },
  webSqlFactory,
];

if (postgresSqlFactory !== null) {
  factories.push(postgresSqlFactory);
}

defineContractSuite<SqlAdapter>(
  "SQL contract",
  factories,
  (getImpl, factory) => defineSqlCases(getImpl, factory),
);
