// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

/** Web chrome: top app bar, centralized dialog, disabled-feature framework. */

export { TopAppBar } from './top-app-bar'

export {
  WebDialogProvider,
  WebDialogHost,
  useWebDialog,
} from './web-dialog'
export type { WebDialogOptions, WebDialogApi } from './web-dialog'

export {
  DisabledFeature,
  DisabledFeatureButton,
  useDisabledFeatureDialog,
} from './disabled-feature'
export type { DisabledFeatureProps, DisabledFeatureButtonProps } from './disabled-feature'

export { AiChatDisabledPanel, CanvasDisabledPanel } from './disabled-feature-panels'

export { useFeatureFlag, useIsFeatureEnabled } from './use-feature-flag'
export type { FeatureFlagState } from './use-feature-flag'

export {
  WEB_FEATURE_FLAGS,
  WEB_FEATURE_IDS,
  getFeatureFlag,
  isFeatureEnabled,
} from './feature-flags'
export type { WebFeatureId, WebFeatureFlag } from './feature-flags'

export {
  PROPOSED_WEB_CHROME_MESSAGE_KEYS,
  resolveCatalogText,
  useWebChromeText,
  useFeatureText,
  listProposedKeysFromFlags,
} from './web-chrome-messages'
export type { FeatureText } from './web-chrome-messages'
