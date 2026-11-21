import { platform } from '@/lib/platform'
import type { KnowledgeSource, KnowledgeSourceType } from '@/types/knowledge'

export interface KnowledgeSettings {
  enabledSourceTypes: KnowledgeSourceType[]
  globalSemanticSearchEnabled: boolean
  semanticSearchEnabled: boolean
  indexPaused: boolean
}

export const DEFAULT_KNOWLEDGE_SETTINGS: KnowledgeSettings = {
  enabledSourceTypes: ['article', 'record', 'canvas'],
  globalSemanticSearchEnabled: true,
  semanticSearchEnabled: true,
  indexPaused: false,
}

export async function getKnowledgeSettings(): Promise<KnowledgeSettings> {
  try {
    const store = await platform.store.load('store.json')
    return {
      enabledSourceTypes: await store.get<KnowledgeSourceType[]>('ragEnabledSourceTypes')
        ?? DEFAULT_KNOWLEDGE_SETTINGS.enabledSourceTypes,
      globalSemanticSearchEnabled: await store.get<boolean>('ragGlobalSemanticSearchEnabled')
        ?? DEFAULT_KNOWLEDGE_SETTINGS.globalSemanticSearchEnabled,
      semanticSearchEnabled: await store.get<boolean>('wikiSemanticSearchEnabled')
        ?? DEFAULT_KNOWLEDGE_SETTINGS.semanticSearchEnabled,
      indexPaused: await store.get<boolean>('ragKnowledgeIndexPaused')
        ?? DEFAULT_KNOWLEDGE_SETTINGS.indexPaused,
    }
  } catch (error) {
    // DA-3 (SET-14): a failed settings load degrades to the
    // defaults instead of rejecting into every caller. Return
    // copies so callers cannot mutate the shared defaults.
    console.error('Failed to load knowledge settings:', error)
    return {
      ...DEFAULT_KNOWLEDGE_SETTINGS,
      enabledSourceTypes: [...DEFAULT_KNOWLEDGE_SETTINGS.enabledSourceTypes],
    }
  }
}

export function isKnowledgeSourceEnabled(source: KnowledgeSource, settings: KnowledgeSettings) {
  return settings.enabledSourceTypes.includes(source.sourceType)
}
