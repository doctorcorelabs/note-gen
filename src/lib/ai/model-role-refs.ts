// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-06): pure predicates deciding whether a stored model
// role value (primaryModel, editorModel, ...) still points at a
// model or provider that is being deleted. Role values use three
// formats (see getAISettingsByModelId): bare model id, composite
// `${configKey}-${modelId}`, and legacy bare config key.

export function roleValueReferencesModel(
  value: string,
  configKey: string,
  modelId: string,
): boolean {
  if (!value) return false
  return value === modelId || value === `${configKey}-${modelId}`
}

export function roleValueReferencesConfig(
  value: string,
  configKey: string,
  modelIds: string[],
): boolean {
  if (!value) return false
  if (value === configKey || value.startsWith(`${configKey}-`)) return true
  return modelIds.includes(value)
}
