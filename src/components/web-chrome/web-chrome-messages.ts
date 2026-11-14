// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useMessages } from 'next-intl'
import { getFeatureFlag, WEB_FEATURE_IDS, type WebFeatureId } from './feature-flags'

/**
 * Proposed message catalog keys for web chrome strings.
 *
 * These keys are PROPOSALS ONLY. They are not present in messages/*.json
 * and this module never edits the catalogs. The catalog owner adds each key
 * to en.json and zh.json (and keeps the two catalogs parallel) in a separate
 * change; once a key exists, resolveCatalogText finds it and the translated
 * string renders automatically. Until then, the English fallback text from
 * feature-flags.ts renders. Three label keys below reuse keys that already
 * exist in the catalog (navigation.chat, navigation.canvases, wiki.title);
 * the rest are new proposals under the webChrome namespace.
 */
export const PROPOSED_WEB_CHROME_MESSAGE_KEYS: readonly string[] = [
  'webChrome.aiChat.unavailable',
  'webChrome.canvas.unavailable',
  'webChrome.wiki.unavailable',
  'webChrome.collaboration.label',
  'webChrome.collaboration.unavailable',
  'webChrome.imageHosting.label',
  'webChrome.imageHosting.unavailable',
  'webChrome.screenshotScan.label',
  'webChrome.screenshotScan.unavailable',
  'webChrome.browserPanel.label',
  'webChrome.browserPanel.unavailable',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Look up a dotted message key in a next-intl messages tree. Returns
 * undefined when any segment is missing or the final value is not a
 * string, so callers can fall back to English defaults. Pure function:
 * safe to unit test without a provider.
 */
export function resolveCatalogText(messages: unknown, dottedKey: string): string | undefined {
  const segments = dottedKey.split('.')
  let current: unknown = messages
  for (const segment of segments) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined
}

/**
 * Resolve a message key against the active catalog, falling back to the
 * given English default when the key is absent. Missing keys render the
 * fallback text, never a raw key and never an empty string.
 */
export function useWebChromeText(): (dottedKey: string, fallback: string) => string {
  const messages = useMessages()
  return (dottedKey: string, fallback: string) =>
    resolveCatalogText(messages, dottedKey) ?? fallback
}

export type FeatureText = {
  label: string
  message: string
}

/** Resolve the display label and disabled-state message for one feature. */
export function useFeatureText(featureId: WebFeatureId): FeatureText {
  const resolveText = useWebChromeText()
  const flag = getFeatureFlag(featureId)
  return {
    label: resolveText(flag.labelKey, flag.fallbackLabel),
    message: resolveText(flag.messageKey, flag.fallbackMessage),
  }
}

/** Every proposed key, derived from the flag registry (guards against drift). */
export function listProposedKeysFromFlags(): readonly string[] {
  const keys: string[] = []
  for (const id of WEB_FEATURE_IDS) {
    const flag = getFeatureFlag(id)
    if (flag.labelKey.startsWith('webChrome.')) keys.push(flag.labelKey)
    keys.push(flag.messageKey)
  }
  return keys
}
