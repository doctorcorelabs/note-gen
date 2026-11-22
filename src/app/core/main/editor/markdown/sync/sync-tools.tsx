'use client'

import { useUserErrorMessage } from '@/lib/use-user-error-message'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { ArrowDownCircle, ArrowUpCircle, CloudCog, History } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { editorDisabledMessageKeys, isEditorFeatureDisabled } from '@/lib/editor-disabled'
import { prepareActiveEditorDeactivationDurably } from '@/lib/editor-deactivation'
import { compareFileVersions } from '@/lib/sync/auto-sync'
import { getSyncPushQueue } from '@/lib/sync/sync-push-queue'
import useArticleStore from '@/stores/article'
import { useDocumentSyncStore, type DocumentSyncPhase } from '@/stores/document-sync'
import useSettingStore, { useSettingsHydrationStore } from '@/stores/setting'
import { useSettingsDialogStore } from '@/stores/settings-dialog'
import { StatusBarItem } from '../../../status-bar-order'
import { useSyncAvailability } from '../../../file/use-sync-availability'
import { HistorySheet } from './history-sheet'
import { PullButton, usePullSync } from './pull-button'
import { SyncButton, usePushSync } from './sync-button'

interface SyncToolsProps {
  editor: Editor
  markdown?: string
  getMarkdown?: () => string
  prepareExternalAction?: () => boolean
  onMarkdownChange?: (markdown: string) => void
  embedded?: boolean
}

function DesktopSyncTools({ configured, ...props }: SyncToolsProps & { configured: boolean }) {
  const owner = useId()
  const path = useArticleStore(state => state.activeFilePath)
  const workspacePath = useSettingStore(state => state.workspacePath)
  const provider = useSettingStore(state => state.primaryBackupMethod)
  const register = useDocumentSyncStore(state => state.register)
  const unregister = useDocumentSyncStore(state => state.unregister)
  const push = usePushSync(props)
  const pull = usePullSync(props)
  const [working, setWorking] = useState(false)
  const [failed, setFailed] = useState(false)
  const workingRef = useRef(false)
  const mountedRef = useRef(true)
  const t = useTranslations('syncOverview.document')
  const userErrorMessage = useUserErrorMessage()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      unregister(owner)
    }
  }, [owner, unregister])

  useEffect(() => { setFailed(false) }, [path, workspacePath, provider, push.contextKey])

  const isCurrent = useCallback(() => {
    const settings = useSettingStore.getState()
    return mountedRef.current && push.isContextCurrent() && useArticleStore.getState().activeFilePath === path
      && settings.workspacePath === workspacePath && settings.primaryBackupMethod === provider
  }, [path, workspacePath, provider, push.isContextCurrent])

  const run = useCallback(async (action: () => Promise<void>) => {
    if (!path || !configured || workingRef.current || push.busy || pull.busy || !isCurrent()) return
    workingRef.current = true
    setWorking(true)
    setFailed(false)
    try {
      if (props.prepareExternalAction && !props.prepareExternalAction()) return
      await action()
    } catch (error) {
      if (isCurrent()) {
        setFailed(true)
        toast({ title: t('failed'), description: userErrorMessage(error) ?? undefined, variant: 'destructive' })
      }
    } finally {
      workingRef.current = false
      if (mountedRef.current) setWorking(false)
    }
  }, [configured, isCurrent, path, props.prepareExternalAction, pull.busy, push.busy, t])

  const sync = useCallback(() => run(async () => {
    const content = props.getMarkdown?.() ?? props.markdown ?? props.editor.getMarkdown()
    if (!await prepareActiveEditorDeactivationDurably(path)) return
    await useArticleStore.getState().flushPendingArticleSave(path)
    if (!isCurrent()) return
    const comparison = await compareFileVersions(path)
    if (!isCurrent()) return
    if (props.prepareExternalAction && !props.prepareExternalAction()) return
    const latestContent = props.getMarkdown?.() ?? props.markdown ?? props.editor.getMarkdown()
    if (content !== latestContent || comparison.action === 'pull' || comparison.action === 'conflict') {
      pull.openConflict()
      return
    }
    // Matching remote metadata alone does not mean local edits are uploaded.
    // The queue compares actual content and performs conditional remote writes.
    await getSyncPushQueue().retry([path])
  }), [isCurrent, path, props.editor, props.getMarkdown, props.markdown, props.prepareExternalAction, pull.openConflict, run])
  const upload = useCallback(() => run(push.push), [push.push, run])
  const download = useCallback(() => run(pull.pull), [pull.pull, run])

  const phase: DocumentSyncPhase = working || push.busy || pull.status === 'pulling' ? 'syncing'
    : pull.status === 'conflict' ? 'conflict'
      : failed || push.error || pull.status === 'error' ? 'error'
        : pull.hasUpdate ? 'update-available'
          : pull.status === 'checking' ? 'checking' : 'idle'
  const supportsHistory = provider === 'github' || provider === 'gitee' || provider === 'gitlab' || provider === 'gitea'

  useEffect(() => {
    if (!configured || !path || !push.configured || !pull.configured) {
      unregister(owner)
      return
    }
    register({ owner, path, workspacePath, provider, busy: working || push.busy || pull.busy,
      phase, sync, push: upload, pull: download, resolveConflict: pull.openConflict })
  }, [configured, download, owner, path, phase, provider, pull.busy, pull.configured, pull.openConflict,
    push.busy, push.configured, register, sync, unregister, upload, working, workspacePath])

  return <>
    {configured && supportsHistory && <StatusBarItem id="editor:sync-history" rank={61}>
      <HistorySheet editor={props.editor} prepareExternalAction={props.prepareExternalAction} onMarkdownChange={props.onMarkdownChange} />
    </StatusBarItem>}
    {pull.conflictDialog}
  </>
}

