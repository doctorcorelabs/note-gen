'use client'

// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// React hook resolving userErrorMessageKey through next-intl
// (DA-2, BUG-07 / E27-04). Returns null for AbortError so callers
// can skip the toast entirely on user-initiated aborts. Unmapped
// keys fall back to errors.unknown and the raw error is logged to
// the console, never rendered.

import { useTranslations } from 'next-intl'
import { useCallback } from 'react'

import { userErrorMessageKey } from './web/user-error-message'

export function useUserErrorMessage(): (error: unknown) => string | null {
  const t = useTranslations()
  return useCallback(
    (error: unknown): string | null => {
      const key = userErrorMessageKey(error)
      if (key === null) {
        return null
      }
      if (t.has(key)) {
        return t(key)
      }
      console.error('Unmapped error shown to user:', error)
      return t('errors.unknown')
    },
    [t],
  )
}
