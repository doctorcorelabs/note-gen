// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Filesystem contract suite entry: the parameterized cases from
// fs-cases.ts run against the fake in-memory filesystem.
//
// Factories: fake only. Web and Tauri factories are registered by the
// integrator in tests/contract/implementations/ once the adapters
// land; the Tauri column runs only with CONTRACT_TAURI=1 and must
// never block PRs. The web factory must implement writeExternally()
// with a direct write that bypasses the adapter under test.

import { defineContractSuite } from "./contract-harness";
import type { ContractFactory } from "./contract-harness";
import type { FsAdapter } from "./contract-types";
import { createFakeFsAdapter, FakeFsAdapter } from "../fakes/fake-fs";
import { defineFsCases, type FsContractFactory } from "./fs-cases";

const fakeFactory: FsContractFactory = {
  name: "fake",
  create: () => createFakeFsAdapter(),
  writeExternally: async (impl, path, content) => {
    if (!(impl instanceof FakeFsAdapter)) {
      throw new Error(
        "Filesystem contract factory can only write externally through a fake filesystem adapter",
      );
    }
    await impl.simulateExternalWrite(path, content);
  },
};

defineContractSuite<FsAdapter>(
  "Filesystem contract",
  [fakeFactory as ContractFactory<FsAdapter>],
  defineFsCases,
);
