'use client'
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

import { useTranslations } from 'next-intl'
import { SettingType } from '../components/setting-base'
import { Brain } from 'lucide-react'
import { MemoryList } from '@/components/memories/memory-list'

function MemoriesSettingsPage() {
  const t = useTranslations('settings.memories')

  return (
    <SettingType
      id="memories"
      title={t('title')}
      desc={t('desc')}
      icon={<Brain className="size-4 lg:size-6" />}
    >
      <MemoryList />
    </SettingType>
  )
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedMemoriesSettingsPage() {
  if (!isTauri()) {
    return <DisabledSettingSection section="memories" />
  }
  return <MemoriesSettingsPage />
}
