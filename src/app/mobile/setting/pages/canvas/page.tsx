'use client'

import { Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { isTauri } from '@/lib/platform/detect'
import CanvasSettingPage from '@/app/core/setting/canvas/page'

// Web fork (Fase 1, CANVAS-02): mobile equivalent of the settings
// dialog gate (AD-20), same shape as GatedMobileSyncPage. The
// mobile route mounted the full upstream canvas settings page as
// working controls in web mode. In web mode render only this
// marker with the same settings.disabled.canvas catalog copy; the
// upstream page stays in the tree for later phases.
function MobileCanvasDisabledNotice() {
  const t = useTranslations('settings')
  return (
    <div data-disabled-setting-section="canvas" className="p-4">
      <Alert>
        <Info />
        <AlertTitle>{t('canvas.title')}</AlertTitle>
        <AlertDescription>{t('disabled.canvas')}</AlertDescription>
      </Alert>
    </div>
  )
}

export default function MobileCanvasSettingPage() {
  if (!isTauri()) {
    return <MobileCanvasDisabledNotice />
  }
  return <CanvasSettingPage mobile />
}
