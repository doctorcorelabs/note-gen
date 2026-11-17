// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// F122-Q1 (W4-F122Q): runtime guard over the four username API sites
// without JSON body validation. The guard itself is tested at runtime;
// the wiring of each call site is pinned by reading the source files,
// following the static-pin precedent of no-platform-shadowing.spec.ts
// (no application module is imported for the wiring checks, so the
// heavy sync/store graph is never loaded here).
//
// Runner: Vitest, unit project (vitest run --project unit).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  requireApiUsername,
  type ApiUsernameProvider,
} from "./api-username";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("requireApiUsername (F122-Q1)", () => {
  it("returns a non-empty string username unchanged", () => {
    expect(requireApiUsername("octocat", "GitHub")).toBe("octocat");
    expect(requireApiUsername("gitea-user", "Gitea")).toBe("gitea-user");
    expect(requireApiUsername("gitlab-user", "Gitlab")).toBe("gitlab-user");
  });

  it.each([
    ["GitHub", undefined],
    ["GitHub", null],
    ["GitHub", ""],
    ["GitHub", 42],
    ["GitHub", {}],
    ["Gitea", undefined],
    ["Gitea", ""],
    ["Gitlab", undefined],
    ["Gitlab", ""],
  ] as Array<[ApiUsernameProvider, unknown]>)(
    "throws an API validation error for %s with %s",
    (provider, value) => {
      expect(() => requireApiUsername(value, provider)).toThrow(
        new Error(`Invalid ${provider} user response`),
      );
    },
  );

  it("throws a plain Error, never a store error", () => {
    let thrown: unknown;
    try {
      requireApiUsername(undefined, "GitHub");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toHaveProperty("code", "invalid_argument");
    expect((thrown as Error).message).toBe("Invalid GitHub user response");
  });
});

describe("F122-Q1 call-site wiring", () => {
  const sites = [
    {
      file: "src/lib/sync/github.ts",
      key: "githubUsername",
      pattern:
        /store\.set\('githubUsername',\s*requireApiUsername\(data\.login,\s*"GitHub"\)\)/,
    },
    {
      file: "src/lib/sync/gitea.ts",
      key: "giteaUsername",
      pattern:
        /store\.set\('giteaUsername',\s*requireApiUsername\(userInfo\.login,\s*"Gitea"\)\)/,
    },
    {
      file: "src/lib/sync/gitlab.ts",
      key: "gitlabUsername",
      pattern:
        /store\.set\('gitlabUsername',\s*requireApiUsername\(userInfo\.username,\s*"Gitlab"\)\)/,
    },
    {
      file: "src/stores/imageHosting.ts",
      key: "githubImageUsername",
      pattern:
        /store\.set\('githubImageUsername',\s*requireApiUsername\(imageRepoUserInfo\?\.data\?\.login,\s*"GitHub"\)\)/,
    },
  ] as const;

  it.each(sites)(
    "$file guards the $key write through requireApiUsername",
    ({ file, pattern }) => {
      const source = readSource(file);
      expect(source).toContain("requireApiUsername");
      expect(source).toMatch(pattern);
    },
  );

  it("leaves the Gitee inline guard in place as the precedent", () => {
    const source = readSource("src/lib/sync/gitee.ts");
    expect(source).toContain(
      "if (typeof data?.login !== 'string' || !data.login) throw new Error('Invalid Gitee user response')",
    );
    expect(source).toContain("await store.set('giteeUsername', data.login);");
  });
});
