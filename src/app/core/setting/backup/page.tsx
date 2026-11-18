'use client'

import { ArchiveRestore } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { SettingType } from '@/app/core/setting/components/setting-base'
import { DisabledSettingSection } from '@/app/core/setting/components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'
import { BackupSettings } from './backup-settings'

// The direct route renders the same gate as the settings dialog in web
// mode: managed backup settings (folder, schedule, create, restore)
// have no server endpoint in this version (DA-12-02, DA-12-03,
// DA-09-N04), so the upstream desktop page must never mount from
// this route in a browser. The one export endpoint (AD-201 item 2A)
// is reached from the error recovery screen, not from this page.
// Desktop keeps the upstream page unchanged.
export default function BackupPage() {
  const t = useTranslations('settings.backup')

  if (!isTauri()) {
    return <DisabledSettingSection section="backup" />
  }

  return (
    <SettingType id="backup" title={t('title')} desc={t('desc')} icon={<ArchiveRestore className="size-5" />}>
      <BackupSettings />
    </SettingType>
  )
}
