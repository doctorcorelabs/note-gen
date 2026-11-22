'use client';
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'
import { Eye, ImageIcon } from "lucide-react"
import { useTranslations } from 'next-intl';
import { SettingType } from '../components/setting-base';
import { OcrSetting } from "./ocr";
import { VlmSetting } from "./vlm";
import useSettingStore from "@/stores/setting";
import { Switch } from "@/components/ui/switch";
import { Item, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions } from '@/components/ui/item';

function ImageMethod() {
  const t = useTranslations('settings.imageMethod');
  const { enableImageRecognition, setEnableImageRecognition } = useSettingStore()
  
  return (
    <SettingType id="imageMethod" icon={<ImageIcon />} title={t('title')} desc={t('desc')}>
      <div className="space-y-4">
        <Item variant="outline">
          <ItemMedia variant="icon"><Eye className="size-4" /></ItemMedia>
          <ItemContent>
            <ItemTitle>{t('enable.title')}</ItemTitle>
            <ItemDescription>{t('enable.desc')}</ItemDescription>
          </ItemContent>
          <ItemActions className="mobile-setting-inline-action">
            <Switch
              checked={enableImageRecognition}
              onCheckedChange={setEnableImageRecognition}
            />
          </ItemActions>
        </Item>
        <OcrSetting />
        <VlmSetting />
      </div>
    </SettingType>
  )
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedImageMethod() {
  if (!isTauri()) {
    return <DisabledSettingSection section="imageMethod" />
  }
  return <ImageMethod />
}
