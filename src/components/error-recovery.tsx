'use client'

import { useEffect, useState } from 'react'
import {
  ArrowLeftIcon,
  ArchiveIcon,
  BrushCleaningIcon,
  BugIcon,
  CircleAlertIcon,
  ClipboardIcon,
  DatabaseIcon,
  FolderOpenIcon,
  InfoIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react'
import { isTauri, platform, platform as platformAdapters } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { isMobileDevice } from '@/lib/check'

type RecoveryAction =
  | 'exit'
  | 'clear-cache'
  | 'open-data'
  | 'delete-canvas'
  | 'clear-canvases'
  | 'reset-settings'
  | 'export-backup'
  | 'reset-database'
  | 'report-issue'

interface StoredTab {
  id: string
  path: string
  canvasId?: string
}

interface CanvasRecoveryContext {
  id: string
  title?: string
}

interface DiagnosticContext {
  appVersion?: string
  platform?: string
  osVersion?: string
  page?: string
}

const CANVAS_TAB_PREFIX = 'canvas://project/'
const EDITOR_WORKSPACE_LAYOUT_STORE_KEY = 'editorWorkspaceLayout:main'
const TEMPORARY_DIRECTORIES = ['canvas-thumbnails', 'temp_screenshot'] as const
const LAYOUT_STORAGE_KEYS = [
  'leftSidebarVisible',
  'centerPanelVisible',
  'rightSidebarVisible',
  'leftSidebarTab',
  'canvas-manager-view-mode',
  'canvas-manager-sort-mode',
] as const
const LAYOUT_STORAGE_PREFIX = 'react-resizable-panels:main-layout:'
const DATABASE_RESET_PHRASE = 'DELETE DATABASE'
const SETTINGS_RESET_PHRASE = 'RESET SETTINGS'
const GITHUB_BUG_REPORT_URL = 'https://github.com/codexu/note-gen/issues/new'

function getCanvasIdFromTab(tab?: StoredTab) {
  if (!tab) return null
  if (tab.canvasId) return tab.canvasId
  return tab.path.startsWith(CANVAS_TAB_PREFIX)
    ? tab.path.slice(CANVAS_TAB_PREFIX.length) || null
    : null
}

function getSafeRoute() {
  return isMobileDevice() ? '/mobile/chat' : '/core/main'
}

async function clearStartupState() {
  const store = await platform.store.load('store.json')
  await store.set('openTabs', [])
  await store.set('activeTabId', '')
  await store.set('activeFilePath', '')
  await store.set('currentPage', getSafeRoute())
  await store.delete(EDITOR_WORKSPACE_LAYOUT_STORE_KEY)
  await store.save()
}

function openSafeRoute() {
  window.location.replace('/')
}

export function ErrorRecovery({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const [activeAction, setActiveAction] = useState<RecoveryAction | null>(null)
  const [actionError, setActionError] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const [canvasContext, setCanvasContext] = useState<CanvasRecoveryContext | null>(null)
  const [diagnosticContext, setDiagnosticContext] = useState<DiagnosticContext>({})
  const [databaseResetOpen, setDatabaseResetOpen] = useState(false)
  const [databaseResetAcknowledged, setDatabaseResetAcknowledged] = useState(false)
  const [databaseResetPhrase, setDatabaseResetPhrase] = useState('')
  const [settingsResetOpen, setSettingsResetOpen] = useState(false)
  const [settingsResetAcknowledged, setSettingsResetAcknowledged] = useState(false)
  const [settingsResetPhrase, setSettingsResetPhrase] = useState('')

  // Web variant (DA28-14): in the browser there is no local
  // database file, no file manager, and no desktop save dialog.
  // Desktop-only actions are hidden, destructive server-side
  // actions need typed confirmation, and copy must say what the
  // action really deletes on the server.
  const isWeb = !isTauri()

  useEffect(() => {
    console.error('应用错误:', error)
  }, [error])

  useEffect(() => {
    let cancelled = false

    async function resolveRecoveryContext() {
      const nextDiagnosticContext: DiagnosticContext = {
        page: `${window.location.pathname}${window.location.search}`,
      }
      try {
        nextDiagnosticContext.appVersion = await platform.os.getAppVersion()
        nextDiagnosticContext.platform = platform.os.platform()
        nextDiagnosticContext.osVersion = platform.os.version()
      } catch (diagnosticError) {
        console.error('读取诊断环境失败:', diagnosticError)
      }
      if (!cancelled) setDiagnosticContext(nextDiagnosticContext)

      try {
        const routeCanvasId = window.location.pathname.includes('/canvas/editor')
          ? new URLSearchParams(window.location.search).get('id')
          : null
        const store = await platform.store.load('store.json')
        const tabs = await store.get<StoredTab[]>('openTabs') || []
        const activeTabId = await store.get<string>('activeTabId')
        const activeTab = tabs.find(tab => tab.id === activeTabId)
        const canvasId = routeCanvasId || getCanvasIdFromTab(activeTab)
        if (!canvasId || cancelled) return

        let title: string | undefined
        try {
          const { getCanvasProject } = await import('@/db/canvases')
          title = (await getCanvasProject(canvasId))?.title
        } catch (contextError) {
          console.error('读取异常画布信息失败:', contextError)
        }
        if (!cancelled) setCanvasContext({ id: canvasId, title })
      } catch (contextError) {
        console.error('识别异常画布失败:', contextError)
      }
    }

    void resolveRecoveryContext()
    return () => {
      cancelled = true
    }
  }, [])

  async function runRecovery(action: RecoveryAction, task: () => Promise<void>) {
    setActiveAction(action)
    setActionError('')
    setActionMessage('')
    try {
      await task()
    } catch (recoveryError) {
      console.error('恢复操作失败:', recoveryError)
      setActionError(recoveryError instanceof globalThis.Error ? recoveryError.message : 'Recovery failed, please try again')
      setActiveAction(null)
    }
  }

  function exitErrorPage() {
    void runRecovery('exit', async () => {
      await clearStartupState()
      openSafeRoute()
    })
  }

  function clearTemporaryData() {
    void runRecovery('clear-cache', async () => {
      // In web mode the data directory paths are virtual prefixes
      // with no files behind them, so only the browser-saved
      // layout state below is cleared. Desktop keeps the file
      // cleanup.
      if (!isWeb) {
        const dataDirectory = await platform.path.appDataDir()
        for (const directory of TEMPORARY_DIRECTORIES) {
          const path = await platform.path.join(dataDirectory, directory)
          if (await platform.fs.exists(path)) {
            await platform.fs.remove(path, { recursive: true })
          }
        }
      }
      for (const key of LAYOUT_STORAGE_KEYS) {
        window.localStorage.removeItem(key)
      }
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index)
        if (key?.startsWith(LAYOUT_STORAGE_PREFIX)) {
          window.localStorage.removeItem(key)
        }
      }
      setActionMessage(isWeb
        ? 'Interface layout saved in this browser has been cleared. You can reload or return to the app.'
        : 'Temporary cache and interface layout have been cleared. You can reload or return to the app.')
      setActiveAction(null)
    })
  }

  function openDataDirectory() {
    // Structural guard: the button is hidden in web mode, and the
    // web opener always rejects this call. Never reach it.
    if (isWeb) {
      setActionError('The data directory cannot be opened from a browser. This action is only available in the desktop app.')
      return
    }
    void runRecovery('open-data', async () => {
      const configDirectory = await platform.path.appConfigDir()
      const databasePath = await platform.path.join(configDirectory, 'note.db')
      if (await platform.fs.exists(databasePath)) {
        await platform.opener.revealItemInDir(databasePath)
      } else {
        await platform.opener.openPath(configDirectory)
      }
      setActionMessage('The data directory has been opened in the file manager. Before modifying files, exit NoteGen and make a backup.')
      setActiveAction(null)
    })
  }

  function deleteCurrentCanvas() {
    if (!canvasContext) return
    void runRecovery('delete-canvas', async () => {
      const { getCanvasProject, softDeleteCanvasProject } = await import('@/db/canvases')
      const project = await getCanvasProject(canvasContext.id)
      await softDeleteCanvasProject(canvasContext.id)
      if (project?.thumbnailPath) {
        const { removeCanvasThumbnail } = await import('@/lib/canvas/thumbnail')
        await removeCanvasThumbnail(project.thumbnailPath)
      }
      await clearStartupState()
      openSafeRoute()
    })
  }

  function clearAllCanvases() {
    void runRecovery('clear-canvases', async () => {
      const { clearCanvasProjects } = await import('@/db/canvases')
      await clearCanvasProjects()
      const thumbnailDirectory = await platform.path.join(await platform.path.appDataDir(), 'canvas-thumbnails')
      if (await platform.fs.exists(thumbnailDirectory)) {
        await platform.fs.remove(thumbnailDirectory, { recursive: true })
      }
      await clearStartupState()
      openSafeRoute()
    })
  }

  function resetSettings() {
    // In web mode store.clear() queues deletion of every server
    // settings key, including the aiModelList cascade that
    // removes saved AI provider secrets, so one click from a
    // crash screen must never delete them. Require the same
    // typed-phrase protection the database reset has.
    if (isWeb && (!settingsResetAcknowledged || settingsResetPhrase !== SETTINGS_RESET_PHRASE)) return
    void runRecovery('reset-settings', async () => {
      const store = await platform.store.load('store.json')
      await store.clear()
      await store.set('currentPage', getSafeRoute())
      await store.save()
      openSafeRoute()
    })
  }

  function resetLocalDatabase() {
    // Structural guard: Level 4 is hidden in web mode, and the
    // delete_local_database command is rejected as desktop-only
    // by the web invoke router. Never reach the confirmation.
    if (isWeb) {
      setActionError('Deleting the database is not available in the browser. This action is only available in the desktop app.')
      return
    }
    if (!databaseResetAcknowledged || databaseResetPhrase !== DATABASE_RESET_PHRASE) return
    void runRecovery('reset-database', async () => {
      try {
        await clearStartupState()
      } catch (startupStateError) {
        console.warn('清理启动状态失败，将继续重置数据库:', startupStateError)
      }

      try {
        const { db } = await import('@/db')
        await db.close()
      } catch (databaseCloseError) {
        console.warn('数据库连接未打开或关闭失败，将继续尝试删除:', databaseCloseError)
      }

      await platform.invoke.invoke('delete_local_database')
      await platformAdapters.process.relaunch()
    })
  }

  function exportFullBackup() {
    // Structural guard: Level 4 is hidden in web mode, and the
    // path-shaped save dialog always rejects in the browser.
    // Never reach it.
    if (isWeb) {
      setActionError('Exporting a full backup is not available in the browser. This action is only available in the desktop app.')
      return
    }
    void runRecovery('export-backup', async () => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const outputPath = await platform.dialog.save({
        title: 'Export full NoteGen data backup',
        defaultPath: `note-gen-full-backup-${timestamp}.zip`,
        filters: [{
          name: 'ZIP Files',
          extensions: ['zip'],
        }],
      })

      if (!outputPath) {
        setActiveAction(null)
        return
      }

      const savedPath = await platform.invoke.invoke<string>('export_app_data', { outputPath })
      setActionMessage(`Full data backup exported to: ${savedPath}`)
      setActiveAction(null)
    })
  }

  function handleDatabaseResetOpenChange(open: boolean) {
    setDatabaseResetOpen(open)
    if (!open) {
      setDatabaseResetAcknowledged(false)
      setDatabaseResetPhrase('')
    }
  }

  function handleSettingsResetOpenChange(open: boolean) {
    setSettingsResetOpen(open)
    if (!open) {
      setSettingsResetAcknowledged(false)
      setSettingsResetPhrase('')
    }
  }

  function getErrorDetails() {
    return [
      `Error: ${error.message || 'Unknown error'}`,
      error.digest ? `Error ID: ${error.digest}` : '',
      diagnosticContext.appVersion ? `NoteGen：${diagnosticContext.appVersion}` : '',
      diagnosticContext.platform ? `System: ${diagnosticContext.platform} ${diagnosticContext.osVersion || ''}`.trim() : '',
      `Page: ${diagnosticContext.page || window.location.href}`,
      `Time: ${new Date().toISOString()}`,
      error.stack ? `\n${error.stack}` : '',
    ].filter(Boolean).join('\n')
  }

  async function copyErrorDetails() {
    try {
      await navigator.clipboard.writeText(getErrorDetails())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (clipboardError) {
      console.error('复制错误信息失败:', clipboardError)
      setActionError('Cannot copy error info, please check clipboard permissions')
    }
  }

  const busy = activeAction !== null
  const mobile = isMobileDevice()

  function reportGitHubIssue() {
    void runRecovery('report-issue', async () => {
      let diagnosticsCopied = false
      try {
        await navigator.clipboard.writeText(getErrorDetails())
        diagnosticsCopied = true
      } catch (clipboardError) {
        console.error('复制 GitHub 反馈信息失败:', clipboardError)
      }

      const issueUrl = new URL(GITHUB_BUG_REPORT_URL)
      issueUrl.searchParams.set('template', 'bug_report.yml')
      issueUrl.searchParams.set('title', '[bug] App entered error recovery mode')
      await platform.opener.openUrl(issueUrl)
      setActionMessage(
        diagnosticsCopied
          ? 'The GitHub bug report page has been opened and the error info copied. Please paste it into the error log and add reproduction steps.'
          : 'The GitHub bug report page has been opened. Please add the error info and reproduction steps.'
      )
      setActiveAction(null)
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <CircleAlertIcon />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Badge variant="secondary" className="self-start">Recovery mode</Badge>
              <CardTitle>This page cannot be opened properly</CardTitle>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <Alert variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>Error details</AlertTitle>
            <AlertDescription className="max-h-24 overflow-auto break-words font-mono text-xs">
              {error.message || 'Unknown error'}
            </AlertDescription>
          </Alert>

          {actionError ? (
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>Recovery failed</AlertTitle>
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}

          {actionMessage ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>Action completed</AlertTitle>
              <AlertDescription>{actionMessage}</AlertDescription>
            </Alert>
          ) : null}

          <Card size="sm">
            <CardHeader>
              <CardTitle>Try recovery in order</CardTitle>
            </CardHeader>
            <CardContent>
              <Accordion
                type="single"
                collapsible
                defaultValue="level-1"
                className="rounded-lg border px-3"
              >
                <AccordionItem value="level-1">
                  <AccordionTrigger>
                    <span className="flex items-center gap-2">
                      <Badge variant="secondary">Level 1</Badge>
                      Re-enter the app
                      <Badge variant="outline">Nearly lossless</Badge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-3">
                    <Alert>
                      <InfoIcon />
                      <AlertTitle>What this level clears</AlertTitle>
                      <AlertDescription>
                        “Reload” clears nothing; “Exit error page” only clears the last opened page, active tabs, and file position state.
                      </AlertDescription>
                    </Alert>
                    <Alert>
                      <InfoIcon />
                      <AlertTitle>What this level does not clear</AlertTitle>
                      <AlertDescription>
                        It will not delete notes, records, canvases, chats, the database, attachments, or app settings.
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={reset} disabled={busy}>
                        <RefreshCwIcon data-icon="inline-start" />
                        Reload current page
                      </Button>
                      <Button onClick={exitErrorPage} disabled={busy}>
                        {activeAction === 'exit'
                          ? <Spinner data-icon="inline-start" />
                          : <ArrowLeftIcon data-icon="inline-start" />}
                        Exit error page
                      </Button>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="level-2">
                  <AccordionTrigger>
                    <span className="flex items-center gap-2">
                      <Badge variant="secondary">Level 2</Badge>
                      Clear cache and layout
                      <Badge variant="outline">Low risk</Badge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-3">
                    <Alert>
                      <BrushCleaningIcon />
                      <AlertTitle>What this level clears</AlertTitle>
                      <AlertDescription>
                        {isWeb
                          ? 'Clears interface layout saved in this browser, such as left/right sidebars, panel widths, and canvas list views. These can be regenerated. Thumbnails and temporary files live on the server and are not touched.'
                          : 'Clears canvas thumbnails, temporary screenshots, and interface layout caches such as left/right sidebars, panel widths, and canvas list views. These can be regenerated.'}
                      </AlertDescription>
                    </Alert>
                    <Alert>
                      <InfoIcon />
                      <AlertTitle>What this level does not clear</AlertTitle>
                      <AlertDescription>
                        It will not delete note content, records, canvas items, chats, model settings, sync settings, or the database.
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={clearTemporaryData} disabled={busy}>
                        {activeAction === 'clear-cache'
                          ? <Spinner data-icon="inline-start" />
                          : <BrushCleaningIcon data-icon="inline-start" />}
                        Clear cache and layout
                      </Button>
                      {!mobile && !isWeb ? (
                        <Button variant="ghost" onClick={openDataDirectory} disabled={busy}>
                          {activeAction === 'open-data'
                            ? <Spinner data-icon="inline-start" />
                            : <FolderOpenIcon data-icon="inline-start" />}
                          Open data directory
                        </Button>
                      ) : null}
                    </div>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="level-3">
                  <AccordionTrigger>
                    <span className="flex items-center gap-2">
                      <Badge variant="secondary">Level 3</Badge>
                      Reset specific data
                      <Badge variant="outline">Confirmation needed</Badge>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="flex flex-col gap-3">
                    {canvasContext ? (
                      <Alert>
                        <Trash2Icon />
                        <AlertTitle>Current broken canvas</AlertTitle>
                        <AlertDescription>
                          Only moves the current canvas to the canvas trash and deletes its thumbnail; other canvases, notes, records, and settings are unaffected.
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    <Alert>
                      <DatabaseIcon />
                      <AlertTitle>{isWeb ? 'All canvases' : 'All local canvases'}</AlertTitle>
                      <AlertDescription>
                        {isWeb
                          ? 'Permanently clears all canvas items and thumbnails stored in the server database; it will not delete Markdown notes, records, chats, settings, or other database content.'
                          : 'Permanently clears all local canvas items and thumbnails; it will not delete Markdown notes, records, chats, settings, or other database content.'}
                      </AlertDescription>
                    </Alert>
                    <Alert>
                      <RotateCcwIcon />
                      <AlertTitle>App settings</AlertTitle>
                      <AlertDescription>
                        {isWeb
                          ? 'Clears interface, model, sync, workspace, and startup settings stored on the server, including saved AI provider keys; it will not delete note files, record files, or canvas data.'
                          : 'Clears interface, model, sync, workspace, and startup settings; it will not delete note files, record files, or the canvas database.'}
                      </AlertDescription>
                    </Alert>
                    <div className="flex flex-wrap gap-2">
                      {canvasContext ? (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="outline" disabled={busy}>
                              {activeAction === 'delete-canvas'
                                ? <Spinner data-icon="inline-start" />
                                : <Trash2Icon data-icon="inline-start" />}
                              Delete current broken canvas
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete current broken canvas?</AlertDialogTitle>
                              <AlertDialogDescription>
                                {canvasContext.title
                                  ? `“${canvasContext.title}” will be moved to the canvas trash; other canvases and notes are unaffected.`
                                  : 'The current canvas will be moved to the canvas trash; other canvases and notes are unaffected.'}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction variant="destructive" onClick={deleteCurrentCanvas}>
                                Move to trash
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      ) : null}

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" disabled={busy}>
                            {activeAction === 'clear-canvases'
                              ? <Spinner data-icon="inline-start" />
                              : <DatabaseIcon data-icon="inline-start" />}
                            {isWeb ? 'Clear all canvases' : 'Clear all local canvases'}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{isWeb ? 'Clear all canvases?' : 'Clear all local canvases?'}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {isWeb
                                ? 'All canvases and thumbnails stored on the server will be permanently deleted; notes and records are unaffected. This cannot be undone.'
                                : 'All local canvases and thumbnails will be permanently deleted; notes and records are unaffected. This cannot be undone.'}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction variant="destructive" onClick={clearAllCanvases}>
                              Confirm clear
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>

                      <AlertDialog open={settingsResetOpen} onOpenChange={handleSettingsResetOpenChange}>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" disabled={busy}>
                            {activeAction === 'reset-settings'
                              ? <Spinner data-icon="inline-start" />
                              : <RotateCcwIcon data-icon="inline-start" />}
                            Reset app settings
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{isWeb ? 'Reset server settings?' : 'Reset app settings?'}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {isWeb
                                ? 'This will clear interface, model, sync, and workspace settings stored on the server, including saved AI provider keys. Notes, records, and canvases are not deleted. This cannot be undone.'
                                : 'This will clear interface, model, sync, and workspace settings, but will not delete local notes, records, or the canvas database.'}
                            </AlertDialogDescription>
                          </AlertDialogHeader>

                          {isWeb ? (
                            <>
                              <Alert variant="destructive">
                                <CircleAlertIcon />
                                <AlertTitle>Will be permanently deleted</AlertTitle>
                                <AlertDescription>
                                  Server settings, including saved AI provider keys. A transient server failure does not require this reset; try reloading first.
                                </AlertDescription>
                              </Alert>

                              <Field orientation="horizontal">
                                <Checkbox
                                  id="settings-reset-acknowledgement"
                                  checked={settingsResetAcknowledged}
                                  onCheckedChange={checked => setSettingsResetAcknowledged(checked === true)}
                                />
                                <FieldLabel htmlFor="settings-reset-acknowledgement">
                                  I confirm that my server settings do not need to be kept
                                </FieldLabel>
                              </Field>

                              <Field>
                                <FieldLabel htmlFor="settings-reset-phrase">
                                  Type “{SETTINGS_RESET_PHRASE}” to confirm
                                </FieldLabel>
                                <Input
                                  id="settings-reset-phrase"
                                  value={settingsResetPhrase}
                                  onChange={event => setSettingsResetPhrase(event.target.value)}
                                  autoComplete="off"
                                  placeholder={SETTINGS_RESET_PHRASE}
                                />
                                <FieldDescription>
                                  You must check the confirmation above and type the exact same text.
                                </FieldDescription>
                              </Field>
                            </>
                          ) : null}

                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={isWeb && (!settingsResetAcknowledged || settingsResetPhrase !== SETTINGS_RESET_PHRASE)}
                              onClick={resetSettings}
                            >
                              Confirm reset
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {!mobile && !isWeb ? (
                  <AccordionItem value="level-4">
                    <AccordionTrigger>
                      <span className="flex items-center gap-2">
                        <Badge variant="destructive">Level 4</Badge>
                        Delete local database
                        <Badge variant="destructive">Irreversible</Badge>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="flex flex-col gap-3">
                      <Alert variant="destructive">
                        <CircleAlertIcon />
                        <AlertTitle>What this level permanently clears</AlertTitle>
                        <AlertDescription>
                          Deletes local database content such as canvases, chats, record indexes, tags, vector data, memories, and activity records, and restarts NoteGen.
                        </AlertDescription>
                      </Alert>
                      <Alert>
                        <InfoIcon />
                        <AlertTitle>What this level does not clear</AlertTitle>
                        <AlertDescription>
                          It will not delete Markdown files, the attachments directory, or the recordings directory.
                        </AlertDescription>
                      </Alert>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={exportFullBackup} disabled={busy}>
                          {activeAction === 'export-backup'
                            ? <Spinner data-icon="inline-start" />
                            : <ArchiveIcon data-icon="inline-start" />}
                          Export full data backup
                        </Button>
                        <AlertDialog open={databaseResetOpen} onOpenChange={handleDatabaseResetOpenChange}>
                          <AlertDialogTrigger asChild>
                            <Button variant="destructive" disabled={busy}>
                              {activeAction === 'reset-database'
                                ? <Spinner data-icon="inline-start" />
                                : <DatabaseIcon data-icon="inline-start" />}
                              Go to database deletion confirmation
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Permanently delete local database?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This is the last recovery level. NoteGen will close the database, delete the database file, and restart. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>

                            <Alert variant="destructive">
                              <CircleAlertIcon />
                              <AlertTitle>Will be permanently deleted</AlertTitle>
                              <AlertDescription>
                                Database content such as canvases, chats, record indexes, tags, vector data, memories, and activity records. Markdown files, attachments, and the recordings directory will not be deleted.
                              </AlertDescription>
                            </Alert>

                            <Field orientation="horizontal">
                              <Checkbox
                                id="database-reset-acknowledgement"
                                checked={databaseResetAcknowledged}
                                onCheckedChange={checked => setDatabaseResetAcknowledged(checked === true)}
                              />
                              <FieldLabel htmlFor="database-reset-acknowledgement">
                                I confirm that important data does not need to be kept or has been backed up
                              </FieldLabel>
                            </Field>

                            <Field>
                              <FieldLabel htmlFor="database-reset-phrase">
                                Type “{DATABASE_RESET_PHRASE}” to confirm
                              </FieldLabel>
                              <Input
                                id="database-reset-phrase"
                                value={databaseResetPhrase}
                                onChange={event => setDatabaseResetPhrase(event.target.value)}
                                autoComplete="off"
                                placeholder={DATABASE_RESET_PHRASE}
                              />
                              <FieldDescription>
                                You must check the confirmation above and type the exact same text.
                              </FieldDescription>
                            </Field>

                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                disabled={!databaseResetAcknowledged || databaseResetPhrase !== DATABASE_RESET_PHRASE}
                                onClick={resetLocalDatabase}
                              >
                                Permanently delete and restart
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                ) : null}
              </Accordion>
            </CardContent>
          </Card>

          {isWeb ? (
            <Alert>
              <InfoIcon />
              <AlertTitle>Desktop-only actions are not available here</AlertTitle>
              <AlertDescription>
                Opening the data directory, exporting a full backup, and deleting the database need the desktop app, so they are hidden in the browser. If the app keeps failing after a reload, copy the error info below and report the issue.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-wrap justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="sm" onClick={() => void copyErrorDetails()}>
              <ClipboardIcon data-icon="inline-start" />
              {copied ? 'Copied' : 'Copy error info'}
            </Button>
            <Button variant="ghost" size="sm" onClick={reportGitHubIssue} disabled={busy}>
              {activeAction === 'report-issue'
                ? <Spinner data-icon="inline-start" />
                : <BugIcon data-icon="inline-start" />}
              Report GitHub Issue
            </Button>
          </div>
        </CardFooter>
      </Card>
    </main>
  )
}
