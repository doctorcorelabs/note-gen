// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Store contract suite entry: the parameterized cases from
// store-cases.ts run against the fake in-memory store and the real
// web adapter over a fake settings server.
//
// Factories: fake plus web. The web factory lives in
// implementations/web.ts. The Tauri factory is registered by the
// integrator in tests/contract/implementations/ once the adapter
// lands; the Tauri column runs only with CONTRACT_TAURI=1 and must
// never block PRs.
//
// The web column remaps arbitrary keys to catalogued S keys and
// asserts the real error taxonomy; see EXCEPTIONS.md E10-E12. The
// fake column assertions are unchanged.
//
// Negative control: with CONTRACT_BROKEN_STORE=1 this entry uses the
// deliberately broken fake (tests/fakes/broken-fake-store.ts) instead
// of the correct fake. That run is expected to FAIL: it proves the
// cases can detect contract violations. See tests/contract/README.md.

import { defineContractSuite } from "./contract-harness";
import type { ContractFactory } from "./contract-harness";
import type { StoreAdapter } from "./contract-types";
import { createBrokenFakeStoreAdapter } from "../fakes/broken-fake-store";
import {
  createFakeStoreAdapter,
  FakeStoreAdapter,
} from "../fakes/fake-store";
import {
  webCorruptStoreFactory,
  webStoreFactory,
} from "./implementations/web";
import {
  defineCorruptStoreCases,
  defineStoreCases,
  type StoreContractFactory,
} from "./store-cases";

const useBrokenFake = process.env.CONTRACT_BROKEN_STORE === "1";

function createStoreAdapter(backings?: FakeStoreAdapter["backings"]) {
  const options = backings === undefined ? {} : { backings };
  return useBrokenFake
    ? createBrokenFakeStoreAdapter(options)
    : createFakeStoreAdapter(options);
}

function reopen(impl: StoreAdapter): Promise<StoreAdapter> {
  if (impl instanceof FakeStoreAdapter) {
    return Promise.resolve(createStoreAdapter(impl.backings));
  }
  throw new Error(
    "Store contract factory can only reopen a fake store adapter",
  );
}

const fakeFactory: StoreContractFactory = {
  name: useBrokenFake ? "fake-broken" : "fake",
  create: () => createStoreAdapter(),
  teardown: async (impl) => {
    await impl.closeAll();
  },
  reopen,
};

defineContractSuite<StoreAdapter>(
  "Store contract",
  [
    fakeFactory as ContractFactory<StoreAdapter>,
    webStoreFactory as ContractFactory<StoreAdapter>,
  ],
  defineStoreCases,
);

// Corrupt-backing cases run in their own suite because they need a
// factory that fails on load(). The corrupt flag is fake-only; the
// web factory provides its own corrupt-backing construction (an
// unreachable backend; see implementations/web.ts and E12).
defineContractSuite<StoreAdapter>(
  "Store contract (corrupt backing)",
  [
    {
      name: "fake-corrupt",
      create: () => createFakeStoreAdapter({ corrupt: true }),
      teardown: async (impl) => {
        await impl.closeAll();
      },
    },
    webCorruptStoreFactory,
  ],
  (getImpl, factory) => defineCorruptStoreCases(getImpl, factory),
);
