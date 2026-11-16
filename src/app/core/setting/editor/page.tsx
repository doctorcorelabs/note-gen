'use client';
import { UserRoundCog } from "lucide-react"
import { SettingSection, SettingType } from "../components/setting-base";
import { useTranslations } from 'next-intl';
import ShowEditorStats from './show-editor-stats';
import ShowUndoRedo from './show-undo-redo';
import Outline from './outline';
import { DisabledFeatureNote } from '../components/setting-disabled-notice';
import LayoutSettings from './layout-settings';
import { ItemGroup } from '@/components/ui/item';
import EditorMode from './editor-mode';
import ShowSourceLineNumbers from './show-source-line-numbers';
import SourceWrap from './source-wrap';
import useSettingStore from '@/stores/setting';

export default function EditorSettingPage() {
  const t = useTranslations('settings.editor');
  const settingsT = useTranslations('settings');
  const disabledT = useTranslations('settings.disabled');
  const editorViewMode = useSettingStore((state) => state.editorViewMode);

  return <SettingType id="editorSetting" icon={<UserRoundCog />} title={t('title')} desc={t('desc')}>
    <div className="flex flex-col gap-6">
      <SettingSection title={settingsT('defaultModels.title')}>
        <DisabledFeatureNote>{disabledT('editorModels')}</DisabledFeatureNote>
      </SettingSection>
      <SettingSection title={t('layout.title')} desc={t('layout.desc')}>
        <ItemGroup>
          <LayoutSettings />
        </ItemGroup>
      </SettingSection>
      <SettingSection title={t('display.title')} desc={t('display.desc')}>
        <ItemGroup>
          <EditorMode />
          {editorViewMode === 'source' ? (
            <>
              <ShowSourceLineNumbers />
              <SourceWrap />
            </>
          ) : null}
          <ShowEditorStats />
          <Outline />
          <ShowUndoRedo />
        </ItemGroup>
      </SettingSection>
    </div>
  </SettingType>
}
