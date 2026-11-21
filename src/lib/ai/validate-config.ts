// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-16): pure per-field validation for a resolved
// AiConfig (the shape getAISettingsByModelId returns, where
// `model` is the resolved model name). Returns the first missing
// field, or null when the config is callable. The apiKey check
// only fires when the provider template declares a key URL and
// no custom proxy can inject auth, so local providers (Ollama
// class) without keys stay callable.

import type { AiConfig } from "@/app/core/setting/config"

export type AiConfigField = "baseURL" | "model" | "apiKey"

export function validateAiConfigFields(
  config: AiConfig | undefined,
): { field: AiConfigField } | null {
  if (!config?.baseURL) return { field: "baseURL" }
  if (!config.model) return { field: "model" }
  if (!config.apiKey && config.apiKeyUrl && config.proxyMode !== "custom") {
    return { field: "apiKey" }
  }
  return null
}
