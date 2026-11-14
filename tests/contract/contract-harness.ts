// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Parameterized contract harness (fase1/desain-pengujian.md section 2.1).
//
// One suite, many implementations: the same cases run once per factory,
// each case against a fresh instance from beforeEach, with no shared state
// between cases or implementations. A case receives the implementation
// through getImpl() so the same case body serves every factory.
//
// Current factories: fake only. Web and Tauri factories are registered by
// the integrator in tests/contract/implementations/ once the adapters
// land; the Tauri column runs only with CONTRACT_TAURI=1 and must never
// block PRs. This harness does not invent factories for implementations
// that do not exist yet.

import { afterEach, beforeEach, describe } from "vitest";

export interface ContractFactory<T> {
  name: string;
  create: () => Promise<T> | T;
  teardown?: (impl: T) => Promise<void> | void;
}

export function defineContractSuite<T>(
  suiteName: string,
  factories: ContractFactory<T>[],
  defineCases: (
    getImpl: () => T,
    factory: ContractFactory<T>,
  ) => void,
): void {
  for (const factory of factories) {
    describe(`${suiteName} [impl=${factory.name}]`, () => {
      let impl: T;

      beforeEach(async () => {
        impl = await factory.create();
      });

      afterEach(async () => {
        if (factory.teardown) {
          await factory.teardown(impl);
        }
      });

      // The factory itself is passed so cases can use factory-provided
      // helpers that differ per implementation (reopening a store over
      // the same backing, writing a file from outside the adapter).
      // Factories may carry extra fields beyond ContractFactory; case
      // files define their own factory interface for those.
      defineCases(() => impl, factory);
    });
  }
}

// Names of the implementations a suite actually ran against, for reports.
// A missing implementation is never reported as skipped; it is absent.
export function implementationsUnderTest(
  factories: readonly ContractFactory<unknown>[],
): string {
  return factories.map((factory) => factory.name).join(", ");
}
