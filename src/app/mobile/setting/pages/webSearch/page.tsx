'use client'

import { Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { isTauri } from '@/lib/platform/detect'
import WebSearchSettingPage from '@/app/core/setting/webSearch/page'

// Web fork (Fase 1, F1 area 21): mobile equivalent of the
// settings dialog gate (AD-20), same shape as GatedMobileSyncPage.
// The mobile route mounted the full upstream web-search page,
// including API key fields that can never be used in web mode.
// In web mode render only this marker with the same
// settings.disabled.webSearch catalog copy; the upstream page
// stays in the tree for later phases.
function MobileWebSearchDisabledNotice() {
  const t = useTranslations('settings')
  return (
    <div data-disabled-setting-section="webSearch" className="p-4">
      <Alert>
        <Info />
        <AlertTitle>{t('webSearch.title')}</AlertTitle>
        <AlertDescription>{t('disabled.webSearch')}</AlertDescription>
      </Alert>
    </div>
  )
}

export default function MobileWebSearchSettingPage() {
  if (!isTauri()) {
    return <MobileWebSearchDisabledNotice />
  }
  return <WebSearchSettingPage mobile />
}
