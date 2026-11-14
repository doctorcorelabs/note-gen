// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { getFeatureFlag, isFeatureEnabled, type WebFeatureId } from './feature-flags'

export type FeatureFlagState = {
  /** True only when the feature is enabled in this build. */
  enabled: boolean
  flag: ReturnType<typeof getFeatureFlag>
}

/**
 * Read one build-static feature flag.
 *
 * Flags do not change at runtime in Phase 1, so this hook returns the
 * registry entry directly. It exists as a hook so call sites keep one
 * access pattern when flags later gain a dynamic source: call sites must
 * not import WEB_FEATURE_FLAGS directly for render decisions.
 */
export function useFeatureFlag(featureId: WebFeatureId): FeatureFlagState {
  return { enabled: isFeatureEnabled(featureId), flag: getFeatureFlag(featureId) }
}

/** Boolean-only convenience for conditional rendering. */
export function useIsFeatureEnabled(featureId: WebFeatureId): boolean {
  return isFeatureEnabled(featureId)
}
