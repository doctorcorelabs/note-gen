// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/**
 * Build-static feature flags for the web fork.
 *
 * Flags in this registry are static for a build. Enabling a feature is a
 * reviewed code change made together with its backend gate, never a runtime
 * toggle and never a silent fallback. A disabled feature must render an
 * explicit disabled state through DisabledFeature (see disabled-feature.tsx),
 * never fail silently and never render a control that looks working.
 *
 * Message keys listed here are PROPOSED catalog keys. They do not exist in
 * messages/*.json yet; the resolver in web-chrome-messages.ts renders the
 * English fallback text below until the keys land in the catalogs. Do not
 * edit messages/*.json from this module; catalog work stays with the i18n
 * owner so en/zh key parity is kept in one place.
 */

export type WebFeatureId =
  | 'ai-chat'
  | 'canvas'
  | 'wiki-generation'
  | 'collaboration'
  | 'image-hosting'
  | 'screenshot-scan'
  | 'browser-panel'
  | 'plugins'

export type WebFeatureFlag = {
  id: WebFeatureId
  /** False for every feature in the Phase 1 build. */
  enabled: boolean
  /** Planned phase label, or 'None' when no web equivalent is planned. */
  targetPhase: string
  /** Catalog key for the feature label. Some keys already exist. */
  labelKey: string
  /** English label rendered while the label key is missing. */
  fallbackLabel: string
  /** Proposed catalog key for the disabled-state message. */
  messageKey: string
  /** English message rendered while the message key is missing. */
  fallbackMessage: string
}

export const WEB_FEATURE_FLAGS: Record<WebFeatureId, WebFeatureFlag> = {
  'ai-chat': {
    id: 'ai-chat',
    enabled: false,
    targetPhase: 'Phase 3',
    labelKey: 'navigation.chat',
    fallbackLabel: 'AI chat',
    messageKey: 'webChrome.aiChat.unavailable',
    fallbackMessage:
      'AI chat is not available in this build. Your notes are never sent to a third-party AI provider.',
  },
  canvas: {
    id: 'canvas',
    enabled: false,
    targetPhase: 'Phase 2',
    labelKey: 'navigation.canvases',
    fallbackLabel: 'Canvas',
    messageKey: 'webChrome.canvas.unavailable',
    fallbackMessage:
      'Canvas is not available in this build. Your existing canvas files are kept unchanged.',
  },
  'wiki-generation': {
    id: 'wiki-generation',
    enabled: false,
    targetPhase: 'Phase 3',
    labelKey: 'wiki.title',
    fallbackLabel: 'Wiki',
    messageKey: 'webChrome.wiki.unavailable',
    fallbackMessage:
      'Wiki generation is not available in this build. Existing wiki blocks in your notes are kept unchanged.',
  },
  collaboration: {
    id: 'collaboration',
    enabled: false,
    targetPhase: 'Phase 4',
    labelKey: 'webChrome.collaboration.label',
    fallbackLabel: 'Collaboration',
    messageKey: 'webChrome.collaboration.unavailable',
    fallbackMessage:
      'Collaboration is not available in this build. Editing is single-user; your changes save only to this workspace.',
  },
  'image-hosting': {
    id: 'image-hosting',
    enabled: false,
    targetPhase: 'Phase 2',
    labelKey: 'webChrome.imageHosting.label',
    fallbackLabel: 'Image hosting',
    messageKey: 'webChrome.imageHosting.unavailable',
    fallbackMessage:
      'Image hosting is not available in this build. Images are saved to your workspace instead.',
  },
  'screenshot-scan': {
    id: 'screenshot-scan',
    enabled: false,
    targetPhase: 'None',
    labelKey: 'webChrome.screenshotScan.label',
    fallbackLabel: 'Screenshot scan',
    messageKey: 'webChrome.screenshotScan.unavailable',
    fallbackMessage:
      'Screenshot scan is not available in this build. Use your operating system screenshot tool, then paste the image into the editor.',
  },
  'browser-panel': {
    id: 'browser-panel',
    enabled: false,
    targetPhase: 'None',
    labelKey: 'webChrome.browserPanel.label',
    fallbackLabel: 'Browser panel',
    messageKey: 'webChrome.browserPanel.unavailable',
    fallbackMessage:
      'The browser panel is not available in this build. External links open in a new browser tab instead.',
  },
  plugins: {
    id: 'plugins',
    enabled: false,
    targetPhase: 'Phase 3b',
    labelKey: 'settings.plugins.title',
    fallbackLabel: 'Plugins',
    messageKey: 'webChrome.plugins.unavailable',
    fallbackMessage:
      'Plugins are not available in this build. No plugin can be installed, enabled, or run, and no plugin code is loaded.',
  },
}

export const WEB_FEATURE_IDS: readonly WebFeatureId[] = [
  'ai-chat',
  'canvas',
  'wiki-generation',
  'collaboration',
  'image-hosting',
  'screenshot-scan',
  'browser-panel',
  'plugins',
]

export function getFeatureFlag(featureId: WebFeatureId): WebFeatureFlag {
  return WEB_FEATURE_FLAGS[featureId]
}

export function isFeatureEnabled(featureId: WebFeatureId): boolean {
  return WEB_FEATURE_FLAGS[featureId].enabled
}
