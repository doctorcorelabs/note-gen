// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-01, SET-13): pure helpers for ModelSelect, extracted
// so the grouping and persist ordering can be unit tested
// without the component graph.

import type { ModelConfig } from "../../setting/config"

export interface GroupedModel {
  configKey: string
  configTitle: string
  model: ModelConfig
}

export interface ModelGroup {
  configKey: string
  configTitle: string
  items: GroupedModel[]
}

// SET-13: group by provider key, not title. Two providers that
// share a title (common after copying a provider) stay separate
// groups; the title is only the heading label. Group order
// follows first appearance.
export function groupModelsByConfig(models: GroupedModel[]): ModelGroup[] {
  const groups: ModelGroup[] = []
  const byKey = new Map<string, ModelGroup>()
  for (const item of models) {
    let group = byKey.get(item.configKey)
    if (!group) {
      group = { configKey: item.configKey, configTitle: item.configTitle, items: [] }
      byKey.set(item.configKey, group)
      groups.push(group)
    }
    group.items.push(item)
  }
  return groups
}

export interface ModelSelectionStore {
  set: (key: string, value: string) => Promise<void>
  save: () => Promise<void>
}

// SET-01: the set must complete before save flushes, and a
// rejected set must reach the caller instead of becoming an
// unhandled rejection next to a successful empty save.
export async function persistModelSelection(
  store: ModelSelectionStore,
  key: string,
  value: string,
): Promise<void> {
  await store.set(key, value)
  await store.save()
}
