'use client'
import { Input } from "@/components/ui/input"
import { useTranslations } from 'next-intl'
import { isTauri } from '@/lib/platform'
import useSettingStore from "@/stores/setting"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { DisabledFeatureNote } from "../components/setting-disabled-notice"

export function SettingAssets({ showTitle = true }: { showTitle?: boolean }) {
  const t = useTranslations('settings.file.assets')
  const disabledT = useTranslations('settings.disabled')
  const { assetsPath, setAssetsPath } = useSettingStore()
  const desktopApp = isTauri()
  return (
    <Field>
      {showTitle ? <FieldLabel htmlFor="assets-path">{t('title')}</FieldLabel> : null}
      <Input
        id="assets-path"
        aria-label={t('title')}
        placeholder={t('select')}
        value={assetsPath}
        disabled={!desktopApp}
        onChange={(e) => setAssetsPath(e.target.value)}
      />
      <FieldDescription>{t('desc')}</FieldDescription>
      {!desktopApp ? (
        <DisabledFeatureNote>{disabledT('assetsPath')}</DisabledFeatureNote>
      ) : null}
    </Field>
  )
}
