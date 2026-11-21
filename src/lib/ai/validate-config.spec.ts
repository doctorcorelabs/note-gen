// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-16): per-field validation of a resolved AiConfig.
// The apiKey check fires only when the template declares a key
// URL and no custom proxy can inject auth, so local providers
// without keys stay callable.
//
// Runner: Vitest, unit project (vitest run --project unit).

import { describe, expect, it } from "vitest";

import type { AiConfig } from "@/app/core/setting/config";
import { validateAiConfigFields } from "./validate-config";

function config(partial: Partial<AiConfig>): AiConfig {
  return { key: "cfg", title: "Test", ...partial };
}

describe("SET-16 validateAiConfigFields", () => {
  it("reports baseURL for an undefined config", () => {
    expect(validateAiConfigFields(undefined)).toEqual({ field: "baseURL" });
  });

  it("reports model when baseURL is set but the model name is empty", () => {
    expect(validateAiConfigFields(config({ baseURL: "https://x/v1", model: "" })))
      .toEqual({ field: "model" });
  });

  it("passes a local provider without apiKey or apiKeyUrl", () => {
    expect(validateAiConfigFields(config({
      baseURL: "http://localhost:11434/v1",
      model: "llama3",
    }))).toBeNull();
  });

  it("reports apiKey when the template declares a key URL and no key is set", () => {
    expect(validateAiConfigFields(config({
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKeyUrl: "https://platform.openai.com/api-keys",
      proxyMode: "direct",
    }))).toEqual({ field: "apiKey" });
  });

  it("passes when a custom proxy can inject auth", () => {
    expect(validateAiConfigFields(config({
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKeyUrl: "https://platform.openai.com/api-keys",
      proxyMode: "custom",
    }))).toBeNull();
  });

  it("passes a complete config", () => {
    expect(validateAiConfigFields(config({
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKey: "sk-test",
      apiKeyUrl: "https://platform.openai.com/api-keys",
    }))).toBeNull();
  });
});
