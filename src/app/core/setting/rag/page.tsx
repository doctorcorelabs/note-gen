'use client'
import { DisabledSettingSection } from '../components/setting-disabled-notice'
import { isTauri } from '@/lib/platform/detect'

import { useTranslations } from 'next-intl'
import { BookOpen, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { SettingType } from '../components/setting-base'
import { ModelSetting } from './model-setting'
import { Settings } from './settings'
import { WikiSettingsPanel } from '@/components/wiki/wiki-settings-panel'
import { EditorDisabledNotice } from '@/components/editor-disabled-notice'
import { isEditorFeatureDisabled } from '@/lib/editor-disabled'
import { WikiKnowledgePreferences } from '@/components/wiki/wiki-knowledge-preferences'
import { KnowledgeSettingCard } from '@/components/wiki/knowledge-setting-card'
import { useWikiData } from '@/components/wiki/use-wiki-data'
import { useWikiErrorMessage } from '@/components/wiki/use-wiki-error-message'
import { updateWikiSettings } from '@/lib/wiki/settings'
import { Switch } from '@/components/ui/switch'
import { assertWikiContextCurrent } from '@/lib/wiki/context'
import { useWikiActionScope } from '@/components/wiki/use-wiki-action-scope'

function KnowledgeSetting() {
  const t = useTranslations('settings.rag')
  const wiki = useTranslations('wiki')
  const errorMessage = useWikiErrorMessage()
  const { data, refresh } = useWikiData()
  const { busy, beginAction } = useWikiActionScope(data?.context.id ?? 'loading')
  const semanticEnabled = data?.settings.semanticSearchEnabled ?? false

  async function toggleSemantic(semanticSearchEnabled: boolean) {
    if (!data) return
    const operation = beginAction()
    try {
      await assertWikiContextCurrent(data.context.id)
      if (!operation.isCurrent()) return
      await updateWikiSettings({ semanticSearchEnabled }, data.context.id)
      if (operation.isCurrent()) await refresh()
    } catch (error) {
      if (operation.isCurrent()) toast.error(wiki('failed'), { description: errorMessage(error) })
    } finally { operation.finish() }
  }

  return <SettingType id="rag" title={wiki('title')} desc={wiki('description')} icon={<BookOpen />}>
    {/* Web fork (Fase 1, V3-24): wiki generation is not available
        in the web MVP (audit section 4.3). The panel is replaced
        by the honest marker; the semantic search card and the
        knowledge preferences below are untouched. */}
    {isEditorFeatureDisabled('wiki') ? <EditorDisabledNotice feature="wiki" /> : <WikiSettingsPanel />}
    <KnowledgeSettingCard title={t('ragTitle')} description={t('ragDescription')} icon={Layers} label={wiki('optionalMode')} enabled={semanticEnabled} actions={<Switch aria-label={t('ragTitle')} checked={semanticEnabled} disabled={busy || !data} onCheckedChange={enabled => void toggleSemantic(enabled)} />}>
      {semanticEnabled ? <>
        <ModelSetting kind="embedding" />
        <Settings />
      </> : null}
    </KnowledgeSettingCard>
    <WikiKnowledgePreferences />
  </SettingType>
}

// Web fork (Fase 1, A30-01): same self-gate as sync/backup
// (S-P0-07, AD-20). The settings dialog already renders the
// disabled marker for this section, but the direct route mounted
// the full upstream page in web mode. The upstream page stays in
// the tree for later phases; desktop behavior is unchanged.
export default function GatedKnowledgeSetting() {
  if (!isTauri()) {
    return <DisabledSettingSection section="rag" />
  }
  return <KnowledgeSetting />
}
