'use client'
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

import { SettingPrompt } from './setting-prompt'
import { Drama } from 'lucide-react'

function PromptSetting() {
  return <SettingPrompt id="prompt" icon={<Drama />} />
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedPromptSetting() {
  if (!isTauri()) {
    return <DisabledSettingSection section="prompt" />
  }
  return <PromptSetting />
}
