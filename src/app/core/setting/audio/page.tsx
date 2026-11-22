'use client';
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'
import { SettingType } from "../components/setting-base";
import { Setting } from "./setting";
import { Volume2 } from "lucide-react"
import { useTranslations } from "next-intl";

function AudioPage() {
  const t = useTranslations('settings.audio');

  return <SettingType id="audio" icon={<Volume2 />} title={t('title')} desc={t('desc')}>
    <Setting />
  </SettingType>
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedAudioPage() {
  if (!isTauri()) {
    return <DisabledSettingSection section="audio" />
  }
  return <AudioPage />
}
