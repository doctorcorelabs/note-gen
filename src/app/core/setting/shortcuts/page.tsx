'use client';

import { LayoutTemplate } from "lucide-react"
import { SettingSection, SettingType } from "../components/setting-base";
import { Item, ItemGroup, ItemContent, ItemTitle, ItemDescription, ItemActions } from '@/components/ui/item';
import { useTranslations } from "next-intl";
import useShortcutStore from "@/stores/shortcut";
import { capabilities } from '@/lib/platform';
import { Alert, AlertDescription } from '@/components/ui/alert';
import ShortcutsInput from "./shorcut-input";
import { EditorShortcutsSection } from "./editor-shortcuts-section";

export default function ShortcutsPage() {
  const t = useTranslations('settings.shortcuts');
  const { shortcuts } = useShortcutStore()
  const globalShortcutsAvailable = capabilities.globalShortcut

  return <SettingType id="shortcuts" title={t('title')} desc={t('desc')} icon={<LayoutTemplate />}>
    <div className="flex flex-col gap-6">
      <SettingSection title={t('globalShortcuts.title')} desc={t('globalShortcuts.desc')}>
        {!globalShortcutsAvailable ? (
          <Alert>
            <AlertDescription>{t('globalShortcuts.webUnavailable')}</AlertDescription>
          </Alert>
        ) : null}
        <ItemGroup className="gap-4">
          {
            shortcuts.map((shortcut) => (
              <Item key={shortcut.key} variant="outline">
                <ItemContent>
                  <ItemTitle>{t(`shortcuts.${shortcut.key}.title`)}</ItemTitle>
                  <ItemDescription>{t(`shortcuts.${shortcut.key}.desc`)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ShortcutsInput name={shortcut.key} disabled={!globalShortcutsAvailable} />
                </ItemActions>
              </Item>
            ))
          }
        </ItemGroup>
      </SettingSection>
      <EditorShortcutsSection />
    </div>
  </SettingType>
}
