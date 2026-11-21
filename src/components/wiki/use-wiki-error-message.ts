'use client'

import { useCallback } from 'react'
import { useTranslations } from 'next-intl'

export function useWikiErrorMessage() {
  const t = useTranslations('wiki')
  const tRoot = useTranslations()
  return useCallback((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    const code = /^(WIKI_[A-Z_]+)(?::|$)/.exec(message)?.[1]
    if (code && t.has(`errors.${code}`)) {
      return t(`errors.${code}`)
    }
    // UTANG-UJI-05: never surface raw internal error text in the UI.
    // The raw message goes to the console log for diagnosis only; the
    // user sees a generic localized message instead.
    console.error('Wiki operation failed:', cause)
    if (t.has('errors.WIKI_UNKNOWN')) {
      return t('errors.WIKI_UNKNOWN')
    }
    return tRoot.has('settings.security.errors.unknown')
      ? tRoot('settings.security.errors.unknown')
      : 'Something went wrong. Please try again.'
  }, [t, tRoot])
}
