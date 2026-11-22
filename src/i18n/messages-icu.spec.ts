// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// DA-6 F28-1: every catalog string must parse as ICU
// MessageFormat. Two mermaid ER templates carried an unquoted
// "o{" (MALFORMED_ARGUMENT) and one R2 hint carried an unquoted
// "<ACCOUNT_ID>" (UNCLOSED_TAG); next-intl has no onError
// fallback configured, so invalid strings break at render time.
// This spec parses both catalogs end to end so the class cannot
// return silently. Key parity en/zh is asserted here too.
//
// Run: `pnpm vitest run --project unit src/i18n/messages-icu.spec.ts`

import { createRequire } from "node:module";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

type IntlMessageFormatCtor = new (message: string, locale?: string) => unknown;

function loadIntlMessageFormat(): IntlMessageFormatCtor {
  const require = createRequire(import.meta.url);
  // intl-messageformat is a transitive dependency (via use-intl);
  // resolve it through the packages that depend on it instead of
  // adding a direct dependency for a test-only gate.
  try {
    return require("intl-messageformat").IntlMessageFormat as IntlMessageFormatCtor;
  } catch {
    const useIntlDir = dirname(require.resolve("use-intl", {
      paths: [dirname(require.resolve("next-intl"))],
    }));
    return require(require.resolve("intl-messageformat", { paths: [useIntlDir] }))
      .IntlMessageFormat as IntlMessageFormatCtor;
  }
}

function leafStrings(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") {
    out.push([path, value]);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      leafStrings(child, path ? `${path}.${key}` : key, out);
    }
  }
}

describe("message catalogs (DA-6 F28-1)", () => {
  it("parses every en and zh string as ICU MessageFormat", () => {
    const IntlMessageFormat = loadIntlMessageFormat();
    const failures: string[] = [];
    for (const [locale, catalog] of [["en", en], ["zh", zh]] as const) {
      const leaves: Array<[string, string]> = [];
      leafStrings(catalog, "", leaves);
      for (const [path, message] of leaves) {
        try {
          new IntlMessageFormat(message, locale);
        } catch (error) {
          failures.push(`${locale}:${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps en and zh key sets identical", () => {
    const enLeaves: Array<[string, string]> = [];
    const zhLeaves: Array<[string, string]> = [];
    leafStrings(en, "", enLeaves);
    leafStrings(zh, "", zhLeaves);
    expect(zhLeaves.map(([path]) => path).sort()).toEqual(enLeaves.map(([path]) => path).sort());
  });
});