export function SyncTools(props: SyncToolsProps) {
  const t = useTranslations('common')
  const settingsReady = useSettingsHydrationStore(state => state.status === 'ready')
  const method = useSettingStore(state => state.primaryBackupMethod)
  const workspacePath = useSettingStore(state => state.workspacePath)
  const activeFilePath = useArticleStore(state => state.activeFilePath)
  const availability = useSyncAvailability()

  if (!settingsReady || method === 'selfHosted' || method === 'local') return null
  // Web fork (Fase 1, V3-24): sync, pull, and file history are not
  // available in the web MVP (audit section 4.5, AD-11). The
  // buttons stay visible in a disabled state and show the honest
  // marker on click; hiding them silently is forbidden. The AD-17
  // revision-guard conflict dialog is a different UI and is not
  // affected by this gate.
  if (isEditorFeatureDisabled('syncTools')) return <DisabledSyncTools />
  if (props.embedded) return <DesktopSyncTools key={JSON.stringify([workspacePath, method, activeFilePath])}
    {...props} configured={availability.configured} />

  if (!availability.configured) {
    return <Button type="button" variant="ghost" size="xs" onClick={() => useSettingsDialogStore.getState().openSettings('sync')}>
      <CloudCog data-icon="inline-start" aria-hidden="true" />
      {t('configureSync')}
    </Button>
  }

  return <div className="flex items-center gap-1">
    <HistorySheet editor={props.editor} prepareExternalAction={props.prepareExternalAction} onMarkdownChange={props.onMarkdownChange} />
    <SyncButton getMarkdown={props.getMarkdown} prepareExternalAction={props.prepareExternalAction} />
    <PullButton editor={props.editor} markdown={props.markdown} getMarkdown={props.getMarkdown}
      prepareExternalAction={props.prepareExternalAction} onMarkdownChange={props.onMarkdownChange} />
  </div>
}

/**
 * Disabled history/sync/pull buttons for the web MVP (Fase 1,
 * V3-24). The buttons keep their desktop affordances at reduced
 * opacity, stay focusable, and explain themselves on click. They
 * never open a sheet, never start a sync, and never call the
 * sync backend.
 */
export function DisabledSyncTools() {
  const tDisabled = useTranslations('editor.disabled')
  const tSync = useTranslations('syncOverview')
  const { titleKey, messageKey } = editorDisabledMessageKeys('syncTools')
  const title = tDisabled(titleKey)
  const message = tDisabled(messageKey)
  const showNotice = () => {
    toast({ title, description: message })
  }
  const buttonClassName = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground opacity-50 transition-colors hover:bg-[hsl(var(--muted))]'
  return (
    <div className="flex items-center gap-1" role="group" aria-label={title}>
      <button type="button" aria-disabled="true" title={message} aria-label={title} onClick={showNotice} className={buttonClassName}>
        <History size={14} />
        <span className="text-xs">{tSync('historyVersions')}</span>
      </button>
      <button type="button" aria-disabled="true" title={message} aria-label={title} onClick={showNotice} className="rounded p-0.5 text-muted-foreground opacity-50 transition-colors hover:bg-muted hover:text-foreground">
        <ArrowUpCircle size={14} />
      </button>
      <button type="button" aria-disabled="true" title={message} aria-label={title} onClick={showNotice} className="rounded p-0.5 text-muted-foreground opacity-50 transition-colors hover:bg-muted hover:text-foreground">
        <ArrowDownCircle size={14} />
      </button>
    </div>
  )
}

export default SyncTools
