'use client'
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Sparkles } from 'lucide-react'
import { SettingType } from '../components/setting-base'
import { useSkillsStore } from '@/stores/skills'
import { SkillsSettings } from './components/skills-settings'

function SkillsSettingPage() {
  const t = useTranslations('settings.skills')
  const { initSkills } = useSkillsStore()

  useEffect(() => {
    initSkills()
  }, [initSkills])

  return (
    <SettingType
      id="skills"
      title={t('title')}
      desc={t('desc')}
      icon={<Sparkles />}
    >
      <SkillsSettings />
    </SettingType>
  )
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedSkillsSettingPage() {
  if (!isTauri()) {
    return <DisabledSettingSection section="skills" />
  }
  return <SkillsSettingPage />
}
