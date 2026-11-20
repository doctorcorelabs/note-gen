'use client'

import { ArchiveRestore } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { SettingType } from '@/app/core/setting/components/setting-base'
import { BackupSettings } from './backup-settings'
import { DisabledSettingSection } from '@/app/core/setting/components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

export default function BackupPage() {
  const t = useTranslations('settings.backup')

  // Web fork (Fase 1, S-P0-07): same gate as the settings dialog
  // (AD-20). In web mode the upstream backup page must not mount:
  // there is no local backup folder and no backup endpoint.
  if (!isTauri()) {
    return <DisabledSettingSection section="backup" />
  }

  return (
    <SettingType id="backup" title={t('title')} desc={t('desc')} icon={<ArchiveRestore className="size-5" />}>
      <BackupSettings />
    </SettingType>
  )
}
